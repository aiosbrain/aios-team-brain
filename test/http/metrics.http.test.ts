import { describe, expect, it } from "vitest";
import { BASE_URL, db, issueKeyFor, keyHeaders, seedTeam } from "./http-helpers";

// HTTP edge of POST /api/v1/metrics (agentic-maturity snapshot ingest), closing a coverage
// gap noted in AIO-219: this route previously had no HTTP-level test. Covers auth/tier
// gating and the v1.3 ce_band field's 422 bound.

const METRICS = `${BASE_URL}/api/v1/metrics`;

function payload(over: Record<string, unknown> = {}) {
  return {
    date: "2026-07-04",
    signals: {
      delegation_ratio: 0.3, correction_loop_avg: 1.2, error_rate: 0.05,
      cost_per_task: 0.4, tokens_per_task: 30_000, cache_hit_rate: 0.8,
      tool_diversity: 8, verify_tool_rate: 0.3, subagent_usage: 0.5,
    },
    sessions: 40, tasks: 130,
    ...over,
  };
}

describe("POST /api/v1/metrics (HTTP)", () => {
  it("rejects a missing/invalid API key with 401", async () => {
    const res = await fetch(METRICS, {
      method: "POST",
      headers: { Authorization: "Bearer nope", "Content-Type": "application/json" },
      body: JSON.stringify(payload()),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an external-tier key with 403 (agentic-maturity is team-tier only)", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "external");

    const res = await fetch(METRICS, {
      method: "POST",
      headers: keyHeaders(key, seed.teamSlug),
      body: JSON.stringify(payload()),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_tier");
  });

  it("201s with a ce_band and the DB row shows the persisted band", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");

    const res = await fetch(METRICS, {
      method: "POST",
      headers: keyHeaders(key, seed.teamSlug),
      body: JSON.stringify(payload({ ce_band: 3 })),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("ok");

    const { data } = await db()
      .from("agentic_maturity_snapshots")
      .select("ce_band")
      .eq("team_id", seed.teamId)
      .eq("member_id", seed.memberId)
      .eq("snapshot_date", "2026-07-04")
      .single();
    expect((data as { ce_band: number }).ce_band).toBe(3);
  });

  it("422s on an out-of-range ce_band", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");

    const res = await fetch(METRICS, {
      method: "POST",
      headers: keyHeaders(key, seed.teamSlug),
      body: JSON.stringify(payload({ ce_band: 7 })),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("invalid_payload");
  });

  it("201s when ce_band is omitted (older client)", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");

    const res = await fetch(METRICS, {
      method: "POST",
      headers: keyHeaders(key, seed.teamSlug),
      body: JSON.stringify(payload()),
    });
    expect(res.status).toBe(201);
  });
});
