/**
 * One-time backfill: converge meeting-todo tasks created under the OLD ordinal row_key scheme
 * (`meet-<hash>-001`) to the CONTENT-hash key the extractor produces today (`meet-<hash>-<titleHash>`).
 *
 * Why: a task pushed to Linear/Plane before the content-key switch keeps its ordinal key, so a
 * re-extract mints a NEW content-keyed task for the same todo — the pushed ordinal row is preserved by
 * the prune, and pushing the new copy opens a SECOND provider issue (the duplicate-issue bug). This
 * rewrites each ordinal task's row_key (and its task_pm_links row_key) so the next re-extract upserts
 * over the existing pushed row instead. Collisions collapse to a pushed survivor; idempotent.
 *
 * Dry-run by default (prints the plan, writes nothing). Pass --apply to write.
 *
 *   DATABASE_URL=<prod> SECRETS_KEY=<prod> npx tsx --conditions react-server \
 *     scripts/backfill-meeting-todo-rowkeys.ts [--team <slug>] [--apply]
 */
import { runSql } from "@/lib/db/pg/pool";
import { adminClient } from "@/lib/db/admin";
import { backfillMeetingTodoRowKeys, MEETING_TODO_PROJECT_SLUG } from "@/lib/meetings/extract-todos";

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

  console.log(`Backfill meeting-todo row_keys (ordinal → content) — ${APPLY ? "APPLY" : "DRY-RUN"} — ${teams.length} team(s)\n`);
  let totalScanned = 0;
  let totalRekeyed = 0;
  let totalCollapsed = 0;

  for (const team of teams) {
    if (APPLY) {
      const r = await backfillMeetingTodoRowKeys(db, team.id);
      if (r.scanned) console.log(`  ${team.slug}: scanned ${r.scanned}, rekeyed ${r.rekeyed}, collapsed ${r.collapsed}`);
      totalScanned += r.scanned;
      totalRekeyed += r.rekeyed;
      totalCollapsed += r.collapsed;
    } else {
      // Dry-run: count ordinal-keyed meeting tasks without mutating anything.
      const { rows } = await runSql<{ n: string }>(
        `select count(*)::text as n
           from tasks t join projects p on p.id = t.project_id
          where t.team_id = $1 and p.slug = $2 and t.row_key ~ '^meet-[0-9a-f]{10}-[0-9]{3}$'`,
        [team.id, MEETING_TODO_PROJECT_SLUG]
      );
      const n = Number(rows[0]?.n ?? "0");
      if (n) console.log(`  ${team.slug}: ${n} ordinal-keyed task(s) would be converged`);
      totalScanned += n;
    }
  }

  if (APPLY) {
    console.log(`\nRekeyed ${totalRekeyed} task(s); collapsed ${totalCollapsed} duplicate(s) across ${totalScanned} scanned.`);
  } else {
    console.log(`\n${totalScanned} ordinal-keyed task(s) across all teams. Re-run with --apply to converge them.`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
