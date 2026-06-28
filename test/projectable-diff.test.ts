import { describe, expect, it } from "vitest";
import {
  effectiveProjectable,
  projectableChanged,
  type ProjectableSnapshot,
} from "@/lib/ingest/projectable-diff";

// Spec: the reactive push path re-projects ONLY rows whose projected fields changed. Projected set is
// title · normalized status · sprint · priority · labels · parent_row_key · assignee — NOT due/body.

const snap = (over: Partial<ProjectableSnapshot> = {}): ProjectableSnapshot => ({
  title: "T",
  status: "backlog",
  sprint: "",
  priority: "none",
  labels: [],
  parent_row_key: null,
  assignee: "",
  ...over,
});

describe("projectable-diff (changed-rows predicate)", () => {
  it("a brand-new row (no snapshot) is always changed", () => {
    expect(projectableChanged(null, effectiveProjectable({ title: "x" }, null))).toBe(true);
  });

  it("identical projected values are unchanged (a due-only edit never trips this)", () => {
    const s = snap({ title: "x", status: "ready" });
    // Re-emits title/status with the same values; due_date isn't in the projected set.
    expect(projectableChanged(s, effectiveProjectable({ title: "x", status: "ready" }, s))).toBe(false);
  });

  it("an assignee change IS a change (assignee is now projected); same assignee is not", () => {
    const s = snap({ title: "T", assignee: "Chetan" });
    expect(projectableChanged(s, effectiveProjectable({ title: "T", assignee: "Chetan" }, s))).toBe(false);
    expect(projectableChanged(s, effectiveProjectable({ title: "T", assignee: "John" }, s))).toBe(true);
    // a present-but-empty assignee clears it (change); an absent assignee key preserves the snapshot
    expect(projectableChanged(s, effectiveProjectable({ title: "T", assignee: "" }, s))).toBe(true);
    expect(projectableChanged(s, effectiveProjectable({ title: "T" }, s))).toBe(false);
  });

  it("a title change is changed", () => {
    const s = snap({ title: "old" });
    expect(projectableChanged(s, effectiveProjectable({ title: "new" }, s))).toBe(true);
  });

  it("a status change is changed (normalized)", () => {
    const s = snap({ status: "backlog" });
    expect(projectableChanged(s, effectiveProjectable({ title: "T", status: "In Progress" }, s))).toBe(true);
  });

  it("a label reorder is NOT a change (order-independent)", () => {
    const s = snap({ labels: ["a", "b"] });
    expect(projectableChanged(s, effectiveProjectable({ title: "T", labels: ["b", "a"] }, s))).toBe(false);
  });

  it("a label add IS a change", () => {
    const s = snap({ labels: ["a"] });
    expect(projectableChanged(s, effectiveProjectable({ title: "T", labels: ["a", "c"] }, s))).toBe(true);
  });

  it("a priority alias that resolves to the same value is unchanged", () => {
    const s = snap({ priority: "urgent" });
    expect(projectableChanged(s, effectiveProjectable({ title: "T", priority: "critical" }, s))).toBe(false);
  });

  it("a real priority change is changed", () => {
    const s = snap({ priority: "high" });
    expect(projectableChanged(s, effectiveProjectable({ title: "T", priority: "low" }, s))).toBe(true);
  });

  it("absent partial keys preserve the snapshot (no change)", () => {
    const s = snap({ title: "T", labels: ["a"], priority: "high", parent_row_key: "E" });
    const eff = effectiveProjectable({ title: "T" }, s); // six-col push: no labels/priority/parent keys
    expect(eff.labels).toEqual(["a"]);
    expect(eff.priority).toBe("high");
    expect(eff.parent_row_key).toBe("E");
    expect(projectableChanged(s, eff)).toBe(false);
  });

  it("a present-but-empty parent clears it (change)", () => {
    const s = snap({ parent_row_key: "E" });
    const eff = effectiveProjectable({ title: "T", parent: "" }, s);
    expect(eff.parent_row_key).toBeNull();
    expect(projectableChanged(s, eff)).toBe(true);
  });

  it("a parent re-point is changed", () => {
    const s = snap({ parent_row_key: "E1" });
    expect(projectableChanged(s, effectiveProjectable({ title: "T", parent: "E2" }, s))).toBe(true);
  });

  it("a null-priority snapshot vs an absent priority key is unchanged (none ≡ null)", () => {
    const s = snap({ priority: "none" });
    expect(projectableChanged(s, effectiveProjectable({ title: "T" }, s))).toBe(false);
  });
});
