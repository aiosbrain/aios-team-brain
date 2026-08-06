/**
 * Drive one battery projection run through the REAL projector path (PIPEFF-2 / AIO-821).
 *
 * This is deliberately the scheduler's own pair of calls — `runGraphProjection()` then
 * `recordIngestRun(projectionRunInput(...))` — and not a bespoke pusher, because the second call is
 * what writes `ingest_runs.meta.episodes`. Without that row the cost harness's cross-check is
 * unavailable, Q5 (the signed retry gap) is unmeasurable, and C1 loses its guard against a
 * retry-rate shift masquerading as a token saving. A bespoke loop over chunkContent + REST would
 * reproduce the push and silently skip the record — which is exactly the blocker the plan review
 * raised against the first battery design.
 *
 * The one divergence from the scheduler: it records UNCONDITIONALLY. The scheduler skips recording a
 * no-signal tick to keep the panel quiet; the battery needs the row even if something upstream made
 * the run a no-op, because "no row" and "no episodes" must stay distinguishable.
 *
 * Env: DATABASE_URL (the battery Postgres) · GRAPHITI_URL (the arm's graphiti).
 * Usage: npx tsx --conditions react-server scripts/graph-window-battery/run-projection.ts
 */
import { runGraphProjection } from "@/lib/graph/run";
import { projectionRunInput } from "@/lib/graph/projection-run";
import { recordIngestRun } from "@/lib/ingest/runs";
import { adminClient } from "@/lib/db/admin";

async function main(): Promise<void> {
  const startedAt = Date.now();
  console.log(`[battery] projection start ${new Date(startedAt).toISOString()} → ${process.env.GRAPHITI_URL}`);

  const s = await runGraphProjection();
  await recordIngestRun(adminClient(), projectionRunInput(s, "manual", startedAt, Date.now()));

  console.log(
    `[battery] pushed: ${s.projected} items → ${s.episodes} episodes · skipped ${s.skipped} · scanned ${s.scanned} · teams ${s.teams}` +
      (s.errors.length ? `\n[battery] ERRORS: ${s.errors.join("; ")}` : "")
  );
  console.log(`[battery] projection recorded ${new Date().toISOString()} — extraction continues async; wait for llm_usage to drain`);
  process.exit(!s.episodes || s.errors.length ? 1 : 0);
}
void main();
