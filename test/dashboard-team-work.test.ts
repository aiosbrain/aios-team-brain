import { describe, expect, it } from "vitest";
import { assembleTeamWork, type TaskLite, type ArcLite } from "@/lib/dashboard/team-work";
import type { RosterPerson } from "@/lib/dashboard/people-match";

/**
 * Spec for the consolidated "Working On" assembly: per roster-person, fold in (a) a narrative-arc
 * summary from the context layer, (b) their open tasks, and (c) their recently-accomplished tasks —
 * all matched by the roster-keyed identity logic so the graph's noisy names (two "Johns", "Chetan"
 * vs "Chetan Nandakumar") and free-text task assignees resolve to one person. Pure, no DB/LLM.
 */

const roster: RosterPerson[] = [
  { memberId: "j", displayName: "John Ellison", handle: "john-ellison" },
  { memberId: "c", displayName: "Chetan", handle: "chetan" },
];

const DONE_SINCE = "2026-06-01T00:00:00.000Z";

const tasks: TaskLite[] = [
  { id: "t1", title: "Ship auth", assignee: "John", status: "in_progress", updatedAt: "2026-06-20T00:00:00.000Z" },
  { id: "t2", title: "Fix RLS", assignee: "john-ellison", status: "blocked", updatedAt: "2026-06-19T00:00:00.000Z" },
  { id: "t3", title: "Old thing", assignee: "John Ellison", status: "done", updatedAt: "2026-05-01T00:00:00.000Z" }, // before window
  { id: "t4", title: "Landed dashboard", assignee: "John Ellison", status: "done", updatedAt: "2026-06-25T00:00:00.000Z" },
  { id: "t5", title: "Retrieval fix", assignee: "Chetan Nandakumar", status: "in_progress", updatedAt: "2026-06-22T00:00:00.000Z" },
  { id: "t6", title: "Someone else", assignee: "Priya", status: "in_progress", updatedAt: "2026-06-22T00:00:00.000Z" },
];

const arcs: ArcLite[] = [
  { title: "Auth hardening", summary: "The team is hardening auth and RLS.", confidence: "high", participants: ["John"] },
  { title: "Query quality", summary: "Improving retrieval and dates.", confidence: "medium", participants: ["Chetan Nandakumar"] },
];

describe("assembleTeamWork", () => {
  it("dedupes noisy names onto one roster row and buckets that person's tasks", () => {
    const people = assembleTeamWork(roster, tasks, arcs, DONE_SINCE);
    const john = people.find((p) => p.memberId === "j")!;

    expect(john.name).toBe("John Ellison"); // canonical roster name, not the graph's "John"
    // "John", "john-ellison", "John Ellison" all fold onto this one person.
    expect(john.openTasks.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    // Accomplished = done + within window; t3 (May) excluded, t4 (Jun 25) included.
    expect(john.accomplished.map((t) => t.id)).toEqual(["t4"]);
  });

  it("pulls each person's summary + threads from the arcs they participate in", () => {
    const people = assembleTeamWork(roster, tasks, arcs, DONE_SINCE);
    const john = people.find((p) => p.memberId === "j")!;
    const chetan = people.find((p) => p.memberId === "c")!;

    expect(john.summary).toBe("The team is hardening auth and RLS.");
    expect(john.threads).toEqual(["Auth hardening"]);
    // "Chetan" roster matches arc participant "Chetan Nandakumar".
    expect(chetan.summary).toBe("Improving retrieval and dates.");
    expect(chetan.openTasks.map((t) => t.id)).toEqual(["t5"]);
  });

  it("does not attribute another person's task (Priya) to anyone on the roster", () => {
    const people = assembleTeamWork(roster, tasks, arcs, DONE_SINCE);
    const allTaskIds = people.flatMap((p) => [...p.openTasks, ...p.accomplished].map((t) => t.id));
    expect(allTaskIds).not.toContain("t6");
  });
});
