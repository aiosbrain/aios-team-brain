import { describe, expect, it, vi } from "vitest";

/**
 * AUDITFIX-7, Fable diff review (LOW) — the substrate-error path must not WIDEN the answer.
 *
 * `visibleItemIdsForProjects` fails closed on a read error and flags it (`error: true`), so the id
 * set is an ERROR-derived empty rather than a genuine one. `delegatedVisibleItemIds` also returns the
 * token's project set now — and returning it on that path would serve hand-typed rows while every
 * SOURCED row was error-suppressed, i.e. a strictly wider answer than the same failure produced
 * before this slice. "Substrate error → serve nothing" is the posture everywhere else.
 *
 * The mutation removing that gate SURVIVED until this test existed: the fix had no pin, which is the
 * failure mode this slice has been caught by repeatedly.
 */
vi.mock("@/lib/access/oracle", () => ({
  effectiveVisibleProjects: async () => new Set(["p1", "p2"]),
  visibleProjects: async () => ({ projectIds: new Set<string>(), groupIds: new Set<string>() }),
}));

const TOKEN = { teamId: "t1", memberId: "m1", onBehalfOf: null, projectScope: null };

/** A DbClient stub whose substrate read fails — the only thing under test. */
function erroringDb(fail: boolean) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "not", "order", "limit", "gt"]) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (v: unknown) => unknown) =>
    resolve(fail ? { data: null, error: { message: "substrate read failed" } } : { data: [], error: null });
  return { from: () => chain } as never;
}

describe("delegatedVisibleItemIds — the error path must not widen", () => {
  it("a substrate READ ERROR yields NO project set, so the hand-typed arm closes too", async () => {
    const { delegatedVisibleItemIds } = await import("@/lib/access/enforce");
    const r = await delegatedVisibleItemIds(erroringDb(true), TOKEN);
    expect(r.error, "the read failure is still flagged").toBe(true);
    expect(r.ids.size).toBe(0);
    expect(
      r.projectIds,
      "returning the authority here would serve hand-typed rows while every sourced row was suppressed"
    ).toEqual([]);
  });

  it("a clean read still returns the effective project set", async () => {
    const { delegatedVisibleItemIds } = await import("@/lib/access/enforce");
    const r = await delegatedVisibleItemIds(erroringDb(false), TOKEN);
    expect(r.error).toBeUndefined();
    expect([...r.projectIds].sort(), "the happy path is unchanged — this gate must not close it").toEqual(["p1", "p2"]);
  });
});
