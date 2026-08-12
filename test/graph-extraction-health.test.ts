import { describe, it, expect } from "vitest";
import {
  deriveGraphExtractionStalled,
  parseProbeTimestamp,
  EXTRACTION_LAG_BUDGET_MS,
  MIN_EPISODES_FOR_EXTRACTION_SIGNAL,
} from "@/lib/graph/extraction-health";

/**
 * The exact prod failure (2026-07): the projector POSTs episodes, Graphiti returns 202 and records
 * graph_project=OK, then its extractor fails every job ("Output length exceeded max tokens 8192") so
 * NO facts get created. `graph_project` stays green, /healthcheck stays green — the only observable
 * signal is "many episodes projected, zero facts extracted". This is that spec.
 */
describe("deriveGraphExtractionStalled", () => {
  const N = MIN_EPISODES_FOR_EXTRACTION_SIGNAL;

  it("STALLED: a real backlog of projected episodes but zero extracted facts (the live bug)", () => {
    expect(deriveGraphExtractionStalled({ episodes: 1243, facts: 0 })).toBe(true);
    expect(deriveGraphExtractionStalled({ episodes: N, facts: 0 })).toBe(true);
  });

  it("healthy: episodes projected AND facts exist — the extractor is working", () => {
    expect(deriveGraphExtractionStalled({ episodes: 1243, facts: 400 })).toBe(false);
    expect(deriveGraphExtractionStalled({ episodes: N, facts: 1 })).toBe(false);
  });

  it("not flagged below the threshold — a fresh install may still be mid-first-extraction", () => {
    // Too few episodes to distinguish "broken" from "Graphiti still processing the first batch".
    expect(deriveGraphExtractionStalled({ episodes: N - 1, facts: 0 })).toBe(false);
    expect(deriveGraphExtractionStalled({ episodes: 5, facts: 0 })).toBe(false);
  });

  it("nothing projected yet ⇒ not stalled (zero-vs-zero is a fresh graph, not a failure)", () => {
    expect(deriveGraphExtractionStalled({ episodes: 0, facts: 0 })).toBe(false);
  });

  it("unknown facts (Neo4j unreadable) ⇒ not stalled — reachability is a different leg's concern", () => {
    expect(deriveGraphExtractionStalled({ episodes: 1243, facts: null })).toBe(false);
  });

  it("unknown episodes (ledger unreadable) ⇒ not stalled — can't tell", () => {
    expect(deriveGraphExtractionStalled({ episodes: null, facts: 0 })).toBe(false);
    expect(deriveGraphExtractionStalled({ episodes: null, facts: null })).toBe(false);
  });
});

/**
 * The SECOND prod failure (2026-07-28), which the spec above could not see.
 *
 * Graphiti's extraction key hit `insufficient_quota`. Every episode failed extraction — but the
 * graph already held ~weeks of facts from before the key ran dry, so `facts === 0` was false and
 * the probe stayed silent. Admin → Integrations showed the graph leg **green** while extraction had
 * been dead for hours; it was found by reading the service logs, not the dashboard.
 *
 * The bug in the detector is a category error: it asks "did extraction EVER work?" when the question
 * an operator needs answered is "is extraction working NOW?". A non-zero historical fact count
 * answers the first question forever, so the check disarms itself the moment it has ever succeeded.
 *
 * The signal that separates them is RECENCY: episodes keep landing while no new fact appears.
 */
describe("deriveGraphExtractionStalled — extraction that STOPPED, not extraction that never started", () => {
  const N = MIN_EPISODES_FOR_EXTRACTION_SIGNAL;
  const HOUR = 3_600_000;
  const now = Date.parse("2026-07-28T12:00:00Z");
  const at = (hoursAgo: number) => now - hoursAgo * HOUR;

  it("STALLED: episodes still arriving, newest fact far older than the newest episode", () => {
    // The live case. 400 historical facts is exactly what kept the old check quiet.
    expect(
      deriveGraphExtractionStalled({
        episodes: 1243,
        facts: 400,
        newestEpisodeAtMs: at(0.2),
        newestFactAtMs: at(30),
      })
    ).toBe(true);
  });

  it("healthy: facts trailing episodes by less than the lag budget", () => {
    // Extraction is serial and ~10-20s per episode, so facts ALWAYS trail. A small gap is normal
    // and must not page anyone.
    expect(
      deriveGraphExtractionStalled({
        episodes: 1243,
        facts: 400,
        newestEpisodeAtMs: at(0),
        newestFactAtMs: at(1),
      })
    ).toBe(false);
  });

  it("healthy: a QUIET period — both are old together", () => {
    // Nothing was projected for a week, so of course no facts appeared. Measuring fact age against
    // `now` instead of against the newest EPISODE would cry stall on every quiet team.
    expect(
      deriveGraphExtractionStalled({
        episodes: 1243,
        facts: 400,
        newestEpisodeAtMs: at(200),
        newestFactAtMs: at(201),
      })
    ).toBe(false);
  });

  it("still catches the ORIGINAL failure — zero facts, whatever the timestamps say", () => {
    expect(
      deriveGraphExtractionStalled({ episodes: 1243, facts: 0, newestEpisodeAtMs: at(0), newestFactAtMs: null })
    ).toBe(true);
    expect(deriveGraphExtractionStalled({ episodes: N, facts: 0 })).toBe(true);
  });

  it("cannot tell: a missing timestamp is never evidence of a stall", () => {
    // Neo4j unreadable, or an older Graphiti that didn't stamp created_at. "Don't know" is not "broken".
    expect(
      deriveGraphExtractionStalled({ episodes: 1243, facts: 400, newestEpisodeAtMs: at(0), newestFactAtMs: null })
    ).toBe(false);
    expect(
      deriveGraphExtractionStalled({ episodes: 1243, facts: 400, newestEpisodeAtMs: null, newestFactAtMs: at(30) })
    ).toBe(false);
  });

  it("respects the episode threshold for the recency check too", () => {
    // A handful of episodes on a fresh install can legitimately lag; don't flag what we can't judge.
    expect(
      deriveGraphExtractionStalled({ episodes: 3, facts: 1, newestEpisodeAtMs: at(0), newestFactAtMs: at(50) })
    ).toBe(false);
  });
});

/**
 * The parsing seam. Two producers, no compiler between them: Postgres `timestamptz::text` and Neo4j
 * `toString(datetime)`. If either format shifts, the recency check disarms itself silently while every
 * other test here stays green — the exact class of bug this file was rewritten to fix. So the real
 * wire formats are pinned rather than assumed.
 */
describe("parseProbeTimestamp — the formats the two probes actually emit", () => {
  it("parses Postgres timestamptz::text, with any offset", () => {
    expect(parseProbeTimestamp("2026-07-28 12:34:56.789+00")).toBe(Date.parse("2026-07-28T12:34:56.789Z"));
    expect(parseProbeTimestamp("2026-07-28 05:34:56.789-07")).toBe(Date.parse("2026-07-28T12:34:56.789Z"));
    expect(parseProbeTimestamp("2026-07-28 18:04:56.789+05:30")).toBe(Date.parse("2026-07-28T12:34:56.789Z"));
  });

  it("parses Neo4j toString(datetime), including nanosecond precision", () => {
    expect(parseProbeTimestamp("2026-07-28T12:34:56.789000000Z")).toBe(Date.parse("2026-07-28T12:34:56.789Z"));
    expect(parseProbeTimestamp("2026-07-28T12:34:56.789+00:00")).toBe(Date.parse("2026-07-28T12:34:56.789Z"));
  });

  it("returns null — never NaN — for absent or unparseable input", () => {
    // A bracketed named zone is the realistic future break (a Neo4j upgrade could emit it); it must
    // read as "don't know", which disarms the check, not as a bogus epoch that fabricates a stall.
    expect(parseProbeTimestamp("2026-07-28T12:34:56+01:00[Europe/London]")).toBeNull();
    expect(parseProbeTimestamp(null)).toBeNull();
    expect(parseProbeTimestamp(undefined)).toBeNull();
    expect(parseProbeTimestamp("")).toBeNull();
    expect(parseProbeTimestamp("not a date")).toBeNull();
  });
});

describe("the lag budget boundary", () => {
  const base = { episodes: 1243, facts: 400, newestEpisodeAtMs: 1_000_000_000_000 };
  it("is exclusive: exactly at budget is healthy, one ms past is stalled", () => {
    expect(
      deriveGraphExtractionStalled({ ...base, newestFactAtMs: base.newestEpisodeAtMs - EXTRACTION_LAG_BUDGET_MS })
    ).toBe(false);
    expect(
      deriveGraphExtractionStalled({ ...base, newestFactAtMs: base.newestEpisodeAtMs - EXTRACTION_LAG_BUDGET_MS - 1 })
    ).toBe(true);
  });

  it("a fact NEWER than the newest episode is healthy, not negative-lag nonsense", () => {
    expect(deriveGraphExtractionStalled({ ...base, newestFactAtMs: base.newestEpisodeAtMs + 60_000 })).toBe(false);
  });
});

/**
 * LIVENESS vs NOVELTY (STALLPROBE-1 / AIO-876).
 *
 * The lag half of the probe answers "when did the graph last learn something NEW?" and was being read
 * as "when did the extractor last RUN?". On a mature graph those diverge — prod runs ~6.1
 * `dedupe_edges` per `extract_edges`, so most extracted edges resolve onto an existing edge and create
 * no `RELATES_TO`, freezing `max(created_at)` while extraction works perfectly. On 2026-08-12 that
 * produced "accepting episodes but extracting 0 facts" one minute after a clean pipeline run, beside
 * a census reporting 2,928 NEW entities.
 *
 * The fix asks the extractor's OWN ledger (`llm_usage`, source='graph') whether it ran. These pin both
 * directions: the false positive must go, and the 2026-07-28 quota outage must stay loud.
 */
describe("deriveGraphExtractionStalled — liveness overrides novelty", () => {
  const N = MIN_EPISODES_FOR_EXTRACTION_SIGNAL;
  const EPISODE_AT = Date.parse("2026-08-12T00:15:02Z");
  /** Facts frozen well past the budget — the condition that used to be sufficient to accuse. */
  const LAGGING = {
    episodes: N * 10,
    facts: 113_352,
    newestEpisodeAtMs: EPISODE_AT,
    newestFactAtMs: EPISODE_AT - (EXTRACTION_LAG_BUDGET_MS + 3_600_000),
  };

  it("is NOT stalled when the ledger shows a successful call after the newest episode", () => {
    // The reported false positive, in the shape it actually occurred: extraction completed 60s after
    // the episode was projected, and every new edge deduplicated.
    expect(
      deriveGraphExtractionStalled({
        ...LAGGING,
        extractor: { readable: true, newestAtMs: EPISODE_AT + 60_000 },
      })
    ).toBe(false);
  });

  it("IS stalled when the ledger shows NO call since the newest episode — the 2026-07-28 outage", () => {
    // The direction that must not be weakened: a dead extractor writes no llm_usage rows either, so
    // lag + silence is the real signal. Without this the fix would be a blanket alarm-suppressor.
    expect(
      deriveGraphExtractionStalled({
        ...LAGGING,
        extractor: { readable: true, newestAtMs: EPISODE_AT - 48 * 3_600_000 },
      })
    ).toBe(true);
  });

  it("IS stalled when the ledger is readable and EMPTY — no activity at all", () => {
    expect(deriveGraphExtractionStalled({ ...LAGGING, extractor: { readable: true, newestAtMs: null } })).toBe(true);
  });

  it("an UNREADABLE ledger never manufactures a stall — ignorance is not evidence", () => {
    // `readable:false` is a failed query, which is not the same fact as "the extractor did nothing".
    expect(deriveGraphExtractionStalled({ ...LAGGING, extractor: { readable: false, newestAtMs: null } })).toBe(false);
  });

  it("zero facts outranks liveness — a running extractor producing nothing is still broken", () => {
    // The never-extracted case must not be suppressible by ledger activity, or a busy-but-useless
    // extractor would read healthy.
    expect(
      deriveGraphExtractionStalled({
        episodes: N * 10,
        facts: 0,
        newestEpisodeAtMs: EPISODE_AT,
        newestFactAtMs: null,
        extractor: { readable: true, newestAtMs: EPISODE_AT + 60_000 },
      })
    ).toBe(true);
  });

  it("with NO ledger supplied, the verdict falls back to fact-lag alone (pre-fix behaviour)", () => {
    // The back-compat control: existing callers/tests that pass no `extractor` must be unaffected,
    // otherwise this change would silently disarm the lag check everywhere it isn't wired.
    expect(deriveGraphExtractionStalled(LAGGING)).toBe(true);
  });

  it("healthy lag is still healthy regardless of the ledger", () => {
    // The other control: liveness must not be able to CREATE a stall on a graph that is keeping up.
    const fresh = { ...LAGGING, newestFactAtMs: EPISODE_AT - 60_000 };
    expect(deriveGraphExtractionStalled({ ...fresh, extractor: { readable: true, newestAtMs: null } })).toBe(false);
  });
});
