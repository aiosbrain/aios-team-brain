/**
 * Connector CLI — close the loop after pasting a token in Admin → Integrations.
 *
 * The problem this solves: saving a connector gives no feedback until the next scheduler tick
 * (≤30 min), and a wrong Slack scope fails inside that tick where nobody is watching. So the
 * setup loop was paste → wait → guess, and "it isn't working" was indistinguishable from
 * "nothing new to ingest". `status` answers it from the recorded run history; `verify` forces a
 * sync now and reports what actually landed.
 *
 * Read-and-run only: it never writes an integration row. `lib/integrations/manage` is the single
 * legal writer for `integrations` and the Admin UI encrypts + audits that write — this CLI would
 * bypass both. Pasting tokens stays a human action in the UI, deliberately.
 *
 * Run:  npx tsx --conditions react-server scripts/connectors.ts <status|verify> [--team <slug>]
 * Prod: railway run -s Postgres bash -lc \
 *         'DATABASE_URL=$DATABASE_PUBLIC_URL npx tsx --conditions react-server scripts/connectors.ts status'
 */
import { adminClient } from "@/lib/db/admin";
import { listRecentIngestRuns } from "@/lib/ingest/runs";
import { runManualSync } from "@/lib/ingest/manual-sync";
import {
  type IntegrationRow,
  type RunRow,
  formatConnectorTable,
  hasActionableProblem,
  summarizeConnectors,
} from "@/lib/ingest/connector-status";

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const USAGE = `Team Brain connector CLI — commands:
  status              show each connector: configured, last run, what landed, and any error
  verify              force a sync now, then show status (skips the ≤30 min scheduler wait)

Flags:
  --team <slug>       team to inspect (default: the only team, or 'demo')

Exit code is 1 when a connector needs attention (a stored credential is missing, or its last
run failed). "Configured but never run" and "ran, nothing new" are not failures.`;

async function resolveTeam(admin: ReturnType<typeof adminClient>, ref: string | undefined) {
  if (ref) {
    const col = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(ref) ? "id" : "slug";
    const { data } = await admin.from("teams").select("id, slug").eq(col, ref).maybeSingle();
    if (!data) die(`no team '${ref}'`);
    return data as { id: string; slug: string };
  }
  // Single-team installs are the common case — don't make people pass --team for no reason.
  const { data } = await admin.from("teams").select("id, slug").limit(2);
  const teams = (data ?? []) as { id: string; slug: string }[];
  if (teams.length === 0) die("no teams exist yet — create one first (scripts/admin.ts create-team)");
  if (teams.length > 1) die(`several teams exist — pass --team <slug>`);
  return teams[0];
}

async function loadStatuses(admin: ReturnType<typeof adminClient>, teamId: string) {
  const { data: integrations } = await admin
    .from("integrations")
    .select("type, name, status, secret_ciphertext")
    .eq("team_id", teamId);

  // Map to has_secret rather than carrying ciphertext around: the summary only needs to know
  // whether a credential exists, and the blob has no business leaving the query.
  const rows: IntegrationRow[] = ((integrations ?? []) as Record<string, unknown>[]).map((r) => ({
    type: String(r.type),
    name: String(r.name),
    status: String(r.status),
    has_secret: Boolean(r.secret_ciphertext),
  }));

  const runs = (await listRecentIngestRuns(admin, teamId, 200)) as unknown as RunRow[];
  return summarizeConnectors(rows, runs);
}

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  if (cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }
  if (cmd !== "status" && cmd !== "verify") die(`unknown command '${cmd}'\n\n${USAGE}`);

  const teamFlag = rest.includes("--team") ? rest[rest.indexOf("--team") + 1] : undefined;
  const admin = adminClient();
  const team = await resolveTeam(admin, teamFlag);

  if (cmd === "verify") {
    console.log(`▶ forcing a sync for team ${team.slug} (this is what the scheduler does every 30 min)…\n`);
    const result = await runManualSync(team.id);
    // runManualSync returns the same markdown the dashboard "sync now" command streams back.
    if (result?.summary) console.log(`${result.summary}\n`);
  }

  const statuses = await loadStatuses(admin, team.id);
  console.log(`Connectors — team ${team.slug}\n`);
  console.log(formatConnectorTable(statuses));

  const actionable = hasActionableProblem(statuses);
  if (cmd === "status" && statuses.some((s) => s.verdict === "pending")) {
    console.log(`\nSome connectors have not run yet. Run \`connectors verify\` to sync now instead of waiting.`);
  }
  if (actionable) {
    console.log(`\n✗ One or more connectors need attention (see above).`);
    process.exit(1);
  }
  console.log(`\n✓ Nothing needs attention.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
