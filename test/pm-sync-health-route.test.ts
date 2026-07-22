import { describe, expect, it } from "vitest";
import { parseProjectionRunLimit } from "@/app/api/v1/pm-sync/health/route";

describe("pm-sync health route", () => {
  it("defaults and clamps the requested run count", () => {
    expect(parseProjectionRunLimit(null)).toBe(10);
    expect(parseProjectionRunLimit("not-a-number")).toBe(10);
    expect(parseProjectionRunLimit("0")).toBe(1);
    expect(parseProjectionRunLimit("3.9")).toBe(3);
    expect(parseProjectionRunLimit("500")).toBe(50);
  });
});
