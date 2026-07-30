import { describe, it, expect } from "vitest";
import {
  createMeetingBackfillScheduler,
  shouldScheduleMeetingBackfill,
} from "@/lib/meetings/schedule-backfill";

/**
 * Spec: a pushed meeting must become visible on the Meetings page without waiting for the 30-minute
 * scheduler tick — but paying for at most one backfill run per burst of pushes, and never able to fail
 * the push that triggered it.
 */

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("shouldScheduleMeetingBackfill — what earns an immediate run", () => {
  it("schedules for a newly pushed meeting transcript", () => {
    expect(shouldScheduleMeetingBackfill({ kind: "transcript", source: "granola", status: "created" })).toBe(true);
  });

  // `updated` is worth scheduling because it heals an item that has no note yet (an earlier run failed,
  // or the note was deleted). It does NOT re-extract an already-noted meeting — the backfill only scans
  // un-noted items, so for those the run is a no-op scan plus the duplicate-merge sweep.
  it("schedules when an existing item is updated — it may still be missing its note", () => {
    expect(shouldScheduleMeetingBackfill({ kind: "transcript", source: "granola", status: "updated" })).toBe(true);
  });

  it("does NOT schedule for a Slack thread — the Meetings page must not fill with chat", () => {
    expect(shouldScheduleMeetingBackfill({ kind: "transcript", source: "slack", status: "created" })).toBe(false);
  });

  it("does NOT schedule for a byte-identical re-push — `aios push` re-sends unchanged files routinely", () => {
    expect(shouldScheduleMeetingBackfill({ kind: "transcript", source: "granola", status: "unchanged" })).toBe(false);
  });

  it("does NOT schedule for a non-transcript kind", () => {
    expect(shouldScheduleMeetingBackfill({ kind: "deliverable", source: "granola", status: "created" })).toBe(false);
  });

  it("does NOT schedule when the source is missing or not a string", () => {
    expect(shouldScheduleMeetingBackfill({ kind: "transcript", source: undefined, status: "created" })).toBe(false);
    expect(shouldScheduleMeetingBackfill({ kind: "transcript", source: 42, status: "created" })).toBe(false);
  });
});

describe("createMeetingBackfillScheduler — coalescing", () => {
  it("runs immediately when nothing is in flight", async () => {
    const seen: string[] = [];
    const s = createMeetingBackfillScheduler(async (t) => void seen.push(t));
    s.schedule("team-1");
    await s.idle("team-1");
    expect(seen).toEqual(["team-1"]);
  });

  it("collapses a burst of pushes into ONE running + ONE trailing run", async () => {
    // The case that motivated this: a Granola sync pushed three meetings in ~4 seconds. Three overlapping
    // full scans would be 3x the LLM spend for one run's worth of work.
    const gate = deferred();
    let started = 0;
    const s = createMeetingBackfillScheduler(async () => {
      started++;
      await gate.promise;
    });

    s.schedule("team-1"); // starts run #1
    s.schedule("team-1"); // arrives during #1 -> queues the trailing run
    s.schedule("team-1"); // subsumed by the already-queued run
    s.schedule("team-1");
    expect(started).toBe(1);

    gate.resolve();
    await s.idle("team-1");
    expect(started).toBe(2); // the one trailing run, not four
  });

  it("never runs two scans for the same team concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const gate = deferred();
    const s = createMeetingBackfillScheduler(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gate.promise;
      active--;
    });
    s.schedule("team-1");
    s.schedule("team-1");
    gate.resolve();
    await s.idle("team-1");
    expect(maxActive).toBe(1);
  });

  it("does not let one team's in-flight run block another team", async () => {
    const gate = deferred();
    const seen: string[] = [];
    const s = createMeetingBackfillScheduler(async (t) => {
      seen.push(t);
      if (t === "team-1") await gate.promise;
    });
    s.schedule("team-1");
    s.schedule("team-2");
    expect(seen).toEqual(["team-1", "team-2"]);
    gate.resolve();
    await s.idle("team-1");
    await s.idle("team-2");
  });

  it("returns a promise that resolves only after the covering run finishes", async () => {
    // `after()` awaits this, which is what keeps the host from freezing the process mid-extraction.
    const gate = deferred();
    let done = false;
    const s = createMeetingBackfillScheduler(async () => {
      await gate.promise;
      done = true;
    });
    const settled = s.schedule("team-1");
    let resolvedEarly = false;
    void settled.then(() => (resolvedEarly = !done));
    await Promise.resolve();
    expect(done).toBe(false);
    gate.resolve();
    await settled;
    expect(done).toBe(true);
    expect(resolvedEarly).toBe(false);
  });

  it("the awaited promise also covers a trailing coalesced run", async () => {
    const gate = deferred();
    let finished = 0;
    const s = createMeetingBackfillScheduler(async () => {
      await gate.promise;
      finished++;
    });
    s.schedule("team-1");
    const second = s.schedule("team-1"); // queues the trailing run
    gate.resolve();
    await second;
    expect(finished).toBe(2); // resolved only once the trailing run completed too
  });

  it("swallows a failing run — a broken model must never fail the push behind it", async () => {
    const s = createMeetingBackfillScheduler(async () => {
      throw new Error("model down");
    });
    expect(() => s.schedule("team-1")).not.toThrow();
    await expect(s.idle("team-1")).resolves.toBeUndefined();
  });

  it("recovers after a failure — the next push still gets a run", async () => {
    let calls = 0;
    const s = createMeetingBackfillScheduler(async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
    });
    s.schedule("team-1");
    await s.idle("team-1");
    s.schedule("team-1");
    await s.idle("team-1");
    expect(calls).toBe(2);
  });
});
