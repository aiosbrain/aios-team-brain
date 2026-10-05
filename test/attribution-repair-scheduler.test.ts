import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAttributionRepairLoop,
  REPAIR_IDLE_POLL_MS,
  startAttributionRepairScheduler,
  type AttributionRepairLoop,
  type AttributionRepairLoopDeps,
} from "@/lib/ingest/attribution-repair-scheduler";
import { kickAttributionRepair, onAttributionRepairKick } from "@/lib/ingest/reconcile-attribution";
import type { PendingRepairTeam, RepairTurnDisposition } from "@/lib/ingest/reconcile-attribution";

/**
 * THE ATTRIBUTION-REPAIR SCHEDULER (AIO-1167), on a fake clock over a model of the durable queue.
 *
 * Spec.
 *   1. BOOT: starting it discovers durable pending work at once — it does not wait an interval, and
 *      it does not run anything synchronously inside `start()` (register() must return first).
 *   2. PARTIAL: a team whose turn leaves work to do NOW gets its next turn immediately — the next
 *      round starts when the last one returns, with no timer (not even a zero-delay one) between
 *      them. A long repair is driven to convergence with no clock time passing and no failure.
 *   3. IDLE: with nothing to continue it asks again every five seconds, and not more often.
 *   4. DEADLINE: a failed turn is in durable backoff; the team is not attempted again until its
 *      deadline has passed, and is found by an ordinary poll once it has.
 *   5. FAIRNESS: each round gives every pending team ONE turn, oldest-touched first, so a team with
 *      an enormous repair cannot starve another, and a team that becomes pending mid-way is served
 *      within one round. A per-round cap defers and never hides: a capped round is followed at once
 *      by the next page. A team whose turn could not move it (busy, deferred, failed) is set aside
 *      BY NAME for one idle interval — never by position, because the queue shifts under any
 *      offset (a failed team leaves it for its backoff) and the offset then lands on a healthy team.
 *   6. BUSY is not progress and not failure: it waits for the next poll rather than spinning.
 *   7. A KICK only brings the next round forward; rounds never overlap; nothing depends on a kick.
 *   8. SUPPRESSION: it does not start on a copied-staging runtime or when opted out.
 *
 * The model below is the authority table as the scheduler sees it: per team, how many batches
 * remain, when it was last touched, and a retry deadline. The real-PostgreSQL counterpart is
 * `test/datamechanics/attribution-repair-continuation.datamechanics.test.ts`.
 */

interface ModelTeam {
  remaining: number;
  touched: number;
  deadline: number;
  /** Turn numbers (1-based, per team) on which the turn fails. */
  failOn?: number[];
  busyUntil?: number;
  /** The turn finds a retry deadline that discovery was too early to see, until this time. */
  deferredUntil?: number;
  turns: number;
}

class Authority {
  readonly teams = new Map<string, ModelTeam>();
  readonly discoveries: number[] = [];
  readonly turns: { team: string; at: number; disposition: RepairTurnDisposition | "failed" }[] = [];
  private sequence = 0;

  pending(team: string, remaining: number, over: Partial<ModelTeam> = {}): void {
    this.teams.set(team, { remaining, touched: ++this.sequence, deadline: 0, turns: 0, ...over });
  }

  discover = async (limit: number, exclude: readonly string[] = []): Promise<PendingRepairTeam[]> => {
    this.discoveries.push(Date.now());
    return [...this.teams.entries()]
      // Exactly the production filter order: pending, deadline passed, not excluded — THEN the cap.
      .filter(([teamId, team]) => team.remaining > 0 && team.deadline <= Date.now() && !exclude.includes(teamId))
      .sort(([, a], [, b]) => a.touched - b.touched)
      .slice(0, limit)
      .map(([teamId]) => ({ teamId, teamSlug: teamId }));
  };

  runTurn = async ({ teamId }: PendingRepairTeam): Promise<RepairTurnDisposition> => {
    const team = this.teams.get(teamId)!;
    const record = (disposition: RepairTurnDisposition | "failed") => {
      this.turns.push({ team: teamId, at: Date.now(), disposition });
    };
    if (team.busyUntil !== undefined && Date.now() < team.busyUntil) {
      record("busy");
      return "busy";
    }
    if (team.deferredUntil !== undefined && Date.now() < team.deferredUntil) {
      record("deferred");
      return "deferred";
    }
    team.turns++;
    if (team.failOn?.includes(team.turns)) {
      // What a failed turn leaves durable: nothing done, and a deadline.
      team.deadline = Date.now() + 30_000;
      team.touched = ++this.sequence;
      record("failed");
      throw new Error(`turn ${team.turns} failed for ${teamId}`);
    }
    team.remaining--;
    team.touched = ++this.sequence;
    const disposition = team.remaining > 0 ? "continuing" : "settled";
    record(disposition);
    return disposition;
  };

  order(): string[] {
    return this.turns.map((turn) => turn.team);
  }
}

let loop: AttributionRepairLoop | null = null;
const failures: { team: string | null; message: string }[] = [];

function start(authority: Authority, over: Partial<AttributionRepairLoopDeps> = {}): AttributionRepairLoop {
  loop = createAttributionRepairLoop({
    discover: authority.discover,
    runTurn: authority.runTurn,
    onFailure: (team, error) => failures.push({ team: team?.teamId ?? null, message: (error as Error).message }),
    ...over,
  });
  loop.start();
  return loop;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
  failures.length = 0;
});

afterEach(() => {
  loop?.stop();
  loop = null;
  onAttributionRepairKick(null);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("attribution-repair scheduler: boot, continuation, idle", () => {
  it("BOOT discovers durable pending work at once, and nothing runs inside start() itself", async () => {
    const authority = new Authority();
    authority.pending("a", 1);
    start(authority);
    // start() only armed a timer: register() can return before any database work begins.
    expect(authority.discoveries).toEqual([]);
    const boot = Date.now();
    await vi.advanceTimersByTimeAsync(0);
    expect(authority.discoveries).toEqual([boot]);
    expect(authority.turns).toEqual([{ team: "a", at: boot, disposition: "settled" }]);
  });

  it("PARTIAL progress is continuation: a 40-batch repair converges with no idle wait and no failure", async () => {
    const authority = new Authority();
    authority.pending("big", 40);
    start(authority);
    const boot = Date.now();
    // No clock time passes at all: each next round starts when the last one returns.
    await vi.advanceTimersByTimeAsync(0);
    expect(authority.turns).toHaveLength(40);
    expect(authority.turns.every((turn) => turn.at === boot)).toBe(true);
    expect(authority.turns.at(-1)!.disposition).toBe("settled");
    expect(authority.teams.get("big")!.remaining).toBe(0);
    // One discovery per round: every batch was preceded by asking the durable queue again.
    expect(authority.discoveries).toHaveLength(40);
    expect(failures).toEqual([]);
  });

  it("continuation is not a timer: the only timers ever armed are the boot round and the idle poll", async () => {
    // A zero-delay timer is not zero (Node, and this fake clock, run it a millisecond later), so a
    // loop that scheduled its next round on one would put the clock between every pair of batches.
    const authority = new Authority();
    authority.pending("big", 12);
    authority.pending("other", 3);
    const armed: number[] = [];
    const pendingDuringTurns: number[] = [];
    const original = authority.runTurn;
    authority.runTurn = async (team) => {
      pendingDuringTurns.push(vi.getTimerCount());
      return original(team);
    };
    start(authority, {
      setTimer: (fn, ms) => {
        armed.push(ms);
        return setTimeout(fn, ms);
      },
      clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(authority.turns).toHaveLength(15);
    expect(authority.teams.get("big")!.remaining).toBe(0);
    expect(armed).toEqual([0, REPAIR_IDLE_POLL_MS]);
    // While there was work, nothing was waiting on the clock at all.
    expect(pendingDuringTurns.every((count) => count === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("IDLE polls every five seconds — not sooner — and finds work that appeared without any kick", async () => {
    const authority = new Authority();
    start(authority);
    const boot = Date.now();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(REPAIR_IDLE_POLL_MS - 1);
    expect(authority.discoveries).toEqual([boot]);
    await vi.advanceTimersByTimeAsync(1);
    expect(authority.discoveries).toEqual([boot, boot + REPAIR_IDLE_POLL_MS]);

    // A mutation in another process: durable state only, nobody tells this scheduler.
    authority.pending("late", 2);
    await vi.advanceTimersByTimeAsync(REPAIR_IDLE_POLL_MS);
    expect(authority.order()).toEqual(["late", "late"]);
    expect(authority.turns[0].at).toBe(boot + 2 * REPAIR_IDLE_POLL_MS);
    expect(REPAIR_IDLE_POLL_MS).toBe(5_000);
  });
});

describe("attribution-repair scheduler: deadline, fairness, busy", () => {
  it("DEADLINE: a failed team is not attempted again until its durable deadline has passed", async () => {
    const authority = new Authority();
    authority.pending("flaky", 2, { failOn: [1] });
    start(authority);
    const boot = Date.now();
    await vi.advanceTimersByTimeAsync(0);
    expect(authority.turns).toEqual([{ team: "flaky", at: boot, disposition: "failed" }]);
    expect(failures).toEqual([{ team: "flaky", message: "turn 1 failed for flaky" }]);

    // Polls keep happening every five seconds, and none of them touches the team in backoff.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(authority.discoveries.length).toBeGreaterThanOrEqual(6);
    expect(authority.turns).toHaveLength(1);

    // The first poll at or after the deadline resumes it, and it then continues without waiting.
    await vi.advanceTimersByTimeAsync(REPAIR_IDLE_POLL_MS);
    expect(authority.turns.slice(1).map((turn) => turn.disposition)).toEqual(["continuing", "settled"]);
    expect(authority.turns[1].at).toBeGreaterThanOrEqual(boot + 30_000);
    expect(authority.turns[1].at).toBeLessThan(boot + 30_000 + REPAIR_IDLE_POLL_MS);
    expect(authority.turns[2].at).toBe(authority.turns[1].at);
  });

  it("a failure in backoff does not hold back another team's continuation", async () => {
    const authority = new Authority();
    authority.pending("flaky", 1, { failOn: [1] });
    authority.pending("healthy", 3);
    start(authority);
    await vi.advanceTimersByTimeAsync(0);
    expect(authority.order()).toEqual(["flaky", "healthy", "healthy", "healthy"]);
    expect(authority.teams.get("healthy")!.remaining).toBe(0);
  });

  it("FAIRNESS: one turn per team per round, oldest-touched first — a huge repair cannot starve a small one", async () => {
    const authority = new Authority();
    authority.pending("huge", 50);
    authority.pending("small", 2);
    start(authority);
    await vi.advanceTimersByTimeAsync(0);
    // They alternate from the first round; `small` is done after its second turn, not after 50.
    expect(authority.order().slice(0, 4)).toEqual(["huge", "small", "huge", "small"]);
    expect(authority.order().lastIndexOf("small")).toBe(3);
    expect(authority.order().filter((team) => team === "huge")).toHaveLength(50);
  });

  it("FAIRNESS: a team that becomes pending mid-repair is served within one round", async () => {
    const authority = new Authority();
    authority.pending("huge", 30);
    const original = authority.runTurn;
    authority.runTurn = async (team) => {
      const disposition = await original(team);
      // Appears after `huge`'s fifth batch, with no kick.
      if (authority.turns.length === 5) authority.pending("arrival", 1);
      return disposition;
    };
    start(authority);
    await vi.advanceTimersByTimeAsync(0);
    const order = authority.order();
    expect(order.slice(0, 5)).toEqual(["huge", "huge", "huge", "huge", "huge"]);
    // The very next round reaches it: at most one more `huge` batch goes first.
    expect(order.indexOf("arrival")).toBeLessThanOrEqual(6);
    expect(authority.teams.get("huge")!.remaining).toBe(0);
  });

  it("FAIRNESS under a per-round cap: every team is reached, because a turn moves its team to the back", async () => {
    const authority = new Authority();
    for (const team of ["a", "b", "c", "d", "e"]) authority.pending(team, 2);
    start(authority, { teamsPerRound: 2 });
    await vi.advanceTimersByTimeAsync(0);
    const order = authority.order();
    // Nobody gets a second turn before everybody has had a first.
    expect(new Set(order.slice(0, 5))).toEqual(new Set(["a", "b", "c", "d", "e"]));
    expect(order).toHaveLength(10);
  });

  it("THE CAP DEFERS, IT NEVER HIDES: a page full of teams that cannot move does not stand in front of the ones behind it", async () => {
    // Two teams are owned by another process for a long time. A busy turn touches nothing, so they
    // stay at the front of the durable order — and with a cap of two they fill every first page.
    const authority = new Authority();
    const boot = Date.now();
    authority.pending("owned-1", 1, { busyUntil: boot + 60_000 });
    authority.pending("owned-2", 1, { busyUntil: boot + 60_000 });
    authority.pending("behind", 3);
    authority.pending("further-behind", 1);
    start(authority, { teamsPerRound: 2 });
    await vi.advanceTimersByTimeAsync(0);
    // Both teams behind the cap were reached and driven to completion at once, without a poll.
    expect(authority.teams.get("behind")!.remaining).toBe(0);
    expect(authority.teams.get("further-behind")!.remaining).toBe(0);
    const served = authority.turns.filter((turn) => turn.disposition !== "busy");
    expect(served.map((turn) => turn.team)).toEqual(["behind", "further-behind", "behind", "behind"]);
    expect(served.every((turn) => turn.at === boot)).toBe(true);
    expect(failures).toEqual([]);
    // And it does not spin on the two it cannot have: it is idle, on the one poll timer, and the
    // next poll finds them still busy and goes idle again.
    expect(vi.getTimerCount()).toBe(1);
    const turnsAtIdle = authority.turns.length;
    const discoveriesAtIdle = authority.discoveries.length;
    await vi.advanceTimersByTimeAsync(REPAIR_IDLE_POLL_MS - 1);
    expect(authority.discoveries).toHaveLength(discoveriesAtIdle);
    await vi.advanceTimersByTimeAsync(1);
    expect(authority.turns.slice(turnsAtIdle).map((turn) => [turn.team, turn.disposition]))
      .toEqual([["owned-1", "busy"], ["owned-2", "busy"]]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("CAPPED + a FAILURE: the failed team leaving the queue for its backoff does not push a small healthy team out of every page", async () => {
    // The shape that starves under a positional skip: A fails and disappears into backoff, B and D
    // have long repairs, C needs one turn. "Skip one" would then skip C — whoever is first once A
    // is gone — on every page for as long as B and D keep working.
    const authority = new Authority();
    authority.pending("A", 1, { failOn: [1] });
    authority.pending("B", 30);
    authority.pending("C", 1);
    authority.pending("D", 30);
    start(authority, { teamsPerRound: 2 });
    const boot = Date.now();
    await vi.advanceTimersByTimeAsync(0);
    // Round 1 is A (fails) and B; round 2 is the two teams that have not had a turn — C first.
    expect(authority.order().slice(0, 4)).toEqual(["A", "B", "C", "D"]);
    expect(authority.turns[2]).toEqual({ team: "C", at: boot, disposition: "settled" });
    // B and D then take turn about to the end; nobody waited on the clock and A was tried once.
    expect(authority.teams.get("B")!.remaining).toBe(0);
    expect(authority.teams.get("D")!.remaining).toBe(0);
    expect(authority.turns.every((turn) => turn.at === boot)).toBe(true);
    expect(authority.order().filter((team) => team === "A")).toHaveLength(1);
    expect(failures).toEqual([{ team: "A", message: "turn 1 failed for A" }]);
    // A failure is not progress: with only A left the loop is idle, on its one timer.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("CAPPED at the production cap: 22 teams, the first fails, and the 21st — one turn of work — is served in the second round", async () => {
    const authority = new Authority();
    const names = Array.from({ length: 22 }, (_, index) => `t${String(index + 1).padStart(2, "0")}`);
    for (const name of names) {
      authority.pending(name, name === "t21" ? 1 : 3, name === "t01" ? { failOn: [1] } : {});
    }
    start(authority); // REPAIR_TEAMS_PER_ROUND, as production runs it
    const boot = Date.now();
    await vi.advanceTimersByTimeAsync(0);
    const order = authority.order();
    // Round 1 is t01..t20. Round 2 starts with the two teams the cap deferred.
    expect(order.slice(0, 20)).toEqual(names.slice(0, 20));
    expect(order.slice(20, 22)).toEqual(["t21", "t22"]);
    expect(authority.turns[20]).toEqual({ team: "t21", at: boot, disposition: "settled" });
    // Every healthy team converged in the same burst; each got exactly its own turns, in rotation.
    for (const name of names.slice(1)) expect(authority.teams.get(name)!.remaining, name).toBe(0);
    expect(order).toHaveLength(1 + 20 * 3 + 1);
    expect(authority.turns.every((turn) => turn.at === boot)).toBe(true);
    expect(failures.map((failure) => failure.team)).toEqual(["t01"]);
  });

  it("CAPPED + DEFERRED and BUSY at the front: each is tried once, rests, and the teams behind are served at once", async () => {
    const authority = new Authority();
    const boot = Date.now();
    authority.pending("deferred", 1, { deferredUntil: boot + 60_000 });
    authority.pending("owned", 1, { busyUntil: boot + 60_000 });
    authority.pending("small", 1);
    authority.pending("large", 9);
    start(authority, { teamsPerRound: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(authority.turns.slice(0, 4).map((turn) => [turn.team, turn.disposition])).toEqual([
      ["deferred", "deferred"], ["owned", "busy"], ["small", "settled"], ["large", "continuing"],
    ]);
    expect(authority.teams.get("large")!.remaining).toBe(0);
    // Neither stuck team was asked for again while the others worked: no spin, and no progress
    // was ever attributed to them (the loop went idle the moment `large` finished).
    expect(authority.turns.filter((turn) => turn.team === "deferred" || turn.team === "owned")).toHaveLength(2);
    expect(authority.turns.every((turn) => turn.at === boot)).toBe(true);
    expect(failures).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    // They are asked for again at the idle interval, as if the loop had simply been idle.
    await vi.advanceTimersByTimeAsync(REPAIR_IDLE_POLL_MS);
    expect(authority.turns.slice(-2).map((turn) => [turn.team, turn.at - boot, turn.disposition])).toEqual([
      ["deferred", REPAIR_IDLE_POLL_MS, "deferred"], ["owned", REPAIR_IDLE_POLL_MS, "busy"],
    ]);
  });

  it("a rest is bounded by the CLOCK, not by the work: under sustained capped repairs a team that was busy is served one idle interval later", async () => {
    // Driven round by round on an injected clock: each productive turn takes one second.
    const clock = { t: 0 };
    const teams = new Map([
      ["x", { remaining: 1, touched: 1 }],
      ["a", { remaining: 8, touched: 2 }],
      ["b", { remaining: 8, touched: 3 }],
    ]);
    let sequence = 3;
    const log: [number, string, string][] = [];
    const manual = createAttributionRepairLoop({
      teamsPerRound: 2,
      now: () => clock.t,
      discover: async (limit, exclude) => [...teams.entries()]
        .filter(([teamId, team]) => team.remaining > 0 && !exclude.includes(teamId))
        .sort(([, left], [, right]) => left.touched - right.touched)
        .slice(0, limit)
        .map(([teamId]) => ({ teamId, teamSlug: teamId })),
      runTurn: async ({ teamId }) => {
        const team = teams.get(teamId)!;
        // `x` is owned by another process for the first three seconds, and is first in the queue.
        if (teamId === "x" && clock.t < 3_000) {
          log.push([clock.t, teamId, "busy"]);
          return "busy";
        }
        team.remaining--;
        team.touched = ++sequence;
        const disposition = team.remaining > 0 ? "continuing" : "settled";
        log.push([clock.t, teamId, disposition]);
        clock.t += 1_000;
        return disposition;
      },
    });
    const rounds = [await manual.runRound(), await manual.runRound(), await manual.runRound(), await manual.runRound()];
    // Every round filled its page with real work — the pass never "ended" — yet `x` was not kept
    // out until it did, and was not asked for on every round either.
    expect(rounds.map((summary) => summary.capped)).toEqual([true, true, true, true]);
    expect(log.filter(([, team]) => team === "x")).toEqual([[0, "x", "busy"], [REPAIR_IDLE_POLL_MS, "x", "settled"]]);
    expect(teams.get("a")!.remaining).toBeGreaterThan(0);
    expect(teams.get("b")!.remaining).toBeGreaterThan(0);
    // While it rested, the two long repairs alternated and nothing else was skipped.
    expect(log.slice(1, 6).map(([, team]) => team)).toEqual(["a", "b", "a", "b", "a"]);
  });

  it("a capped round of teams that all SETTLED is followed at once by the teams still waiting", async () => {
    const authority = new Authority();
    for (const team of ["a", "b", "c", "d", "e"]) authority.pending(team, 1);
    start(authority, { teamsPerRound: 2 });
    const boot = Date.now();
    await vi.advanceTimersByTimeAsync(0);
    // No round had anything left to continue, yet nobody waited five seconds behind the cap.
    expect(authority.order()).toEqual(["a", "b", "c", "d", "e"]);
    expect(authority.turns.every((turn) => turn.at === boot && turn.disposition === "settled")).toBe(true);
  });

  it("BUSY is neither progress nor failure: it waits for the next poll instead of spinning", async () => {
    const authority = new Authority();
    const boot = Date.now();
    authority.pending("owned-elsewhere", 1, { busyUntil: boot + 7_000 });
    start(authority);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(REPAIR_IDLE_POLL_MS);
    expect(authority.turns.map((turn) => [turn.at - boot, turn.disposition]))
      .toEqual([[0, "busy"], [REPAIR_IDLE_POLL_MS, "busy"]]);
    await vi.advanceTimersByTimeAsync(REPAIR_IDLE_POLL_MS);
    expect(authority.turns.at(-1)).toMatchObject({ at: boot + 2 * REPAIR_IDLE_POLL_MS, disposition: "settled" });
    expect(failures).toEqual([]);
  });

  it("a DISCOVERY failure is reported and retried at the idle interval", async () => {
    const authority = new Authority();
    authority.pending("a", 1);
    const discover = authority.discover;
    let outage = true;
    authority.discover = async (limit, exclude) => {
      if (outage) {
        authority.discoveries.push(Date.now());
        throw new Error("database unreachable");
      }
      return discover(limit, exclude);
    };
    start(authority);
    await vi.advanceTimersByTimeAsync(0);
    expect(failures).toEqual([{ team: null, message: "database unreachable" }]);
    expect(authority.turns).toEqual([]);
    outage = false;
    await vi.advanceTimersByTimeAsync(REPAIR_IDLE_POLL_MS);
    expect(authority.order()).toEqual(["a"]);
  });
});

describe("attribution-repair scheduler: kicks accelerate only", () => {
  it("a kick brings the next round forward from the idle wait", async () => {
    const authority = new Authority();
    const running = start(authority);
    const boot = Date.now();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    authority.pending("kicked", 1);
    running.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(authority.turns).toEqual([{ team: "kicked", at: boot + 1_000, disposition: "settled" }]);
    // The idle cadence resumes from the kicked round; the superseded timer does not also fire.
    await vi.advanceTimersByTimeAsync(REPAIR_IDLE_POLL_MS - 1);
    expect(authority.discoveries).toEqual([boot, boot + 1_000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(authority.discoveries).toEqual([boot, boot + 1_000, boot + 1_000 + REPAIR_IDLE_POLL_MS]);
  });

  it("a kick ends every rest: a team that was busy because the kicking caller owned it is taken up at once", async () => {
    const authority = new Authority();
    const boot = Date.now();
    // Owned by a bounded caller for the first second; then that caller hands over and kicks.
    authority.pending("handed-over", 2, { busyUntil: boot + 1_000 });
    const running = start(authority);
    await vi.advanceTimersByTimeAsync(0);
    expect(authority.turns).toEqual([{ team: "handed-over", at: boot, disposition: "busy" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    running.kick();
    await vi.advanceTimersByTimeAsync(0);
    // Not four seconds later, when its rest would have run out by itself.
    expect(authority.turns.slice(1)).toEqual([
      { team: "handed-over", at: boot + 1_000, disposition: "continuing" },
      { team: "handed-over", at: boot + 1_000, disposition: "settled" },
    ]);
  });

  it("rounds never overlap: a kick during a round queues exactly one follow-up round", async () => {
    const authority = new Authority();
    authority.pending("slow", 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = authority.runTurn;
    let inFlight = 0;
    let peak = 0;
    authority.runTurn = async (team) => {
      peak = Math.max(peak, ++inFlight);
      if (team.teamId === "slow") await gate;
      try {
        return await original(team);
      } finally {
        inFlight--;
      }
    };
    const running = start(authority);
    await vi.advanceTimersByTimeAsync(0);
    expect(authority.discoveries).toHaveLength(1);
    // Work that this round's discovery was too early to see, announced three times over.
    authority.pending("arrived-mid-round", 1);
    running.kick();
    running.kick();
    running.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(authority.discoveries).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(authority.order()).toEqual(["slow", "arrived-mid-round"]);
    expect(authority.discoveries).toHaveLength(2);
    expect(peak).toBe(1);
  });

  it("a kick before start, or after stop, does nothing — and stop cancels the pending poll", async () => {
    const authority = new Authority();
    authority.pending("a", 1);
    const idle = createAttributionRepairLoop({ discover: authority.discover, runTurn: authority.runTurn });
    idle.kick();
    await vi.advanceTimersByTimeAsync(REPAIR_IDLE_POLL_MS * 2);
    expect(authority.discoveries).toEqual([]);

    idle.start();
    idle.start(); // idempotent: one loop, one timer
    await vi.advanceTimersByTimeAsync(0);
    expect(authority.discoveries).toHaveLength(1);
    idle.stop();
    idle.kick();
    await vi.advanceTimersByTimeAsync(REPAIR_IDLE_POLL_MS * 3);
    expect(authority.discoveries).toHaveLength(1);
  });

  it("runRound reports what one round did, and one team's failure does not end it for the rest", async () => {
    const authority = new Authority();
    const boot = Date.now();
    authority.pending("fails", 1, { failOn: [1] });
    authority.pending("continues", 2);
    authority.pending("settles", 1);
    authority.pending("busy", 1, { busyUntil: boot + 1 });
    const manual = createAttributionRepairLoop({ discover: authority.discover, runTurn: authority.runTurn });
    await expect(manual.runRound()).resolves.toEqual({
      attempted: 4, continuing: 1, settled: 1, busy: 1, deferred: 0, failed: 1, capped: false,
    });
  });
});

describe("attribution-repair scheduler: production start is suppressed where it must be", () => {
  const armed = () => vi.getTimerCount();

  it("does not start when opted out, and a kick then reaches nothing", () => {
    vi.stubEnv("ATTRIBUTION_REPAIR_POLL_ENABLED", "false");
    const listener = vi.fn();
    onAttributionRepairKick(listener);
    startAttributionRepairScheduler();
    expect(armed()).toBe(0);
    // It did not replace the registered listener with a loop of its own.
    kickAttributionRepair();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not start on a copied-staging runtime, whatever the poll flags say", () => {
    vi.stubEnv("STAGING_DATA_MODE", "copy-ready");
    vi.stubEnv("ATTRIBUTION_REPAIR_POLL_ENABLED", "true");
    vi.stubEnv("INGEST_POLL_ENABLED", "true");
    startAttributionRepairScheduler();
    expect(armed()).toBe(0);
  });

  it("instrumentation starts it outside the ingest gate, after the copied-staging return", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("instrumentation.ts", "utf8");
    const staging = source.indexOf("if (isCopiedStagingRuntime())");
    const ingestGate = source.indexOf('if (process.env.INGEST_POLL_ENABLED !== "false") {');
    const ingestGateEnd = source.indexOf("}", source.indexOf("startIngestScheduler();"));
    const repair = source.indexOf("startAttributionRepairScheduler();");
    expect(staging).toBeGreaterThan(-1);
    expect(ingestGate).toBeGreaterThan(staging);
    // After the ingest block has CLOSED: disabling connector polling does not disable the repair.
    expect(repair).toBeGreaterThan(ingestGateEnd);
    // And the ingest chain does not own it either: it neither imports nor starts it.
    const chain = readFileSync("lib/ingest/scheduler.ts", "utf8");
    expect(chain).not.toMatch(/import\(\s*["']@\/lib\/ingest\/attribution-repair-scheduler["']\s*\)/);
    expect(chain).not.toContain("startAttributionRepairScheduler");
  });
});
