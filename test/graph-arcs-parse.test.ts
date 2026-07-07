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
    const [arc] = parseArcsJson(raw, { now: "2026-07-02T00:00:00.000Z" });
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
    const [arc] = parseArcsJson(raw, { now: NOW });
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
    expect(parseArcsJson(raw, { now: NOW })[0].id).toBe(arc.id);
  });

  it("coerces a bad confidence to 'low' and defaults missing fields", () => {
    const [arc] = parseArcsJson(JSON.stringify({ arcs: [{ title: "X", confidence: "vibes" }] }), { now: NOW });
    expect(arc.confidence).toBe("low");
    expect(arc.summary).toBe("");
    expect(arc.participants).toEqual([]);
    expect(arc.supporting_sources).toEqual([]);
  });

  it("caps at 5 arcs", () => {
    const arcs = Array.from({ length: 9 }, (_, i) => ({ title: `A${i}`, confidence: "low" }));
    expect(parseArcsJson(JSON.stringify({ arcs }), { now: NOW })).toHaveLength(5);
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
    const [arc] = parseArcsJson("```json\n" + body + "\n```", { now: NOW });
    expect(arc.title).toBe("Auth rewrite");
  });

  it("unwraps a JSON object wrapped in a bare ``` code fence", () => {
    const body = JSON.stringify({ arcs: [{ title: "Auth rewrite", confidence: "high" }] });
    const [arc] = parseArcsJson("```\n" + body + "\n```", { now: NOW });
    expect(arc.title).toBe("Auth rewrite");
  });

  it("unwraps a JSON object padded with a leading/trailing sentence", () => {
    const body = JSON.stringify({ arcs: [{ title: "Auth rewrite", confidence: "high" }] });
    const [arc] = parseArcsJson(`Here is the analysis:\n${body}\nLet me know if you need more.`, { now: NOW });
    expect(arc.title).toBe("Auth rewrite");
  });

  it("leaves a clean, unwrapped response untouched", () => {
    const raw = JSON.stringify({ arcs: [{ title: "Auth rewrite", confidence: "high" }] });
    const [arc] = parseArcsJson(raw, { now: NOW });
    expect(arc.title).toBe("Auth rewrite");
  });
});

describe("parseArcsJson evidence (verifiable, linkable)", () => {
  const NOW = "2026-07-02T00:00:00.000Z";
  const fact = (id: string, text: string, episodeUuids: string[] = []) => ({
    id,
    fact: text,
    at: NOW,
    subjectType: "person",
    subject: "a",
    object: "b",
    episodeUuids,
  });
  const facts = [
    fact("f1", "Chetan shipped the Linear importer", ["ep-1"]),
    fact("f2", "John reviewed the RLS change", ["ep-2"]),
    fact("f3", "Retrieval got date-awareness", []),
  ];
  const epToItem = new Map([
    ["ep-1", { itemId: "item-aaa", source: "slack" }],
    ["ep-2", { itemId: "item-bbb", source: "github" }],
  ]);

  it("maps cited fact numbers to real facts + resolves each one's source item", () => {
    const raw = JSON.stringify({ arcs: [{ title: "Importers", confidence: "high", supporting_facts: [1, 3] }] });
    const [arc] = parseArcsJson(raw, { facts, epToItem, now: NOW });
    expect(arc.evidence).toEqual([
      { fact: "Chetan shipped the Linear importer", at: NOW, itemId: "item-aaa", source: "slack" },
      { fact: "Retrieval got date-awareness", at: NOW, itemId: undefined, source: undefined },
    ]);
  });

  it("drops out-of-range and duplicate fact indices", () => {
    const raw = JSON.stringify({ arcs: [{ title: "T", confidence: "low", supporting_facts: [2, 2, 99, 0, -1] }] });
    const [arc] = parseArcsJson(raw, { facts, epToItem, now: NOW });
    expect(arc.evidence.map((e) => e.fact)).toEqual(["John reviewed the RLS change"]);
    expect(arc.evidence[0].itemId).toBe("item-bbb");
  });

  it("falls back to free-text supporting_sources (unlinked) when no fact numbers are cited", () => {
    const raw = JSON.stringify({ arcs: [{ title: "T", confidence: "low", supporting_sources: ["Slack #eng", "a PR"] }] });
    const [arc] = parseArcsJson(raw, { facts, epToItem, now: NOW });
    expect(arc.evidence).toEqual([{ fact: "Slack #eng" }, { fact: "a PR" }]);
  });
});
