import { describe, expect, it } from "vitest";
import {
  effectiveProjectable,
  projectableChanged,
  persistedChanged,
  normalizeDue,
  type ProjectableSnapshot,
} from "@/lib/ingest/projectable-diff";
import { taskRowSchema } from "@/lib/api/schemas";

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

  it("a parsed row that omitted assignee still preserves the snapshot", () => {
    const s = snap({ title: "T", assignee: "Chetan" });
    const parsed = taskRowSchema.parse({ row_key: "T-1", title: "T" });
    expect("assignee" in parsed).toBe(false);
    expect(projectableChanged(s, effectiveProjectable(parsed, s))).toBe(false);
    expect(effectiveProjectable(parsed, s).assignee).toBe("Chetan");
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

// Spec: `persistedChanged` is the WIDER predicate that gates tasks.updated_at — the projected set
// PLUS due_date. A due-only edit is a real edit (bumps updated_at) but must NOT re-project.
describe("persistedChanged (updated_at gate = projected ∪ due_date)", () => {
  it("a brand-new row is always persisted-changed", () => {
    expect(persistedChanged(null, effectiveProjectable({ title: "x" }, null), null, null)).toBe(true);
  });

  it("a due-only change: NOT projectable, but IS persisted (so updated_at bumps, projection doesn't)", () => {
    const s = snap({ title: "T", status: "ready" });
    const eff = effectiveProjectable({ title: "T", status: "ready" }, s);
    expect(projectableChanged(s, eff)).toBe(false); // no board re-projection
    expect(persistedChanged(s, eff, "2026-07-01", "2026-07-09")).toBe(true); // but a real edit
  });

  it("nothing changed (same projected + same due) is NOT persisted-changed → updated_at preserved", () => {
    const s = snap({ title: "T", status: "ready" });
    const eff = effectiveProjectable({ title: "T", status: "ready" }, s);
    expect(persistedChanged(s, eff, "2026-07-01", "2026-07-01")).toBe(false);
  });

  it("a projected change implies a persisted change", () => {
    const s = snap({ status: "backlog" });
    const eff = effectiveProjectable({ title: "T", status: "in_progress" }, s);
    expect(persistedChanged(s, eff, null, null)).toBe(true);
  });

  it("due comparison is date-granular and tolerates Date | ISO | null", () => {
    expect(normalizeDue(new Date("2026-07-09T13:00:00Z"))).toBe("2026-07-09");
    expect(normalizeDue("2026-07-09")).toBe("2026-07-09");
    expect(normalizeDue(null)).toBe("");
    const s = snap({ title: "T" });
    const eff = effectiveProjectable({ title: "T" }, s);
    // same calendar day, different representations → not a change
    expect(persistedChanged(s, eff, new Date("2026-07-09T00:00:00Z"), "2026-07-09")).toBe(false);
  });
});
