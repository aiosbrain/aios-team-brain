import { describe, it, expect } from "vitest";
import {
  groupTimeline,
  normalizeSource,
  itemWorkTime,
  dayLabel,
  mostRecentPerPerson,
  summaryPromptFor,
  type EvidenceWithMember,
  type SignalWithMember,
  type TaskInfo,
  type TimelineMember,
  type PersonDay,
  type TimelineDay,
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

describe("itemWorkTime (includes attributed docs, never synced_at)", () => {
  it("prefers git committed_at, then generic source_ts", () => {
    expect(itemWorkTime({ committed_at: "2026-07-01T00:00:00Z", source_ts: "2026-06-01T00:00:00Z" })).toBe("2026-07-01T00:00:00.000Z");
    expect(itemWorkTime({ source_ts: "2026-06-02T00:00:00Z" })).toBe("2026-06-02T00:00:00.000Z");
  });
  it("falls back to a doc's edit/create time (the fix — docs were dropped before)", () => {
    // A Notion doc: last_edited_time. A Google Drive doc: modifiedTime. A hand-authored deliverable: updated/date/created.
    expect(itemWorkTime({ last_edited_time: "2026-07-10T12:00:00Z" })).toBe("2026-07-10T12:00:00.000Z");
    expect(itemWorkTime({ modifiedTime: "2026-07-11T12:00:00Z" })).toBe("2026-07-11T12:00:00.000Z");
    expect(itemWorkTime({ updated: "2026-07-12", created: "2026-01-01" })).toBe("2026-07-12T00:00:00.000Z"); // updated wins over created
    expect(itemWorkTime({ date: "2026-07-13" })).toBe("2026-07-13T00:00:00.000Z");
    expect(itemWorkTime({ created: "2026-07-14T00:00:00Z" })).toBe("2026-07-14T00:00:00.000Z");
  });
  it("NEVER uses synced_at, and returns null when no source work-time exists", () => {
    expect(itemWorkTime({ synced_at: "2026-07-20T00:00:00Z", title: "a doc" })).toBeNull(); // synced_at ignored → dropped
    expect(itemWorkTime({})).toBeNull();
    expect(itemWorkTime(null)).toBeNull();
    expect(itemWorkTime({ committed_at: "not-a-date" })).toBeNull(); // unparseable → null
  });
});

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

/**
 * Spec for the Home "Working on" collapse: one entry per person = their MOST RECENT day of work,
 * ordered by recency. This is what makes "Working on" identical to (a slice of) the Timeline.
 */
describe("mostRecentPerPerson", () => {
  const person = (memberId: string, name: string, total: number): PersonDay => ({
    memberId,
    name,
    handle: name.toLowerCase(),
    total,
    tasks: [],
    other: [],
    signals: [],
  });

  it("keeps each person's newest day and drops their older appearances", () => {
    const days: TimelineDay[] = [
      { date: "2026-07-23", label: "Today", people: [person("m1", "Chetan", 5), person("m2", "John", 3)] },
      { date: "2026-07-22", label: "Yesterday", people: [person("m1", "Chetan", 9), person("m3", "Dana", 2)] },
    ];
    const out = mostRecentPerPerson(days);
    // Chetan+John from today (most recent), Dana only appears yesterday → included once.
    expect(out.map((p) => p.name)).toEqual(["Chetan", "John", "Dana"]);
    // Chetan's entry is TODAY's (total 5), not yesterday's (9).
    expect(out.find((p) => p.memberId === "m1")!.total).toBe(5);
  });

  it("sorts undated ('unknown') last regardless of input order", () => {
    const days: TimelineDay[] = [
      { date: "unknown", label: "Undated", people: [person("m9", "Ghost", 1)] },
      { date: "2026-07-23", label: "Today", people: [person("m1", "Chetan", 5)] },
    ];
    expect(mostRecentPerPerson(days).map((p) => p.name)).toEqual(["Chetan", "Ghost"]);
  });
});

describe("signals lane — decisions are SIGNAL: shown, never counted as work", () => {
  const sig = (over: Partial<SignalWithMember>): SignalWithMember => ({
    id: Math.random().toString(36).slice(2),
    memberId: "m1",
    kind: "decision",
    title: "picked Postgres",
    at: "2026-07-22",
    ...over,
  });

  it("a decision lands in `signals`, not tasks/other, and does NOT enter the work total", () => {
    const days = groupTimeline([ev({ memberId: "m1", source: "github" })], taskInfo, members, today, undefined, [sig({})]);
    const p = days[0].people.find((x) => x.memberId === "m1")!;
    expect(p.total).toBe(1); // the commit only — the decision is NOT counted
    expect(p.signals.flatMap((g) => g.items).map((s) => s.title)).toEqual(["picked Postgres"]);
    expect(p.other.flatMap((g) => g.items).map((i) => i.title)).not.toContain("picked Postgres");
  });

  it("a person with ONLY signals appears (total 0) but summaryPromptFor ignores signals (no work-synopsis leak)", () => {
    const days = groupTimeline([], taskInfo, members, today, undefined, [sig({ memberId: "m2", title: "chose SWR" })]);
    const p = days[0].people.find((x) => x.memberId === "m2")!;
    expect(p.total).toBe(0);
    expect(p.signals.flatMap((g) => g.items)).toHaveLength(1);
    expect(summaryPromptFor(p, "Wed")).toBe(""); // no tasks/other → empty; decisions never enter the prompt
  });
});

describe("mostRecentPerPerson skips signal-only days (Home 'Working on' is about WORK)", () => {
  it("a decision-only later day never displaces a person's real most-recent-work day", () => {
    const workMon = groupTimeline([ev({ memberId: "m1", at: "2026-07-20T09:00:00Z", source: "github" })], taskInfo, members, "2026-07-22");
    const sigWed = groupTimeline([], taskInfo, members, "2026-07-22", undefined, [{ id: "d1", memberId: "m1", kind: "decision", title: "a call", at: "2026-07-22" }]);
    const days: TimelineDay[] = [...sigWed, ...workMon]; // Wed (signal-only) is newer
    const out = mostRecentPerPerson(days);
    const m1 = out.find((p) => p.memberId === "m1")!;
    expect(m1.total).toBe(1); // Monday's WORK day, not Wednesday's signal-only day
    expect(m1.signals).toEqual([]);
  });
})
