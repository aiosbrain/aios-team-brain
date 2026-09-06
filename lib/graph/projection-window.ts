/**
 * STGENV-3 — the projection precondition. Spec: `docs/design/staging-bounded-projection.md`.
 *
 * WHY THIS EXISTS. STAGING-1's refresh empties `graph_episodes` on staging, so every restored item
 * looks unprojected. The day `GRAPHITI_URL` is set there, the first tick bills fresh entity extraction
 * for the whole corpus — measured ~$190, 95% of the LLM bill. That hazard was recorded in prose and
 * left unguarded. This turns it into a REFUSAL.
 *
 * PURE ON PURPOSE. Every input is a parameter — including the clock — so the decision is unit-testable
 * without a database, and so the FLOOR IS PER-RUN. An absolute floor read from config would grow with
 * every staging refresh (a floor set in September re-extracts September→now in October, then
 * September→November) while satisfying "a window is configured" the whole time.
 */

/** Refusal reasons. Each is distinct so a caller can discriminate without parsing prose. */
export type RefusalReason =
  | "staging-window-unset"
  | "invalid-window"
  | "staging-state-unknown"
  /** Decided per-team against stored fan-out state (D3e); not produced by this function. */
  | "window-with-fanout"
  /** D3e's detector could not answer. DISTINCT from `window-with-fanout` on purpose: the durable
   *  discriminator in `ingest_runs.meta.refused` has to tell "an initiative exists, unset the window"
   *  apart from "the read failed", or the operator is sent to fix the wrong thing. */
  | "fanout-state-unknown";

export type MarkerRead = { ok: true; marker: boolean } | { ok: false; error: string };

export type ProjectionPrecondition =
  | { proceed: true; workAtFloor?: string }
  | { proceed: false; refused: RefusalReason; error: string };

export type WindowParse =
  | { kind: "unset" }
  | { kind: "days"; days: number }
  | { kind: "invalid" };

export const WINDOW_ENV = "GRAPH_PROJECT_WINDOW_DAYS";

/**
 * A TRIMMED-EMPTY value is UNSET, not invalid — and that distinction is load-bearing.
 * Railway and `.env` both render an unset variable as `""`. If `""` were "invalid", a production
 * instance holding a blank `GRAPH_PROJECT_WINDOW_DAYS=` would refuse EVERY run, while the tests stayed
 * green because the unbounded-production fixture would naturally use `undefined`.
 *
 * Everything else that is not a positive integer is INVALID and refuses. It never falls back to
 * unbounded: a bad value must not silently become "no bound", which is the trap re-arming itself.
 * A PLAIN DECIMAL DIGIT STRING is required, not merely "something `Number()` likes". `parseInt("7d")`
 * is 7, and `Number("1e3")` is 1000 — an integer, positive, and accepted by the obvious implementation
 * as a 1000-day window. The spec-derived test caught that. A window is a spending decision an operator
 * types on purpose, so the value stored in Railway must read as what it means: `1000` is a legitimate
 * deliberate choice, `1e3` is almost certainly a mistake, and there is no reason for the two to be the
 * same input. This also rejects `+7`, `7.0`, `0x1e`, `Infinity`.
 *
 * There is deliberately NO UPPER BOUND. A large window is the operator explicitly choosing a large
 * spend, which is the whole point of making them type it; a cap would be a second silent decision.
 */
export function parseWindowDays(raw: string | undefined): WindowParse {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { kind: "unset" };
  if (!/^\d+$/.test(trimmed)) return { kind: "invalid" };
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n <= 0) return { kind: "invalid" };
  return { kind: "days", days: n };
}

const DAY_MS = 86_400_000;

export function projectionPrecondition(args: {
  marker: MarkerRead;
  window: string | undefined;
  /** The run's clock, passed in. See the per-run note above. */
  now: Date;
}): ProjectionPrecondition {
  const parsed = parseWindowDays(args.window);

  // FAIL CLOSED, and FIRST. A failed detector cannot establish that this is production, and failing
  // open would defeat the guard entirely. The cost is stated honestly in the spec: a persistently
  // failing read refuses every run, not one tick.
  if (!args.marker.ok) {
    return {
      proceed: false,
      refused: "staging-state-unknown",
      // Deliberately does NOT name the window variable. A production admin hitting "Project to graph"
      // during a database blip must not be told to configure a staging-only knob.
      error: `graph projection refused: could not determine whether this database is staging (reading staging_marker failed: ${args.marker.error})`,
    };
  }

  if (parsed.kind === "invalid") {
    return {
      proceed: false,
      refused: "invalid-window",
      error: `graph projection refused: ${WINDOW_ENV} must be a positive whole number of days, got ${JSON.stringify(args.window)}`,
    };
  }

  if (parsed.kind === "unset") {
    if (!args.marker.marker) return { proceed: true }; // production: unbounded, unchanged
    return {
      proceed: false,
      refused: "staging-window-unset",
      error:
        `graph projection refused: this database carries staging_marker and ${WINDOW_ENV} is not set. ` +
        `An unbounded projection here would extract the whole restored corpus. Set ${WINDOW_ENV} to the ` +
        `number of days of work history to project (there is deliberately no default — the amount is a ` +
        `spending decision).`,
    };
  }

  // Bounded — on EITHER environment. A variable that silently does nothing on one of them is the
  // class this repo keeps recording.
  return { proceed: true, workAtFloor: new Date(args.now.getTime() - parsed.days * DAY_MS).toISOString() };
}

/**
 * Is this item HELD by the window? Pure, so the decision that spends money is unit-testable.
 *
 * DELIBERATELY NOT `pickEpisodeTimestamp`. That helper falls back to `synced_at` when `work_at` is
 * absent, which is correct for dating an episode and exactly wrong here: `synced_at` is re-dated by
 * every sync tick, so the fallback would quietly admit an item on the axis this whole slice exists to
 * move off. `work_at` is `NOT NULL` in the schema, so the absent case is theoretical — and when a
 * theoretical case does occur it resolves toward HOLD, the direction that cannot spend money by
 * accident. An operator can always widen the window; nobody can un-bill an extraction.
 */
export function heldByWindow(
  item: { work_at?: string | Date | null },
  workAtFloor: string | undefined
): boolean {
  if (!workAtFloor) return false;
  const raw = item.work_at;
  if (raw === null || raw === undefined) return true;
  const d = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(d.getTime())) return true;
  return d.toISOString() < workAtFloor;
}
