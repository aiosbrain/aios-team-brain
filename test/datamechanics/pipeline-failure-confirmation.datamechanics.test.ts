import { describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import { recordIngestRun } from "@/lib/ingest/runs";
import { getPipelineHealth } from "@/lib/ingest/pipeline-health";

/**
 * BANNERFLAP-1 — the streak query, against real Postgres.
 *
 * The pure classification is unit-tested (`test/pipeline-failure-confirmation.test.ts`). What CANNOT
 * be unit-tested is the SQL that feeds it, and that is where this slice's sharpest hazards live:
 *
 *   • the window function replacing `distinct on (source)`, and its `finished_at desc, id desc`
 *     ordering under a SAME-MILLISECOND tie — a real shape (a fast fail then a retry in the same
 *     tick) that decides which row is "newest" and therefore whether the leg is failing at all;
 *   • the `(source, team_id)` partition. `access_bootstrap` writes a per-team row AND an
 *     instance-wide row on every tick, and the outer scope is `team_id = $1 or team_id is null`, so a
 *     source-level streak is broken by global heartbeat rows that say nothing about this team;
 *   • team scoping — another team's failures must not confirm this team's leg.
 *
 * FakeSupabase has none of this: no window functions, no `is not distinct from`, no ordering
 * semantics. A fake here would assert the shape of a query rather than its result.
 */

const MIN = 60 * 1000;

/**
 * `dense`, deliberately, for every classification fixture. `slack`/`github` are CONNECTOR_SOURCES:
 * with no enabled integration for the seeded team they are suppressed from `failing` by
 * `isOrphanedConnector` — so an "absent from the banner" assertion on them passes whether or not the
 * classification works at all. The first draft of this file used `slack` and was green for that wrong
 * reason. `dense` is neither a connector nor age-judged (`staleThresholdMs` is null), so the
 * classification is the ONLY term that can move it in or out of `failing`.
 */

async function record(opts: {
  teamId: string | null;
  source: string;
  ok: boolean;
  at: number;
  errors?: string[];
}): Promise<void> {
  await recordIngestRun(db(), {
    teamId: opts.teamId,
    source: opts.source,
    trigger: "scheduler",
    ok: opts.ok,
    created: 0,
    errors: opts.errors,
    // Epoch MS, not ISO — `recordIngestRun` takes numbers and derives duration from them. tsc does
    // not catch a mistake here because `tsconfig` excludes the test tree.
    startedAt: opts.at,
    finishedAt: opts.at,
  });
}

const leg = (health: Awaited<ReturnType<typeof getPipelineHealth>>, source: string) =>
  health.legs.find((l) => l.source === source);

describe("the streak query (data-mechanics)", () => {
  it("a lone failure after a success is UNCONFIRMED and absent from the loud banner", async () => {
    const { teamId } = await seedTeam();
    const now = Date.now();
    await record({ teamId, source: "dense", ok: true, at: now - 60 * MIN });
    await record({ teamId, source: "dense", ok: false, at: now - 30 * MIN, errors: ["timeout"] });

    const health = await getPipelineHealth(teamId);
    expect(leg(health, "dense")?.ok).toBe(false); // still visible and still red in the runs table
    expect(leg(health, "dense")?.failureClass).toBe("unconfirmed");
    expect(health.failing.map((l) => l.source)).not.toContain("dense");
  });

  it("two consecutive failures are CONFIRMED, and failingSince is the OLDEST of the streak", async () => {
    const { teamId } = await seedTeam();
    const now = Date.now();
    await record({ teamId, source: "dense", ok: true, at: now - 90 * MIN });
    await record({ teamId, source: "dense", ok: false, at: now - 60 * MIN, errors: ["first"] });
    await record({ teamId, source: "dense", ok: false, at: now - 30 * MIN, errors: ["second"] });

    const health = await getPipelineHealth(teamId);
    const l = leg(health, "dense");
    expect(l?.failureClass).toBe("confirmed");
    expect(health.failing.map((s) => s.source)).toContain("dense");
    // The duration the banner renders: the START of the streak, not the newest re-failure.
    expect(Date.parse(l!.failingSince!)).toBeCloseTo(now - 60 * MIN, -4);
    expect(l?.error).toBe("second"); // the newest error still drives the message
  });

  it("a success NEWER than a streak resets it — a healed leg is not still failing", async () => {
    const { teamId } = await seedTeam();
    const now = Date.now();
    await record({ teamId, source: "dense", ok: false, at: now - 60 * MIN });
    await record({ teamId, source: "dense", ok: false, at: now - 45 * MIN });
    await record({ teamId, source: "dense", ok: true, at: now - 10 * MIN });

    const health = await getPipelineHealth(teamId);
    expect(leg(health, "dense")?.failureClass).toBe("ok");
    expect(leg(health, "dense")?.failingSince).toBeNull();
    expect(health.failing.map((l) => l.source)).not.toContain("dense");
  });

  it("breaks a same-millisecond tie by id — the retry, not the fail, is 'newest'", async () => {
    // The shape `llm-health` already documents: a fast fail then a retry in the same tick. Without
    // the `id desc` tie-break the newest row is arbitrary and the leg flickers. Inserted
    // fail-then-success at ONE instant, so only the PK can order them.
    const { teamId } = await seedTeam();
    const at = Date.now() - 20 * MIN;
    await record({ teamId, source: "dense", ok: false, at, errors: ["transient"] });
    await record({ teamId, source: "dense", ok: true, at });

    const health = await getPipelineHealth(teamId);
    expect(leg(health, "dense")?.ok).toBe(true);
    expect(leg(health, "dense")?.failureClass).toBe("ok");
  });

  it("an instance-wide row does NOT break a team's streak — the (source, team_id) partition", async () => {
    // `access_bootstrap` writes a per-team failure AND a global row on every tick
    // (lib/ingest/scheduler.ts). Partitioning by `source` alone lets those global rows sit between
    // this team's failures and un-confirm a real outage. Spec review found this; the codebase had
    // already been bitten by the same mixing (`context_backfill_all` exists because of it).
    const { teamId } = await seedTeam();
    const now = Date.now();
    await record({ teamId, source: "access_bootstrap", ok: true, at: now - 90 * MIN });
    await record({ teamId, source: "access_bootstrap", ok: false, at: now - 60 * MIN, errors: ["a"] });
    await record({ teamId: null, source: "access_bootstrap", ok: true, at: now - 45 * MIN }); // global heartbeat
    await record({ teamId, source: "access_bootstrap", ok: false, at: now - 30 * MIN, errors: ["b"] });

    const health = await getPipelineHealth(teamId);
    const l = leg(health, "access_bootstrap");
    expect(l?.failureClass).toBe("confirmed");
    expect(Date.parse(l!.failingSince!)).toBeCloseTo(now - 60 * MIN, -4);
  });

  it("is team-scoped — another team's failures cannot confirm this team's leg", async () => {
    const mine = await seedTeam();
    const other = await seedTeam();
    const now = Date.now();
    await record({ teamId: mine.teamId, source: "dense", ok: true, at: now - 60 * MIN });
    await record({ teamId: mine.teamId, source: "dense", ok: false, at: now - 30 * MIN });
    await record({ teamId: other.teamId, source: "dense", ok: false, at: now - 25 * MIN });
    await record({ teamId: other.teamId, source: "dense", ok: false, at: now - 20 * MIN });

    const health = await getPipelineHealth(mine.teamId);
    expect(leg(health, "dense")?.failureClass).toBe("unconfirmed");
    expect(health.failing.map((l) => l.source)).not.toContain("dense");
  });

  it("THE ACCEPTED COST, pinned so it stays deliberate: an api-only failure with no heartbeat is quiet", async () => {
    // Spec §3a. `meeting_notes` has a non-null staleness threshold, but `stale` ages the SCHEDULER
    // heartbeat — and a team whose only run is `trigger: 'api'` (from `aios push`) has none, so
    // `stale` never fires. Today that leg is loud; under confirmation it is quiet until a second run.
    // The window is self-closing (the next scheduler tick either succeeds or confirms), and the
    // alternative — ageing a leg with no heartbeat — is the cry-wolf behaviour
    // `pipeline-health-poller-heartbeat` was written to prevent. If a later change makes this loud,
    // THIS is the test that should be argued with rather than quietly updated.
    const { teamId } = await seedTeam();
    await recordIngestRun(db(), {
      teamId,
      source: "meeting_notes",
      trigger: "api",
      ok: false,
      created: 0,
      errors: ["push-triggered backfill failed"],
      startedAt: Date.now() - 10 * MIN,
      finishedAt: Date.now() - 10 * MIN,
    });

    const health = await getPipelineHealth(teamId);
    expect(leg(health, "meeting_notes")?.ok).toBe(false); // recorded and visible
    expect(leg(health, "meeting_notes")?.stale).toBe(false); // no heartbeat to age
    expect(leg(health, "meeting_notes")?.failureClass).toBe("unconfirmed");
    expect(health.failing.map((l) => l.source)).not.toContain("meeting_notes");
  });
});
