import { describe, it, expect } from "vitest";
import { digest, headlineTask, DIGEST_ARC_LIMIT, DIGEST_PEOPLE_LIMIT } from "@/lib/dashboard/pulse-digest";
import type { PersonDay, TaskGroup } from "@/lib/dashboard/timeline-group";

/**
 * Spec: the Pulse snapshot header is BOUNDED — its height must not track data volume. These assertions
 * are written from that product rule, not from the current constants: the expected counts below are
 * literals, so raising a cap turns them red and forces a deliberate decision about the fold instead of
 * letting the first screen quietly grow back into the old feed.
 */

function task(taskId: string, status: string): TaskGroup {
  return { taskId, title: `task ${taskId}`, status, source: "linear", sources: [], evidenceCount: 0 };
}

function person(tasks: TaskGroup[]): PersonDay {
  return { memberId: "m1", name: "Ada", handle: "ada", total: 0, tasks, other: [], unlinked: 0, signals: [] };
}

describe("digest — bounded snapshot bands", () => {
  it("caps a full arc set to the snapshot limit and reports the remainder", () => {
    // 12 = MAX_ARCS in lib/graph/arcs.ts — the worst case the arcs band can ever hand the snapshot.
    const arcs = Array.from({ length: 12 }, (_, i) => `arc-${i}`);
    const d = digest(arcs, DIGEST_ARC_LIMIT);
    expect(d.shown).toHaveLength(3);
    expect(d.hidden).toBe(9);
    expect(d.total).toBe(12);
  });

  it("caps a large roster so a growing team cannot push the fold down", () => {
    const people = Array.from({ length: 20 }, (_, i) => `p-${i}`);
    const d = digest(people, DIGEST_PEOPLE_LIMIT);
    expect(d.shown).toHaveLength(6);
    expect(d.hidden).toBe(14);
  });

  it("hides nothing when the band is not full", () => {
    const d = digest(["a", "b"], DIGEST_ARC_LIMIT);
    expect(d.shown).toEqual(["a", "b"]);
    expect(d.hidden).toBe(0);
    expect(d.total).toBe(2);
  });

  it("preserves the caller's order — bands pass already-sorted data", () => {
    expect(digest(["c", "a", "b"], 2).shown).toEqual(["c", "a"]);
  });

  it("never reports a negative remainder for a nonsense limit", () => {
    const d = digest(["a", "b"], -5);
    expect(d.shown).toEqual([]);
    expect(d.hidden).toBe(2);
  });

  it("treats a missing list as empty rather than throwing", () => {
    expect(digest(null, DIGEST_ARC_LIMIT)).toEqual({ shown: [], hidden: 0, total: 0 });
  });
});

describe("headlineTask — the one task a compact row shows", () => {
  it("headlines active work over finished work regardless of list order", () => {
    const p = person([task("done-1", "done"), task("wip-1", "in_progress")]);
    expect(headlineTask(p)?.taskId).toBe("wip-1");
  });

  it("headlines a blocked task over a merely-queued one — blocked work is underway", () => {
    // `blocked` is ACTIVE per lib/tasks/activity-policy (underway and stuck); `ready` is only OPEN.
    const p = person([task("ready-1", "ready"), task("blocked-1", "blocked")]);
    expect(headlineTask(p)?.taskId).toBe("blocked-1");
  });

  it("headlines open work over backlog intake", () => {
    const p = person([task("backlog-1", "backlog"), task("ready-1", "ready")]);
    expect(headlineTask(p)?.taskId).toBe("ready-1");
  });

  it("keeps the incoming task order when statuses share a tier", () => {
    // in_progress and blocked are both ACTIVE — no invented precedence between them, so the order
    // groupTimeline already produced wins (evidenceCount DESC, then title — NOT recency).
    const p = person([task("first", "in_progress"), task("second", "blocked")]);
    expect(headlineTask(p)?.taskId).toBe("first");
  });

  it("falls back to null when the person has no tasks, so the row shows counts instead", () => {
    expect(headlineTask(person([]))).toBeNull();
  });

  it("still picks something when every status is unrecognised", () => {
    // activity-policy fails closed on unmapped statuses, so these rank last — but a row with tasks must
    // never headline nothing.
    const p = person([task("odd-1", "sideways")]);
    expect(headlineTask(p)?.taskId).toBe("odd-1");
  });

  it("prefers a recognised active task over an unmapped one regardless of order", () => {
    const p = person([task("odd-1", "sideways"), task("wip-1", "in_progress")]);
    expect(headlineTask(p)?.taskId).toBe("wip-1");
  });
});
