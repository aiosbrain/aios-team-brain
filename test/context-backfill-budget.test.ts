import { describe, it, expect, afterEach } from "vitest";
import {
  budgetExpired,
  contextBackfillBudgetMs,
  DEFAULT_CONTEXT_BACKFILL_BUDGET_MS,
} from "@/lib/projects/context/backfill-budget";
import { orderByRotation, type TeamBackfillState } from "@/lib/projects/context/backfill-cursor";

/**
 * TICKSTALL-1 — the pure halves of the budget and the rotation. The rotation property in particular
 * (no team can be starved by a team ahead of it) is INVISIBLE on prod, which runs one team, so a pure
 * test is the only place it is ever actually checked.
 */

const ORIGINAL = process.env.CONTEXT_BACKFILL_BUDGET_MS;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CONTEXT_BACKFILL_BUDGET_MS;
  else process.env.CONTEXT_BACKFILL_BUDGET_MS = ORIGINAL;
});

describe("contextBackfillBudgetMs — one parse site, documented default", () => {
  it("defaults to 5 minutes when unset", () => {
    delete process.env.CONTEXT_BACKFILL_BUDGET_MS;
    expect(contextBackfillBudgetMs()).toBe(DEFAULT_CONTEXT_BACKFILL_BUDGET_MS);
    expect(DEFAULT_CONTEXT_BACKFILL_BUDGET_MS).toBe(5 * 60 * 1000);
  });

  it("reads an explicit override", () => {
    process.env.CONTEXT_BACKFILL_BUDGET_MS = "90000";
    expect(contextBackfillBudgetMs()).toBe(90_000);
  });

  it("falls back to the default on junk, zero or negative — never to a silently-disabled sweep", () => {
    // The direction matters. `0` is indistinguishable from "budget already expired", so a typo would
    // quietly reduce the sweep to one batch per tick forever, for a reason nobody could see in a log.
    for (const bad of ["", "abc", "0", "-1", "NaN"]) {
      process.env.CONTEXT_BACKFILL_BUDGET_MS = bad;
      expect(contextBackfillBudgetMs(), `input ${JSON.stringify(bad)}`).toBe(DEFAULT_CONTEXT_BACKFILL_BUDGET_MS);
    }
  });
});

describe("budgetExpired", () => {
  it("is inclusive at the boundary — exactly at the budget counts as spent", () => {
    expect(budgetExpired(1000, 1000 + 5000, 5000)).toBe(true);
    expect(budgetExpired(1000, 1000 + 4999, 5000)).toBe(false);
  });

  it("survives a backwards clock without reporting expiry", () => {
    // A negative elapsed must not read as expired; it also must not read as infinite budget, but the
    // caller's min-one-batch rule covers that side.
    expect(budgetExpired(10_000, 9_000, 5_000)).toBe(false);
  });
});

const st = (teamId: string, lastServedAt: string | null): TeamBackfillState => ({ teamId, lastServedAt, cursor: null });

describe("orderByRotation — no team can be starved by the team ahead of it", () => {
  it("serves the least-recently-served team first", () => {
    const out = orderByRotation([
      st("c", "2026-08-18T03:00:00Z"),
      st("a", "2026-08-18T01:00:00Z"),
      st("b", "2026-08-18T02:00:00Z"),
    ]);
    expect(out.map((s) => s.teamId)).toEqual(["a", "b", "c"]);
  });

  it("puts a never-served team at the FRONT", () => {
    // A new team must not wait behind an established one — and `null` sorting last is the obvious way
    // to get this backwards.
    const out = orderByRotation([st("old", "2026-08-18T01:00:00Z"), st("new", null)]);
    expect(out.map((s) => s.teamId)).toEqual(["new", "old"]);
  });

  it("breaks ties deterministically by teamId, so the order is TOTAL", () => {
    // Without a total order, two teams with identical clocks can swap places between passes and
    // "every team is served within N passes" stops being provable.
    const same = "2026-08-18T01:00:00Z";
    expect(orderByRotation([st("b", same), st("a", same)]).map((s) => s.teamId)).toEqual(["a", "b"]);
    expect(orderByRotation([st("a", same), st("b", same)]).map((s) => s.teamId)).toEqual(["a", "b"]);
  });

  it("does not mutate its input", () => {
    const input = [st("c", "3"), st("a", "1")];
    orderByRotation(input);
    expect(input.map((s) => s.teamId)).toEqual(["c", "a"]);
  });

  it("EVERY team is served within team_count passes, even when one team is served every pass", () => {
    // Criterion 9's property, simulated over the pure ordering rule: each pass serves ONE team (the
    // worst case, a budget that expires after the first turn) and stamps its clock. The invariant is
    // that after N passes with N teams, none has gone unserved — which is exactly what the old
    // sequential loop violated permanently.
    const teams = ["t1", "t2", "t3", "t4"];
    const states = new Map(teams.map((t) => [t, st(t, null)]));
    const servedAt = new Map<string, number>();
    for (let pass = 1; pass <= teams.length; pass++) {
      const first = orderByRotation([...states.values()])[0];
      if (!servedAt.has(first.teamId)) servedAt.set(first.teamId, pass);
      states.set(first.teamId, st(first.teamId, `2026-08-18T00:00:${String(pass).padStart(2, "0")}Z`));
    }
    expect([...servedAt.keys()].sort()).toEqual(teams);
    expect(Math.max(...servedAt.values())).toBeLessThanOrEqual(teams.length);
  });
});
