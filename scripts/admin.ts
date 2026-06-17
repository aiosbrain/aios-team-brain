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
import { adminClient } from "@/lib/supabase/admin";
import { createMember } from "@/lib/admin/members";
import { issueApiKey, revokeApiKey } from "@/lib/admin/keys";
import { issueLoginLink } from "@/lib/admin/login";

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

async function resolveTeam(admin: ReturnType<typeof adminClient>, slug: string) {
  const { data } = await admin.from("teams").select("id, slug").eq("slug", slug).maybeSingle();
  if (!data) die(`no team '${slug}'`);
  return data as { id: string; slug: string };
}

const USAGE = `Team Brain admin CLI — commands:
  create-member <email> --name <n> --handle <h> [--role admin|lead|member] [--team <slug>] [--upsert]
  login-link <email> [--team <slug>] [--ttl-min <n>] [--base-url <url> | env BRAIN_URL]
  issue-key <member-email> [--name <n>] [--team <slug>]
  revoke-key <api-key-uuid> [--team <slug>]
  list-members [--team <slug>]
  list-keys [--team <slug>]
  pg:schema                              # load postgres/schema.sql (idempotent)
Defaults: --team demo. Requires DATABASE_URL (postgres).`;

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
    execFileSync("npx", ["tsx", "scripts/pg-load-schema.ts"], { stdio: "inherit" });
    return;
  }

  if (!process.env.DATABASE_URL) die("DATABASE_URL is required");
  const admin = adminClient();
  const teamSlug = (flags.team as string) || "demo";

  switch (cmd) {
    case "create-member": {
      const email = positionals[0] || die("usage: create-member <email> --name <n> --handle <h>");
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
      console.log(`✓ member ${email} (${res.id}) status=${res.status} on team ${team.slug}`);
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
    default:
      die(`unknown command '${cmd}'\n\n${USAGE}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => die(e instanceof Error ? e.message : String(e)));
