import { describe, it, expect } from "vitest";
import {
  scoreSummaryHealth,
  scoreTemporalCoverage,
} from "../scripts/graph-window-battery/small-model-metrics.mjs";
import {
  armConfig,
  effectiveSnapshot,
  assertArmsDiffer,
  ARM_FIELD,
} from "../scripts/graph-window-battery/small-model-arms.mjs";
import {
  SMALL_MODEL_METRICS,
  smallModelMetrics,
  METRICS,
  judgeMetric,
  decide,
  assessSession,
  VERDICT,
} from "../scripts/graph-window-battery/decision.mjs";
import { SMALL_ELIGIBLE_KINDS, wantsSmallModel, GRAPHITI_SMALL_MODEL_MARKER } from "@/lib/llm/graph-call-kind";
import { selectSmallExtractionBackend } from "@/lib/query/llm-backend";

// Spec: docs/design/graph-small-model-activation.md — the acceptance criteria. These pin the metrics
// that gate a lever worth ~28.7% of graph spend, and the failure shapes review said would otherwise
// pass: uniform boilerplate summaries, and two "arms" that silently resolved to the same config.

const entity = (name: string, summary: string, facts: string[] = []) => ({ name, summary, facts });

describe("Q10 summary health — the boilerplate detector", () => {
  it("scores a real, varied, fact-grounded set as healthy", () => {
    const s = scoreSummaryHealth([
      entity("Chetan", "Chetan shipped the Linear importer and owns pm-sync.", ["Chetan shipped the Linear importer"]),
      entity("Graphiti", "Graphiti extracts entities and edges from episodes.", ["Graphiti extracts entities"]),
      entity("Railway", "Railway hosts the brain and its Postgres.", ["Railway hosts the brain"]),
    ]);
    expect(s.nonEmptyShare).toBe(1);
    expect(s.distinctness).toBe(1);
    expect(s.factOverlap).toBeGreaterThan(0.5);
  });

  it("CATCHES same-length boilerplate — the case mean length alone passes", () => {
    // The exact adversarial shape review named: incumbent-like length, non-empty, and worthless.
    const s = scoreSummaryHealth([
      entity("Chetan", "This entity is mentioned in the source material provided."),
      entity("Graphiti", "This entity is mentioned in the source material provided."),
      entity("Railway", "This entity is mentioned in the source material provided."),
    ]);
    expect(s.nonEmptyShare).toBe(1); // the naive floor passes…
    expect(s.meanLength).toBeGreaterThan(40); // …and so does length…
    expect(s.distinctness).toBeLessThan(0.4); // …but distinctness does not.
    expect(s.factOverlap).toBe(0); // and it is detached from the entity's own facts
  });

  it("catches near-boilerplate where only the entity name varies", () => {
    const s = scoreSummaryHealth([
      entity("Chetan", "Chetan is an entity mentioned within the provided source material."),
      entity("Graphiti", "Graphiti is an entity mentioned within the provided source material."),
      entity("Railway", "Railway is an entity mentioned within the provided source material."),
    ]);
    expect(s.distinctness).toBeLessThan(0.5);
  });

  it("catches a truncating arm and a blank arm", () => {
    expect(scoreSummaryHealth([entity("A", ""), entity("B", "")]).nonEmptyShare).toBe(0);
    const truncated = scoreSummaryHealth([entity("A", "Chetan"), entity("B", "Graphiti")]);
    expect(truncated.meanLength).toBeLessThan(12); // two-sided against the incumbent's mean
  });

  it("refuses to call an EMPTY entity set healthy (no evidence is not a pass)", () => {
    expect(scoreSummaryHealth([])).toEqual({
      total: 0,
      nonEmptyShare: null,
      meanLength: null,
      distinctness: null,
      factOverlap: null,
    });
  });
});

describe("Q11 temporal coverage", () => {
  it("is the share of edges carrying a resolved valid_at", () => {
    const s = scoreTemporalCoverage([
      { valid_at: "2026-08-01T00:00:00Z" },
      { valid_at: null },
      { valid_at: "2026-08-02T00:00:00Z" },
      { valid_at: "   " },
    ]);
    expect(s.total).toBe(4);
    expect(s.share).toBe(0.5); // blank strings are not dates
  });

  it("is NULL, not 0, when there are no edges — no evidence ≠ total regression", () => {
    expect(scoreTemporalCoverage([])).toEqual({ total: 0, share: null });
  });
});

describe("arm separation — the leak that reads as a clean negative", () => {
  it("STRONG sets the field to null EXPLICITLY, so nothing is inherited by omission", () => {
    expect(armConfig("STRONG")).toEqual({ [ARM_FIELD]: null });
    expect(armConfig("SMALL", "vendor/cheap-model")).toEqual({ [ARM_FIELD]: "vendor/cheap-model" });
  });

  it("refuses a SMALL arm with no model", () => {
    expect(() => armConfig("SMALL", "")).toThrow(/requires a model/i);
    expect(() => armConfig("SMALL", undefined)).toThrow(/requires a model/i);
  });

  it("REFUSES two arms that resolved to identical config (the inherited-field leak)", () => {
    // STRONG ran after SMALL and inherited extraction_small_model: both route small, the delta
    // collapses, and without this the session reports "no savings" instead of "broken experiment".
    const a = effectiveSnapshot("SMALL", "vendor/cheap-model");
    const b = effectiveSnapshot("STRONG", "vendor/cheap-model");
    const v = assertArmsDiffer(a, b);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/IDENTICAL|inherited/i);
  });

  it("accepts a genuine strong-vs-small pair", () => {
    expect(assertArmsDiffer(effectiveSnapshot("STRONG", null), effectiveSnapshot("SMALL", "vendor/cheap-model")).ok).toBe(true);
  });

  it("keys on the RESOLVED value, so an intended-but-inert SMALL arm is caught", () => {
    // The arm asked for a small model but the backend resolved to null (e.g. provider not configured)
    // — it is a strong arm wearing a small label, and comparing it to STRONG measures nothing.
    const v = assertArmsDiffer(effectiveSnapshot("STRONG", null), effectiveSnapshot("SMALL", null));
    expect(v.ok).toBe(false);
  });

  it("refuses two snapshots of the same arm", () => {
    expect(assertArmsDiffer(effectiveSnapshot("SMALL", "m"), effectiveSnapshot("SMALL", "m")).ok).toBe(false);
  });
});

describe("the small-model registry gates on C2, not C1", () => {
  it("uses USD/episode as the cost gate and does NOT inherit C1", () => {
    // C1 is ratio-fall on input TOKENS; this lever sends the same tokens to a cheaper model, so C1
    // could never pass and would have pre-registered a guaranteed STOP.
    expect(SMALL_MODEL_METRICS.C2.kind).toBe("ratio-fall");
    expect(SMALL_MODEL_METRICS.C2.label).toMatch(/USD/i);
    expect("C1" in SMALL_MODEL_METRICS).toBe(false);
  });

  it("reuses the shared quality bands verbatim rather than forking them", () => {
    for (const k of ["Q1", "Q2", "Q4", "Q5", "Q7"] as const) {
      expect(SMALL_MODEL_METRICS[k]).toBe(METRICS[k]);
    }
  });

  it("sets the cost band from the PRE-FLIGHT, before any arm runs", () => {
    expect(smallModelMetrics({ addressableShare: 0.287 }).C2.margin).toBe(0.15);
    expect(smallModelMetrics({ addressableShare: 0.187 }).C2.margin).toBe(0.1);
    expect(smallModelMetrics().C2.margin).toBe(0.15); // conservative default
  });

  it("does not carry the dead Q3 or the superseded Q6", () => {
    expect("Q3" in SMALL_MODEL_METRICS).toBe(false); // structural zero on graphiti 0.29.3
    expect("Q6" in SMALL_MODEL_METRICS).toBe(false); // superseded by Q7
  });
});

describe("the routing this battery exists to qualify", () => {
  it("routes ONLY the small-eligible kinds, and only when the marker is present", () => {
    const body = (system: string, model: string) => ({ model, messages: [{ role: "system", content: system }] });
    const DEDUPE_EDGES = "You are a fact deduplication assistant.";
    const EXTRACT_NODES = "You are an entity extraction specialist for conversational messages.";

    expect(wantsSmallModel(body(DEDUPE_EDGES, GRAPHITI_SMALL_MODEL_MARKER))).toBe(true);
    // An eligible prompt WITHOUT the marker stays strong.
    expect(wantsSmallModel(body(DEDUPE_EDGES, "qwen/qwen3.7-plus"))).toBe(false);
    // Entity extraction must NEVER be downgraded, marker or not.
    expect(wantsSmallModel(body(EXTRACT_NODES, GRAPHITI_SMALL_MODEL_MARKER))).toBe(false);
    expect(SMALL_ELIGIBLE_KINDS.has("extract_nodes")).toBe(false);
    expect(SMALL_ELIGIBLE_KINDS.has("dedupe_nodes")).toBe(false);
  });

  it("is INERT today: with extraction_small_model unset the small backend is null", () => {
    // This is the state the whole slice is about — the lever shipped and was never pulled.
    const keys = {
      openrouterKey: "k",
      extractionProvider: "openrouter" as const,
      extractionModel: "qwen/qwen3.7-plus",
      // extractionSmallModel deliberately unset
    };
    expect(selectSmallExtractionBackend({}, keys)).toBeNull();
    // …and set, it resolves — so the assertion above is not vacuous.
    expect(selectSmallExtractionBackend({}, { ...keys, extractionSmallModel: "vendor/cheap" })?.model).toBe("vendor/cheap");
  });
});

describe("marker pre-flight — settles 28.7% vs 18.7% before anything is spent", () => {
  const req = (system: string, model: string) => ({
    kind: "request",
    body: { model, messages: [{ role: "system", content: system }] },
  });
  const DEDUPE_EDGES = "You are a fact deduplication assistant.";
  const SUMMARIES = "You are a helpful assistant that generates concise entity summaries from provided context.";
  const EXTRACT_NODES = "You are an entity extraction specialist for conversational messages.";

  it("counts the marker per call kind, ignoring response records", async () => {
    const { tallyMarkers } = await import("../scripts/graph-window-battery/small-marker-preflight.mjs");
    const t = tallyMarkers([
      req(DEDUPE_EDGES, GRAPHITI_SMALL_MODEL_MARKER),
      req(DEDUPE_EDGES, GRAPHITI_SMALL_MODEL_MARKER),
      req(EXTRACT_NODES, "qwen/qwen3.7-plus"),
      // A response record has no request body and must not be counted as an unmarked call —
      // doing so would silently halve every share.
      { kind: "response", status: 200, body: { choices: [] } },
    ]);
    expect(t.requests).toBe(3);
    expect(t.kinds.find((k: { kind: string }) => k.kind === "dedupe_edges")).toMatchObject({ calls: 2, marked: 2 });
    expect(t.kinds.find((k: { kind: string }) => k.kind === "extract_nodes")).toMatchObject({ calls: 1, marked: 0 });
  });

  it("reports the 18.7% case when node_summaries_batch never carries the marker", async () => {
    const { tallyMarkers, assessEligibility } = await import(
      "../scripts/graph-window-battery/small-marker-preflight.mjs"
    );
    const t = tallyMarkers([
      req(DEDUPE_EDGES, GRAPHITI_SMALL_MODEL_MARKER),
      req(SUMMARIES, "qwen/qwen3.7-plus"), // deployed image does NOT ask for a small model here
    ]);
    // The cost map MUST be shares of TOTAL graph spend. An earlier version of this test passed only
    // two kinds and pinned 0.173/0.273 = 0.634 as correct — which would select the 15% band when the
    // true addressable share is 17.3% and the spec demands 10%. The test itself taught the wrong
    // contract; review caught it.
    const FULL_COST_SHARE = {
      dedupe_nodes: 0.251,
      extract_edges: 0.242,
      extract_nodes: 0.219,
      dedupe_edges: 0.173,
      node_summaries_batch: 0.1,
      edge_timestamps: 0.014,
    };
    const a = assessEligibility(t, FULL_COST_SHARE);
    expect(a.missing).toContain("node_summaries_batch");
    // dedupe_edges routable only → 17.3% of ALL graph spend, i.e. the 18.7%-ish case…
    expect(a.addressableShare).toBeCloseTo(0.173, 3);
    // …and that share must select the 10% band, which is the whole point of measuring it.
    expect(smallModelMetrics({ addressableShare: a.addressableShare! }).C2.margin).toBe(0.1);
  });

  it("flags a kind that carries the marker but is NOT declared eligible (table drift)", async () => {
    const { tallyMarkers, assessEligibility } = await import(
      "../scripts/graph-window-battery/small-marker-preflight.mjs"
    );
    const t = tallyMarkers([req(EXTRACT_NODES, GRAPHITI_SMALL_MODEL_MARKER)]);
    const a = assessEligibility(t, { extract_nodes: 1 });
    expect(a.unexpected).toContain("extract_nodes");
    expect(a.routable).not.toContain("extract_nodes"); // the proxy still routes it strong
    expect(a.addressableShare).toBe(0);
  });
});

describe("folded review findings — regressions", () => {
  it("a name-repetition arm is NOT scored as distinct (Fable: perfect score on every term)", () => {
    // Summaries that are just the entity name repeated. Before the fold these emptied the word set
    // after name-stripping, were exempted from duplicate detection, and scored
    // {distinctness:1, factOverlap:1} — a PERFECT score for the exact shape Q10 exists to catch.
    const s = scoreSummaryHealth([
      entity("Chetan", "Chetan Chetan Chetan Chetan Chetan Chetan Chetan Chetan.", ["Chetan shipped it"]),
      entity("Graphiti", "Graphiti Graphiti Graphiti Graphiti Graphiti Graphiti.", ["Graphiti extracts"]),
    ]);
    expect(s.distinctness).toBe(0);
  });

  it("Q11 is UNDEFINED when edges exist but none is datable (AC5), not 0", () => {
    // 0 would make the ratio-to-incumbent Infinity/NaN and read as a total coverage collapse.
    expect(scoreTemporalCoverage([{ valid_at: null }, { valid_at: "" }])).toEqual({ total: 2, share: null });
  });

  it("Q11's band is TWO-SIDED — hallucinated dates must not score as an improvement", () => {
    // The downgraded prompt says "NEVER hallucinate dates" because that is the weak-model failure
    // mode; a ratio-lower floor would reward inventing them.
    expect(SMALL_MODEL_METRICS.Q11.kind).toBe("ratio-both");
  });

  it("every Q10 term is BANDED — distinctness, fact-overlap, and (two-sided) length", () => {
    // An earlier registry banded distinctness alone while claiming two-sidedness, leaving a padding
    // arm ungated despite an acceptance criterion naming it.
    expect(SMALL_MODEL_METRICS.Q10.kind).toBe("ratio-lower");
    expect(SMALL_MODEL_METRICS.Q10F.kind).toBe("ratio-lower");
    expect(SMALL_MODEL_METRICS.Q10L.kind).toBe("ratio-both"); // padding AND truncation
  });

  it("the pre-flight REFUSES when nothing routable carries the marker (AC10)", async () => {
    const { tallyMarkers, assessEligibility } = await import(
      "../scripts/graph-window-battery/small-marker-preflight.mjs"
    );
    const t = tallyMarkers([
      { kind: "request", body: { model: "qwen/qwen3.7-plus", messages: [{ role: "system", content: "You are a fact deduplication assistant." }] } },
    ]);
    const a = assessEligibility(t, { dedupe_edges: 1 });
    expect(a.refusal).toMatch(/cannot save anything|re-derive/i);
    expect(a.routable).toEqual([]);
  });

  it("legacy node_attributes absence is NOT reported as drift on a 0.29.3 capture", async () => {
    const { tallyMarkers, assessEligibility } = await import(
      "../scripts/graph-window-battery/small-marker-preflight.mjs"
    );
    const t = tallyMarkers([
      { kind: "request", body: { model: GRAPHITI_SMALL_MODEL_MARKER, messages: [{ role: "system", content: "You are a fact deduplication assistant." }] } },
    ]);
    const a = assessEligibility(t, { dedupe_edges: 1 });
    // 0.13.2-only; its absence on the deployed image is expected, and an always-firing alarm is noise.
    expect(a.missing).not.toContain("node_attributes");
  });
});

describe("the judge is WIRED to the small-model registry (the critical fold)", () => {
  // Both reviewers independently found that SMALL_MODEL_METRICS had zero consumers: judgeMetric
  // hardcoded METRICS and decide iterated Object.keys(METRICS), so a small-model session would have
  // been judged on C1 — the guaranteed STOP the C2 amendment exists to remove. These pin the wiring.
  const flat = [1000, 1000]; // input tokens/episode: UNCHANGED, which is what this lever does
  const halved = { inc: [0.01, 0.01], arm: [0.005, 0.005] }; // USD/episode: cut in half

  const smallSession = () =>
    assessSession({
      incumbent: {
        Q1: [10, 10], Q2: [1, 1], Q4: [0.5, 0.5], Q5: [0, 0], Q7: [1, 1],
        Q10: [0.9, 0.9], Q10F: [0.6, 0.6], Q10L: [120, 120], Q11: [0.5, 0.5], C2: halved.inc,
      },
      universeSize: 20,
      underpowered: [],
      armsCompleted: true,
      harnessRefused: false,
      crossCheckAvailable: true,
      registry: smallModelMetrics({ addressableShare: 0.287 }),
    });

  it("judgeMetric can judge C2/Q10/Q11 when handed the small-model registry", () => {
    const reg = smallModelMetrics({ addressableShare: 0.287 });
    // Before the fold this threw `unknown metric C2` — the registry was unreachable.
    const r = judgeMetric("C2", halved.arm, halved.inc, {}, reg);
    expect(r.verdict).toBe(VERDICT.PASS); // a 50% cost fall clears the 15% band
    expect(() => judgeMetric("Q10", [0.9, 0.9], [0.9, 0.9], {}, reg)).not.toThrow();
  });

  it("SHIPS an arm that halves cost while leaving tokens flat (AC8b)", () => {
    const session = smallSession();
    expect(session.valid).toBe(true);
    const out = decide({
      session,
      incumbent: {
        Q1: [10, 10], Q2: [1, 1], Q4: [0.5, 0.5], Q5: [0, 0], Q7: [1, 1],
        Q10: [0.9, 0.9], Q10F: [0.6, 0.6], Q10L: [120, 120], Q11: [0.5, 0.5], C2: halved.inc,
      },
      arms: [{
        name: "SMALL",
        metrics: {
          Q1: [10, 10], Q2: [1, 1], Q4: [0.5, 0.5], Q5: [0, 0], Q7: [1, 1],
          Q10: [0.9, 0.9], Q10F: [0.6, 0.6], Q10L: [120, 120], Q11: [0.5, 0.5], C2: halved.arm,
        },
        extras: { personsLost: 0 },
      }],
      registry: smallModelMetrics({ addressableShare: 0.287 }),
    });
    expect(out.outcome).toBe("SHIP");
    // …and C1 is not even considered for this arm.
    expect(out.arms[0].results.map((r: { key: string }) => r.key)).not.toContain("C1");
  });

  it("PROVES the C1 trap was real: the same flat-token data FAILS the default registry", () => {
    // ratio-fall demands a 25% token reduction. This lever sends the same tokens at a lower price,
    // so judging it on C1 is a pre-registered STOP for a saving it cannot produce.
    const r = judgeMetric("C1", flat, flat, {}, METRICS);
    expect(r.verdict).not.toBe(VERDICT.PASS);
  });

  it("marks a session INVALID when arm separation failed (AC6, wired not documented)", () => {
    const broken = assessSession({
      incumbent: { C2: halved.inc },
      universeSize: 20,
      underpowered: [],
      armsCompleted: true,
      harnessRefused: false,
      crossCheckAvailable: true,
      registry: smallModelMetrics({ addressableShare: 0.287 }),
      armSeparation: assertArmsDiffer(effectiveSnapshot("STRONG", "m"), effectiveSnapshot("SMALL", "m")),
    });
    expect(broken.valid).toBe(false);
    expect(broken.problems.join(" ")).toMatch(/IDENTICAL|inherited|separation/i);
  });
});

describe("informativeness guard — Q3's lesson, mechanised (GRAPHSMALL-2)", () => {
  it("calls a CEILING metric uninformative: coverage ~1.0 has no room to fall by the band", async () => {
    // The Q11 risk: graphiti backdates valid_at to the episode's work time, so coverage may be ~1.0
    // on every arm — a metric that cannot move, scoring a meaningless 1.0 ratio as PASS. Q3 read a
    // structural ZERO exactly this way and was only caught live, after the money was spent.
    const { assessInformativeness } = await import("../scripts/graph-window-battery/small-model-metrics.mjs");
    const r = assessInformativeness([1.0, 1.0], { bandMargin: 0.15 });
    expect(r.informative).toBe(false);
    expect(r.reason).toMatch(/ceiling|no room/i);
  });

  it("calls a FLOOR metric uninformative (the literal Q3 shape)", async () => {
    const { assessInformativeness } = await import("../scripts/graph-window-battery/small-model-metrics.mjs");
    expect(assessInformativeness([0, 0], { bandMargin: 0.15 }).informative).toBe(false);
  });

  it("calls a MID-RANGE incumbent informative — the guard must not disarm a working metric", async () => {
    const { assessInformativeness } = await import("../scripts/graph-window-battery/small-model-metrics.mjs");
    const r = assessInformativeness([0.5, 0.52], { bandMargin: 0.15 });
    expect(r.informative).toBe(true);
  });

  it("treats a null/absent incumbent as uninformative, not as zero", async () => {
    const { assessInformativeness } = await import("../scripts/graph-window-battery/small-model-metrics.mjs");
    // `null` is what the scorers return for "no evidence"; scoring it 0 would read as total collapse.
    expect(assessInformativeness([null, null], { bandMargin: 0.15 }).informative).toBe(false);
    expect(assessInformativeness([], { bandMargin: 0.15 }).informative).toBe(false);
    expect(assessInformativeness([0.5, 0.5], {}).informative).toBe(false); // no band → cannot judge room
  });

  it("an UNINFORMATIVE metric is EXCLUDED from gating, never counted as a pass", () => {
    // A metric that cannot fail is not evidence of safety. Here Q11 would FAIL if judged (arm well
    // below the incumbent), but it is excluded — and the result reports which questions went unanswered.
    const base = { Q1: [10, 10], Q2: [1, 1], Q4: [0.5, 0.5], Q5: [0, 0], Q7: [1, 1],
      Q10: [0.9, 0.9], Q10F: [0.6, 0.6], Q10L: [120, 120], Q11: [1.0, 1.0], C2: [0.01, 0.01] };
    const session = assessSession({
      incumbent: base, universeSize: 20, underpowered: [], armsCompleted: true,
      harnessRefused: false, crossCheckAvailable: true,
      registry: smallModelMetrics({ addressableShare: 0.287 }),
    });
    const out = decide({
      session,
      incumbent: base,
      arms: [{ name: "SMALL", metrics: { ...base, Q11: [0.2, 0.2], C2: [0.005, 0.005] }, extras: { personsLost: 0 } }],
      registry: smallModelMetrics({ addressableShare: 0.287 }),
      uninformative: ["Q11"],
    });
    expect(out.uninformative).toContain("Q11");
    expect(out.arms[0].results.map((r: { key: string }) => r.key)).not.toContain("Q11");
    // …and with Q11 JUDGED instead, that same arm is blocked — proving the exclusion is doing work.
    const judgedOut = decide({
      session, incumbent: base,
      arms: [{ name: "SMALL", metrics: { ...base, Q11: [0.2, 0.2], C2: [0.005, 0.005] }, extras: { personsLost: 0 } }],
      registry: smallModelMetrics({ addressableShare: 0.287 }),
    });
    expect(judgedOut.arms[0].ships).toBe(false);
  });
});
