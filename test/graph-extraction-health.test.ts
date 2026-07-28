import { describe, it, expect } from "vitest";
import {
  deriveGraphExtractionStalled,
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
