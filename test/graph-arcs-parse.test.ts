import { describe, expect, it } from "vitest";
import { parseArcsJson } from "@/lib/graph/arcs";

/**
 * Spec for the arc JSON normalizer (the fragile bit — an LLM's JSON is untrusted). Derived from the
 * contract the panel needs: safe defaults, capped at 5, coerced confidence, stable ids, never throws.
 */

describe("parseArcsJson", () => {
  const NOW = "2026-07-02T00:00:00.000Z";

  it("normalizes a well-formed arc and assigns a stable id", () => {
    const raw = JSON.stringify({
      arcs: [
        { title: "Auth rewrite", confidence: "high", summary: "Migrating to SSO.", participants: ["Alice"], supporting_sources: ["Slack"] },
      ],
    });
    const [arc] = parseArcsJson(raw, NOW);
    expect(arc).toMatchObject({
      title: "Auth rewrite",
      confidence: "high",
      summary: "Migrating to SSO.",
      participants: ["Alice"],
      supporting_sources: ["Slack"],
      derived_at: NOW,
    });
    expect(arc.id).toMatch(/^arc-[0-9a-f]{10}$/);
    // stable: same title → same id
    expect(parseArcsJson(raw, NOW)[0].id).toBe(arc.id);
  });

  it("coerces a bad confidence to 'low' and defaults missing fields", () => {
    const [arc] = parseArcsJson(JSON.stringify({ arcs: [{ title: "X", confidence: "vibes" }] }), NOW);
    expect(arc.confidence).toBe("low");
    expect(arc.summary).toBe("");
    expect(arc.participants).toEqual([]);
    expect(arc.supporting_sources).toEqual([]);
  });

  it("caps at 5 arcs", () => {
    const arcs = Array.from({ length: 9 }, (_, i) => ({ title: `A${i}`, confidence: "low" }));
    expect(parseArcsJson(JSON.stringify({ arcs }), NOW)).toHaveLength(5);
  });

  it("returns [] for null, malformed JSON, or a missing arcs array (never throws)", () => {
    expect(parseArcsJson(null)).toEqual([]);
    expect(parseArcsJson("not json")).toEqual([]);
    expect(parseArcsJson(JSON.stringify({ nope: 1 }))).toEqual([]);
  });
});
