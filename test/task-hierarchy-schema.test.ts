import { describe, expect, it } from "vitest";
import { taskRowSchema, normalizeTaskPriority, TASK_PRIORITIES } from "@/lib/api/schemas";

// Spec (brain-api v1.12): task rows keep optional parent/labels/priority; `body` is NOT a contract
// field (dashboard/DB-only) and strict row parsing must reject it. Priority normalizes to the
// allowed set with a few common aliases.

describe("normalizeTaskPriority", () => {
  it("passes through the allowed set", () => {
    for (const p of TASK_PRIORITIES) expect(normalizeTaskPriority(p)).toBe(p);
  });
  it("is case/space-insensitive", () => {
    expect(normalizeTaskPriority(" High ")).toBe("high");
    expect(normalizeTaskPriority("URGENT")).toBe("urgent");
  });
  it("maps common aliases", () => {
    expect(normalizeTaskPriority("critical")).toBe("urgent");
    expect(normalizeTaskPriority("p0")).toBe("urgent");
    expect(normalizeTaskPriority("p1")).toBe("high");
    expect(normalizeTaskPriority("p2")).toBe("medium");
    expect(normalizeTaskPriority("p3")).toBe("low");
  });
  it("unknown / empty / null → none", () => {
    expect(normalizeTaskPriority("")).toBe("none");
    expect(normalizeTaskPriority(null)).toBe("none");
    expect(normalizeTaskPriority(undefined)).toBe("none");
    expect(normalizeTaskPriority("banana")).toBe("none");
  });
});

describe("taskRowSchema (v1.2 hierarchy)", () => {
  it("accepts parent / labels / priority", () => {
    const r = taskRowSchema.parse({
      row_key: "P0.1",
      title: "Register MCP",
      parent: "P0",
      labels: ["integration", "wave-1"],
      priority: "high",
    });
    expect(r.parent).toBe("P0");
    expect(r.labels).toEqual(["integration", "wave-1"]);
    expect(r.priority).toBe("high");
  });

  it("rejects `body` because it is not a contract field", () => {
    expect(() =>
      taskRowSchema.parse({
        row_key: "T-1",
        title: "x",
        body: "this must be rejected",
      }),
    ).toThrow();
  });

  it("omitting hierarchy fields is valid (six-column rows)", () => {
    const r = taskRowSchema.parse({ row_key: "T-1", title: "x" });
    expect(r.parent).toBeUndefined();
    expect(r.labels).toBeUndefined();
    expect(r.priority).toBeUndefined();
  });

  it("rejects a non-string label entry", () => {
    expect(() => taskRowSchema.parse({ row_key: "T-1", title: "x", labels: [1, 2] })).toThrow();
  });
});
