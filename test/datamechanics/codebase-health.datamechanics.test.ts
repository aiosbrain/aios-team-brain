import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { POST as codebasesPOST } from "@/app/api/v1/codebases/route";
import { issueApiKey } from "@/lib/admin/keys";
import { getCodebaseDetail, getCodebaseSummaries } from "@/lib/metrics/codebases";
import { db, seedTeam, type Seed } from "./helpers";

// Spec (brain-api document revision 1.15, AIO-609): POST /api/v1/codebases accepts an
// OPTIONAL `metrics.codebase_health` object — scored scanner-side, persisted VERBATIM
// (provenance-only, never recomputed), rejected 422 when sparse or malformed, team-tier
// only. Verified here against the REAL route handler + real Postgres, using the vendored
// canonical fixtures (test/fixtures/contract/codebase-payload-1.15-fixtures.json) so the
// wire payloads under test are exactly the contract's.

const CB_URL = "http://test/api/v1/codebases";

type Fixture = { name: string; payload: { codebase: { slug: string }; metrics: Record<string, unknown> } };
const fixtures = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "fixtures", "contract", "codebase-payload-1.15-fixtures.json"),
    "utf8",
  ),
) as { valid: Fixture[]; invalid: Fixture[] };

function fixture(bucket: "valid" | "invalid", prefix: string): Fixture["payload"] {
  const f = fixtures[bucket].find((x) => x.name.startsWith(prefix));
  if (!f) throw new Error(`fixture ${bucket}/${prefix} missing`);
  // Deep-copy so per-test slug overrides never leak between tests.
  return structuredClone(f.payload);
}

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
  const { key } = await issueApiKey(db(), seed.teamId, memberId, `${tier} key`);
  return { key };
}

function post(key: string, teamSlug: string, body: unknown) {
  const req = new Request(CB_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "X-AIOS-Team": teamSlug,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return codebasesPOST(req);
}

describe("codebase_health ingest (real route handler, real Postgres)", () => {
  it("201 with health: persisted VERBATIM and read back on the detail breakdown", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");
    const body = fixture("valid", "valid-with-health");
    const slug = `health-${randomUUID().slice(0, 6)}`;
    body.codebase.slug = slug;

    const res = await post(key, seed.teamSlug, body);
    expect(res.status).toBe(201);

    const detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    // Verbatim: the exact object the scanner pushed, incl. measured_at — no recompute.
    expect(detail?.breakdown?.codebase_health).toEqual(body.metrics.codebase_health);
    expect(detail?.breakdown?.codebase_health?.measured_at).toBe("2026-07-30T09:00:00Z");
    expect(detail?.breakdown?.codebase_health?.status).toBe("warn");
  });

  it("201 without health: a pre-1.15 payload is unaffected and reads back null", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");
    const body = fixture("valid", "valid-without-health");
    const slug = `nohealth-${randomUUID().slice(0, 6)}`;
    body.codebase.slug = slug;

    const res = await post(key, seed.teamSlug, body);
    expect(res.status).toBe(201);

    const detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.breakdown).not.toBeNull();
    expect(detail?.breakdown?.codebase_health).toBeNull();
  });

  it("422 sparse: health without the full raw-metrics block is rejected, nothing persisted", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");
    const body = fixture("invalid", "invalid-sparse-health-only");
    const slug = `sparse-${randomUUID().slice(0, 6)}`;
    body.codebase.slug = slug;

    const res = await post(key, seed.teamSlug, body);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("invalid_payload");

    // Rejected at the boundary — no codebase/metrics row was upserted for the slug.
    const detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail).toBeNull();
  });

  it("422 malformed health: wrong scalar types inside codebase_health are rejected", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");
    const body = fixture("invalid", "invalid-bad-health-types");

    const res = await post(key, seed.teamSlug, body);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("invalid_payload");
  });

  it("422 smuggled key: a health object carrying a file path is rejected, not stripped", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");
    const body = fixture("invalid", "invalid-health-unknown-key");

    const res = await post(key, seed.teamSlug, body);
    expect(res.status).toBe(422);
  });

  it("403 external tier: a with-health push is forbidden before parsing", async () => {
    const seed = await seedTeam();
    const ext = await issueKeyFor(seed, "external");
    const body = fixture("valid", "valid-with-health");

    const res = await post(ext.key, seed.teamSlug, body);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_tier");
  });

  it("idempotent: re-posting the same head_sha updates in place — one metrics row, health kept", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");
    const body = fixture("valid", "valid-with-health");
    const slug = `idem-${randomUUID().slice(0, 6)}`;
    body.codebase.slug = slug;

    const first = await post(key, seed.teamSlug, body);
    expect(first.status).toBe(201);
    const second = await post(key, seed.teamSlug, structuredClone(body));
    expect(second.status).toBe(201);
    const { codebase_id, metrics_id } = (await second.json()) as {
      codebase_id: string;
      metrics_id: string;
    };

    // Same (codebase_id, head_sha) point — no duplicate time-series row. (Test-only read;
    // pages must go through lib/metrics/codebases, which the tier-filter guard enforces.)
    const { data: rows } = await db()
      .from("code_metrics")
      .select("id, codebase_health")
      .eq("codebase_id", codebase_id);
    expect(rows).toHaveLength(1);
    expect((rows as { id: string }[])[0].id).toBe(metrics_id);

    const detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.breakdown?.codebase_health).toEqual(body.metrics.codebase_health);
  });

  it("health is team-tier only on the read side — external viewers get nothing", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");
    const body = fixture("valid", "valid-with-health");
    const slug = `tier-${randomUUID().slice(0, 6)}`;
    body.codebase.slug = slug;
    expect((await post(key, seed.teamSlug, body)).status).toBe(201);

    const { codebases } = await getCodebaseSummaries(db(), seed.teamId, "90d", "external");
    expect(codebases).toHaveLength(0);
    expect(await getCodebaseDetail(db(), seed.teamId, slug, "90d", "external")).toBeNull();
  });
});
