import { describe, expect, it } from "vitest";
import {
  parseArcsJson,
  stripTaskKeys,
  rankArcs,
  newestEvidenceAt,
  balanceFactsByContributor,
  balanceFacts,
  dedupeFacts,
  arcsRequested,
  parseOffTopicIds,
  pruneEvidenceByIds,
  type NarrativeArc,
} from "@/lib/graph/arcs";
import type { AtomicFact } from "@/lib/graph/learning";

/** Minimal NarrativeArc fixture for the coherence-prune tests. */
function makeArc(over: Partial<NarrativeArc>): NarrativeArc {
  return {
    id: "arc-x",
    title: "t",
    confidence: "medium",
    summary: "s",
    participants: [],
    supporting_sources: [],
    evidence: [],
    derived_at: "2026-07-24T00:00:00.000Z",
    ...over,
  };
}
const ev = (fact: string, itemId?: string) => ({ fact, itemId });

/**
 * Spec for the arc JSON normalizer (the fragile bit — an LLM's JSON is untrusted). Derived from the
 * contract the panel needs: safe defaults, capped at MAX_ARCS, coerced confidence, stable ids, never throws.
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

  it("caps at MAX_ARCS (12) arcs", () => {
    const arcs = Array.from({ length: 16 }, (_, i) => ({ title: `A${i}`, confidence: "low" }));
    expect(parseArcsJson(JSON.stringify({ arcs }), { now: NOW })).toHaveLength(12);
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

describe("balanceFacts — contributor→item (one giant doc can't BE a person's whole share)", () => {
  const f = (id: string, who: string, item: string) => ({ id, who, item });
  const humanOf = (x: { who: string }) => x.who;
  const itemOf = (x: { item: string }) => x.item;

  it("a single dominant item does NOT crowd out a contributor's other items in their share", () => {
    // Chetan: 6 facts from one huge doc (ARCHITECTURE.md) + 1 fact each from 3 real work items.
    // Per-CONTRIBUTOR balancing alone would fill his slice doc-first; per-ITEM must interleave so his
    // varied work leads. Budget 4 (single contributor) → one from each of his 4 items, doc no more than
    // its round-robin share.
    const facts = [
      f("d1", "C", "arch"), f("d2", "C", "arch"), f("d3", "C", "arch"),
      f("d4", "C", "arch"), f("d5", "C", "arch"), f("d6", "C", "arch"),
      f("w1", "C", "social"), f("w2", "C", "security"), f("w3", "C", "meetings"),
    ];
    const out = balanceFacts(facts, humanOf, itemOf, 4).map((x) => x.id);
    // First four picks are one-per-item (item diversity leads), NOT four arch chunks.
    expect(out).toEqual(["d1", "w1", "w2", "w3"]);
    expect(out.filter((id) => id.startsWith("d"))).toHaveLength(1); // the doc contributes ONE, not four
  });

  it("perItemCap bounds how many facts any one item can contribute before balancing", () => {
    const facts = [
      f("d1", "C", "arch"), f("d2", "C", "arch"), f("d3", "C", "arch"), f("d4", "C", "arch"),
      f("w1", "C", "work"),
    ];
    // Cap arch at 2 → arch may appear at most twice regardless of budget.
    const out = balanceFacts(facts, humanOf, itemOf, 10, 2).map((x) => x.id);
    expect(out.filter((id) => id.startsWith("d"))).toEqual(["d1", "d2"]);
    expect(out).toContain("w1");
  });

  it("still balances ACROSS contributors (a high-volume person can't crowd out a low one)", () => {
    const facts = [
      f("j1", "John", "a"), f("j2", "John", "b"), f("j3", "John", "c"),
      f("c1", "Chetan", "x"),
    ];
    const out = balanceFacts(facts, humanOf, itemOf, 2).map((x) => x.id);
    expect(out).toContain("c1"); // Chetan present despite John's 3:1 volume
  });
});

describe("dedupeFacts — no wasted prompt slots on repeats / self-referential noise", () => {
  const mk = (id: string, fact: string, subject = "s", object = "o", episodeUuids: string[] = []): AtomicFact => ({
    id, fact, at: "2026-07-20T00:00:00Z", subjectType: "entity", subject, object, episodeUuids,
  });

  it("drops exact-repeat fact text, keeping the first (newest) occurrence", () => {
    const out = dedupeFacts([mk("1", "Chetan fixed observability"), mk("2", "Chetan fixed observability")]);
    expect(out.map((f) => f.id)).toEqual(["1"]);
  });

  it("UNIONS the source episodes of the dropped duplicate into the kept fact", () => {
    const out = dedupeFacts([mk("1", "same fact", "s", "o", ["epA"]), mk("2", "same fact", "s", "o", ["epB"])]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("1"); // first kept
    expect([...out[0].episodeUuids].sort()).toEqual(["epA", "epB"]); // both sources retained
  });

  it("is case/space-insensitive on the repeat check", () => {
    const out = dedupeFacts([mk("1", "Chetan  fixed  X"), mk("2", "chetan fixed x")]);
    expect(out).toHaveLength(1);
  });

  it("drops self-referential subject===object noise (the 'user is a duplicate of user' backstop)", () => {
    const out = dedupeFacts([mk("1", "user is a duplicate of user", "user", "user"), mk("2", "real fact", "a", "b")]);
    expect(out.map((f) => f.id)).toEqual(["2"]);
  });
});

describe("arcsRequested — scale requested arcs with distinct contributors (not a flat ceiling)", () => {
  it("floors at 6 for a small team and scales ~2 per contributor up to the cap", () => {
    expect(arcsRequested(1)).toBe(6); // floor
    expect(arcsRequested(2)).toBe(6); // floor still
    expect(arcsRequested(4)).toBe(8);
    expect(arcsRequested(6)).toBe(12); // cap (MAX_ARCS)
    expect(arcsRequested(20)).toBe(12); // never exceeds the cap
  });
});

describe("parseOffTopicIds — the coherence LLM's reply", () => {
  it("parses {off_topic:[…]} and uppercases the ids", () => {
    expect(parseOffTopicIds('{"off_topic":["A1F3","a2f1"]}')).toEqual(new Set(["A1F3", "A2F1"]));
  });
  it("accepts a bare array too", () => {
    expect(parseOffTopicIds('["A1F1"]')).toEqual(new Set(["A1F1"]));
  });
  it("drops nothing on garbage / wrong shape / empty (never prunes on uncertainty)", () => {
    expect(parseOffTopicIds("not json")).toEqual(new Set());
    expect(parseOffTopicIds('{"off_topic":"A1F1"}')).toEqual(new Set()); // not an array
    expect(parseOffTopicIds('{"off_topic":[]}')).toEqual(new Set());
    expect(parseOffTopicIds('{"other":["A1F1"]}')).toEqual(new Set());
  });
});

describe("pruneEvidenceByIds — drop a cross-topic outlier before participant attribution", () => {
  // contributorsByItem: the version-author map attributeArcs uses. Every item here resolves ≥1 human
  // unless a test needs the empty-human edge.
  const credit = new Map([
    ["i-chetan", ["Chetan"]], ["i-fatma", ["Fatma"]],
    ["b1", ["A"]], ["b2", ["A"]], ["c1", ["B"]], ["c2", ["B"]], ["s1", ["S"]],
  ]);

  it("drops the flagged evidence from a ≥2-evidence arc (so its author is no longer cited)", () => {
    // Arc A1 cites Chetan's on-topic fact + Fatma's off-topic doc; the coherence pass flags A1F2 (Fatma's).
    const arc = makeArc({ evidence: [ev("chetan: arc runtime hardening", "i-chetan"), ev("fatma: goal-setting theory", "i-fatma")] });
    const [out] = pruneEvidenceByIds([arc], new Set(["A1F2"]), credit);
    expect(out.evidence.map((e) => e.itemId)).toEqual(["i-chetan"]); // Fatma's item gone → she won't be a participant
  });

  it("never strips an arc's LAST evidence (all-flagged = an incoherent arc, left intact)", () => {
    const arc = makeArc({ evidence: [ev("f1", "i-chetan"), ev("f2", "i-fatma")] });
    expect(pruneEvidenceByIds([arc], new Set(["A1F1", "A1F2"]), credit)[0].evidence).toHaveLength(2);
  });

  it("keeps the arc when pruning would empty its evidence-HUMAN set (avoids the model-name fallback)", () => {
    // Survivor F1 is connector-authored (resolves NO human); F2 is Fatma's off-topic doc. Flagging F2
    // would leave zero human evidence → groundParticipants would fall back to the model's names. Keep it.
    const arc = makeArc({ evidence: [ev("f1", "i-connector"), ev("f2", "i-fatma")] });
    expect(pruneEvidenceByIds([arc], new Set(["A1F2"]), credit)[0].evidence).toHaveLength(2); // i-connector has no human
  });

  it("ignores single-evidence arcs (not prune candidates) and numbers only candidates", () => {
    const big = makeArc({ id: "big", evidence: [ev("b1", "b1"), ev("b2", "b2")] });
    const small = makeArc({ id: "small", evidence: [ev("s1", "s1")] });
    const big2 = makeArc({ id: "big2", evidence: [ev("c1", "c1"), ev("c2", "c2")] });
    // candidates are [big, big2] → A1, A2 (small is skipped). Flag A2F1 → big2 loses c1 only.
    const out = pruneEvidenceByIds([big, small, big2], new Set(["A2F1"]), credit);
    expect(out[0].evidence).toHaveLength(2); // big untouched
    expect(out[1].evidence).toHaveLength(1); // small untouched
    expect(out[2].evidence.map((e) => e.itemId)).toEqual(["c2"]); // big2 lost c1
  });

  it("ignores an out-of-range or unknown-arc flag (harmless no-op)", () => {
    const arc = makeArc({ evidence: [ev("f1", "i-chetan"), ev("f2", "i-fatma")] });
    // A1F5 (no 5th fact) and A9F1 (no 9th arc) match nothing → both facts kept.
    expect(pruneEvidenceByIds([arc], new Set(["A1F5", "A9F1"]), credit)[0].evidence).toHaveLength(2);
  });

  it("is a no-op when nothing is flagged", () => {
    const arc = makeArc({ evidence: [ev("f1"), ev("f2")] });
    expect(pruneEvidenceByIds([arc], new Set(), credit)).toEqual([arc]);
  });
});
