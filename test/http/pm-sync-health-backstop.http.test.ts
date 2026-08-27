import { describe, expect, it } from "vitest";

import { BASE_URL, issueKeyFor, keyHeaders, seedTeam } from "./http-helpers";

/**
 * ADOPTUNIQ-1 — `GET /api/v1/pm-sync/health` gained `health.backstop`, and this is the ONLY tier that
 * can see it.
 *
 * `Response.json` is this repo's documented type blind spot: widening what a route returns is only
 * half-checked, because every forwarding caller keeps compiling and every unit test over the pure
 * `computeProjectionHealth` keeps passing. Nothing in the unit tier touches the wire. So a refactor
 * that drops the field from the ROUTE — while leaving the function that computes it perfectly
 * intact — would ship green, and the admin card would silently render "unverified" forever.
 *
 * This is the pin for that: the field must survive the JSON boundary, with a real socket and a real
 * database behind it.
 */

const HEALTH = `${BASE_URL}/api/v1/pm-sync/health`;

describe("GET /api/v1/pm-sync/health — the DB backstop reaches the wire", () => {
  it("returns `health.backstop`, and it is one of the four known states", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");

    const res = await fetch(HEALTH, { headers: keyHeaders(key, seed.teamSlug) });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { health?: { status?: string; backstop?: string } };
    expect(body.health, "the response must carry a health object").toBeTruthy();

    // Asserted as PRESENT first, separately from its value: `toBeDefined` on a missing key and a
    // wrong-valued key fail for different reasons, and the failure message should say which.
    expect(
      Object.prototype.hasOwnProperty.call(body.health ?? {}, "backstop"),
      "health.backstop must survive the JSON boundary",
    ).toBe(true);
    expect(["installed", "missing", "malformed", "unknown"]).toContain(body.health?.backstop);

    // The test database HAS the index (db:test:up loads schema.sql, which carries the guarded block),
    // so anything other than `installed` here means the block did not run on the real load path —
    // which is exactly the regression this pin exists to catch, and it cannot be faked by the pure
    // classifier passing its own unit tests.
    expect(body.health?.backstop, "the test DB loads schema.sql, so the backstop must be installed").toBe(
      "installed",
    );

    // And it stays DISTINCT from the run status — the two describe unrelated things, and folding the
    // backstop into `status` is the shortcut this shape exists to prevent.
    expect(body.health?.status).not.toBe(body.health?.backstop);
  });

  it("refuses an unauthenticated read rather than leaking schema state", async () => {
    const res = await fetch(HEALTH, { headers: { Authorization: "Bearer nope", "X-AIOS-Team": "x" } });
    expect(res.status).toBe(401);
  });
});
