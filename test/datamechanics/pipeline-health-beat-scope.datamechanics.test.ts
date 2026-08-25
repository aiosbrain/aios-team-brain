import { describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import { recordIngestRun } from "@/lib/ingest/runs";
import { getPipelineHealth, staleThresholdMs } from "@/lib/ingest/pipeline-health";

/**
 * AUDITFIX-24 — spec `docs/design/auditfix24-staleness-beat-scope.md`.
 *
 * The staleness clock read `distinct on (source)` across `team_id = $1 or team_id is null`, taking
 * whichever partition was newer. So a team with no scheduler row of its OWN was aged against an
 * instance-wide row that says nothing about it — and once AUDITFIX-22 stopped refreshing the
 * instance-wide `access_bootstrap` row on ordinary ticks (prod: 51 rows/day → 0/day across the
 * deploy) that row froze, reddening the banner on every healthy team created afterwards.
 *
 * Real Postgres because the whole behaviour is the `distinct on` partitioning, which the in-memory
 * fake cannot run.
 *
 * ⚠️ WHICH OF THESE ARE RED-FIRST, because it is easy to miscount: AC1, AC1b, AC2b and AC12 fail
 * against the shipped code. AC2, AC4 and AC5's B-side pass before the fix — they are regression pins
 * and mutation targets, not evidence the fix does anything.
 */

const TEAM_BEAT = "access_bootstrap";
const GLOBAL_BEAT = "context_backfill_all";
const TEAM_BAR = staleThresholdMs(TEAM_BEAT)!;
const GLOBAL_BAR = staleThresholdMs(GLOBAL_BEAT)!;

const aged = (bar: number) => Date.now() - (bar + 60 * 60 * 1000);
const fresh = () => Date.now() - 60 * 1000;

/**
 * `finishedAt` is set explicitly on BOTH ends: it is what the health query orders and ages by, and a
 * fixture that set only `startedAt` would write every row at the current time — making "an old tick"
 * indistinguishable from a fresh one and leaving the ordering a tie.
 */
async function record(opts: {
  teamId: string | null;
  source: string;
  trigger: "scheduler" | "api";
  at: number;
  ok?: boolean;
}): Promise<void> {
  await recordIngestRun(db(), {
    teamId: opts.teamId ?? undefined,
    source: opts.source,
    trigger: opts.trigger,
    ok: opts.ok ?? true,
    created: 0,
    startedAt: opts.at - 1000,
    finishedAt: opts.at,
  });
}

async function legOf(teamId: string, source: string) {
  const health = await getPipelineHealth(teamId);
  return { health, leg: health.legs.find((l) => l.source === source) };
}

/** Asserts the fixture row really landed. A swallowed insert would leave every "not stale" assertion
 *  below passing for the wrong reason — the leg would simply not exist. */
async function schedulerRows(teamId: string | null, source: string): Promise<number> {
  const q = db().from("ingest_runs").select("id").eq("source", source).eq("trigger", "scheduler");
  const { data } = await (teamId === null ? q.is("team_id", null) : q.eq("team_id", teamId));
  return ((data ?? []) as unknown[]).length;
}

describe("AUDITFIX-24: the staleness beat reads the partition its poller writes (data-mechanics)", () => {
  it("AC1: a brand-new team is NOT stale on a team-beat leg, despite an aged instance-wide row", async () => {
    const { teamId } = await seedTeam();
    // The fossil: an aged instance-wide scheduler row, which is what AUDITFIX-22 stopped refreshing.
    await record({ teamId: null, source: TEAM_BEAT, trigger: "scheduler", at: aged(TEAM_BAR) });
    // The team's only row is its creation row — real teams get one, and it is NOT the poller.
    await record({ teamId, source: TEAM_BEAT, trigger: "api", at: fresh() });
    expect(await schedulerRows(teamId, TEAM_BEAT), "precondition: the team has NO scheduler row").toBe(0);
    expect(await schedulerRows(null, TEAM_BEAT), "precondition: the fossil must exist").toBe(1);

    const { leg } = await legOf(teamId, TEAM_BEAT);
    expect(leg, "the creation row makes the leg exist").toBeDefined();
    expect(leg!.stale, "a healthy brand-new team is not aged against a fossil").toBe(false);
  });

  it("AC1b: and the exemption holds when the team's OWN newest row is old too", async () => {
    const { teamId } = await seedTeam();
    await record({ teamId: null, source: TEAM_BEAT, trigger: "scheduler", at: aged(TEAM_BAR) });
    // ⚠️ AGED, unlike AC1. Without this, an implementation that falls back to the leg's own row when
    // the team has no beat passes AC1 outright, because AC1's creation row is fresh.
    await record({ teamId, source: TEAM_BEAT, trigger: "api", at: aged(TEAM_BAR) });

    const { leg } = await legOf(teamId, TEAM_BEAT);
    expect(leg, "the aged creation row still makes the leg exist").toBeDefined();
    expect(leg!.stale, "no scheduler row for this team means NO clock — not the leg's own row").toBe(false);
  });

  it("AC2: the team's OWN aged scheduler row still ages it", async () => {
    const { teamId } = await seedTeam();
    await record({ teamId, source: TEAM_BEAT, trigger: "scheduler", at: aged(TEAM_BAR) });

    const { leg, health } = await legOf(teamId, TEAM_BEAT);
    expect(leg!.stale, "a dead per-team poller is exactly what staleness is for").toBe(true);
    expect(health.failing.map((l) => l.source)).toContain(TEAM_BEAT);
  });

  it("AC2b: a FRESHER instance-wide row does NOT rescue an aged team beat", async () => {
    const { teamId } = await seedTeam();
    await record({ teamId, source: TEAM_BEAT, trigger: "scheduler", at: aged(TEAM_BAR) });
    await record({ teamId: null, source: TEAM_BEAT, trigger: "scheduler", at: fresh() });

    const { leg } = await legOf(teamId, TEAM_BEAT);
    // The direction that HIDES a failure: under "newest partition wins" this team reads healthy
    // while its own poller is dead.
    expect(leg!.stale, "an instance-wide row must not stand in for this team's dead beat").toBe(true);
  });

  it("AC3: a fresh team row wins over an aged fossil", async () => {
    const { teamId } = await seedTeam();
    await record({ teamId: null, source: TEAM_BEAT, trigger: "scheduler", at: aged(TEAM_BAR) });
    await record({ teamId, source: TEAM_BEAT, trigger: "scheduler", at: fresh() });

    const { leg } = await legOf(teamId, TEAM_BEAT);
    // Also the criterion that reddens a resolver keyed by `source` alone: Postgres orders
    // `is_global` false-then-true, so the global row would arrive last and win the overwrite.
    expect(leg!.stale).toBe(false);
  });

  it("AC4: an instance-wide leg still ages from instance-wide rows, both ways", async () => {
    const stale = await seedTeam();
    await record({ teamId: null, source: GLOBAL_BEAT, trigger: "scheduler", at: aged(GLOBAL_BAR) });
    expect((await legOf(stale.teamId, GLOBAL_BEAT)).leg!.stale, "no team row, aged global row → stale").toBe(true);

    const healthy = await seedTeam();
    await record({ teamId: null, source: GLOBAL_BEAT, trigger: "scheduler", at: fresh() });
    expect((await legOf(healthy.teamId, GLOBAL_BEAT)).leg!.stale, "a recent global row clears it").toBe(false);
  });

  it("AC5: a team-beat leg is judged per TEAM — nobody borrows another team's clock", async () => {
    // THREE teams in one fixture, deliberately: the property is that each resolves its OWN row, and
    // a two-team fixture cannot separate "reads the right team" from "reads the newest row anywhere".
    const ticking = await seedTeam();
    const wedged = await seedTeam();
    const brandNew = await seedTeam();
    await record({ teamId: ticking.teamId, source: TEAM_BEAT, trigger: "scheduler", at: fresh() });
    await record({ teamId: wedged.teamId, source: TEAM_BEAT, trigger: "scheduler", at: aged(TEAM_BAR) });
    await record({ teamId: brandNew.teamId, source: TEAM_BEAT, trigger: "api", at: fresh() });

    expect((await legOf(ticking.teamId, TEAM_BEAT)).leg!.stale, "it ticked a minute ago").toBe(false);
    // The load-bearing one. A resolver that dropped `team_id = $1` would hand this team the
    // TICKING team's fresher row and report it healthy while its own poller is dead.
    expect((await legOf(wedged.teamId, TEAM_BEAT)).leg!.stale, "its own beat is old, and no other team's rescues it").toBe(true);
    expect((await legOf(brandNew.teamId, TEAM_BEAT)).leg!.stale, "it has never ticked, so it has no clock at all").toBe(false);
  });

  it("AC6b: when the beat READ fails, getPipelineHealth still falls back to the leg's own row", async () => {
    const { teamId } = await seedTeam();
    await record({ teamId, source: TEAM_BEAT, trigger: "api", at: aged(TEAM_BAR) });

    // A failed beat read must not SILENCE staleness — the opposite failure from a missing clock.
    // Faulting the beat query specifically, keyed on its own select shape, so a fault that killed
    // every read would not pass for this.
    const health = await withFailingBeatRead(() => getPipelineHealth(teamId));
    const leg = health.legs.find((l) => l.source === TEAM_BEAT);
    expect(leg, "the leg still exists — only the BEAT read failed").toBeDefined();
    expect(leg!.stale, "fail OPEN: fall back to the newest row of any trigger, which is aged").toBe(true);
  });
});

/**
 * Runs `fn` with the BEAT query — and only the beat query — failing.
 *
 * `getPipelineHealth` reads through `runSql`, so the fault is injected there and keyed on the beat
 * statement's own text. Faulting every read instead would make this criterion pass for the bootstrap
 * query's reason rather than the beat's, which is how a fail-closed test in a sibling slice came to
 * prove nothing.
 */
async function withFailingBeatRead<T>(fn: () => Promise<T>): Promise<T> {
  const pool = await import("@/lib/db/pg/pool");
  const real = pool.runSql;
  const spy = (async (sql: string, params?: unknown[]) => {
    if (sql.includes("is_global")) throw new Error("beat read exploded");
    return real(sql as never, params as never);
  }) as typeof pool.runSql;
  Object.defineProperty(pool, "runSql", { value: spy, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(pool, "runSql", { value: real, configurable: true, writable: true });
  }
}
