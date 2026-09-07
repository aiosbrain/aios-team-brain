/**
 * Team Brain admin CLI. Runs against any Postgres `DATABASE_URL` (local/dev/test,
 * or prod via `railway run`). Reuses the audited primitives in lib/admin/* — it
 * does NOT re-implement auth/key/SQL logic. Secrets (API keys, login tokens) print
 * ONCE and are never logged elsewhere; GITHUB_TOKEN is read from env/stdin only.
 *
 * Run:  npx tsx --conditions react-server scripts/admin.ts <command> [args] [--flags]
 * Prod: railway run -s Postgres bash -lc \
 *         'DATABASE_URL=$DATABASE_PUBLIC_URL npx tsx --conditions react-server scripts/admin.ts <cmd>'
 */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { adminClient } from "@/lib/db/admin";
import { makeMaterializeDeps, parseConfirmFlags, runMaterializeCommand } from "@/lib/access/materialize-command";
import { createMember, deleteMember } from "@/lib/admin/members";
import { syncMemberActor, removeMemberActor } from "@/lib/graph/company-actors";
import { issueApiKey, revokeApiKey } from "@/lib/admin/keys";
import { issueLoginLink } from "@/lib/admin/login";
import { adminSetPassword } from "@/lib/auth/pg-login";
import { isPasswordStrongEnough, randomPassword, MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { createTeam, renameTeam } from "@/lib/admin/teams";
import { addAuthorAlias } from "@/lib/admin/aliases";
import { linkGithub, listOrgMembers } from "@/lib/codebases/github";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { assessAccessHealth, type AccessHealth } from "@/lib/admin/access-health";
import { formatAccessHealth } from "@/lib/admin/access-health-format";
// EXPLICIT-ID purge only. `purgeItemsByPathPrefix` is deliberately NOT imported: it is path-scoped
// and team-wide, and the workspace path roots (`0-context/`, `2-work/`, `3-log/`) are shared by every
// project in a team — a prefix purge from a command line would take out unrelated real content. That
// footgun stays behind the ingest callers that build their prefix from the same helper that wrote it.
import { purgeItemIds } from "@/lib/ingest/purge";

import { parseAdminArgs, ADMIN_BOOLEAN_FLAGS, CliExitError } from "@/lib/admin/args";

function die(msg: string): never {
  throw new CliExitError(msg);
}

async function resolveTeam(admin: ReturnType<typeof adminClient>, ref: string) {
  // Accept a UUID or a slug — keying ops by team_id survives a slug rename.
  const col = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(ref) ? "id" : "slug";
  const { data } = await admin.from("teams").select("id, slug").eq(col, ref).maybeSingle();
  if (!data) die(`no team '${ref}'`);
  return data as { id: string; slug: string };
}

const USAGE = `Team Brain admin CLI — commands:
  create-team <slug> --name <display>   # bootstrap: create a team, no SQL. Idempotent.
  create-member <email> --name <n> --handle <h> [--role admin|lead|member] [--team <slug>] [--upsert]
  login-link <email> [--team <slug>] [--ttl-min <n>] [--base-url <url> | env BRAIN_URL]
  issue-key <member-email> [--name <n>] [--team <slug>]
  revoke-key <api-key-uuid> [--team <slug>]
  list-members [--team <slug>]
  list-keys [--team <slug>]
  delete-member <email> [--hard] [--team <id|slug>]   # soft-disable by default; --hard removes
  add-group-member <group-slug> <member-email> [--team <id|slug>]     # deliberate membership action; builtins = the posture move (humans only)
  remove-group-member <group-slug> <member-email> [--team <id|slug>]  # inverse; builtin removal mirrors members.tier
  grant-project <group-slug> <project-slug> [--actor <admin-email>] [--team <id|slug>]   # ENFB-2: THE access edge (group → project); audited as system — --actor records a named admin authorizer in the audit META (REVOKE-1 D1b)
  repair-system-edge <group-slug> <project-slug> --actor <admin-email> [--team <id|slug>]  # remove a FORBIDDEN substrate edge (AUDITFIX-21)
  revoke-project <group-slug> <project-slug> --actor <admin-email> [--team <id|slug>]    # REVOKE-1: the destructive half — --actor REQUIRED (an active team-posture admin); system projects refuse; no-op revokes report + audit nothing
  rename-team <new-slug> [--name <display>] [--team <id|slug>]
  add-author-alias <member-email> <git-identity> [--team <id|slug>] [--force]
  link-github <member-email> <github-login> [--team <id|slug>] [--force]   # needs GITHUB_TOKEN env
  link-identity <member-email> <provider> <external-id> [--handle <h>] [--email <e>] [--team <id|slug>] [--force]
                                         # link a provider user id (e.g. slack U…) to a member
  sync-github --org <org> [--team <id|slug>]                               # list candidates (needs GITHUB_TOKEN)
  access-health <team-slug>              # standing access-violation/read-zero scan (lockouts AND unsanctioned system grants)
  drain-context <team-slug>              # partition a team's items (the demo bootstrap's post-seed step)
  purge-items --team <id|slug> --ids <uuid,uuid,…> --reason "<text>" [--confirm | --dry-run]
                                         # irreversibly remove specific items + their versions/chunks/
                                         # facts, retire their graph episodes, audit, bust derived
                                         # caches. DRY RUN by default — --confirm actually deletes.
                                         # Explicit ids only; there is no path-prefix form here.
  materialize-builtins [--confirm] [--confirm-production]
                                         # STAGINGMARK-1: complete PRET-4's one-time builtin
                                         # materialization WITHOUT booting the app. Since
                                         # STAGINGMARK-2 the PRET-6 migration repairs a partitioned
                                         # fleet itself at preDeploy, so this is for inspecting a
                                         # fleet or recovering an OLDER release. REFUSES a fleet with
                                         # content but no context substrate — stamping there would
                                         # clear the migration's gate (docs/OPS.md).
                                         # DRY RUN by default. No-op when the marker is already
                                         # present. --confirm-production is additionally required
                                         # when the database carries no staging_marker.
  pg:schema                              # load postgres/schema.sql (idempotent)
Boolean flags take no value: pass them bare to enable, or omit to disable. Put positionals first.
Defaults: --team demo (accepts a team UUID too). Requires DATABASE_URL (postgres). GitHub token via GITHUB_TOKEN env only.`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURGE_USAGE = `purge-items --team <id|slug> --ids <uuid,uuid,…> --reason "<text>" [--confirm | --dry-run]`;

/** Print the standing access-health verdict: blockers are what an operator must FIX — a human locked
 *  OUT (grants/backfill) or a group let IN the substrate never sanctioned (AUDITFIX-23); warnings are
 *  read-zero states worth knowing. The wording lives in a shared import-safe formatter module. */
function printHealth(r: AccessHealth): void {
  for (const line of formatAccessHealth(r)) console.log(line);
}

async function memberIdByEmail(admin: ReturnType<typeof adminClient>, teamId: string, email: string) {
  const { data } = await admin
    .from("members")
    .select("id")
    .eq("team_id", teamId)
    .eq("email", email.trim().toLowerCase())
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

export async function main(argv: string[]) {
  const parsedArgs = parseAdminArgs(argv, ADMIN_BOOLEAN_FLAGS);
  if (!parsedArgs.ok) die(parsedArgs.error);
  const { cmd, positionals, flags } = parsedArgs;
  // `--help` as the command token too: parseArgs makes it the cmd, so neither of the other two
  // clauses match and it used to fall through to the DATABASE_URL check.
  if (cmd === "help" || cmd === "--help" || flags.help) return console.log(USAGE);

  if (cmd === "pg:schema") {
    execFileSync("node", ["scripts/pg-load-schema.mjs"], { stdio: "inherit" });
    return;
  }

  if (!process.env.DATABASE_URL) die("DATABASE_URL is required");
  const admin = adminClient();
  const teamSlug = (flags.team as string) || "demo";

  switch (cmd) {
    case "create-team": {
      const slug = positionals[0] || die("usage: create-team <slug> --name <display>");
      // `--name` with no following value parses as boolean `true` (parseArgs), which would
      // otherwise pass truthiness here and crash later at `.trim()` instead of showing usage.
      const name =
        (typeof flags.name === "string" && flags.name) ||
        die("usage: create-team <slug> --name <display>");
      const team = await createTeam(admin, { slug, name });
      console.log(`✓ team ${team.slug} (${team.id}) "${team.name}"`);
      break;
    }
    case "create-member": {
      const email = positionals[0] || die("usage: create-member <email> --name <n> --handle <h> [--password <p>]");
      const team = await resolveTeam(admin, teamSlug);
      const res = await createMember(
        admin,
        team.id,
        {
          email,
          displayName: (flags.name as string) || email.split("@")[0],
          actorHandle: (flags.handle as string) || email.split("@")[0],
          role: ((flags.role as string) || "member") as "admin" | "lead" | "member",
          tier: (flags.tier as "team" | "external") || "team",
        },
        { upsert: Boolean(flags.upsert) }
      );
      // Set a sign-in password (audit M1/M2b) — printed ONCE, never logged elsewhere. Without this
      // the member row exists but no one can log in as them until an admin resets a password via
      // the dashboard.
      const password = (flags.password as string) || randomPassword();
      if (!isPasswordStrongEnough(password)) die(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      await adminSetPassword(email, password);
      try {
        await syncMemberActor(admin, team.id, res.id);
      } catch (e) {
        console.error("company-graph sync failed:", e instanceof Error ? e.message : e);
      }
      console.log(`✓ member ${email} (${res.id}) status=${res.status} on team ${team.slug}`);
      console.log(`✓ password set (copy now, shown once): ${password}`);
      break;
    }
    case "login-link": {
      const email = positionals[0] || die("usage: login-link <email>");
      const team = await resolveTeam(admin, teamSlug);
      const baseUrl = (flags["base-url"] as string) || process.env.BRAIN_URL || "";
      const { token, url } = await issueLoginLink(admin, team.id, email, {
        nextPath: `/t/${team.slug}`,
        // Explicit legacy presence check: this is a value flag, including bare-true compatibility.
        ttlMinutes: flags["ttl-min"] !== undefined && flags["ttl-min"] !== ""
          ? Number(flags["ttl-min"] as string) : 60,
        baseUrl,
      });
      if (!token) die(`no member for ${email} (invite-only) — run create-member first`);
      console.log(url ? `✓ one-time login link (expires soon):\n${url}` : `✓ token (append to /auth/confirm?token=): ${token}`);
      break;
    }
    case "issue-key": {
      const email = positionals[0] || die("usage: issue-key <member-email> [--name <n>]");
      const team = await resolveTeam(admin, teamSlug);
      const memberId = (await memberIdByEmail(admin, team.id, email)) || die(`no member ${email}`);
      const { key } = await issueApiKey(admin, team.id, memberId, (flags.name as string) || "cli key");
      console.log(`✓ API key (shown once — store it now):\n${key}`);
      break;
    }
    case "revoke-key": {
      const id = positionals[0] || die("usage: revoke-key <api-key-uuid>");
      const team = await resolveTeam(admin, teamSlug);
      await revokeApiKey(admin, team.id, id);
      console.log(`✓ revoked key ${id}`);
      break;
    }
    case "list-members": {
      const team = await resolveTeam(admin, teamSlug);
      const { data } = await admin
        .from("members")
        .select("email, actor_handle, role, tier, status")
        .eq("team_id", team.id)
        .order("created_at");
      console.table(data ?? []);
      break;
    }
    case "list-keys": {
      const team = await resolveTeam(admin, teamSlug);
      const { data } = await admin
        .from("api_keys")
        .select("id, key_id, name, last_used_at, revoked_at")
        .eq("team_id", team.id)
        .order("created_at");
      console.table(data ?? []);
      break;
    }
    case "delete-member": {
      const email = positionals[0] || die("usage: delete-member <email> [--hard]");
      const team = await resolveTeam(admin, teamSlug);
      const hard = Boolean(flags.hard);
      // Capture direct reports BEFORE the delete — a hard delete's FK cascade clears their
      // manager_member_id as part of the delete itself, so reading it back after would find none.
      let directReportIds: string[] = [];
      if (hard) {
        const { data: before } = await admin.from("members").select("id").eq("team_id", team.id).eq("email", email).maybeSingle();
        const beforeId = (before as { id: string } | null)?.id;
        if (beforeId) {
          const { data: reports } = await admin.from("members").select("id").eq("team_id", team.id).eq("manager_member_id", beforeId);
          directReportIds = (reports ?? []).map((r) => (r as { id: string }).id);
        }
      }
      const r = await deleteMember(admin, team.id, email, { hard });
      if (r.deleted && r.id) {
        try {
          if (r.mode === "hard") await removeMemberActor(admin, team.id, r.id, directReportIds);
          else await syncMemberActor(admin, team.id, r.id);
        } catch (e) {
          console.error("company-graph sync failed:", e instanceof Error ? e.message : e);
        }
      }
      console.log(
        r.deleted
          ? `✓ ${r.mode === "hard" ? "deleted" : "disabled"} ${email} on ${team.slug}`
          : `• no-op for ${email} (${r.reason})`
      );
      break;
    }
    case "add-group-member":
    case "remove-group-member": {
      // PRET-4 §1c: the first deliberate-membership surface. Builtin targets are the posture
      // move (humans only, members.tier mirrored by the writer); ordinary groups behave as
      // before. Slug-addressed; audited via the single writer.
      const groupSlug = positionals[0] || die(`usage: ${cmd} <group-slug> <member-email> [--team <id|slug>]`);
      const email = positionals[1] || die(`usage: ${cmd} <group-slug> <member-email> [--team <id|slug>]`);
      const team = await resolveTeam(admin, teamSlug);
      const { data: g } = await admin
        .from("groups")
        .select("id, slug, is_builtin")
        .eq("team_id", team.id)
        .eq("slug", groupSlug)
        .maybeSingle();
      if (!g) die(`no group '${groupSlug}' on team ${team.slug}`);
      const { data: m } = await admin
        .from("members")
        .select("id, email, tier")
        .eq("team_id", team.id)
        .eq("email", email.toLowerCase())
        .maybeSingle();
      if (!m) die(`no member ${email} on team ${team.slug}`);
      const { addMemberToGroup, removeMemberFromGroup } = await import("@/lib/access/groups");
      const fn = cmd === "add-group-member" ? addMemberToGroup : removeMemberFromGroup;
      const r = await fn(admin, team.id, (g as { id: string }).id, (m as { id: string }).id, (m as { id: string }).id);
      if (!r.ok) die(`${cmd} failed: ${r.error}`);
      const { data: after } = await admin
        .from("members")
        .select("tier")
        .eq("team_id", team.id)
        .eq("id", (m as { id: string }).id)
        .single();
      console.log(
        `✓ ${cmd === "add-group-member" ? "added" : "removed"} ${email} ${cmd === "add-group-member" ? "to" : "from"} '${groupSlug}'` +
          ((g as { is_builtin: boolean }).is_builtin ? ` (posture move — tier now '${(after as { tier: string }).tier}')` : "")
      );
      break;
    }
    case "grant-project": {
      // ENFB-2: the operator's grant edge — what makes the restricted-initiative lifecycle
      // (and the stranded-creator repair the D1 duplicate-arm deliberately does NOT do)
      // actually operable. Routes through the sole-writer group module, audited there.
      const groupSlug = positionals[0] || die(`usage: ${cmd} <group-slug> <project-slug> [--actor <admin-email>] [--team <id|slug>]`);
      const projectSlug = positionals[1] || die(`usage: ${cmd} <group-slug> <project-slug> [--actor <admin-email>] [--team <id|slug>]`);
      const team = await resolveTeam(admin, teamSlug);
      const { data: g } = await admin
        .from("groups")
        .select("id, slug")
        .eq("team_id", team.id)
        .eq("slug", groupSlug)
        .maybeSingle();
      if (!g) die(`no group '${groupSlug}' on team ${team.slug}`);
      const { data: proj } = await admin
        .from("projects")
        .select("id, slug")
        .eq("team_id", team.id)
        .eq("slug", projectSlug)
        .maybeSingle();
      if (!proj) die(`no project '${projectSlug}' on team ${team.slug}`);
      // REVOKE-1 (D1b): the operator's act audits as system; --actor records a named
      // active-admin authorizer in the audit META only (never the actor field, never
      // added_by — either would attribute the act to a human who merely approved it).
      // A value-less --actor DIES (Fable diff M1): silently dropping the authorizer is the
      // exact attribution failure this flag exists to prevent.
      if (flags.actor === true) die("--actor requires a value (an admin email)");
      const { grantProjectToGroup } = await import("@/lib/access/groups");
      let grantAuthorizer: string | undefined;
      if (typeof flags.actor === "string") {
        grantAuthorizer = (await memberIdByEmail(admin, team.id, flags.actor)) || die(`no member ${flags.actor}`);
      }
      const r = await grantProjectToGroup(admin, team.id, (proj as { id: string }).id, (g as { id: string }).id, null,
        grantAuthorizer ? { authorizedByMemberId: grantAuthorizer, via: "cli" } : {});
      if (!r.ok) die(`${cmd} failed: ${r.error}`);
      // created:false = the edge already existed → NOTHING was written (audit-on-change), so
      // claiming "(authorized by …)" would be a lie (Fable diff L1).
      console.log(
        r.created === false
          ? `· '${projectSlug}' was already granted to '${groupSlug}' on ${team.slug} — nothing written, no authorizer recorded`
          : `✓ granted '${projectSlug}' to '${groupSlug}' on ${team.slug}${grantAuthorizer ? ` (authorized by ${flags.actor})` : ""}`
      );
      break;
    }
    case "repair-system-edge": {
      // AUDITFIX-21: the ONLY sanctioned way to delete a FORBIDDEN edge on a protected project —
      // the state AUDITFIX-23's census reports and `revoke-project` refuses by design. The WRITER
      // holds every invariant (authority first, protected-and-unsanctioned only, delete with
      // RETURNING, audit only a real deletion); this arm resolves the team and hands over.
      const groupSlug = positionals[0];
      const projectSlug = positionals[1];
      if (flags.actor === true) die("--actor requires a value (an admin email)");
      const team = await resolveTeam(admin, teamSlug);
      const { runRepairSystemEdgeVerb, repairVerbDeps } = await import("@/lib/access/repair-verb");
      const outcome = await runRepairSystemEdgeVerb(
        repairVerbDeps(admin, team.id, "cli"),
        { groupSlug, projectSlug, actorEmail: typeof flags.actor === "string" ? flags.actor : undefined }
      );
      if (!outcome.ok) die(outcome.error);
      console.log(
        outcome.revoked
          ? `· removed the unsanctioned edge '${projectSlug}' -> '${groupSlug}' on ${team.slug}`
          : `· nothing to remove — '${projectSlug}' -> '${groupSlug}' does not exist on ${team.slug}`
      );
      break;
    }
    case "revoke-project": {
      // REVOKE-1: the destructive half of the access edge. The WRITER holds the invariants
      // (system-kind refusal, the app's admin predicate, check order — spec D2/D2b/D2c); this
      // verb resolves names, preflights for message quality, and requires the authorizer.
      const groupSlug = positionals[0];
      const projectSlug = positionals[1];
      if (flags.actor === true) die("--actor requires a value (an admin email)");
      const team = await resolveTeam(admin, teamSlug);
      const { runRevokeProjectVerb } = await import("@/lib/access/revoke-verb");
      const { revokeProjectFromGroup } = await import("@/lib/access/groups");
      const outcome = await runRevokeProjectVerb(
        {
          resolveGroupId: async (slug) => {
            const { data } = await admin.from("groups").select("id").eq("team_id", team.id).eq("slug", slug).maybeSingle();
            return (data as { id: string } | null)?.id ?? null;
          },
          resolveProject: async (slug) => {
            // AUDITFIX-21: `slug` too — the preflight now uses isProtectedProject, which needs it.
            const { data } = await admin.from("projects").select("id, kind, slug").eq("team_id", team.id).eq("slug", slug).maybeSingle();
            return (data as { id: string; kind: string; slug: string } | null) ?? null;
          },
          resolveMemberIdByEmail: (email) => memberIdByEmail(admin, team.id, email),
          revoke: (projectId, groupId, authorizedByMemberId) =>
            revokeProjectFromGroup(admin, team.id, projectId, groupId, { kind: "operator", authorizedByMemberId, via: "cli" }),
        },
        { groupSlug, projectSlug, actorEmail: typeof flags.actor === "string" ? flags.actor : undefined }
      );
      if (!outcome.ok) die(outcome.error);
      console.log(
        outcome.revoked
          ? `✓ revoked '${projectSlug}' from '${groupSlug}' on ${team.slug} (authorized by ${flags.actor}; takes effect on the next read)`
          : `· no grant of '${projectSlug}' to '${groupSlug}' on ${team.slug} — nothing revoked, nothing audited`
      );
      break;
    }
    case "rename-team": {
      const newSlug = positionals[0] || die("usage: rename-team <new-slug> [--name <display>]");
      const team = await resolveTeam(admin, teamSlug);
      const r = await renameTeam(admin, team.id, {
        slug: newSlug,
        name: typeof flags.name === "string" ? flags.name : undefined,
      });
      console.log(`✓ team is now ${r.slug} / "${r.name}"`);
      break;
    }
    case "add-author-alias": {
      const email = positionals[0] || die("usage: add-author-alias <member-email> <git-identity>");
      const identity = positionals[1] || die("usage: add-author-alias <member-email> <git-identity>");
      const team = await resolveTeam(admin, teamSlug);
      const memberId = (await memberIdByEmail(admin, team.id, email)) || die(`no member ${email}`);
      const r = await addAuthorAlias(admin, team.id, memberId, identity, { force: Boolean(flags.force) });
      console.log(
        `✓ alias ${identity} → ${email}: backfilled ${r.backfilled}, remapped ${r.remapped}, collisions ${r.collisions}` +
          (r.note ? `\n  ⚠ ${r.note}` : "")
      );
      break;
    }
    case "link-github": {
      const email = positionals[0] || die("usage: link-github <member-email> <github-login>");
      const login = positionals[1] || die("usage: link-github <member-email> <github-login>");
      const token = process.env.GITHUB_TOKEN || die("set GITHUB_TOKEN env (do not pass as a flag)");
      const team = await resolveTeam(admin, teamSlug);
      const memberId = (await memberIdByEmail(admin, team.id, email)) || die(`no member ${email}`);
      const r = await linkGithub(admin, team.id, memberId, token, login, { force: Boolean(flags.force) });
      console.log(
        `✓ linked ${email} → @${r.login} (avatar set); ${r.aliases.length} aliases, backfilled ${r.backfilled}`
      );
      break;
    }
    case "link-identity": {
      const email = positionals[0] || die("usage: link-identity <member-email> <provider> <external-id>");
      const provider = positionals[1] || die("usage: link-identity <member-email> <provider> <external-id>");
      const externalId = positionals[2] || die("usage: link-identity <member-email> <provider> <external-id>");
      const team = await resolveTeam(admin, teamSlug);
      const memberId = (await memberIdByEmail(admin, team.id, email)) || die(`no member ${email}`);
      const r = await setMemberIdentity(
        admin,
        team.id,
        memberId,
        {
          provider,
          externalId,
          handle: (flags.handle as string) || undefined,
          email: (flags.email as string) || undefined,
        },
        { force: Boolean(flags.force), actor: { kind: "system" } }
      );
      if (r.conflict) {
        die(`${provider}:${externalId} is already linked to a different member${r.note ? ` (${r.note})` : ""}; pass --force to reassign`);
      }
      console.log(`✓ ${provider}:${externalId} → ${email} (${r.created ? "created" : r.updated ? "updated" : "unchanged"})`);
      break;
    }
    case "access-health": {
      // PRET-6: the standing health check (the flip subsystem's readiness scan, re-homed) —
      // lockouts, unsanctioned system-project grants, and read-zero states, asked of the oracle itself.
      const teamRef = positionals[0] || die("usage: access-health <team-slug>");
      const team = await resolveTeam(admin, teamRef);
      const h = await assessAccessHealth(admin, team.id);
      printHealth(h);
      if (!h.healthy) process.exitCode = 1;
      break;
    }
    case "drain-context": {
      // PRET-6 (cold-read H3): the demo bootstrap's post-seed drain — a team is born enforcing,
      // so its seeded rows must be partitioned before first serve (the PRET-2 cold-read-M2 fix,
      // kept without the retired flip machinery).
      const teamRef = positionals[0] || die("usage: drain-context <team-slug>");
      const team = await resolveTeam(admin, teamRef);
      const { drainTeamContext } = await import("@/lib/projects/context/backfill");
      const d = await drainTeamContext(admin, team.id);
      console.log(`✓ drained ${team.slug}: ${d.batches} batch(es), ${d.unitsCreated} unit(s), ${d.membershipsCreated} membership(s)`);
      break;
    }
    case "purge-items": {
      // A destructive command must not inherit the `--team demo` default: `--team` is REQUIRED here.
      if (typeof flags.team !== "string" || !flags.team.trim()) {
        die(`--team is required for purge-items (no default) — usage: ${PURGE_USAGE}`);
      }
      const idList = typeof flags.ids === "string" ? flags.ids : die(`--ids is required — usage: ${PURGE_USAGE}`);
      const reason =
        (typeof flags.reason === "string" && flags.reason.trim()) ||
        die(`--reason is required (it is written into the items.purged audit row) — usage: ${PURGE_USAGE}`);
      if (flags.confirm && flags["dry-run"]) die("pass either --confirm or --dry-run, not both");
      const given = [...new Set(idList.split(",").map((s) => s.trim()).filter(Boolean))];
      if (given.length === 0) die("--ids resolved to no ids");
      // Validate BEFORE touching the DB: a malformed id is a typo, and a typo in a purge argument is
      // the one input where "ignore what doesn't parse" is the wrong default.
      const malformed = given.filter((id) => !UUID_RE.test(id));
      if (malformed.length > 0) die(`not well-formed uuids: ${malformed.join(", ")}`);
      // Canonicalize AFTER validating: Postgres renders uuids lowercase, and the found/missing
      // reconciliation below is a string compare — an operator pasting an uppercase id from a
      // spreadsheet would otherwise be told their own item "is not on this team".
      const requested = [...new Set(given.map((id) => id.toLowerCase()))];

      const team = await resolveTeam(admin, flags.team);
      const { data: rows, error: readErr } = await admin
        .from("items")
        .select("id, path, kind, access")
        .eq("team_id", team.id)
        .in("id", requested);
      if (readErr) die(`items read failed: ${readErr.message}`);
      const found = (rows ?? []) as { id: string; path: string; kind: string; access: string }[];
      const missing = requested.filter((id) => !found.some((r) => r.id === id));
      if (missing.length > 0) {
        // Refuse rather than purge the subset: `purgeItemIds` is team-scoped, so an id belonging to
        // another team would silently no-op while still being COUNTED in the result — an operator
        // would read "14 purged" for 13 deletions. Make the mismatch the operator's decision.
        die(`${missing.length} id(s) are not items on team ${team.slug}: ${missing.join(", ")}`);
      }

      // Episode preview: `graph_episodes.source_id` has no FK to items, so these rows are exactly what
      // a raw `delete from items` would orphan (and, where `episode_uuid` is set, leave live in Neo4j).
      const { data: eps } = await admin
        .from("graph_episodes")
        .select("source_id, episode_uuid, deferred")
        .eq("team_id", team.id)
        .eq("source_table", "items")
        .in("source_id", requested);
      const episodeRows = (eps ?? []) as { source_id: string; episode_uuid: string | null; deferred: boolean }[];
      const projected = episodeRows.filter((e) => e.episode_uuid).length;

      console.log(`Team ${team.slug} — ${found.length} item(s) resolved for purge:`);
      console.table(
        found.map((r) => ({
          id: r.id,
          path: r.path,
          kind: r.kind,
          access: r.access,
          episodes: episodeRows.filter((e) => e.source_id === r.id).length,
        }))
      );
      console.log(
        `graph episodes: ${episodeRows.length} ledger row(s), ${projected} projected into Graphiti/Neo4j (episode_uuid set)`
      );
      console.log(`reason: ${reason}`);

      if (!flags.confirm) {
        console.log(
          "• DRY RUN — nothing deleted. This is irreversible; re-run the same command with --confirm to purge."
        );
        break;
      }

      const result = await purgeItemIds(admin, team.id, found.map((r) => r.id), reason);
      console.log(`✓ purged ${result.items} item(s) on ${team.slug} — versions/chunks/facts cascaded`);
      console.log(`✓ retired ${result.episodes} graph episode ledger row(s) (graph cleanup finishes via reconcile)`);
      console.log(`✓ audit row written: action='items.purged' (reason + the paths above)`);
      console.log(
        "• derived caches: work_timeline_cache + arc_cache bust requested via bustTeamLearningCaches —\n" +
          "  best-effort, so if a bust failed the error is printed above and those surfaces self-heal on TTL."
      );
      break;
    }
    case "materialize-builtins": {
      // STAGINGMARK-1. The behaviour, and every outcome's exit code, live in
      // lib/access/materialize-command.ts so they are testable — this case is wiring only. It
      // reaches the underlying materialization ONLY through makeMaterializeDeps: a direct second
      // caller here would leave the handler's tests green while the real command still wrote, and
      // test/guards/access-bootstrap-callsites.test.ts fails the build if one appears.
      const parsed = parseConfirmFlags(flags);
      if (!parsed.ok) die(parsed.error);
      const outcome = await runMaterializeCommand(makeMaterializeDeps(admin), parsed);
      for (const line of outcome.lines) console.log(line);
      if (outcome.exitCode !== 0) {
        // FLUSH BEFORE EXITING. `console.log` to a PIPE is asynchronous, and `process.exit()`
        // does not wait for it — so a wrapper or CI job capturing this command's output could
        // see a truncated report, or none, for a run that already touched the database. Awaiting
        // a zero-length write drains what is queued first (second diff review).
        await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
        throw new CliExitError("", outcome.exitCode);
      }
      break;
    }
    case "sync-github": {
      const org = (flags.org as string) || die("usage: sync-github --org <org>");
      const token = process.env.GITHUB_TOKEN || die("set GITHUB_TOKEN env (do not pass as a flag)");
      const candidates = await listOrgMembers(org, token);
      console.log(`Candidates in ${org} — confirm each with: admin link-github <member-email> <login>`);
      console.table(candidates.map((c) => ({ login: c.login, id: c.id })));
      break;
    }
    default:
      die(`unknown command '${cmd}'\n\n${USAGE}`);
  }
}

// basename, not a suffix: `endsWith("/admin.ts")` never matches a Windows path separator, and the
// failure mode is SILENT SUCCESS — the module loads, does nothing, and exits 0. Stated precisely
// (astra review corrected an earlier overclaim): this does NOT fix a RENAMED copy, which still
// skips, and it fires for any entry whose basename is `admin.ts`. It is a cheap identity heuristic,
// not module identity.
if (basename(process.argv[1] ?? "") === "admin.ts") {
  main(process.argv.slice(2))
    // Bare exit(), NOT exit(0): `access-health` reports an unhealthy team by setting
    // process.exitCode = 1, and exit(0) discarded it — the command exited 0 while printing blockers.
    .then(() => process.exit())
    .catch((e) => {
      if (!(e instanceof CliExitError) || e.message) console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
      process.exit(e instanceof CliExitError ? e.exitCode : 1);
    });
}
