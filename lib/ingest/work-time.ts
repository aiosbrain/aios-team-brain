/**
 * THE canonical "when did this work actually happen" resolver — one definition shared by every
 * surface that orders, buckets, or narrates work.
 *
 * Why this module exists: work-time was defined in two places that disagreed. The timeline read a
 * list of frontmatter keys; the graph projector read `frontmatter.source_ts` ALONE. So a git commit
 * (which carries `committed_at`, not `source_ts`) was correctly dated on the timeline but stamped
 * with `synced_at` in the graph — linking a year-old repo made months-old commits narrate as this
 * week's storyline, and the two surfaces disagreed about the same work. Worse, the key list had
 * grown to include names NO connector emits (`last_edited_time`, `modifiedTime`, …), so every
 * document source that relied on them resolved to null and was silently DROPPED from the timeline.
 *
 * Two rules follow from that history:
 *  1. There is exactly one key list and one parser — here. Callers choose only what to do with a
 *     null (the timeline drops the item; the projector falls back to `synced_at`).
 *  2. Key matching is SPELLING-TOLERANT. Frontmatter arrives from sources we do not control (the
 *     LlamaHub readers alone spell it `last_edited_time`, `modifiedTime`, and `modified at`), and a
 *     generic/MCP connector may spell it any way at all. Matching on a normalized form means a new
 *     source plugs in without another hardcoded alias — the alternative is one silent drop per source.
 *
 * `synced_at` is deliberately NOT a work-time: it is bumped on every re-scan, so using it would
 * resurface old content as "today's work" (the mtime/re-sync class of bug).
 *
 * SCOPE: this is the resolver for an ITEM's work-time (timeline + graph projector). `lib/meetings/
 * from-items` keeps its own, deliberately different order (creation before `source_ts`) because a
 * meeting is dated by when it OCCURRED, not when its notes were last touched.
 */

/**
 * Canonical work-time keys in PRIORITY order, as normalized forms (see `normalizeKey`).
 * Ordering encodes intent: an explicit source timestamp beats an edit time, which beats a creation
 * time — "when the work happened", not "when the record first existed".
 */
const WORK_TIME_KEYS_NORMALIZED: readonly string[] = [
  // Explicit "when it happened" signals from a source that knows.
  "committedat", // git commit time (commits-to-items)
  "sourcets", // the contract's explicit work-time (Slack, sidecar docs)
  "occurredat", // events / meetings
  // Edit time — the work-shaped signal for documents.
  "lasteditedtime", // Notion
  "lastmodifiedtime",
  "lastmodified",
  "modifiedtime", // Google Drive (also spelled "modified at" → "modifiedat")
  "modifiedat",
  "modified",
  "updatedat",
  "updated",
  // Weakest: creation / nominal date. A doc that was never edited still happened when it was made.
  "date",
  "createdtime",
  "createdat",
  "created",
  "timestamp",
];

/**
 * The exact spellings our OWN producers emit, in the same priority order — checked as direct
 * property lookups before the normalized fallback so the common case allocates nothing.
 * MUST stay a subset of (and ordered consistently with) `WORK_TIME_KEYS_NORMALIZED`; the unit test
 * pins that relationship.
 */
const COMMON_WORK_TIME_KEYS = ["committed_at", "source_ts", "occurred_at"] as const;

/** Lowercase + drop every non-alphanumeric char, so `last_edited_time` / `lastEditedTime` /
 *  `"Last Edited Time"` / `modified at` all collapse to one comparable token. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Parse a frontmatter value into an ISO instant, or null. Strings only: a bare number is ambiguous
 * (epoch seconds vs milliseconds vs a year) and guessing wrong silently mis-dates work, which is the
 * exact failure class this module exists to prevent — a source with an epoch must normalize it.
 *
 * NOTE: locale-ambiguous strings ("09/07/2026") still parse — wrongly — under JS `Date`; we cannot
 * disambiguate DD/MM here, so connectors must emit ISO-8601.
 */
function parseInstant(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * The keys of `fm` that PARTICIPATE in work-time resolution — its actual spellings, not the
 * canonical forms. Exported so the writer can act on a per-source rule about work-time (see
 * `lib/ingest/source-rules`) without re-deriving which keys those are: a second list would drift
 * from this one, and the drift would be silent in exactly the way the H2 vacuous-key-list bug was.
 * Pure.
 */
export function workTimeKeysIn(fm: Record<string, unknown> | null | undefined): string[] {
  if (!fm) return [];
  const canonical = new Set(WORK_TIME_KEYS_NORMALIZED);
  return Object.keys(fm).filter((key) => canonical.has(normalizeKey(key)));
}

/**
 * The work-time of an item, from its frontmatter — the highest-priority present-and-parseable
 * key, ISO-normalized. Null when the source gave us nothing usable, which callers must handle
 * explicitly (drop vs fall back) rather than silently defaulting to now()/sync-time. Pure.
 */
export function resolveWorkTime(fm: Record<string, unknown> | null | undefined): string | null {
  if (!fm) return null;

  // FAST PATH: the spellings our own connectors actually emit, as direct property lookups. This runs
  // for every item of every timeline/projection build, so it must not allocate — the exact-spelling
  // hit covers essentially all real payloads.
  for (const key of COMMON_WORK_TIME_KEYS) {
    const parsed = parseInstant(fm[key]);
    if (parsed) return parsed;
  }

  // SLOW PATH: only for a source spelling it some other way. Index the item's keys by normalized
  // form, then walk the canonical list in priority order.
  const byNormalized = new Map<string, unknown>();
  for (const [key, value] of Object.entries(fm)) {
    const norm = normalizeKey(key);
    // First spelling wins if a payload somehow carries two spellings of the same concept.
    if (!byNormalized.has(norm)) byNormalized.set(norm, value);
  }
  for (const canonical of WORK_TIME_KEYS_NORMALIZED) {
    const parsed = parseInstant(byNormalized.get(canonical));
    if (parsed) return parsed;
  }
  return null;
}

/** What gets STORED on the item: the work-time plus whether the source actually told us (R1). */
export interface PersistedWorkTime {
  /** Never null and never `synced_at` — the source's own timestamp, else `firstSeenAt`. */
  workAt: string;
  /** False when we fell back. The timeline drops those; the projector accepts them. */
  fromSource: boolean;
}

/**
 * Resolve the work-time to STORE on an item (`items.work_at` / `work_at_from_source`).
 *
 * The fallback is deliberately `firstSeenAt` (`items.created_at`, set once on insert) and never
 * `synced_at`: every connector re-pushes every item on each 30-minute tick, so a `synced_at` fallback
 * ages forward and re-dates old work as today — the R1 bug class this column exists to end.
 *
 * Callers persist the pair rather than re-deriving, so a SQL window or ORDER BY gets the same answer as
 * a TS caller. Pure.
 */
export function resolvePersistedWorkTime(
  fm: Record<string, unknown> | null | undefined,
  firstSeenAt: string
): PersistedWorkTime {
  const fromSource = resolveWorkTime(fm);
  return fromSource ? { workAt: fromSource, fromSource: true } : { workAt: firstSeenAt, fromSource: false };
}
