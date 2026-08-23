import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "./helpers";
import type { DbClient } from "@/lib/db/types";
import { runAccessBootstrapLeg } from "@/lib/ingest/access-bootstrap-leg";
import { ensureAccessBootstrapAllTeams } from "@/lib/access/bootstrap";
import { getPipelineHealth } from "@/lib/ingest/pipeline-health";
import { createTeam } from "@/lib/admin/teams";
import { GENERAL_SLUG } from "@/lib/access/system-projects";

/**
 * AUDITFIX-22 — spec `docs/design/auditfix22-access-bootstrap-ledger.md`.
 *
 * The LEDGER half: a per-team `access_bootstrap` failure must be loud on THAT team's card. Before
 * this slice the leg wrote a per-team row only on failure plus an instance-wide heartbeat every
 * tick, and `newest` (distinct on source, newest wins) handed the verdict to the later global
 * `ok:true` row — so a wedged team's card stayed green.
 *
 * Read §0b before touching a visibility criterion: `getPipelineHealth` keeps a LONE failure out of
 * `failing` until FAILURES_TO_CONFIRM = 2, and the banner renders only `failing`. A criterion that
 * runs one tick and asserts `legs[].ok === false` passes while the operator sees nothing.
 */

/** A team row planted directly — deliberately NOT through createTeam, so it has no creation row. */
async function bareTeam(): Promise<string> {
  const { data, error } = await db()
    .from("teams")
    .insert({ slug: `t-${randomUUID().slice(0, 8)}`, name: "Bare" })
    .select("id")
    .single();
  expect(error, "fixture team must insert").toBeNull();
  return (data as { id: string }).id;
}

/** The reserved-slug initiative that wedges bootstrap — the pre-existing shipped wedge. */
async function wedge(teamId: string): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: teamId, slug: GENERAL_SLUG, name: "General", kind: "initiative" })
    .select("id")
    .single();
  expect(error, "fixture wedge must insert").toBeNull();
  return (data as { id: string }).id;
}

async function legRows(teamId: string | null): Promise<{ ok: boolean; trigger: string; team_id: string | null }[]> {
  const q = db().from("ingest_runs").select("ok, trigger, team_id").eq("source", "access_bootstrap");
  const { data } = await (teamId === null ? q.is("team_id", null) : q.eq("team_id", teamId));
  return (data ?? []) as { ok: boolean; trigger: string; team_id: string | null }[];
}

async function legFor(teamId: string) {
  const h = await getPipelineHealth(teamId);
  return {
    health: h,
    leg: h.legs.find((l) => l.source === "access_bootstrap"),
    failing: h.failing.some((l) => l.source === "access_bootstrap"),
  };
}

/** Fails READS of one table at the adapter boundary; writes still go through for real. */
function clientWithFailingSelect(table: string, message = "injected read failure"): DbClient {
  const real = db();
  const injected = { data: null, error: { message } };
  return new Proxy(real as object, {
    get(target, prop, recv) {
      if (prop !== "from") return Reflect.get(target, prop, recv);
      return (name: string) => {
        const q = (target as { from: (n: string) => unknown }).from(name);
        if (name !== table) return q;
        let isWrite = false;
        const wrap = (b: object): unknown =>
          new Proxy(b, {
            get(bt, bp, br) {
              const v = Reflect.get(bt, bp, br);
              if (bp === "then") {
                if (isWrite) return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(bt) : v;
                return (res: (x: unknown) => unknown) => res(injected);
              }
              if (typeof v !== "function") return v;
              return (...args: unknown[]) => {
                if (bp === "insert" || bp === "upsert" || bp === "update" || bp === "delete") isWrite = true;
                const r = (v as (...a: unknown[]) => unknown).apply(bt, args);
                if (bp === "single" || bp === "maybeSingle") {
                  return isWrite ? r : { then: (res: (x: unknown) => unknown) => res(injected) };
                }
                return r === bt ? br : wrap(r as object);
              };
            },
          });
        return wrap(q as object);
      };
    },
  }) as DbClient;
}

/** Fails INSERTS into one table; reads pass. AC10 needs the insert faulted, not the read — the
 *  §4 "reads only" rule is scoped to BOOTSTRAP faults for exactly this reason. */
function clientWithFailingInsert(table: string): DbClient {
  const real = db();
  const injected = { data: null, error: { message: "injected insert failure" } };
  return new Proxy(real as object, {
    get(target, prop, recv) {
      if (prop !== "from") return Reflect.get(target, prop, recv);
      return (name: string) => {
        const q = (target as { from: (n: string) => unknown }).from(name);
        if (name !== table) return q;
        let isInsert = false;
        const wrap = (b: object): unknown =>
          new Proxy(b, {
            get(bt, bp, br) {
              const v = Reflect.get(bt, bp, br);
              if (bp === "then") {
                if (!isInsert) return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(bt) : v;
                return (res: (x: unknown) => unknown) => res(injected);
              }
              if (typeof v !== "function") return v;
              return (...args: unknown[]) => {
                if (bp === "insert" || bp === "upsert") isInsert = true;
                const r = (v as (...a: unknown[]) => unknown).apply(bt, args);
                if (bp === "single" || bp === "maybeSingle") {
                  return isInsert ? { then: (res: (x: unknown) => unknown) => res(injected) } : r;
                }
                return r === bt ? br : wrap(r as object);
              };
            },
          });
        return wrap(q as object);
      };
    },
  }) as DbClient;
}

describe("AUDITFIX-22: a per-team access failure is loud on that team's card", () => {
  it("AC1: a wedged team is CONFIRMED failing after two ticks — and writes exactly ONE row per tick", async () => {
    const wedged = await bareTeam();
    const healthy = await bareTeam();
    await wedge(wedged);

    await runAccessBootstrapLeg(db());
    await runAccessBootstrapLeg(db());

    const { health, leg, failing } = await legFor(wedged);
    expect(leg, "the leg must exist for this team").toBeDefined();
    expect(leg!.ok).toBe(false);
    // The shipped consumer, at the confirmed threshold — `legs[].ok === false` alone is invisible.
    expect(failing, "access_bootstrap must be in `failing`, which is what the banner renders").toBe(true);
    expect(leg!.failureClass).toBe("confirmed");
    expect(health.healthy).toBe(false);

    // Exactly one scoped ok:false row per tick. Keeping the old `for (const f of r.failed)` loop
    // alongside the callback would double-write, so ONE failed tick would reach streak 2 and go
    // confirmed — single-failure loudness, undoing BANNERFLAP-1 for this leg.
    const rows = await legRows(wedged);
    expect(rows.length, "two ticks, two rows — not four").toBe(2);
    expect(rows.every((r) => r.ok === false)).toBe(true);
    void healthy;
  });

  it("AC2: the OTHER team stays green through the same two ticks", async () => {
    const wedged = await bareTeam();
    const healthy = await bareTeam();
    await wedge(wedged);
    await runAccessBootstrapLeg(db());
    await runAccessBootstrapLeg(db());

    const { health, leg, failing } = await legFor(healthy);
    expect(leg?.ok, "its own newest row is a success").toBe(true);
    expect(failing).toBe(false);
    expect(health.healthy).toBe(true);
  });

  it("AC3: a HEALED team goes fully green — from a CONFIRMED red state, not merely 'green after'", async () => {
    const team = await bareTeam();
    const wedgeId = await wedge(team);
    await runAccessBootstrapLeg(db());
    await runAccessBootstrapLeg(db());
    const red = await legFor(team);
    expect(red.leg!.failureClass, "the precondition IS the criterion — it must be confirmed first").toBe("confirmed");
    expect(red.failing).toBe(true);

    await db().from("projects").delete().eq("id", wedgeId);
    await runAccessBootstrapLeg(db());

    const { health, leg, failing } = await legFor(team);
    expect(leg!.ok).toBe(true);
    expect(leg!.failureClass).toBe("ok");
    expect(leg!.failingSince).toBeNull();
    expect(failing).toBe(false);
    expect(health.healthy).toBe(true);
  });

  it("AC4: an ordinary tick writes NO team_id-is-null row — the global success row is what masked", async () => {
    const a = await bareTeam();
    const b = await bareTeam();
    const globalBefore = (await legRows(null)).length;

    await runAccessBootstrapLeg(db());

    expect((await legRows(a)).length, "team A gets its own row").toBe(1);
    expect((await legRows(b)).length, "team B gets its own row").toBe(1);
    expect((await legRows(null)).length, "and nothing instance-wide").toBe(globalBefore);
  });

  it("AC5: a FLEET-level failure reds a team that has NO row of its own, at the confirmed threshold", async () => {
    // Planted directly, so it genuinely has no scoped row — the prod analogue is a pre-slice team
    // at the deploy transition. createTeam always attempts one now, so this cannot use it.
    const team = await bareTeam();
    expect((await legRows(team)).length, "precondition: zero scoped rows").toBe(0);

    const faulted = clientWithFailingSelect("teams", "teams read exploded");
    await runAccessBootstrapLeg(faulted);
    // EXACTLY one per tick, checked after each — not ">= 2 in total". Two fleet rows in one tick
    // would reach FAILURES_TO_CONFIRM (2) in the team_id-is-null partition after a SINGLE blip and
    // forge `confirmed`, which is the fleet-level twin of the double-write AC1 pins per team.
    expect((await legRows(null)).filter((r) => !r.ok).length, "exactly one after tick 1").toBe(1);
    await runAccessBootstrapLeg(faulted);
    expect((await legRows(null)).filter((r) => !r.ok).length, "exactly two after tick 2").toBe(2);

    const { health, leg, failing } = await legFor(team);
    expect(leg!.ok).toBe(false);
    expect(leg!.failureClass).toBe("confirmed");
    expect(failing).toBe(true);
    expect(health.healthy).toBe(false);
  });

  it("AC6: ZERO teams writes an ok:TRUE heartbeat — nothing to converge is not a failure", async () => {
    // An empty fleet is modelled by faulting nothing and enumerating nothing: run the leg against a
    // client whose `teams` read succeeds with no rows.
    const empty = new Proxy(db() as object, {
      get(target, prop, recv) {
        if (prop !== "from") return Reflect.get(target, prop, recv);
        return (name: string) => {
          const q = (target as { from: (n: string) => unknown }).from(name);
          if (name !== "teams") return q;
          const rows = { then: (res: (x: unknown) => unknown) => res({ data: [], error: null }) };
          const wrap = (o: object): unknown =>
            new Proxy(o, { get: (t, p) => (p === "then" ? rows.then : () => wrap(rows)) });
          return wrap(rows);
        };
      },
    }) as DbClient;

    const before = (await legRows(null)).length;
    await runAccessBootstrapLeg(empty);
    const after = await legRows(null);
    expect(after.length, "a leg with no rows at all is ABSENT, and absent reads as healthy").toBe(before + 1);
    // Assert the PROPERTY, not a positional row: reading `after[last]` from an unordered select
    // would make this pass or fail on row order the moment a second global row exists.
    expect(after.every((r) => r.ok), "ok:false would manufacture a failure and red a team created moments later").toBe(true);
  });

  it("AC7 + AC12: a team created MID-TICK still has a row, and it does NOT claim to be the poller", async () => {
    const team = await createTeam(db(), { slug: `mid-${randomUUID().slice(0, 8)}`, name: "Mid" });
    // No tick has run for it at all — the row must come from the creation path.
    const rows = await legRows(team.id);
    expect(rows.length, "the creation path ATTEMPTS this team's first row").toBe(1);
    expect(rows[0].ok).toBe(true);
    expect(rows[0].trigger, "team creation is not the poller — a 'scheduler' row here fakes liveness").not.toBe("scheduler");

    const { leg } = await legFor(team.id);
    expect(leg, "and it surfaces as a leg rather than silence").toBeDefined();
  });

  it("AC8: the creation row records the outcome it actually got, not a hardcoded success", async () => {
    const slug = `fail-${randomUUID().slice(0, 8)}`;
    // Fault a read ensureAccessBootstrap needs, so it RETURNS ok:false.
    const faulted = clientWithFailingSelect("groups", "groups read exploded");
    const team = await createTeam(faulted, { slug, name: "Fail" });
    const rows = await legRows(team.id);
    expect(rows.length).toBe(1);
    expect(rows[0].ok, "a row that always said ok:true would satisfy AC7 while lying").toBe(false);
  });

  it("AC8b: and when the creation-time bootstrap THROWS, the row is still written", async () => {
    const slug = `throw-${randomUUID().slice(0, 8)}`;
    const real = db();
    const thrower = new Proxy(real as object, {
      get(target, prop, recv) {
        if (prop !== "from") return Reflect.get(target, prop, recv);
        return (name: string) => {
          // `teams` and `ingest_runs` must work: one creates the row, the other records it.
          if (name === "teams" || name === "ingest_runs" || name === "audit_log") {
            return (target as { from: (n: string) => unknown }).from(name);
          }
          throw new Error("bootstrap exploded");
        };
      },
    }) as DbClient;

    const team = await createTeam(thrower, { slug, name: "Throw" });
    const rows = await legRows(team.id);
    expect(rows.length, "the throw path is where this row is load-bearing").toBe(1);
    expect(rows[0].ok).toBe(false);
  });

  it("AC9: rows are written AS EACH TEAM COMPLETES — asserted while the wrapper is still in flight", async () => {
    const a = await bareTeam();
    const b = await bareTeam();

    // The block engages only AFTER the first ingest_runs insert, so it is armed by the very thing
    // under test. Under "record outcomes after the loop" no insert ever happens during the loop, so
    // the block never engages, the wrapper runs to completion, and nothing is observed mid-flight —
    // which is exactly how this criterion discriminates. A THROW could not: the wrapper catches a
    // per-team throw and continues, so a post-loop recording would still write both rows.
    let inserts = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const blocking = new Proxy(db() as object, {
      get(target, prop, recv) {
        if (prop !== "from") return Reflect.get(target, prop, recv);
        return (name: string) => {
          const q = (target as { from: (n: string) => unknown }).from(name);
          if (name === "ingest_runs") {
            return new Proxy(q as object, {
              get(bt, bp, br) {
                const v = Reflect.get(bt, bp, br);
                if (typeof v !== "function") return v;
                return (...args: unknown[]) => {
                  if (bp === "insert") inserts += 1;
                  const r = (v as (...x: unknown[]) => unknown).apply(bt, args);
                  return r === bt ? br : r;
                };
              },
            });
          }
          if (name !== "groups" || inserts === 0) return q;
          // A never-resolving read for the NEXT team, until the test releases it.
          return new Proxy(q as object, {
            get(bt, bp, br) {
              const v = Reflect.get(bt, bp, br);
              if (bp === "then") {
                return (res: (x: unknown) => unknown) => {
                  void gate.then(() => res({ data: [], error: { message: "released" } }));
                };
              }
              if (typeof v !== "function") return v;
              return (...args: unknown[]) => {
                const r = (v as (...x: unknown[]) => unknown).apply(bt, args);
                return r === bt ? br : r;
              };
            },
          });
        };
      },
    }) as DbClient;

    let settled = false;
    const inFlight = runAccessBootstrapLeg(blocking).finally(() => {
      settled = true;
    });

    let rowsMidFlight = 0;
    let stillRunning = false;
    // Budget generously: a real-Postgres bootstrap under a contended shared container can take
    // seconds, and this loop failing red on contention would read as a product bug.
    for (let i = 0; i < 600; i++) {
      rowsMidFlight = (await legRows(a)).length + (await legRows(b)).length;
      if (rowsMidFlight > 0) {
        stillRunning = !settled;
        break;
      }
      if (settled) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    release();
    await inFlight;

    expect(rowsMidFlight, "a team's row must exist before the wrapper returns").toBeGreaterThan(0);
    expect(stillRunning, "and the wrapper must still have been running when it did").toBe(true);
  });

  it("AC10: a swallowed scoped insert self-heals on the next tick", async () => {
    const team = await bareTeam();
    await runAccessBootstrapLeg(clientWithFailingInsert("ingest_runs"));
    expect((await legRows(team)).length, "the row was lost, and recordIngestRun cannot tell").toBe(0);

    await runAccessBootstrapLeg(db());
    const { leg } = await legFor(team);
    expect(leg, "the next tick restores the leg").toBeDefined();
    expect(leg!.ok).toBe(true);
  });

  it("AC11: the per-team tick row carries trigger 'scheduler' — the beat depends on it", async () => {
    const team = await bareTeam();
    await runAccessBootstrapLeg(db());
    const rows = await legRows(team);
    expect(rows.length).toBe(1);
    // No behavioural criterion can catch this: a fresh test DB has no scheduler rows, so the leg is
    // never aged and the whole suite stays green while production's beat freezes at deploy.
    expect(rows[0].trigger).toBe("scheduler");
  });

  it("AC13: the fossil-staleness cost is PINNED — a new team reads stale against a frozen global row", async () => {
    // Seed the fossil: an aged instance-wide scheduler row, which is what this slice stops refreshing.
    const old = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const { error: fossilErr } = await db().from("ingest_runs").insert({
      team_id: null, source: "access_bootstrap", trigger: "scheduler", ok: true,
      created: 0, started_at: old, finished_at: old,
    });
    expect(fossilErr, "the fossil must actually be seeded — this criterion is about it").toBeNull();
    const team = await createTeam(db(), { slug: `fossil-${randomUUID().slice(0, 8)}`, name: "Fossil" });

    const { leg } = await legFor(team.id);
    expect(leg, "its creation row makes the leg exist").toBeDefined();
    expect(leg!.ok, "and that row is a success").toBe(true);
    // ACCEPTED COST, not a bug discovered later: the beat resolves from the frozen global fossil
    // because this team has no scheduler row of its own yet, so a healthy brand-new team reads
    // stale until its first tick. AUDITFIX-24 carries the fix; §2b.1 carries the decision.
    expect(leg!.stale).toBe(true);
  });

  it("the callback's own failure never takes convergence down (spec §2b)", async () => {
    const a = await bareTeam();
    const b = await bareTeam();
    let seen = 0;
    const r = await ensureAccessBootstrapAllTeams(db(), {
      onOutcome: () => {
        seen += 1;
        throw new Error("ledger write exploded");
      },
    });
    expect(seen, "every team was still visited").toBeGreaterThanOrEqual(2);
    expect(r.failed.some((f) => f.error.includes("ledger write exploded")), "and no team was blamed for it").toBe(false);
    void a;
    void b;
  });
});
