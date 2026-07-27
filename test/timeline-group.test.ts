import { describe, it, expect } from "vitest";
import { groupTimeline, normalizeSource, dayLabel, mostRecentPerPerson, summaryPromptFor, type EvidenceWithMember, type SignalWithMember, type TaskInfo, type TimelineMember, type PersonDay, type TimelineDay } from "@/lib/dashboard/timeline-group";
import { resolveWorkTime } from "@/lib/ingest/work-time";

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

describe("resolveWorkTime (includes attributed docs, never synced_at)", () => {
  it("prefers git committed_at, then generic source_ts", () => {
    expect(resolveWorkTime({ committed_at: "2026-07-01T00:00:00Z", source_ts: "2026-06-01T00:00:00Z" })).toBe("2026-07-01T00:00:00.000Z");
    expect(resolveWorkTime({ source_ts: "2026-06-02T00:00:00Z" })).toBe("2026-06-02T00:00:00.000Z");
  });
  it("falls back to a doc's edit/create time (the fix — docs were dropped before)", () => {
    // A Notion doc: last_edited_time. A Google Drive doc: modifiedTime. A hand-authored deliverable: updated/date/created.
    expect(resolveWorkTime({ last_edited_time: "2026-07-10T12:00:00Z" })).toBe("2026-07-10T12:00:00.000Z");
    expect(resolveWorkTime({ modifiedTime: "2026-07-11T12:00:00Z" })).toBe("2026-07-11T12:00:00.000Z");
    expect(resolveWorkTime({ updated: "2026-07-12", created: "2026-01-01" })).toBe("2026-07-12T00:00:00.000Z"); // updated wins over created
    expect(resolveWorkTime({ date: "2026-07-13" })).toBe("2026-07-13T00:00:00.000Z");
    expect(resolveWorkTime({ created: "2026-07-14T00:00:00Z" })).toBe("2026-07-14T00:00:00.000Z");
  });
  it("NEVER uses synced_at, and returns null when no source work-time exists", () => {
    expect(resolveWorkTime({ synced_at: "2026-07-20T00:00:00Z", title: "a doc" })).toBeNull(); // synced_at ignored → dropped
    expect(resolveWorkTime({})).toBeNull();
    expect(resolveWorkTime(null)).toBeNull();
    expect(resolveWorkTime({ committed_at: "not-a-date" })).toBeNull(); // unparseable → null
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

describe("groupTimeline (evidence-gated task → evidence nesting; unlinked work omitted)", () => {
  it("nests linked evidence under its task and puts unlinked evidence in a subordinate lane", () => {
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
    // Unlinked work is SHOWN, below the tasks — omitting it hid ~96% of real work in prod. It is also
    // counted, so coverage stays measurable and we can tell when omitting becomes safe.
    expect(p.other.map((g) => g.source)).toEqual(["github"]);
    expect(p.unlinked).toBe(1);
    expect(p.total).toBe(3); // header must match the body: 2 nested + 1 unlinked
  });

  /**
   * Spec: a task that belongs to SOMEONE ELSE is visibly theirs.
   *
   * The timeline credits work to whoever DID it, so a teammate's ticket legitimately appears on your
   * day — and nothing distinguished it from a ticket you own ("I have a bunch of Linear tasks but I
   * haven't created Linear tasks in ages — I don't know where these are coming from"). The owner's
   * miniature avatar is what makes the difference legible; credit is unchanged either way.
   */
  it("marks a teammate's task with its OWNER, and says nothing about your own", () => {
    const owned = new Map([
      ["t1", { title: "My ticket", status: "in_progress", source: "tasks", assigneeMemberId: "m1" }],
      ["t2", { title: "Their ticket", status: "in_progress", source: "tasks", assigneeMemberId: "m2" }],
      ["t3", { title: "Unassigned", status: "in_progress", source: "tasks", assigneeMemberId: null }],
    ]);
    const days = groupTimeline(
      [ev({ memberId: "m1", taskId: "t1" }), ev({ memberId: "m1", taskId: "t2" }), ev({ memberId: "m1", taskId: "t3" })],
      owned,
      members,
      today
    );
    const byTitle = new Map(days[0].people[0].tasks.map((t) => [t.title, t]));
    // m1 did all three pieces of work — credit is unaffected by who owns the ticket.
    expect(byTitle.get("Their ticket")?.assignee?.name).toBe("John");
    expect(byTitle.get("My ticket")?.assignee).toBeUndefined(); // yours → nothing to say
    expect(byTitle.get("Unassigned")?.assignee).toBeUndefined(); // nobody's → nothing TRUE to say
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

  it("evidence with a dangling/inactive taskId counts as unlinked, and still shows", () => {
    // A taskId we can't resolve is not a task — but the work happened, so it belongs in the unlinked
    // lane rather than vanishing.
    const days = groupTimeline([ev({ taskId: "gone", source: "github" })], taskInfo, members, today);
    const p = days[0].people[0];
    expect(p.tasks).toHaveLength(0);
    expect(p.other[0].source).toBe("github");
    expect(p.unlinked).toBe(1);
  });

  it("drops evidence for an unknown member", () => {
    expect(groupTimeline([ev({ memberId: "ghost" })], taskInfo, members, today)).toHaveLength(0);
  });

  it("orders people within a day by total evidence desc", () => {
    const days = groupTimeline(
      [ev({ memberId: "m2", taskId: "t2" }), ev({ memberId: "m1", taskId: "t1" }), ev({ memberId: "m1", taskId: "t1" })],
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

  it("a decision lands in `signals`, not tasks, and does NOT enter the work total", () => {
    // Task-linked so the person has visible work; the decision must not inflate its count.
    const days = groupTimeline([ev({ memberId: "m1", taskId: "t1", source: "github" })], taskInfo, members, today, undefined, [sig({})]);
    const p = days[0].people.find((x) => x.memberId === "m1")!;
    expect(p.total).toBe(1); // the commit only — the decision is NOT counted
    expect(p.signals.flatMap((g) => g.items).map((s) => s.title)).toEqual(["picked Postgres"]);
    expect(p.tasks.flatMap((t) => t.sources).flatMap((g) => g.items).map((i) => i.title)).not.toContain("picked Postgres");
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
    const workMon = groupTimeline([ev({ memberId: "m1", taskId: "t1", at: "2026-07-20T09:00:00Z", source: "github" })], taskInfo, members, "2026-07-22");
    const sigWed = groupTimeline([], taskInfo, members, "2026-07-22", undefined, [{ id: "d1", memberId: "m1", kind: "decision", title: "a call", at: "2026-07-22" }]);
    const days: TimelineDay[] = [...sigWed, ...workMon]; // Wed (signal-only) is newer
    const out = mostRecentPerPerson(days);
    const m1 = out.find((p) => p.memberId === "m1")!;
    expect(m1.total).toBe(1); // Monday's WORK day, not Wednesday's signal-only day
    expect(m1.signals).toEqual([]);
  });
})
