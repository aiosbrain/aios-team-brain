import { describe, expect, it } from "vitest";
import { scoreArc, arcEvidence } from "@/lib/social/discover-arcs";
import { evidenceCeiling } from "@/lib/social/tier";
import type { NarrativeArc } from "@/lib/graph/arcs";

/**
 * Spec for the pure bits of arc → opportunity discovery: confidence/recency scoring, evidence
 * mapping, and the tier ceiling that keeps an internally-sourced arc from becoming a public post.
 */

const NOW = Date.parse("2026-07-10T00:00:00.000Z");

function arc(over: Partial<NarrativeArc> = {}): NarrativeArc {
  return {
    id: "arc-abc123",
    title: "Context-Management Enhancements",
    confidence: "high",
    summary: "The team is hardening context management.",
    participants: ["Chetan Nandakumar"],
    supporting_sources: [],
    evidence: [{ fact: "f1", itemId: "item-1", source: "slack" }],
    derived_at: "2026-07-10T00:00:00.000Z",
    ...over,
  };
}

describe("scoreArc", () => {
  it("maps arc confidence to the confidence score", () => {
    expect(scoreArc(arc({ confidence: "high" }), NOW).confidence).toBe(0.9);
    expect(scoreArc(arc({ confidence: "medium" }), NOW).confidence).toBe(0.6);
    expect(scoreArc(arc({ confidence: "low" }), NOW).confidence).toBe(0.3);
  });

  it("scores a fresh arc's novelty ~1.0 and decays it with age", () => {
    const fresh = scoreArc(arc({ derived_at: "2026-07-10T00:00:00.000Z" }), NOW);
    expect(fresh.novelty).toBe(1); // age 0 → full recency
    const old = scoreArc(arc({ derived_at: "2026-06-26T00:00:00.000Z" }), NOW); // 14 days → one half-life
    expect(old.novelty).toBe(0.5);
    expect(old.urgency).toBeLessThan(fresh.urgency);
  });

  it("treats an arc as inherently relevant (curated storyline)", () => {
    expect(scoreArc(arc(), NOW).relevance).toBe(0.8);
  });
});

describe("arcEvidence", () => {
  it("keeps only item-linked evidence and carries the source as a note", () => {
    const a = arc({
      evidence: [
        { fact: "f1", itemId: "item-1", source: "github" },
        { fact: "f2" }, // no itemId → dropped (nothing to trace)
        { fact: "f3", itemId: "item-2" },
      ],
    });
    expect(arcEvidence(a)).toEqual([{ itemId: "item-1", note: "github" }, { itemId: "item-2" }]);
  });
});

describe("evidenceCeiling (tier safety)", () => {
  it("is external only when every cited item resolved and is external", () => {
    expect(evidenceCeiling(["external", "external"], 0)).toBe("external");
  });
  it("is team when any evidence is team-tier", () => {
    expect(evidenceCeiling(["external", "team"], 0)).toBe("team");
  });
  it("is team (fail-closed) when any referenced item is missing", () => {
    expect(evidenceCeiling(["external"], 1)).toBe("team");
  });
  it("is external for an opportunity with no item evidence at all", () => {
    expect(evidenceCeiling([], 0)).toBe("external");
  });
});
