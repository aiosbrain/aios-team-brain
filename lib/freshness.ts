/**
 * The freshness envelope — how old a payload is, and whether it can be trusted.
 *
 * Pass-1 review R2 ("silent-degrade-by-default") / M6. Several surfaces are served
 * stale-while-revalidate out of a cache table, so "when was this computed" is a real fact the data
 * layer knows and the wire had no way to say. Routes filled the gap with `as_of: new Date()` — which is
 * not a missing contract but a FALSE one: a 4-hour-old arc set stamped as current.
 *
 * Lives at `lib/` rather than `lib/api/` deliberately. It is produced by the DATA layer (the module that
 * knows when the row was written) and only rendered by the API layer, so putting it under `lib/api`
 * would make `lib/dashboard` and `lib/graph` import the API layer to describe their own results. Same
 * lowest-shared-layer rule the caches themselves follow.
 *
 * The envelope is deliberately NOT a wrapper around the payload. Wrapping would force every caller,
 * component, and test to unwrap; returning it alongside (`{ days, freshness }`) keeps the payload's own
 * shape — and its shape guards — untouched.
 */

/** Epoch-ms + two booleans; no strings, so a consumer can't accidentally render a lie. */
export interface Freshness {
  /**
   * When the payload was ACTUALLY computed (epoch ms) — the cache row's `computed_at`, not the time it
   * was served. This is the field the lie was in.
   */
  computedAt: number;
  /**
   * Past its TTL and served anyway (stale-while-revalidate), with a refresh usually in flight. Not an
   * error: the payload is real, just old. A consumer that needs current data should re-poll rather than
   * treat this as a failure.
   */
  stale: boolean;
  /**
   * A leg **this request's computation** depended on failed, so the payload is plausible but incomplete or
   * wrong — the case that silently reads as a healthy-but-quiet result. Distinct from `stale`: a degraded
   * payload can be freshly computed, and a stale one can be perfectly trustworthy.
   *
   * SCOPE, precisely: it describes the computation that ran on THIS request, not the payload's permanent
   * character, because it is not persisted with the cache row. A request that cold-misses and degrades
   * reports `degraded: true`; the next request, served the row that computation wrote, reports `false` for
   * the same bytes. Fixing that means a `degraded` column on `arc_cache`/`work_timeline_cache` — worth
   * doing (it would also let `computed_at` stop doubling as a trust dial, which is why `writeArcCache`
   * backdates today) and deliberately not bundled here. Until then, read `degraded: true` as "the work
   * done for this response was unreliable", and never `degraded: false` as "this payload is verified good".
   */
  degraded: boolean;
}

/**
 * Build an envelope for a payload computed at `computedAt`, given the TTL that defines staleness.
 *
 * `stale` is DERIVED here rather than passed in so the age→stale rule can't be spelled differently by
 * each caller — the drift shape that made "is this task active" five different predicates (H6).
 */
export function freshness(
  computedAt: number,
  ttlMs: number,
  opts: { now?: number; degraded?: boolean } = {}
): Freshness {
  const now = opts.now ?? Date.now();
  // A non-finite `computed_at` (an unparseable row) is treated as INFINITELY old rather than as `now`.
  // The alternative — defaulting to now — would report a row we can't date as fresh, which is the exact
  // class of lie this module exists to remove.
  const at = Number.isFinite(computedAt) ? computedAt : 0;
  return { computedAt: at, stale: now - at >= ttlMs, degraded: opts.degraded === true };
}

/** An envelope for something computed right now, inline, with nothing cached behind it. */
export function computedNow(opts: { now?: number; degraded?: boolean } = {}): Freshness {
  return { computedAt: opts.now ?? Date.now(), stale: false, degraded: opts.degraded === true };
}

/**
 * The wire rendering: `{ as_of, stale, degraded }`.
 *
 * `as_of` keeps the key the routes already publish. Renaming it to `computed_at` would be gratuitous
 * churn on a contract whose VALUE — not whose name — was wrong, and would break any consumer that reads
 * it today. Every other wire field in this codebase is snake_case, so `stale`/`degraded` fit as-is.
 *
 * Note there is no reason/detail string here, by design: `degraded` names THAT a payload is untrustworthy
 * without naming which internal subsystem failed. Diagnostic prose (LLM base URLs, model slugs, provider
 * error bodies) is team-internal and is redacted per-route for `external` tier — see the `note` handling
 * in `app/api/brain/arcs/route.ts`. Keeping this serializer detail-free means adding the envelope to a
 * route can never introduce a tier leak.
 */
export function freshnessWire(f: Freshness): { as_of: string; stale: boolean; degraded: boolean } {
  return { as_of: new Date(f.computedAt).toISOString(), stale: f.stale, degraded: f.degraded };
}
