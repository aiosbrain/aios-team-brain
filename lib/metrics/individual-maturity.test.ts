import { describe, expect, it } from "vitest";
import { scoreAxes, spineLevel, placement, type AemSignals } from "./individual-maturity";

// Spec-first: assertions derive from the AEM rubric (04-assessment-rubrics.md §1),
// not from reading the implementation. The canonical brain scorer MUST agree with
// the client scorer (scripts/analyze/aem.mjs) — these guard the shared thresholds
// and the core rule: Spine is capped at L3 when Verification ≤ 1.

const ZERO: AemSignals = {
  delegation_ratio: 0, correction_loop_avg: 0, error_rate: 0, cost_per_task: 0,
  tokens_per_task: 0, cache_hit_rate: 0, tool_diversity: 0, verify_tool_rate: 0,
  subagent_usage: 0,
};

describe("AEM canonical scoring", () => {
  it("scores all axes 0 for an empty signal set", () => {
    expect(scoreAxes(ZERO)).toEqual({
      verification: 0, context_hygiene: 0, autonomy: 0, learning: 0, cost_governance: 0,
    });
  });

  it("verification reflects verify-tool rate bands", () => {
    expect(scoreAxes({ ...ZERO, verify_tool_rate: 0.3 }).verification).toBe(4);
    expect(scoreAxes({ ...ZERO, verify_tool_rate: 0.12 }).verification).toBe(3);
    expect(scoreAxes({ ...ZERO, verify_tool_rate: 0.04 }).verification).toBe(2);
    expect(scoreAxes({ ...ZERO, verify_tool_rate: 0 }).verification).toBe(0);
  });

  it("learning axis is capped at 3 (cross-session compounding is unobservable from logs)", () => {
    expect(scoreAxes({ ...ZERO, tool_diversity: 50 }).learning).toBe(3);
  });

  it("cost & governance uses fresh-tokens-per-task inverted bands", () => {
    expect(scoreAxes({ ...ZERO, tokens_per_task: 10_000 }).cost_governance).toBe(4);
    expect(scoreAxes({ ...ZERO, tokens_per_task: 250_000 }).cost_governance).toBe(1);
  });

  // The core rule of the model.
  it("GATE: caps Spine at L3 when verification ≤ 1, even with everything else strong", () => {
    const strong: AemSignals = {
      ...ZERO, verify_tool_rate: 0, cache_hit_rate: 0.8, delegation_ratio: 0.3,
      subagent_usage: 0.5, tool_diversity: 8, tokens_per_task: 10_000,
    };
    const axes = scoreAxes(strong);
    expect(axes.verification).toBe(0);
    expect(spineLevel(axes, strong)).toBe("L3");
  });

  it("climbs past L3 once verification is present alongside autonomy", () => {
    const strong: AemSignals = {
      ...ZERO, verify_tool_rate: 0.3, cache_hit_rate: 0.8, delegation_ratio: 0.3,
      subagent_usage: 0.5, tool_diversity: 8, tokens_per_task: 10_000,
    };
    const lvl = spineLevel(scoreAxes(strong), strong);
    expect(["L4", "L5"]).toContain(lvl);
  });

  it("placement returns axes + spine + a 0–4 overall", () => {
    const p = placement({ ...ZERO, verify_tool_rate: 0.3, cache_hit_rate: 0.6, tokens_per_task: 30_000 });
    expect(p.spine).toMatch(/^L[1-5]$/);
    expect(p.overall).toBeGreaterThanOrEqual(0);
    expect(p.overall).toBeLessThanOrEqual(4);
  });
});
