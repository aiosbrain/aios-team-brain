/**
 * The scheduler's wall-clock budget for the context-backfill stage (TICKSTALL-1,
 * `docs/design/tick-stall-backfill-budget.md` §Decision 1).
 *
 * WHY A BUDGET. The ingest tick is one sequential `await` chain. `runContextBackfill` was measured on
 * prod at **57-60 minutes** against a 30-minute interval, and every stage sequenced after it — the
 * auto-flip, meeting-notes extraction, task-evidence linking, doc-task inference, dense indexing and
 * the graph-health alarm — recorded NOTHING for hours at a stretch. Six such outages in 14 days.
 *
 * The stage is safe to cut short because the backfill is cursor-paged and idempotent: a truncated
 * pass commits every batch it finished and resumes from a stored cursor next tick.
 *
 * ONE PARSE SITE. `contextBackfillBudgetMs` is the only place `CONTEXT_BACKFILL_BUDGET_MS` is read,
 * guarded by `test/guards/context-backfill-budget-single-parse`. A second local parse is how two
 * components come to silently disagree about a budget — the `PRET_FLIP_MAX_PER_TICK` precedent.
 */

/** 5 minutes: ~1/6 of a 30-minute tick, leaving the rest of the chain room to finish every time. */
export const DEFAULT_CONTEXT_BACKFILL_BUDGET_MS = 5 * 60 * 1000;

/**
 * Wall-clock budget for one backfill stage, from `CONTEXT_BACKFILL_BUDGET_MS`.
 *
 * A non-numeric, negative or zero value falls back to the default rather than disabling the sweep:
 * `0` would be indistinguishable from "budget already expired", and while the caller guarantees one
 * batch per team-turn regardless, a silently-zero budget would still reduce the sweep to a crawl for
 * a reason nobody could see. Fail to the documented default, loudly typed.
 */
export function contextBackfillBudgetMs(): number {
  const raw = Number(process.env.CONTEXT_BACKFILL_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONTEXT_BACKFILL_BUDGET_MS;
}

/**
 * Has the stage's budget run out? Checked AFTER each batch, never before — the caller must always
 * make at least one batch of progress per team-turn, or a mis-set budget (or a clock jump) would
 * halt the sweep forever at zero progress, which is a stall wearing a budget's clothes.
 */
export function budgetExpired(startedAtMs: number, nowMs: number, budgetMs: number): boolean {
  return nowMs - startedAtMs >= budgetMs;
}
