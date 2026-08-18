import { describe, it, expect } from "vitest";
import {
  buildPushBackfillRunner,
  createMeetingBackfillScheduler,
  runTracedMeetingBackfill,
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

  it("schedules for a CALENDAR EVENT, which is keyed on source and not on kind (MTGATT-3)", () => {
    // Before this, a pushed calendar event returned false — `isMeetingTranscript` requires
    // kind='transcript' and a producer may reasonably send `artifact`. So your own calendar push sat
    // unlinked until a scheduler tick while someone else's transcript was noted instantly: an
    // invisible half-hour asymmetry between the two producers of the same meeting.
    for (const kind of ["artifact", "transcript"]) {
      expect(shouldScheduleMeetingBackfill({ kind, source: "calendar", status: "created" }), `kind=${kind}`).toBe(true);
    }
    for (const source of ["gcal", "google_calendar", "googlecalendar"]) {
      expect(shouldScheduleMeetingBackfill({ kind: "artifact", source, status: "created" }), source).toBe(true);
    }
  });

  it("still refuses an UNCHANGED calendar re-push — the widening must not cost the dedupe", () => {
    // The inverse half. `aios push` re-sends byte-identical files routinely, so a widening that
    // forgot this would pay for a full scan on every no-op push.
    expect(shouldScheduleMeetingBackfill({ kind: "artifact", source: "calendar", status: "unchanged" })).toBe(false);
  });

  it("still refuses a non-meeting artifact — the widening is scoped to calendar sources", () => {
    expect(shouldScheduleMeetingBackfill({ kind: "artifact", source: "github", status: "created" })).toBe(false);
    expect(shouldScheduleMeetingBackfill({ kind: "artifact", source: null, status: "created" })).toBe(false);
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

describe("runTracedMeetingBackfill — the push path leaves a durable trace", () => {
  it("records a successful run with what it created", async () => {
    const rows: unknown[] = [];
    await runTracedMeetingBackfill({
      backfill: async () => ({ created: 3, scanned: 5, merged: 1 }),
      record: async (r) => void rows.push(r),
    });
    expect(rows).toEqual([{ ok: true, created: 3, meta: { scanned: 5, merged: 1 } }]);
  });

  it("records a FAILED run and rethrows, so a broken model is visible and still non-fatal", async () => {
    // Without this the tick would log `created: 0` forever while the push path silently did (or failed
    // to do) all the work — a ledger showing an idle pipeline exactly when it is the busy one.
    const rows: { ok: boolean; errors?: string[] }[] = [];
    await expect(
      runTracedMeetingBackfill({
        backfill: async () => {
          throw new Error("model down");
        },
        record: async (r) => void rows.push(r),
      })
    ).rejects.toThrow("model down");
    expect(rows).toEqual([{ ok: false, errors: ["model down"] }]);
  });

  it("still traces a run that created nothing", async () => {
    const rows: { created?: number }[] = [];
    await runTracedMeetingBackfill({ backfill: async () => ({}), record: async (r) => void rows.push(r) });
    expect(rows[0]).toMatchObject({ ok: true, created: 0, meta: { scanned: 0, merged: 0 } });
  });
});

describe("buildPushBackfillRunner — the ledger identity is wired, not just declared", () => {
  it("records the run as source=meeting_notes trigger=api, with the team and counts", async () => {
    // Pins the LITERALS at the call site. Reverting the singleton to an untraced backfill, or writing
    // trigger='scheduler' here, would mask a dead poller on the pipeline-health card — and every test
    // over runTracedMeetingBackfill alone would still pass.
    const rows: Record<string, unknown>[] = [];
    const runner = buildPushBackfillRunner({
      db: { tag: "db" },
      resolveKeys: async () => ({ anthropic: "k" }),
      backfill: async () => ({ created: 2, scanned: 4, merged: 0 }),
      record: async (_db, row) => void rows.push(row),
    });
    await runner("team-9");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      teamId: "team-9",
      source: "meeting_notes",
      trigger: "api",
      ok: true,
      created: 2,
    });
    expect(typeof rows[0].startedAt).toBe("number");
  });

  it("passes the resolved keys into the backfill", async () => {
    let seen: unknown;
    const runner = buildPushBackfillRunner({
      db: {},
      resolveKeys: async () => ({ anthropic: "resolved" }),
      backfill: async (_db, _id, opts) => {
        seen = opts.keys;
        return {};
      },
      record: async () => undefined,
    });
    await runner("team-9");
    expect(seen).toEqual({ anthropic: "resolved" });
  });

  it("records ok=false and rethrows when the backfill throws", async () => {
    const rows: Record<string, unknown>[] = [];
    const runner = buildPushBackfillRunner({
      db: {},
      resolveKeys: async () => ({}),
      backfill: async () => {
        throw new Error("boom");
      },
      record: async (_db, row) => void rows.push(row),
    });
    await expect(runner("team-9")).rejects.toThrow("boom");
    expect(rows[0]).toMatchObject({ source: "meeting_notes", trigger: "api", ok: false });
  });
});
