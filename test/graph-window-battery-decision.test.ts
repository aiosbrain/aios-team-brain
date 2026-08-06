import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no types; imported for its pure decision procedure.
import { judgeMetric, assessSession, decide, VERDICT, METRICS } from "../scripts/graph-window-battery/decision.mjs";

/**
 * The battery's decision procedure for PIPEFF-2 (AIO-821).
 *
 * Spec-derived from `docs/design/graph-episode-window.md`, and the spec here is a rulebook rather
 * than a feature: its job is to make the readout a FUNCTION of the numbers, so no metric can be
 * reinterpreted once the numbers exist. Four plan-review rounds found three ways it wasn't one, and
 * every one of those is a test below — they are regressions against real holes, not hypotheticals:
 *
 *   · a metric landing below its band but within noise had NO defined outcome;
 *   · the PASS side ignored the spread, so a degraded incumbent rep LOWERED the bar (bands are
 *     multiplicative in the incumbent's mean) — more noise, easier shipping;
 *   · one-sided Q1/Q3 pointed the wrong way for entity fragmentation, so an arm could fragment the
 *     graph's identity layer and clear every gate.
 *
 * One condition per fixture: each test mutates exactly ONE field of `clean`, so a failure names its
 * own cause. `clean` itself is asserted to SHIP, or every mutation below would prove nothing.
 */

// Two reps per arm; the incumbent's own |rep1 - rep2| is the noise estimate.
const incumbent = {
  Q1: [10.0, 10.1], // entity yield / episode
  Q2: [0.9, 0.91], // people recall
  Q3: [0.3, 0.31], // IS_DUPLICATE_OF share (a fraction, not pp)
  Q4: [0.8, 0.81], // cross-chunk continuity
  Q5: [0.0, 0.01], // signed retry gap
  Q6: [1.0, 1.02], // entity nodes per member name
  C1: [40000, 40100], // input tokens / episode
};

const cleanArm = {
  Q1: [10.0, 10.0],
  Q2: [0.9, 0.9],
  Q3: [0.3, 0.3],
  Q4: [0.8, 0.8],
  Q5: [0.0, 0.0],
  Q6: [1.0, 1.0],
  C1: [24000, 24000], // a 40% fall, comfortably past the 25% C1 demands
};

const session = { incumbent, dupeShare: 0.305, dupeEdges: 900 };

const run = (over: Record<string, unknown> = {}, armOver: Record<string, number[]> = {}) =>
  decide({
    session: assessSession({ ...session, ...over }),
    incumbent,
    arms: [{ name: "SAME", metrics: { ...cleanArm, ...armOver } }],
  });

describe("the baseline is non-vacuous", () => {
  it("ships an arm that beats every band by more than the incumbent's own spread", () => {
    const d = run();
    expect(d.outcome).toBe("SHIP");
    expect(d.winner).toBe("SAME");
  });

  it("gates on every metric the spec names — a metric silently dropped from METRICS is a gate that stops existing", () => {
    expect(Object.keys(METRICS).sort()).toEqual(["C1", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]);
    expect(run().arms[0].results).toHaveLength(7);
  });
});

describe("the fragmentation direction — the hole that made Q1 and Q3 two-sided", () => {
  /**
   * Stripping unrelated predecessors removes the context `_resolve_with_llm` uses to decide whether
   * extracted-"John" IS candidate-"John Smith", so the model stops merging. The result is the same
   * person as several parallel nodes — the AIO-693 class. Under the one-sided bands of the first
   * draft it cleared every gate, because it moves each metric in the PASSING direction.
   */
  it("FAILS an arm whose entity yield RISES — one-sided Q1 called this a pass", () => {
    const d = run({}, { Q1: [11.5, 11.5] }); // +14% against a ±10% band
    expect(d.outcome).toBe("NO_SHIP");
    expect(d.arms[0].blocking.map((b: { key: string }) => b.key)).toEqual(["Q1"]);
    expect(d.arms[0].results.find((r: { key: string }) => r.key === "Q1").verdict).toBe(VERDICT.FAIL);
  });

  it("FAILS an arm whose duplicate share FALLS — a failure-to-merge emits no IS_DUPLICATE_OF edge at all", () => {
    const d = run({}, { Q3: [0.23, 0.23] }); // -7.5pp against a ±5pp band
    expect(d.arms[0].results.find((r: { key: string }) => r.key === "Q3").verdict).toBe(VERDICT.FAIL);
    expect(d.outcome).toBe("NO_SHIP");
  });

  it("FAILS an arm that fragments a member name across more nodes (Q6)", () => {
    const d = run({}, { Q6: [1.2, 1.2] }); // +18% against a ≤105% band
    expect(d.arms[0].results.find((r: { key: string }) => r.key === "Q6").verdict).toBe(VERDICT.FAIL);
  });
});

describe("INCONCLUSIVE blocks exactly as FAIL does", () => {
  it("does not ship a metric that misses its band by less than the incumbent's spread", () => {
    // Q4's band is 85% of the incumbent; the incumbent's spread here is ~1.2% of its mean, so a value
    // just under the edge lands inside the noise and must NOT be read as a pass.
    const d = run({}, { Q4: [0.6825, 0.6825] }); // ratio ≈ 0.8478, band 0.85, tolerance ≈ 0.0124
    const q4 = d.arms[0].results.find((r: { key: string }) => r.key === "Q4");
    expect(q4.verdict).toBe(VERDICT.INCONCLUSIVE);
    expect(d.outcome).toBe("NO_SHIP");
  });

  it("does not ship a metric that BEATS its band by less than the spread either — the symmetric half", () => {
    // Just above the edge. The asymmetric rule this replaced called it PASS.
    const d = run({}, { Q4: [0.688, 0.688] }); // ratio ≈ 0.8547, band 0.85, tolerance ≈ 0.0124
    const q4 = d.arms[0].results.find((r: { key: string }) => r.key === "Q4");
    expect(q4.verdict).toBe(VERDICT.INCONCLUSIVE);
    expect(d.outcome).toBe("NO_SHIP");
  });
});

describe("noise is strictly ANTI-ship — the review's worked counterexample", () => {
  /**
   * True incumbent yield 10.0, true arm value 8.5 — a real 15% regression that must fail a 90% band.
   * One incumbent rep is quietly degraded (a provider brownout that still completes every episode,
   * so it trips no completion check). Mean falls to 8.1, and because the band is MULTIPLICATIVE in
   * that mean, the bar falls with it to 7.29 — and 8.5 clears it. That is how the asymmetric rule let
   * noise work in the shipping direction.
   */
  const degraded = { ...incumbent, Q1: [10.2, 6.0] };

  it("invalidates the session before the arm is even judged — the spread ceiling catches it first", () => {
    const s = assessSession({ ...session, incumbent: degraded });
    expect(s.valid).toBe(false);
    expect(s.problems.join(" ")).toMatch(/Q1 incumbent spread/);
  });

  it("and if the ceiling were removed, the symmetric band still refuses to call it a PASS", () => {
    // Judged directly, bypassing session validity: 8.5 against a lowered 7.29 bar, with a spread of
    // 4.2 (52% of the mean) as the tolerance. The asymmetric rule shipped this.
    const q1 = judgeMetric("Q1", [8.5, 8.5], degraded.Q1);
    expect(q1.verdict).not.toBe(VERDICT.PASS);
  });
});

describe("the C1 gate — a quality-clean arm that barely moves tokens does not ship", () => {
  it("FAILS a token fall short of the 25% the deploy has to earn", () => {
    const d = run({}, { C1: [36000, 36000] }); // a 10% fall
    expect(d.arms[0].results.find((r: { key: string }) => r.key === "C1").verdict).toBe(VERDICT.FAIL);
    expect(d.outcome).toBe("NO_SHIP");
  });

  it("FAILS a retry-gap rise beyond 3pp, since retries inflate C1's attempt denominator", () => {
    const d = run({}, { Q5: [0.05, 0.05] }); // +4.5pp against a +3pp band
    expect(d.arms[0].results.find((r: { key: string }) => r.key === "Q5").verdict).toBe(VERDICT.FAIL);
  });
});

describe("session validity — every trigger is pre-defined, and none of them is 'the numbers came out wrong'", () => {
  it("INVALID when the cross-check is unavailable — the harness prints a ratio anyway, which is why this refuses", () => {
    const d = run({ crossCheckAvailable: false });
    expect(d.outcome).toBe("INVALID");
    expect(d.reasons.join(" ")).toMatch(/cross-check/);
  });

  it("INVALID when a metric is UNDERPOWERED — a corpus too thin to measure is not evidence of a regression", () => {
    const d = run({ underpowered: ["Q6"] });
    expect(d.outcome).toBe("INVALID");
    expect(d.reasons.join(" ")).toMatch(/UNDERPOWERED/);
  });

  it("INVALID when an arm did not complete every episode", () => {
    expect(run({ armsCompleted: false }).outcome).toBe("INVALID");
  });

  it("INVALID when the harness itself refused the window", () => {
    expect(run({ harnessRefused: true }).outcome).toBe("INVALID");
  });

  it("INVALID when the incumbent's duplicate share is above extraction-health's own DEDUPE_ABSOLUTE_FLOOR", () => {
    const d = run({ dupeShare: 0.7 }); // the degraded model's reading
    expect(d.outcome).toBe("INVALID");
    expect(d.reasons.join(" ")).toMatch(/duplicate share/);
  });

  it("INVALID when the incumbent's duplicate share is near zero — that means the PREDICATE is broken, not the graph clean", () => {
    expect(run({ dupeShare: 0.01 }).outcome).toBe("INVALID");
  });

  it("INVALID below the 200-edge minimum the health module also refuses to judge under", () => {
    const d = run({ dupeEdges: 150 });
    expect(d.outcome).toBe("INVALID");
    expect(d.reasons.join(" ")).toMatch(/200-edge/);
  });

  it("an INVALID session yields no arm verdicts at all — a broken instrument reports no result", () => {
    expect(run({ crossCheckAvailable: false }).arms).toEqual([]);
  });
});

describe("the spread ceiling is per-metric and in BAND units, not a fraction of the mean", () => {
  /**
   * "Spread > 25% of the mean" was degenerate at both ends. Q5's healthy mean is ~0, so 25% of it is
   * ~0 and a single retry in one incumbent rep would have invalidated every session — the battery
   * could never have completed a valid run.
   */
  it("tolerates one retry of rep-to-rep difference on Q5, whose healthy mean is ~0", () => {
    const s = assessSession({ ...session, incumbent: { ...incumbent, Q5: [0.0, 0.01] } });
    expect(s.valid).toBe(true);
  });

  it("but not two — 1.5pp is half of Q5's 3pp band", () => {
    const s = assessSession({ ...session, incumbent: { ...incumbent, Q5: [0.0, 0.02] } });
    expect(s.valid).toBe(false);
    expect(s.problems.join(" ")).toMatch(/Q5 incumbent spread/);
  });

  it("refuses a Q3 spread that would leave its two-sided PASS window EMPTY", () => {
    // The old ceiling allowed 7.5pp against a ±5pp band: valid by the rules, unpassable by any arm.
    const s = assessSession({ ...session, incumbent: { ...incumbent, Q3: [0.27, 0.345] } }); // 7.5pp
    expect(s.valid).toBe(false);
  });

  it("GUARANTEES a non-empty PASS window at the ceiling — for every gated metric", () => {
    // The structural property the old ceiling lacked. At exactly half the band margin there must
    // still exist an arm value that PASSes, or the procedure can deadlock mid-experiment.
    for (const key of Object.keys(METRICS)) {
      const m = METRICS[key as keyof typeof METRICS] as { kind: string; margin: number };
      const base = incumbent[key as keyof typeof incumbent] as number[];
      const baseMean = (base[0] + base[1]) / 2;
      // Sit the arm exactly on the incumbent's own value: the most favourable value there is.
      const armAt = m.kind === "ratio-fall" ? [baseMean * (1 - m.margin) * 0.5, baseMean * (1 - m.margin) * 0.5] : [baseMean, baseMean];
      expect(judgeMetric(key, armAt, base).verdict, `${key} has no passable value at its ceiling`).toBe(VERDICT.PASS);
    }
  });
});

describe("arm order — SAME is evaluated before the blunt W1 fallback", () => {
  it("ships W1 when SAME fails, and names W1 as the winner", () => {
    const d = decide({
      session: assessSession(session),
      incumbent,
      arms: [
        { name: "SAME", metrics: { ...cleanArm, Q4: [0.5, 0.5] } },
        { name: "W1", metrics: cleanArm },
      ],
    });
    expect(d.outcome).toBe("SHIP");
    expect(d.winner).toBe("W1");
  });

  it("ships SAME when BOTH pass — the first arm wins, never the better-looking one", () => {
    const d = decide({
      session: assessSession(session),
      incumbent,
      arms: [
        { name: "SAME", metrics: cleanArm },
        { name: "W1", metrics: { ...cleanArm, C1: [10000, 10000] } }, // a far bigger token cut
      ],
    });
    expect(d.winner).toBe("SAME");
  });

  it("NO_SHIP when neither arm clears, and says the negative result gets committed", () => {
    const d = decide({
      session: assessSession(session),
      incumbent,
      arms: [
        { name: "SAME", metrics: { ...cleanArm, Q4: [0.5, 0.5] } },
        { name: "W1", metrics: { ...cleanArm, Q2: [0.5, 0.5] } },
      ],
    });
    expect(d.outcome).toBe("NO_SHIP");
    expect(d.winner).toBeNull();
    expect(d.reasons.join(" ")).toMatch(/negative result/);
  });
});

describe("the two-rep requirement is structural, not stylistic", () => {
  it("refuses a single-rep arm — the second rep IS the noise estimate", () => {
    expect(() => judgeMetric("Q1", [10.0], incumbent.Q1)).toThrow(/2 reps/);
  });

  it("refuses a single-rep incumbent for the same reason", () => {
    expect(() => judgeMetric("Q1", [10.0, 10.0], [10.0])).toThrow(/2 reps/);
  });
});
