import { describe, expect, it } from "vitest";
import { recencyFactor, scoreCandidate } from "@/lib/social/discover-score";

/**
 * Spec for the discovery scoring heuristic. Derived from the ranking intent (recent, substantial,
 * high-signal-kind items should score higher), not the implementation. All scores stay in 0..1.
 */
const DAY = 86_400_000;

describe("discovery scoring", () => {
  it("recency decays by half every half-life and stays in 0..1", () => {
    expect(recencyFactor(0)).toBe(1);
    expect(recencyFactor(14 * DAY, 14)).toBeCloseTo(0.5, 5);
    expect(recencyFactor(28 * DAY, 14)).toBeCloseTo(0.25, 5);
    expect(recencyFactor(10_000 * DAY)).toBeGreaterThanOrEqual(0);
  });

  it("ranks a decision above a raw artifact of equal age/substance (relevance)", () => {
    const base = { updatedAtMs: 0, nowMs: 0, bodyLength: 600, hasTitle: true };
    expect(scoreCandidate({ ...base, kind: "decision" }).relevance).toBeGreaterThan(
      scoreCandidate({ ...base, kind: "artifact" }).relevance
    );
  });

  it("a fresh item is more novel than a stale one", () => {
    const fresh = scoreCandidate({ kind: "decision", updatedAtMs: 100 * DAY, nowMs: 100 * DAY, bodyLength: 300, hasTitle: true });
    const stale = scoreCandidate({ kind: "decision", updatedAtMs: 0, nowMs: 100 * DAY, bodyLength: 300, hasTitle: true });
    expect(fresh.novelty).toBeGreaterThan(stale.novelty);
  });

  it("substance + title drive confidence; all scores stay within 0..1", () => {
    const thin = scoreCandidate({ kind: "deliverable", updatedAtMs: 0, nowMs: 0, bodyLength: 10, hasTitle: false });
    const rich = scoreCandidate({ kind: "deliverable", updatedAtMs: 0, nowMs: 0, bodyLength: 800, hasTitle: true });
    expect(rich.confidence).toBeGreaterThan(thin.confidence);
    for (const s of [thin, rich]) {
      for (const v of Object.values(s)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});
