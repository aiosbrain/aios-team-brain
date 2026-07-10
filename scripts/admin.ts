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
  pg:schema                              # load postgres/schema.sql (idempotent)
Defaults: --team demo (accepts a team UUID too). Requires DATABASE_URL (postgres). GitHub token via GITHUB_TOKEN env only.`;

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
