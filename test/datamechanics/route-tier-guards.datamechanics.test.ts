import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { POST as codebasesPOST } from "@/app/api/v1/codebases/route";
import { POST as metricsPOST } from "@/app/api/v1/metrics/route";
import { issueApiKey } from "@/lib/admin/keys";
import { db, seedTeam, type Seed } from "./helpers";

// The route handlers are the SOLE tier gate for codebase + maturity analytics
// (POSTGRES-ONLY, no RLS backstop). The lib-level datamechanics tests cover the
// ingest/read paths directly; THIS file pins the HTTP edge that they bypass:
//   - an external-tier key is 403 forbidden_tier on BOTH endpoints,
//   - a team-tier key is 201,
//   - the per-key fixed-window limiter returns 429.
// Verified against the real route handlers + real Postgres.

const CB_URL = "http://test/api/v1/codebases";
const MET_URL = "http://test/api/v1/metrics";

/** Issue a key for the seeded team member (tier=team) or a fresh external member. */
async function issueKeyFor(seed: Seed, tier: "team" | "external") {
  let memberId = seed.memberId;
  if (tier === "external") {
    const { data, error } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: `ext-${randomUUID().slice(0, 8)}@test.local`,
        display_name: "External",
        actor_handle: `ext-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "external",
        status: "active",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`external member seed failed: ${error?.message}`);
    memberId = (data as { id: string }).id;
  }
  const { key, keyId } = await issueApiKey(db(), seed.teamId, memberId, `${tier} key`);
  const { data: row } = await db().from("api_keys").select("id").eq("key_id", keyId).single();
  return { key, apiKeyId: (row as { id: string }).id };
}

function post(
  route: (r: NextRequest) => Promise<Response>,
  url: string,
  key: string,
  teamSlug: string,
  body: unknown
) {
  const req = new Request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "X-AIOS-Team": teamSlug,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return route(req);
}

// Minimal bodies that satisfy the schemas (only the required fields).
const scanBody = () => ({ codebase: { slug: "guard-repo" }, metrics: { head_sha: "a".repeat(40) } });
const metricsBody = () => ({ date: "2026-06-19", signals: {} });

describe("route tier guards (real handlers, real Postgres)", () => {
  it("codebases: team key 201, external key 403 forbidden_tier", async () => {
    const seed = await seedTeam();
    const team = await issueKeyFor(seed, "team");
    const ext = await issueKeyFor(seed, "external");

    const ok = await post(codebasesPOST, CB_URL, team.key, seed.teamSlug, scanBody());
    expect(ok.status).toBe(201);

    const denied = await post(codebasesPOST, CB_URL, ext.key, seed.teamSlug, scanBody());
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("forbidden_tier");
  });

  it("metrics: team key 201, external key 403 forbidden_tier", async () => {
    const seed = await seedTeam();
    const team = await issueKeyFor(seed, "team");
    const ext = await issueKeyFor(seed, "external");

    const ok = await post(metricsPOST, MET_URL, team.key, seed.teamSlug, metricsBody());
    expect(ok.status).toBe(201);

    const denied = await post(metricsPOST, MET_URL, ext.key, seed.teamSlug, metricsBody());
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("forbidden_tier");
  });

  it("codebases: a team key over its 60/min budget gets 429 rate_limited", async () => {
    const seed = await seedTeam();
    const team = await issueKeyFor(seed, "team");

    // Pre-fill the fixed-window bucket to the limit so the route's own hit is the 61st.
    const windowStart = new Date();
    windowStart.setSeconds(0, 0);
    await db().from("rate_limits").insert({
      bucket: `${team.apiKeyId}:codebases:post`,
      window_start: windowStart.toISOString(),
      count: 60,
    });

    const limited = await post(codebasesPOST, CB_URL, team.key, seed.teamSlug, scanBody());
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("rate_limited");
  });
});
