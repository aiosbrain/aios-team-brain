import { describe, expect, it } from "vitest";
import { maturitySnapshotPayloadSchema } from "@/lib/api/schemas";

// Spec (brain-api v1.3): ce_band is a shadow, provenance-only 0-4 integer with NO default —
// an omitted field must stay distinguishable (undefined) from an explicit null, so an older
// client's re-push can't accidentally clear a previously stored band.

function payload(over: Record<string, unknown> = {}) {
  return {
    date: "2026-07-04",
    signals: {
      delegation_ratio: 0.3, correction_loop_avg: 1.2, error_rate: 0.05,
      cost_per_task: 0.4, tokens_per_task: 30_000, cache_hit_rate: 0.8,
      tool_diversity: 8, verify_tool_rate: 0.3, subagent_usage: 0.5,
    },
    ...over,
  };
}

describe("maturitySnapshotPayloadSchema — ce_band (v1.3)", () => {
  it("accepts the boundary values 0 and 4", () => {
    expect(maturitySnapshotPayloadSchema.parse(payload({ ce_band: 0 })).ce_band).toBe(0);
    expect(maturitySnapshotPayloadSchema.parse(payload({ ce_band: 4 })).ce_band).toBe(4);
  });

  it("accepts explicit null", () => {
    expect(maturitySnapshotPayloadSchema.parse(payload({ ce_band: null })).ce_band).toBeNull();
  });

  it("stays undefined when omitted (distinguishable from explicit null)", () => {
    expect(maturitySnapshotPayloadSchema.parse(payload()).ce_band).toBeUndefined();
  });

  it("rejects out-of-range and non-integer values", () => {
    expect(() => maturitySnapshotPayloadSchema.parse(payload({ ce_band: 5 }))).toThrow();
    expect(() => maturitySnapshotPayloadSchema.parse(payload({ ce_band: -1 }))).toThrow();
    expect(() => maturitySnapshotPayloadSchema.parse(payload({ ce_band: 2.5 }))).toThrow();
    expect(() => maturitySnapshotPayloadSchema.parse(payload({ ce_band: "3" }))).toThrow();
  });
});
