import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * The context-backfill stage's DURABLE resume cursor and its team rotation order (TICKSTALL-1,
 * `docs/design/tick-stall-backfill-budget.md` §Decision 3 and §Decision 4).
 *
 * WHY THIS EXISTS AT ALL. `backfillAllTeams` used to start every team at `cursor = null`, which was
 * fine while it always drained to completion. The moment the stage gained a time budget that stopped
 * mattering and became actively harmful: without a cursor that survives the tick, a budgeted pass
 * re-scans the same first batch every 30 minutes, forever, and never reaches the tail — a fix that
 * looks like it works because the downstream legs start running again. The first draft of the spec
 * asserted a resume mechanism that did not exist; this module is that mechanism.
 *
 * WHERE THE STATE LIVES. `ingest_runs.meta.cursor` on the team's newest scheduler `context_backfill`
 * row. No schema change, and it survives a deploy — in-memory state would not, and at ~15 deploys a
 * day it would reset before a multi-tick pass could finish.
 *
 * WHAT MAKES IT SAFE, AND THE PRECONDITION THAT CLAIM RESTS ON. One writer per PROCESS:
 * `lib/ingest/single-flight` stops the tick overlapping itself. That is sufficient here because this
 * deployment runs ONE app replica — `instrumentation.register()` starts a scheduler in every Node
 * process, and the single-flight flag is a closure-local boolean, so at two or more replicas two
 * processes would race this cursor and the guarantee below evaporates. That is not a new limitation
 * introduced here (README §"Background schedulers" already states the in-process-only assumption for
 * every poller), but it IS load-bearing for the cursor specifically, so it is named rather than
 * assumed. If this service is ever scaled out, this cursor needs a real lease or CAS — and so do the
 * other schedulers. `recordIngestRun` is append-only and best-effort with no compare-and-swap, so with
 * concurrent ticks two passes could read the same cursor and race their writes, and a stale pass
 * finishing after a drain could resurrect a superseded cursor. Single-flight is a PREREQUISITE here,
 * not an optimisation. (`lib/graph/extraction-alert` also keeps durable state in `ingest_runs.meta`,
 * but it is a low-frequency transition ledger — that precedent establishes the location is
 * acceptable, nothing more.)
 */

export const CONTEXT_BACKFILL_SOURCE = "context_backfill";

export interface TeamBackfillState {
  teamId: string;
  /** Resume point, or null when the last pass drained the corpus (or nothing is recorded yet). */
  cursor: string | null;
  /** `finished_at` of the newest scheduler run for this team — the rotation clock. Null = never served. */
  lastServedAt: string | null;
}

type RunRow = { finished_at: string | null; meta: unknown };

function cursorFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const c = (meta as { cursor?: unknown }).cursor;
  return typeof c === "string" && c.length > 0 ? c : null;
}

/**
 * Read one team's resume cursor and rotation clock from its newest scheduler `context_backfill` row.
 *
 * `finished_at desc, id desc` — the tie-break is load-bearing, not decoration. Rows can share a
 * timestamp (`lib/ingest/pipeline-health` had to learn the same lesson), and without the second key
 * the resume point is arbitrary between same-millisecond rows.
 *
 * `trigger='scheduler'` only. Today neither the admin "backfill now" action
 * (`app/t/[team]/admin/access/actions.ts`) nor `drainTeamContext` records an `ingest_runs` row at all
 * — verified, after an earlier version of this comment claimed they did — so there is no pollution to
 * filter yet. The filter is kept because it costs nothing and because the moment either one starts
 * recording, an unfiltered read would resume the scheduler from somebody else's position.
 *
 * Best-effort by design — a read failure yields a null cursor, which restarts the sweep from the top.
 * That is wasteful but always CORRECT (the reconcile is idempotent); the opposite bias, guessing a
 * cursor, would skip items.
 */
export async function readTeamBackfillState(db: DbClient, teamId: string): Promise<TeamBackfillState> {
  const { data, error } = await db
    .from("ingest_runs")
    .select("finished_at, meta")
    .eq("team_id", teamId)
    .eq("source", CONTEXT_BACKFILL_SOURCE)
    .eq("trigger", "scheduler")
    .order("finished_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);
  if (error) return { teamId, cursor: null, lastServedAt: null };
  const row = ((data ?? []) as RunRow[])[0];
  if (!row) return { teamId, cursor: null, lastServedAt: null };
  return { teamId, cursor: cursorFromMeta(row.meta), lastServedAt: row.finished_at ?? null };
}

/**
 * Service order: least-recently-served team first, never-served teams before everyone.
 *
 * PURE, so the ordering rule is unit-testable without a database — the property it guarantees (no
 * team can be starved by a team ahead of it) is invisible on single-team prod and would otherwise
 * only ever be checked by inspection.
 *
 * A team that FAILED still updates its clock, because the stage records a row for every served turn
 * whatever the outcome. That is what stops a permanently-failing team from monopolising the budget —
 * it goes to the back of the queue like anyone else.
 *
 * Ties break by `teamId` so the order is total and deterministic; two teams with identical clocks
 * must not swap places between passes, or "served within N passes" stops being provable.
 */
export function orderByRotation(states: readonly TeamBackfillState[]): TeamBackfillState[] {
  return [...states].sort((a, b) => {
    if (a.lastServedAt === b.lastServedAt) return a.teamId.localeCompare(b.teamId);
    if (a.lastServedAt === null) return -1; // never served → front of the queue
    if (b.lastServedAt === null) return 1;
    return a.lastServedAt < b.lastServedAt ? -1 : 1;
  });
}
