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
    expect(deriveGraphExtractionStalled(1243, 0)).toBe(true);
    expect(deriveGraphExtractionStalled(N, 0)).toBe(true);
  });

  it("healthy: episodes projected AND facts exist — the extractor is working", () => {
    expect(deriveGraphExtractionStalled(1243, 400)).toBe(false);
    expect(deriveGraphExtractionStalled(N, 1)).toBe(false);
  });

  it("not flagged below the threshold — a fresh install may still be mid-first-extraction", () => {
    // Too few episodes to distinguish "broken" from "Graphiti still processing the first batch".
    expect(deriveGraphExtractionStalled(N - 1, 0)).toBe(false);
    expect(deriveGraphExtractionStalled(5, 0)).toBe(false);
  });

  it("nothing projected yet ⇒ not stalled (zero-vs-zero is a fresh graph, not a failure)", () => {
    expect(deriveGraphExtractionStalled(0, 0)).toBe(false);
  });

  it("unknown facts (Neo4j unreadable) ⇒ not stalled — reachability is a different leg's concern", () => {
    expect(deriveGraphExtractionStalled(1243, null)).toBe(false);
  });

  it("unknown episodes (ledger unreadable) ⇒ not stalled — can't tell", () => {
    expect(deriveGraphExtractionStalled(null, 0)).toBe(false);
    expect(deriveGraphExtractionStalled(null, null)).toBe(false);
  });
});
