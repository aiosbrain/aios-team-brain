import { describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import { recordIngestRun } from "@/lib/ingest/runs";
import { getPipelineHealth, staleThresholdMs } from "@/lib/ingest/pipeline-health";

/**
 * Spec (dead-scheduler heartbeat): `meeting_notes` is one of the legs whose staleness is meaningful,
 * because the scheduler records a row for it on EVERY tick — so the age of its newest row is the age of
 * the last poll. That is what makes a wedged poller visible at all for a team with no connectors.
 *
 * Since `aios push` now runs the same backfill on demand (`trigger='api'`), that heartbeat is only
 * honest if the staleness clock reads SCHEDULER-triggered rows. Otherwise a team that pushes regularly
 * keeps refreshing the newest-row age while the poller is dead — the alarm goes quiet for exactly the
 * teams doing the most work. `ok`/`error` must still come from the newest row of any trigger, so a real
 * failure stays loud whoever caused it.
 *
 * Real Postgres because the whole behaviour lives in the `distinct on` SQL, which FakeSupabase can't run.
 */

const MEETING_STALE_MS = staleThresholdMs("meeting_notes")!;
const beyondThreshold = () => Date.now() - (MEETING_STALE_MS + 60 * 60 * 1000);

/**
 * `at` sets BOTH ends of the run. `finished_at` is what the health query orders and ages by, and it
 * defaults to now — so a fixture that only set `startedAt` would write every row at the current time,
 * making "an old scheduler tick" indistinguishable from a fresh one and leaving the ordering a tie.
 */
async function record(
  teamId: string,
  trigger: "scheduler" | "api",
  opts: { ok?: boolean; at: number; errors?: string[] }
): Promise<void> {
  await recordIngestRun(db(), {
    teamId,
    source: "meeting_notes",
    trigger,
    ok: opts.ok ?? true,
    created: 0,
    errors: opts.errors,
    startedAt: opts.at - 1000,
    finishedAt: opts.at,
  });
}

function leg(health: Awaited<ReturnType<typeof getPipelineHealth>>) {
  return health.legs.find((l) => l.source === "meeting_notes");
}

describe("pipeline health — the poller heartbeat is scheduler-only (data-mechanics)", () => {
  it("flags a wedged poller as stale even though pushes kept running the backfill", async () => {
    const { teamId } = await seedTeam();
    await record(teamId, "scheduler", { at: beyondThreshold() }); // last real tick, long ago
    await record(teamId, "api", { at: Date.now() - 1000 }); // a push ran it seconds ago

    const health = await getPipelineHealth(teamId);
    expect(leg(health)?.stale).toBe(true);
    expect(health.failing.map((l) => l.source)).toContain("meeting_notes");
  });

  it("does not flag a healthy poller", async () => {
    const { teamId } = await seedTeam();
    await record(teamId, "scheduler", { at: Date.now() - 60 * 1000 });
    await record(teamId, "api", { at: Date.now() - 1000 });

    expect(leg(await getPipelineHealth(teamId))?.stale).toBe(false);
  });

  it("still reports a FAILED push-triggered run — ok comes from the newest row of any trigger", async () => {
    const { teamId } = await seedTeam();
    await record(teamId, "scheduler", { at: Date.now() - 60 * 1000 });
    await record(teamId, "api", { ok: false, errors: ["model down"], at: Date.now() - 1000 });

    const health = await getPipelineHealth(teamId);
    // The property this test is FOR is unchanged: the verdict reads the newest row whatever its
    // trigger, so a push-triggered failure is recorded and visible on the leg.
    expect(leg(health)?.ok).toBe(false);
    expect(leg(health)?.error).toBe("model down");
    // What DID change (BANNERFLAP-1): a lone failure on top of a success is `unconfirmed`, so it no
    // longer paints the loud banner. This assertion used to read `false`. It is flipped deliberately,
    // not to make the suite green — the next test proves an api-triggered failure still goes loud once
    // it repeats, which is what stops this from being a silent loss of coverage.
    expect(leg(health)?.failureClass).toBe("unconfirmed");
    expect(health.healthy).toBe(true);
  });

  it("a REPEATED push-triggered failure is loud — trigger-agnostic loudness survives confirmation", async () => {
    // The control for the flipped assertion above. Without this, "one api failure is quiet" could be
    // hiding "api failures are never loud", which would be a real regression for a team whose
    // meeting-notes backfill only ever runs from `aios push`.
    const { teamId } = await seedTeam();
    await record(teamId, "scheduler", { at: Date.now() - 90 * 1000 });
    await record(teamId, "api", { ok: false, errors: ["model down"], at: Date.now() - 60 * 1000 });
    await record(teamId, "api", { ok: false, errors: ["model down again"], at: Date.now() - 1000 });

    const health = await getPipelineHealth(teamId);
    expect(leg(health)?.failureClass).toBe("confirmed");
    expect(health.failing.map((l) => l.source)).toContain("meeting_notes");
    expect(health.healthy).toBe(false);
  });

  it("does not age a leg that has only ever run on demand — no heartbeat to judge, so no wolf-crying", async () => {
    const { teamId } = await seedTeam();
    await record(teamId, "api", { at: beyondThreshold() });

    const health = await getPipelineHealth(teamId);
    expect(leg(health)?.stale).toBe(false);
    expect(health.failing.map((l) => l.source)).not.toContain("meeting_notes");
  });
});
