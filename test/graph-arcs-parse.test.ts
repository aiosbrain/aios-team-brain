import { describe, expect, it } from "vitest";
import { parseArcsJson, stripTaskKeys } from "@/lib/graph/arcs";

/**
 * Spec for the arc JSON normalizer (the fragile bit — an LLM's JSON is untrusted). Derived from the
 * contract the panel needs: safe defaults, capped at 5, coerced confidence, stable ids, never throws.
 */

describe("stripTaskKeys", () => {
  it("removes Linear/Jira-style issue keys from narrative text", () => {
    expect(stripTaskKeys("Shipping the learning layer (AIO-138) and events")).toBe(
      "Shipping the learning layer and events"
    );
    expect(stripTaskKeys("AIO-111 covers auth; AIO-146 covers RLS.")).toBe("covers auth; covers RLS.");
    expect(stripTaskKeys("Working on [AIO-9] the importer.")).toBe("Working on the importer.");
  });
  it("leaves ordinary text untouched", () => {
    expect(stripTaskKeys("Improving retrieval and dates.")).toBe("Improving retrieval and dates.");
    expect(stripTaskKeys("")).toBe("");
  });
});

describe("parseArcsJson strips task keys from title + summary", () => {
  it("does not echo issue keys into the human-facing arc", () => {
    const raw = JSON.stringify({
      arcs: [{ title: "Learning layer (AIO-138)", confidence: "high", summary: "Building AIO-138 and AIO-146.", participants: [] }],
    });
    const [arc] = parseArcsJson(raw, "2026-07-02T00:00:00.000Z");
    expect(arc.title).toBe("Learning layer");
    expect(arc.summary).toBe("Building and.");
    expect(arc.summary).not.toMatch(/AIO-\d+/);
  });
});

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

  // Regression: Claude/GPT often ignore "return ONLY JSON" and wrap the object in a markdown code
  // fence or a leading sentence. Before this fix that silently degraded to "no arcs" with zero
  // diagnostics — exactly the failure mode reported on the Learning page.
  it("unwraps a JSON object wrapped in a ```json code fence", () => {
    const body = JSON.stringify({ arcs: [{ title: "Auth rewrite", confidence: "high" }] });
    const [arc] = parseArcsJson("```json\n" + body + "\n```", NOW);
    expect(arc.title).toBe("Auth rewrite");
  });

  it("unwraps a JSON object wrapped in a bare ``` code fence", () => {
    const body = JSON.stringify({ arcs: [{ title: "Auth rewrite", confidence: "high" }] });
    const [arc] = parseArcsJson("```\n" + body + "\n```", NOW);
    expect(arc.title).toBe("Auth rewrite");
  });

  it("unwraps a JSON object padded with a leading/trailing sentence", () => {
    const body = JSON.stringify({ arcs: [{ title: "Auth rewrite", confidence: "high" }] });
    const [arc] = parseArcsJson(`Here is the analysis:\n${body}\nLet me know if you need more.`, NOW);
    expect(arc.title).toBe("Auth rewrite");
  });

  it("leaves a clean, unwrapped response untouched", () => {
    const raw = JSON.stringify({ arcs: [{ title: "Auth rewrite", confidence: "high" }] });
    const [arc] = parseArcsJson(raw, NOW);
    expect(arc.title).toBe("Auth rewrite");
  });
});
