import { describe, it, expect } from "vitest";
import {
  groupTimeline,
  normalizeSource,
  dayLabel,
  type EvidenceWithMember,
  type TimelineMember,
} from "@/lib/dashboard/timeline-group";

const members = new Map<string, TimelineMember>([
  ["m1", { name: "Chetan", handle: "chetan" }],
  ["m2", { name: "John", handle: "john" }],
]);

const ev = (over: Partial<EvidenceWithMember>): EvidenceWithMember => ({
  id: Math.random().toString(36).slice(2),
  memberId: "m1",
  title: "t",
  source: "github",
  kind: "artifact",
  at: "2026-07-22T09:00:00Z",
  ...over,
});

describe("normalizeSource", () => {
  it("collapses git/github → github and drive variants → gdrive", () => {
    expect(normalizeSource("git")).toBe("github");
    expect(normalizeSource("GitHub")).toBe("github");
    expect(normalizeSource("google_drive")).toBe("gdrive");
  });
  it("passes known sources through and maps unknown → other", () => {
    expect(normalizeSource("linear")).toBe("linear");
    expect(normalizeSource("granola")).toBe("granola");
    expect(normalizeSource("mystery")).toBe("other");
    expect(normalizeSource(null)).toBe("other");
  });
});

describe("dayLabel", () => {
  const today = "2026-07-22";
  it("labels today / yesterday / undated, and formats other days", () => {
    expect(dayLabel("2026-07-22", today)).toBe("Today");
    expect(dayLabel("2026-07-21", today)).toBe("Yesterday");
    expect(dayLabel("unknown", today)).toBe("Undated");
    expect(dayLabel("2026-07-19", today)).toMatch(/Jul 19/);
  });
});

describe("groupTimeline", () => {
  const today = "2026-07-22";

  it("groups day → person → source, days newest-first with undated last", () => {
    const days = groupTimeline(
      [
        ev({ memberId: "m1", source: "github", at: "2026-07-22T09:00:00Z" }),
        ev({ memberId: "m1", source: "linear", kind: "task", at: "2026-07-22T10:00:00Z" }),
        ev({ memberId: "m2", source: "github", at: "2026-07-21T08:00:00Z" }),
        ev({ memberId: "m1", source: "github", at: "" }), // undated → "unknown" bucket
      ],
      members,
      today
    );
    expect(days.map((d) => d.date)).toEqual(["2026-07-22", "2026-07-21", "unknown"]);
    const todayPeople = days[0].people;
    expect(todayPeople[0].name).toBe("Chetan");
    expect(todayPeople[0].sources.map((s) => s.source)).toEqual(["github", "linear"]); // by count, tie→name
  });

  it("drops evidence for an unknown member (never guesses)", () => {
    const days = groupTimeline([ev({ memberId: "ghost" })], members, today);
    expect(days).toEqual([]);
  });

  it("caps items per source but keeps the true total for '+N more'", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      ev({ memberId: "m1", source: "github", at: `2026-07-22T0${i}:00:00Z` })
    );
    const [day] = groupTimeline(many, members, today, 6);
    const gh = day.people[0].sources[0];
    expect(gh.count).toBe(10); // true total
    expect(gh.items).toHaveLength(6); // capped
    expect(gh.items[0].at).toBe("2026-07-22T09:00:00Z"); // newest-first
  });

  it("orders people within a day by evidence count (desc)", () => {
    const days = groupTimeline(
      [
        ev({ memberId: "m2", source: "github" }),
        ev({ memberId: "m1", source: "github" }),
        ev({ memberId: "m1", source: "linear", kind: "task" }),
      ],
      members,
      today
    );
    expect(days[0].people.map((p) => p.name)).toEqual(["Chetan", "John"]); // 2 vs 1
  });

  it("floats the 'newly-assigned' group above real work sources, even at a lower count", () => {
    const days = groupTimeline(
      [
        ev({ memberId: "m1", source: "github" }),
        ev({ memberId: "m1", source: "github" }),
        ev({ memberId: "m1", source: "github" }), // github ×3
        ev({ memberId: "m1", source: "newly-assigned", kind: "task" }), // newly-assigned ×1
      ],
      members,
      today
    );
    // Despite github having a higher count, "Newly assigned" ranks first.
    expect(days[0].people[0].sources.map((s) => s.source)).toEqual(["newly-assigned", "github"]);
  });
});
