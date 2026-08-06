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

const session = { incumbent, dupeShare: 0.305, dupeEdges: 900, armsCompleted: true, harnessRefused: false, crossCheckAvailable: true };

const run = (over: Record<string, unknown> = {}, armOver: Record<string, number[]> = {}) =>
  decide({
    session: assessSession({ ...session, ...over }),
    incumbent,
    arms: [{ name: "SAME", metrics: { ...cleanArm, ...armOver }, extras: { personsLost: 0 } }],
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
    const q1 = judgeMetric("Q1", [8.5, 8.5], degraded.Q1, {});
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

  it("GUARANTEES a non-empty PASS window AT the ceiling — for every gated metric", () => {
    // The structural property the old ceiling lacked, tested where it actually binds. An earlier
    // version of this test used the shared fixture, whose spreads sit ~1/50th of the ceiling — so it
    // would have stayed green if a future edit raised a maxSpread constant above margin/2 and
    // re-opened the deadlock. Here each incumbent is built so its spread EQUALS the ceiling.
    for (const key of Object.keys(METRICS)) {
      const m = METRICS[key as keyof typeof METRICS] as {
        kind: string;
        margin: number;
        maxSpreadRatio?: number;
        maxSpreadPp?: number;
        absolute?: { input: string };
      };
      const mean = m.kind.startsWith("pp") ? 0.3 : 10;
      const ceiling = m.maxSpreadRatio !== undefined ? m.maxSpreadRatio * mean : (m.maxSpreadPp as number);
      const base = [mean - ceiling / 2, mean + ceiling / 2];
      // The most favourable arm there is: the incumbent's own value, except for C1, where the band
      // demands a fall rather than tolerating drift.
      const best = m.kind === "ratio-fall" ? mean * (1 - m.margin) * 0.5 : mean;
      const extras = m.absolute ? { [m.absolute.input]: 0 } : {};

      // Precondition: this incumbent is exactly at — not over — the validity ceiling.
      const sess = assessSession({
        incumbent: { [key]: base },
        dupeShare: 0.305,
        dupeEdges: 900,
        armsCompleted: true,
        harnessRefused: false,
        crossCheckAvailable: true,
      });
      expect(sess.problems.join(" "), `${key} fixture should sit at the ceiling, not over it`).not.toMatch(key);

      expect(judgeMetric(key, [best, best], base, extras).verdict, `${key} has no passable value at its ceiling`).toBe(
        VERDICT.PASS
      );
    }
  });
});

describe("arm order — SAME is evaluated before the blunt W1 fallback", () => {
  it("ships W1 when SAME fails, and names W1 as the winner", () => {
    const d = decide({
      session: assessSession(session),
      incumbent,
      arms: [
        { name: "SAME", metrics: { ...cleanArm, Q4: [0.5, 0.5] }, extras: { personsLost: 0 } },
        { name: "W1", metrics: cleanArm, extras: { personsLost: 0 } },
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
        { name: "SAME", metrics: cleanArm, extras: { personsLost: 0 } },
        { name: "W1", metrics: { ...cleanArm, C1: [10000, 10000] }, extras: { personsLost: 0 } }, // a far bigger token cut
      ],
    });
    expect(d.winner).toBe("SAME");
  });

  it("NO_SHIP when neither arm clears, and says the negative result gets committed", () => {
    const d = decide({
      session: assessSession(session),
      incumbent,
      arms: [
        { name: "SAME", metrics: { ...cleanArm, Q4: [0.5, 0.5] }, extras: { personsLost: 0 } },
        { name: "W1", metrics: { ...cleanArm, Q2: [0.5, 0.5] }, extras: { personsLost: 0 } },
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

describe("Q2's second clause — the one that bites where the ratio is weakest", () => {
  /**
   * The spec gates Q2 on TWO floors: "≥ 95% of W10 AND at most 1 person lost outright". The first
   * version of this file implemented only the ratio, so at small n — where "95%" of 12 names rounds
   * to "lose none" — an arm losing two known people outright would have shipped. A gate clause left
   * outside the executable procedure is the interpretive joint this file exists to close.
   */
  it("FAILS an arm that loses 2 people outright even when the recall RATIO passes", () => {
    const d = decide({
      session: assessSession(session),
      incumbent,
      arms: [{ name: "SAME", metrics: cleanArm, extras: { personsLost: 2 } }],
    });
    const q2 = d.arms[0].results.find((r: { key: string }) => r.key === "Q2");
    expect(q2.verdict).toBe(VERDICT.FAIL);
    expect(q2.absoluteBreach).toMatch(/2 people lost outright/);
    expect(d.outcome).toBe("NO_SHIP");
  });

  it("allows exactly 1 — the clause is 'at most 1', not 'none'", () => {
    const d = decide({
      session: assessSession(session),
      incumbent,
      arms: [{ name: "SAME", metrics: cleanArm, extras: { personsLost: 1 } }],
    });
    expect(d.outcome).toBe("SHIP");
  });

  it("REFUSES to judge when the count was never measured — omission must not read as satisfied", () => {
    expect(() => judgeMetric("Q2", cleanArm.Q2, incumbent.Q2, {})).toThrow(/personsLost/);
  });

  it("is noise-free: a huge incumbent spread cannot rescue a 2-person loss", () => {
    // Deliberate: any tolerance on an integer count would make "lost 2" and "lost 0" indistinguishable
    // and delete the floor. Losing two known people is not a statistical question.
    const q2 = judgeMetric("Q2", cleanArm.Q2, [0.9, 0.2], { personsLost: 2 });
    expect(q2.verdict).toBe(VERDICT.FAIL);
  });
});

describe("assessSession refuses to run on missing safety inputs", () => {
  /**
   * These used to default permissive (`armsCompleted = true`, `crossCheckAvailable = true`), so a
   * runner that forgot to pass one silently disarmed that validity trigger. Same class as the
   * absolute-clause omission above, in the file whose whole job is that the readout cannot be
   * quietly softened.
   */
  it.each(["dupeShare", "dupeEdges", "armsCompleted", "harnessRefused", "crossCheckAvailable"])(
    "throws when %s is omitted rather than treating it as fine",
    (field) => {
      const full = { incumbent, dupeShare: 0.305, dupeEdges: 900, armsCompleted: true, harnessRefused: false, crossCheckAvailable: true };
      const { [field as keyof typeof full]: _omitted, ...rest } = full;
      expect(() => assessSession(rest)).toThrow(new RegExp(field));
    }
  );
});
