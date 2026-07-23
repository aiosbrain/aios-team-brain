import { describe, it, expect } from "vitest";
import {
  groupTimeline,
  normalizeSource,
  dayLabel,
  type EvidenceWithMember,
  type TaskInfo,
  type TimelineMember,
} from "@/lib/dashboard/timeline-group";

const members = new Map<string, TimelineMember>([
  ["m1", { name: "Chetan", handle: "chetan" }],
  ["m2", { name: "John", handle: "john" }],
]);

const taskInfo = new Map<string, TaskInfo>([
  ["t1", { title: "Provider adapter", status: "in_progress", source: "linear" }],
  ["t2", { title: "Second task", status: "in_progress", source: "linear" }],
  ["tEmpty", { title: "Active but no evidence", status: "in_progress", source: "linear" }],
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

describe("normalizeSource / dayLabel", () => {
  it("normalizes sources and labels days", () => {
    expect(normalizeSource("git")).toBe("github");
    expect(normalizeSource("mystery")).toBe("other");
    expect(dayLabel("2026-07-22", today)).toBe("Today");
    expect(dayLabel("2026-07-21", today)).toBe("Yesterday");
  });
});

describe("groupTimeline (evidence-gated task → evidence nesting + Other)", () => {
  it("nests linked evidence under its task; unlinked evidence → Other", () => {
    const days = groupTimeline(
      [
        ev({ id: "c1", taskId: "t1", source: "github" }),
        ev({ id: "c2", taskId: "t1", source: "notion" }),
        ev({ id: "c3", taskId: null, source: "github" }),
      ],
      taskInfo,
      members,
      today
    );
    const p = days[0].people[0];
    expect(p.tasks).toHaveLength(1);
    expect(p.tasks[0].taskId).toBe("t1");
    expect(p.tasks[0].evidenceCount).toBe(2);
    expect(p.tasks[0].sources.map((s) => s.source).sort()).toEqual(["github", "notion"]);
    expect(p.other.map((s) => s.source)).toEqual(["github"]);
  });

  it("EVIDENCE-GATED: an active task with no evidence never appears (no empty headers)", () => {
    // tEmpty is in taskInfo but nothing links to it.
    const days = groupTimeline([ev({ taskId: "t1" })], taskInfo, members, today);
    const ids = days[0].people[0].tasks.map((t) => t.taskId);
    expect(ids).toEqual(["t1"]);
    expect(ids).not.toContain("tEmpty");
  });

  it("orders a person's tasks by evidence count desc", () => {
    const days = groupTimeline(
      [ev({ taskId: "t1" }), ev({ taskId: "t1" }), ev({ taskId: "t2" })],
      taskInfo,
      members,
      today
    );
    expect(days[0].people[0].tasks.map((t) => t.taskId)).toEqual(["t1", "t2"]);
  });

  it("evidence with a dangling/inactive taskId falls back to Other", () => {
    const days = groupTimeline([ev({ taskId: "gone", source: "github" })], taskInfo, members, today);
    expect(days[0].people[0].tasks).toHaveLength(0);
    expect(days[0].people[0].other[0].source).toBe("github");
  });

  it("drops evidence for an unknown member", () => {
    expect(groupTimeline([ev({ memberId: "ghost" })], taskInfo, members, today)).toHaveLength(0);
  });

  it("orders people within a day by total evidence desc", () => {
    const days = groupTimeline(
      [ev({ memberId: "m2", taskId: null }), ev({ memberId: "m1", taskId: "t1" }), ev({ memberId: "m1", taskId: "t1" })],
      taskInfo,
      members,
      today
    );
    expect(days[0].people.map((p) => p.name)).toEqual(["Chetan", "John"]);
  });
});
