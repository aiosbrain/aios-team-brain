import { describe, expect, it } from "vitest";
import {
  parseArcsJson,
  stripTaskKeys,
  rankArcs,
  newestEvidenceAt,
  balanceFactsByContributor,
  type NarrativeArc,
} from "@/lib/graph/arcs";

/**
 * Spec for the arc JSON normalizer (the fragile bit — an LLM's JSON is untrusted). Derived from the
 * contract the panel needs: safe defaults, capped at 8, coerced confidence, stable ids, never throws.
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

  it("caps at 8 arcs", () => {
    const arcs = Array.from({ length: 12 }, (_, i) => ({ title: `A${i}`, confidence: "low" }));
    expect(parseArcsJson(JSON.stringify({ arcs }), { now: NOW })).toHaveLength(8);
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

describe("rankArcs — recency then relevance (surfaces recent contributors' work)", () => {
  const arc = (title: string, confidence: NarrativeArc["confidence"], ats: (string | undefined)[]): NarrativeArc => ({
    id: `arc-${title}`,
    title,
    confidence,
    summary: "",
    participants: [],
    supporting_sources: [],
    evidence: ats.map((at) => ({ fact: `f-${title}`, at })),
    derived_at: "2026-07-17T00:00:00.000Z",
  });

  it("newestEvidenceAt returns the max dated evidence, -Infinity when none is dated", () => {
    expect(newestEvidenceAt(arc("a", "low", ["2026-07-01T00:00:00Z", "2026-07-10T00:00:00Z"]))).toBe(
      Date.parse("2026-07-10T00:00:00Z")
    );
    expect(newestEvidenceAt(arc("b", "low", [undefined]))).toBe(-Infinity);
  });

  it("orders the most-recent arc first even when it's lower confidence (recency wins)", () => {
    const stale = arc("stale-high", "high", ["2026-06-01T00:00:00Z"]);
    const recent = arc("recent-low", "low", ["2026-07-16T00:00:00Z"]);
    expect(rankArcs([stale, recent]).map((a) => a.title)).toEqual(["recent-low", "stale-high"]);
  });

  it("breaks recency ties by confidence, then by evidence depth", () => {
    const day = "2026-07-15T00:00:00Z";
    const lowThin = arc("low-thin", "low", [day]);
    const highAny = arc("high", "high", [day]);
    const lowDeep = arc("low-deep", "low", [day, day]);
    expect(rankArcs([lowThin, highAny, lowDeep]).map((a) => a.title)).toEqual(["high", "low-deep", "low-thin"]);
  });

  it("sorts arcs with no dated evidence last, stably", () => {
    const dated = arc("dated", "low", ["2026-07-10T00:00:00Z"]);
    const undated1 = arc("undated1", "high", [undefined]);
    const undated2 = arc("undated2", "high", [undefined]);
    expect(rankArcs([undated1, dated, undated2]).map((a) => a.title)).toEqual(["dated", "undated1", "undated2"]);
  });
});

describe("balanceFactsByContributor — fair representation (the fix for a contributor going invisible)", () => {
  const f = (id: string, who: string) => ({ id, who });
  const humanOf = (x: { who: string }) => x.who;

  it("round-robins so a high-volume contributor can't crowd out a low-volume one", () => {
    // John has 5 facts, Chetan 1. With the OLD global-newest slice(0,4) Chetan would be dropped;
    // balancing must keep him in.
    const facts = [
      f("j1", "John"), f("j2", "John"), f("j3", "John"), f("j4", "John"), f("j5", "John"),
      f("c1", "Chetan"),
    ];
    const out = balanceFactsByContributor(facts, humanOf, 4);
    expect(out.map((x) => x.id)).toContain("c1");
    expect(out.map((x) => x.id)).toEqual(["j1", "c1", "j2", "j3"]);
  });

  it("consumes each contributor's facts newest-first (per-bucket input order preserved)", () => {
    const facts = [f("j1", "John"), f("j2", "John"), f("c1", "Chetan"), f("c2", "Chetan")];
    expect(balanceFactsByContributor(facts, humanOf, 4).map((x) => x.id)).toEqual(["j1", "c1", "j2", "c2"]);
  });

  it("respects the budget and returns [] for an empty pool", () => {
    const facts = Array.from({ length: 20 }, (_, i) => f(`x${i}`, i % 2 ? "A" : "B"));
    expect(balanceFactsByContributor(facts, humanOf, 5)).toHaveLength(5);
    expect(balanceFactsByContributor([], humanOf, 5)).toEqual([]);
  });

  it("unattributed facts ('') are their own bucket and still get a fair share", () => {
    const facts = [f("j1", "John"), f("j2", "John"), f("u1", ""), f("u2", "")];
    expect(balanceFactsByContributor(facts, humanOf, 4).map((x) => x.id)).toEqual(["j1", "u1", "j2", "u2"]);
  });
});
