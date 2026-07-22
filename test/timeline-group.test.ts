import { describe, it, expect } from "vitest";
import {
  groupTimeline,
  normalizeSource,
  dayLabel,
  type EvidenceWithMember,
  type TaskInfo,
  type TaskSignal,
  type TimelineMember,
} from "@/lib/dashboard/timeline-group";

const members = new Map<string, TimelineMember>([
  ["m1", { name: "Chetan", handle: "chetan" }],
  ["m2", { name: "John", handle: "john" }],
]);

const taskInfo = new Map<string, TaskInfo>([
  ["t1", { title: "Provider adapter", status: "in_progress", source: "linear" }],
  ["t2", { title: "New ticket", status: "backlog", source: "linear" }],
]);

const ev = (over: Partial<EvidenceWithMember>): EvidenceWithMember => ({
  id: Math.random().toString(36).slice(2),
  memberId: "m1",
  title: "t",
  source: "github",
  kind: "commit",
  at: "2026-07-22T09:00:00Z",
  taskId: null,
  ...over,
});

const today = "2026-07-22";

describe("normalizeSource", () => {
  it("collapses git/github → github; passes known through; unknown → other", () => {
    expect(normalizeSource("git")).toBe("github");
    expect(normalizeSource("notion")).toBe("notion");
    expect(normalizeSource("mystery")).toBe("other");
  });
});

describe("dayLabel", () => {
  it("labels today/yesterday and formats others", () => {
    expect(dayLabel("2026-07-22", today)).toBe("Today");
    expect(dayLabel("2026-07-21", today)).toBe("Yesterday");
    expect(dayLabel("unknown", today)).toBe("Undated");
  });
});

describe("groupTimeline (task → evidence nesting + Other)", () => {
  it("nests linked evidence under its task, and unlinked evidence goes to Other", () => {
    const days = groupTimeline(
      [
        ev({ id: "c1", taskId: "t1", source: "github" }),
        ev({ id: "c2", taskId: "t1", source: "notion" }),
        ev({ id: "c3", taskId: null, source: "github" }), // unlinked → Other
      ],
      taskInfo,
      [],
      members,
      today
    );
    const person = days[0].people[0];
    expect(person.tasks).toHaveLength(1);
    expect(person.tasks[0].taskId).toBe("t1");
    expect(person.tasks[0].title).toBe("Provider adapter");
    expect(person.tasks[0].evidenceCount).toBe(2);
    expect(person.tasks[0].sources.map((s) => s.source).sort()).toEqual(["github", "notion"]);
    expect(person.other.map((s) => s.source)).toEqual(["github"]);
    expect(person.other[0].count).toBe(1);
  });

  it("a newly-assigned task SIGNAL shows as an (empty) task card with the flag set", () => {
    const signals: TaskSignal[] = [{ memberId: "m1", taskId: "t2", at: "2026-07-22T08:00:00Z", newlyAssigned: true }];
    const days = groupTimeline([], taskInfo, signals, members, today);
    const t = days[0].people[0].tasks.find((x) => x.taskId === "t2")!;
    expect(t.newlyAssigned).toBe(true);
    expect(t.evidenceCount).toBe(0);
    expect(t.status).toBe("backlog");
  });

  it("orders a person's tasks by evidence count (newly-assigned-empty sinks below worked)", () => {
    const days = groupTimeline(
      [ev({ taskId: "t1" }), ev({ taskId: "t1" })], // t1 has 2 evidence
      taskInfo,
      [{ memberId: "m1", taskId: "t2", at: "2026-07-22T08:00:00Z", newlyAssigned: true }], // t2 empty
      members,
      today
    );
    expect(days[0].people[0].tasks.map((t) => t.taskId)).toEqual(["t1", "t2"]);
  });

  it("evidence with a dangling taskId (no taskInfo) falls back to Other, never crashes", () => {
    const days = groupTimeline([ev({ taskId: "gone", source: "github" })], taskInfo, [], members, today);
    expect(days[0].people[0].tasks).toHaveLength(0);
    expect(days[0].people[0].other[0].source).toBe("github");
  });

  it("drops evidence for an unknown member", () => {
    const days = groupTimeline([ev({ memberId: "ghost" })], taskInfo, [], members, today);
    expect(days).toHaveLength(0);
  });

  it("orders people within a day by total activity desc", () => {
    const days = groupTimeline(
      [ev({ memberId: "m2", taskId: null }), ev({ memberId: "m1", taskId: "t1" }), ev({ memberId: "m1", taskId: "t1" })],
      taskInfo,
      [],
      members,
      today
    );
    expect(days[0].people.map((p) => p.name)).toEqual(["Chetan", "John"]);
  });
});
