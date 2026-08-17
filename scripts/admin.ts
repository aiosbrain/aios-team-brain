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
import { adminClient } from "@/lib/db/admin";
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
import {
  ENFORCEMENT_MODES,
  isEnforcementMode,
  setAccessEnforcement,
  type EnforcementReadiness,
} from "@/lib/admin/access-enforcement";
// EXPLICIT-ID purge only. `purgeItemsByPathPrefix` is deliberately NOT imported: it is path-scoped
// and team-wide, and the workspace path roots (`0-context/`, `2-work/`, `3-log/`) are shared by every
// project in a team — a prefix purge from a command line would take out unrelated real content. That
// footgun stays behind the ingest callers that build their prefix from the same helper that wrote it.
import { purgeItemIds } from "@/lib/ingest/purge";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; positionals: string[]; flags: Flags } {
  const [cmd = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positionals.push(a);
  }
  return { cmd, positionals, flags };
}

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
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
  rename-team <new-slug> [--name <display>] [--team <id|slug>]
  add-author-alias <member-email> <git-identity> [--team <id|slug>] [--force]
  link-github <member-email> <github-login> [--team <id|slug>] [--force]   # needs GITHUB_TOKEN env
  link-identity <member-email> <provider> <external-id> [--handle <h>] [--email <e>] [--team <id|slug>] [--force]
                                         # link a provider user id (e.g. slack U…) to a member
  sync-github --org <org> [--team <id|slug>]                               # list candidates (needs GITHUB_TOKEN)
  set-access-enforcement <team-slug> <permissive|enforcing> [--dry-run]
                                         # arm/disarm per-project access enforcement for ONE team.
                                         # 'enforcing' bootstraps + drains the §11 backfill first,
                                         # then REFUSES if anyone would be locked out of their own
                                         # content. 'permissive' is today's behaviour and the undo.
                                         # The team is a POSITIONAL here — never the --team default.
  purge-items --team <id|slug> --ids <uuid,uuid,…> --reason "<text>" [--confirm]
                                         # irreversibly remove specific items + their versions/chunks/
                                         # facts, retire their graph episodes, audit, bust derived
                                         # caches. DRY RUN by default — --confirm actually deletes.
                                         # Explicit ids only; there is no path-prefix form here.
  pg:schema                              # load postgres/schema.sql (idempotent)
Defaults: --team demo (accepts a team UUID too). Requires DATABASE_URL (postgres). GitHub token via GITHUB_TOKEN env only.`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURGE_USAGE = `purge-items --team <id|slug> --ids <uuid,uuid,…> --reason "<text>" [--confirm]`;

/** Print an enforcement readiness verdict. Blockers are why the flip is refused; warnings are real
 *  behaviour changes the operator still has to know about, so they print on a PASS too. */
function printReadiness(r: EnforcementReadiness): void {
  console.log(
    `readiness: ${r.itemsScanned} item(s) scanned, ${r.unpartitioned.count} unpartitioned; ` +
      `${r.humanPrincipals} human + ${r.agentPrincipals} agent principal(s)`
  );
  if (r.unpartitioned.examples.length > 0) {
    console.log(`  unpartitioned e.g.: ${r.unpartitioned.examples.join(", ")}`);
  }
  if (r.blindHumans.length > 0) {
    console.log("  members who would see NOTHING under enforcing:");
    console.table(r.blindHumans.map((m) => ({ email: m.email, tier: m.tier, member_id: m.memberId })));
  }
  for (const w of r.warnings) console.log(`  ⚠ ${w}`);
  for (const [label, rows] of [
    ["agent", r.unplacedAgents],
    ["connector", r.activeConnectors],
  ] as const) {
    if (rows.length > 0) console.table(rows.map((m) => ({ [label]: m.email, member_id: m.memberId })));
  }
  console.log(r.ready ? "  ✓ ready to enforce" : "  ✗ NOT ready to enforce");
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

async function main() {
  const { cmd, positionals, flags } = parseArgs(process.argv.slice(2));
  if (cmd === "help" || flags.help) return console.log(USAGE);

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
        ttlMinutes: flags["ttl-min"] ? Number(flags["ttl-min"]) : 60,
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
    case "set-access-enforcement": {
      // The team is POSITIONAL, deliberately: every other command falls back to `--team demo`, and
      // a silent default on the one flag that decides what a whole team can see is exactly the
      // accident this command must not enable. Naming the team is the point.
      const teamRef =
        positionals[0] ||
        die(`usage: set-access-enforcement <team-slug> <${ENFORCEMENT_MODES.join("|")}> [--dry-run]`);
      const mode = positionals[1];
      if (!mode || !isEnforcementMode(mode)) {
        // Reject anything outside the two literals BEFORE touching the DB. `teamEnforcesAccess`
        // treats every non-'enforcing' string as permissive, so a typo ('enforce', 'Enforcing')
        // would write a value that reads back as OFF while looking like it worked.
        die(
          `invalid mode '${mode ?? ""}' — must be exactly one of: ${ENFORCEMENT_MODES.join(", ")}\n` +
            `  usage: set-access-enforcement <team-slug> <${ENFORCEMENT_MODES.join("|")}> [--dry-run]`
        );
      }
      const team = await resolveTeam(admin, teamRef);
      const dryRun = Boolean(flags["dry-run"]);
      if (mode === "enforcing" && !dryRun) {
        console.log(`• preparing ${team.slug}: access bootstrap + §11 context backfill (idempotent) …`);
      }
      const r = await setAccessEnforcement(admin, team.id, mode, { dryRun });
      if (r.prepared) {
        console.log(
          `  prepared: ${r.prepared.batches} batch(es), ${r.prepared.unitsCreated} unit(s), ${r.prepared.membershipsCreated} membership(s) created`
        );
      }
      if (r.readiness) printReadiness(r.readiness);
      if (!r.ok) die(r.error ?? "failed");
      if (dryRun) {
        console.log(
          `• dry run — nothing written. ${team.slug} is '${r.previous}'; '${mode}' would ` +
            (mode === "permissive" ? "always be safe (it is the fail-open direction)." : "be safe to apply now.")
        );
        break;
      }
      // The mode below is the value READ BACK from the row, not the one we asked for.
      console.log(
        r.changed
          ? `✓ ${team.slug} access_enforcement: ${r.previous} → ${r.mode}`
          : `• ${team.slug} access_enforcement already '${r.mode}' (no change)`
      );
      if (r.mode === "enforcing") {
        console.log(
          "  scope: enforcement covers GET /api/v1/items, retrieval + both query routes, delegated\n" +
            "  aiosd_ tokens, the work timeline and narrative arcs. Other dashboard surfaces are NOT\n" +
            "  yet enforced — see docs/OPS.md §9. Undo with: set-access-enforcement <team> permissive"
        );
      }
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

main()
  .then(() => process.exit(0))
  .catch((e) => die(e instanceof Error ? e.message : String(e)));
