/**
 * One-time backfill: LINK historical `work_events` that the project-scope bug stranded `unresolved`.
 *
 * Why: the PR→task lookup used to be scoped to the PUSHED project (the repo's), but Linear-mirrored tasks
 * live in `linear-<teamKey>` — so a PR citing `AIO-494` could never find its task and the event was written
 * `unresolved` with `task_id = null`. `lib/work-events/resolve-task` now resolves TEAM-WIDE; this re-runs
 * that rule over the stranded rows so the Timeline's PR-inherited links have history to work with.
 *
 * SAFE BY CONSTRUCTION: writes ONLY `task_id` + `status='linked'`. It never completes a task and never
 * projects back to the PM tool, so re-resolving historical PRs cannot mass-mutate a live Linear workspace.
 * Issue-shaped keys only (the extractor emits junk like `V1`/`GPT-5`). Idempotent — a second run links 0.
 *
 * Dry-run by default (counts the candidates, writes nothing). Pass --apply to write.
 *
 *   DATABASE_URL=<prod> SECRETS_KEY=<prod> npx tsx --conditions react-server \
 *     scripts/backfill-work-event-links.ts [--team <slug>] [--apply]
 */
import { runSql } from "@/lib/db/pg/pool";
import { adminClient } from "@/lib/db/admin";
import { relinkUnresolvedWorkEvents } from "@/lib/work-events/relink";
import { isIssueShapedKey } from "@/lib/work-events/resolve-task";

const APPLY = process.argv.includes("--apply");
const teamArg = (() => {
  const i = process.argv.indexOf("--team");
  return i !== -1 ? process.argv[i + 1] : undefined;
})();

async function main() {
  const db = adminClient();
  const teams = (
    await runSql<{ id: string; slug: string }>(
      teamArg ? `select id, slug from teams where slug = $1` : `select id, slug from teams`,
      teamArg ? [teamArg] : []
    )
  ).rows;

  console.log(`Backfill work_event → task links (LINK-ONLY) — ${APPLY ? "APPLY" : "DRY-RUN"} — ${teams.length} team(s)\n`);
  let totalScanned = 0;
  let totalLinked = 0;

  for (const team of teams) {
    if (APPLY) {
      const r = await relinkUnresolvedWorkEvents(db, team.id);
      if (r.scanned) console.log(`  ${team.slug}: scanned ${r.scanned}, linked ${r.linked}`);
      totalScanned += r.scanned;
      totalLinked += r.linked;
    } else {
      // Dry-run: count the unresolved, issue-shaped events that a run would consider. Deliberately does
      // NOT resolve them (that's a read of tasks per key) — the point is the size of the candidate set.
      const { rows } = await runSql<{ row_key: string }>(
        `select row_key from work_events where team_id = $1 and status = 'unresolved'`,
        [team.id]
      );
      const n = rows.filter((r) => isIssueShapedKey(r.row_key)).length;
      if (n) console.log(`  ${team.slug}: ${n} unresolved issue-shaped event(s) would be re-resolved`);
      totalScanned += n;
    }
  }

  if (APPLY) {
    console.log(`\nLinked ${totalLinked} of ${totalScanned} scanned event(s). No task was completed; no PM write-back.`);
  } else {
    console.log(`\n${totalScanned} candidate event(s) across all teams. Re-run with --apply to link them.`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
