import { describe, expect, it } from "vitest";
import { mergeTimelineSlackContinuation as merge } from "@/lib/dashboard/timeline-continuation-merge";
import type { EvidenceItem, PersonDay, SourceGroup, TaskGroup, TimelineDay } from "@/lib/dashboard/timeline-group";

const item = (id: string, at = "2026-09-19T12:00:00Z", source = "slack"): EvidenceItem =>
  ({ id, at, source, title: id, kind: "message" });
const group = (source: string, items: EvidenceItem[], count = items.length): SourceGroup =>
  ({ source, items, count });
const task = (taskId: string, sources: SourceGroup[]): TaskGroup => ({
  taskId, title: taskId, status: "in_progress", source: "linear", sources,
  evidenceCount: sources.reduce((n, g) => n + g.count, 0),
});
const person = (memberId: string, over: Partial<PersonDay> = {}): PersonDay => ({
  memberId, name: memberId, handle: memberId, total: 0, tasks: [], other: [], unlinked: 0,
  signals: [], ...over,
});
const day = (date: string, people: PersonDay[]): TimelineDay => ({ date, label: date, people });
const ids = (p: PersonDay) => p.tasks.flatMap((t) => t.sources.flatMap((g) => g.items.map((i) => i.id)));

describe("mergeTimelineSlackContinuation", () => {
  it("keeps same-date and same-person rows and recomputes task, source and person counts", () => {
    const initial = [day("2026-09-19", [person("m1", {
      total: 2, tasks: [task("t1", [group("slack", [item("a")])])],
      other: [group("slack", [item("other")])], unlinked: 1, summary: "Old synopsis",
    })])];
    const page = [day("2026-09-19", [
      person("m1", { tasks: [task("t1", [group("slack", [item("b"), item("a")])])] }),
      person("m2", { other: [group("slack", [item("c")])] }),
    ])];
    const result = merge(initial, page);
    expect(result).toHaveLength(1);
    expect(result[0].people.map((p) => p.memberId)).toEqual(["m1", "m2"]);
    expect(result[0].people[0]).toMatchObject({ total: 3, unlinked: 1, summary: undefined });
    expect(result[0].people[0].tasks[0]).toMatchObject({ evidenceCount: 2, sources: [{ count: 2 }] });
    expect(ids(result[0].people[0])).toEqual(["a", "b"]);
    expect(result[0].people[1]).toMatchObject({ total: 1, unlinked: 1 });
    expect(initial[0].people[0].summary).toBe("Old synopsis");
  });

  it("shows the same source evidence under two tasks but credits the person once", () => {
    const page = [day("2026-09-19", [person("m1", {
      tasks: [task("t2", [group("slack", [item("shared")])]), task("t1", [group("slack", [item("shared")])])],
    })])];
    const result = merge([], page)[0].people[0];
    expect(result.tasks.map((t) => t.taskId)).toEqual(["t1", "t2"]);
    expect(result.tasks.map((t) => t.evidenceCount)).toEqual([1, 1]);
    expect(result.total).toBe(1);
  });

  it("is independent of page order and replay, including empty pages and equal-time ordering", () => {
    const a = [
      day("2026-09-18", [person("m2", { other: [group("slack", [item("z", "2026-09-18T12:00:00Z")])] })]),
      day("2026-09-19", [person("m1", { tasks: [task("t1", [group("slack", [item("c")])])] })]),
    ];
    const b = [day("2026-09-19", [person("m1", {
      tasks: [task("t2", [group("slack", [item("b"), item("a")])])],
    })])];
    const forward = merge(merge(merge([], a), b), b);
    const reverse = merge(merge([], b), a);
    expect(forward).toEqual(reverse);
    expect(forward.map((d) => d.date)).toEqual(["2026-09-19", "2026-09-18"]);
    expect(ids(forward[0].people[0])).toEqual(["a", "b", "c"]);
    expect(merge(forward, [])).toEqual(forward);
  });

  it("preserves capped non-Slack counts and rows, meetings and signals", () => {
    const decision = { id: "d1", title: "Decision", kind: "decision" as const, at: "2026-09-19" };
    const existing = [day("2026-09-19", [person("m1", {
      total: 11, unlinked: 7, summary: "Old synopsis",
      tasks: [task("t1", [group("github", [item("git-1", "2026-09-19T09:00:00Z", "github")], 4)])],
      other: [group("notion", [item("doc", "2026-09-19T10:00:00Z", "notion")], 7),
        group("meetings", [], 0)],
      signals: [{ kind: "decision", count: 1, items: [decision] }],
    })])];
    const result = merge(existing, [day("2026-09-19", [person("m1", {
      tasks: [task("t1", [group("slack", [item("s1")])])],
    })])])[0].people[0];
    expect(result.total).toBe(12);
    expect(result.unlinked).toBe(7);
    expect(result.tasks[0].evidenceCount).toBe(5);
    expect(result.tasks[0].sources.find((g) => g.source === "github")).toEqual(existing[0].people[0].tasks[0].sources[0]);
    expect(result.other.find((g) => g.source === "notion")).toEqual(existing[0].people[0].other[0]);
    expect(result.signals).toEqual(existing[0].people[0].signals);
    expect(result.summary).toBeUndefined();
  });

  it("keeps a synopsis on exact replay and removes it when a new association arrives", () => {
    const initial = [day("2026-09-19", [person("m1", {
      summary: "Valid for a", total: 1, tasks: [task("t1", [group("slack", [item("a")])])],
    })])];
    const replay = [day("2026-09-19", [person("m1", { tasks: [task("t1", [group("slack", [item("a")])])] })])];
    expect(merge(initial, replay)[0].people[0].summary).toBe("Valid for a");
    const association = [day("2026-09-19", [person("m1", { tasks: [task("t2", [group("slack", [item("a")])])] })])];
    const changed = merge(initial, association)[0].people[0];
    expect(changed.total).toBe(1);
    expect(changed.summary).toBeUndefined();
  });

  it("refuses non-Slack, malformed, conflicting and capped-Slack inputs", () => {
    const good = [day("2026-09-19", [person("m1", { other: [group("slack", [item("a")])] })])];
    expect(() => merge([], [day("2026-09-19", [person("m1", { other: [group("github", [item("g", undefined, "github")])] })])])).toThrow(/non-Slack/);
    expect(() => merge([], [day("2026-09-19", [person("m1", { other: [group("slack", [{ ...item("a"), id: "" }])] })])])).toThrow(/Slack item/);
    expect(() => merge([], [day("2026-09-18", [person("m1", { other: [group("slack", [item("wrong-day")])] })])])).toThrow(/Slack item day/);
    expect(() => merge(good, [day("2026-09-19", [person("m1", { other: [group("slack", [{ ...item("a"), title: "conflict" }])] })])])).toThrow(/Conflicting Slack evidence/);
    expect(() => merge([], [day("2026-09-19", [person("m1", { tasks: [
      task("t1", [group("slack", [item("a")])]),
      task("t2", [group("slack", [{ ...item("a"), title: "different source row" }])]),
    ] })])])).toThrow(/Conflicting Slack source evidence/);
    expect(() => merge([day("2026-09-19", [person("m1", { other: [group("slack", [item("a")], 2)] })])], [])).toThrow(/capped initial Slack/);
  });
});
