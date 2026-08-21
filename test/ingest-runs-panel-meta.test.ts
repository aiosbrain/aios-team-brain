import { describe, expect, it } from "vitest";
import { formatMetaValue } from "@/components/admin/ingest-runs-panel";

// GRAPHSAT-1 (Codex design round 2 H2): the runs panel rendered object meta values as `[object Object]`
// — `partialDetail` already did, and `deepRequeueSample` is a list of structured identities.
describe("RunMeta value formatting", () => {
  it("renders objects and arrays as compact JSON, scalars as before", () => {
    expect(formatMetaValue({ g: 2 })).toBe('{"g":2}');
    expect(formatMetaValue([{ itemId: "i" }])).toBe('[{"itemId":"i"}]');
    expect(formatMetaValue(3)).toBe("3");
    expect(formatMetaValue("x")).toBe("x");
    expect(formatMetaValue(false)).toBe("false");
  });
});
