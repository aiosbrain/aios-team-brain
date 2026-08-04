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

type V2Finding = {
  fingerprint: string;
  check_id: string;
  axis: string;
  kind: "quality_issue" | "evidence_gap";
  severity: "low" | "medium" | "high" | "critical";
  evidence_status: "complete" | "partial" | "missing" | "stale" | "error";
  remediation_tier: number;
};

function v2Payload(input: {
  slug: string;
  head: string;
  measuredAt: string;
  findings?: V2Finding[];
  evidenceStatus?: "complete" | "partial" | "missing" | "stale" | "error";
}) {
  const body = fixture("valid", "valid-without-health");
  const findings = input.findings ?? [];
  const evidenceStatus = input.evidenceStatus ?? "complete";
  const complete = evidenceStatus === "complete";
  body.codebase.slug = input.slug;
  body.metrics.head_sha = input.head;
  body.metrics.scanned_at = input.measuredAt;
  body.metrics.codebase_health = {
    schema_version: "2",
    rubric_version: "1.1.0",
    profile_id: "aios.team-brain",
    profile_version: "1.0.0",
    head_sha: input.head,
    score_pct: complete && findings.length === 0 ? 100 : 70,
    status: complete ? (findings.length === 0 ? "pass" : "fail") : "warn",
    evidence_status: evidenceStatus,
    quality_gate: complete ? (findings.length === 0 ? "pass" : "fail") : "unknown",
    automation_eligible: complete && findings.length === 0,
    dimensions: {
      test_rigor: {
        passed: complete && findings.length === 0 ? 1 : 0,
        total: complete ? 1 : 0,
        band: complete ? (findings.length === 0 ? 4 : 0) : null,
        evidence_status: evidenceStatus,
      },
    },
    failed_invariant_ids: findings.map((finding) => finding.check_id),
    measured_at: input.measuredAt,
    findings,
  };
  return body;
}

const FINDING_A: V2Finding = {
  fingerprint: "a".repeat(64),
  check_id: "coverage_lines_pct",
  axis: "test_rigor",
  kind: "quality_issue",
  severity: "high",
  evidence_status: "complete",
  remediation_tier: 0,
};

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
    expect(detail?.findings).toEqual([]);
  });

  it("v2 round-trips and materializes deduplicated resolve/reopen history fail closed", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");
    const slug = `ledger-${randomUUID().slice(0, 6)}`;
    const first = v2Payload({
      slug,
      head: "1".repeat(40),
      measuredAt: "2026-08-04T01:00:00Z",
      findings: [FINDING_A],
    });

    expect((await post(key, seed.teamSlug, first)).status).toBe(201);
    let detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.breakdown?.codebase_health).toEqual(first.metrics.codebase_health);
    expect(detail?.findings).toHaveLength(1);
    expect(detail?.findings[0]).toMatchObject({
      fingerprint: FINDING_A.fingerprint,
      status: "open",
      occurrence_count: 1,
    });
    expect(detail?.findings[0].events.map((event) => event.event_type)).toEqual(["detected"]);

    // Same exact metrics point is idempotent: no duplicate row and no duplicate event.
    expect((await post(key, seed.teamSlug, structuredClone(first))).status).toBe(201);
    detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.findings[0].events).toHaveLength(1);

    // Unknown/partial absence cannot resolve the finding.
    const partial = v2Payload({
      slug,
      head: "2".repeat(40),
      measuredAt: "2026-08-04T02:00:00Z",
      evidenceStatus: "partial",
    });
    expect((await post(key, seed.teamSlug, partial)).status).toBe(201);
    detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.findings[0].status).toBe("open");

    // Complete absence resolves; a later recurrence reopens with history intact.
    const resolved = v2Payload({
      slug,
      head: "3".repeat(40),
      measuredAt: "2026-08-04T03:00:00Z",
    });
    expect((await post(key, seed.teamSlug, resolved)).status).toBe(201);

    // An observation older than the resolving snapshot is history-only. Comparing only
    // last_seen_at would incorrectly reopen this because resolution does not mean "seen".
    const staleBeforeReopen = v2Payload({
      slug,
      head: "5".repeat(40),
      measuredAt: "2026-08-04T02:30:00Z",
      findings: [FINDING_A],
    });
    expect((await post(key, seed.teamSlug, staleBeforeReopen)).status).toBe(201);
    detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.findings[0]).toMatchObject({ status: "resolved", occurrence_count: 1 });

    const reopened = v2Payload({
      slug,
      head: "4".repeat(40),
      measuredAt: "2026-08-04T04:00:00Z",
      findings: [FINDING_A],
    });
    expect((await post(key, seed.teamSlug, reopened)).status).toBe(201);

    detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.findings[0]).toMatchObject({ status: "reopened", occurrence_count: 2 });
    expect(detail?.findings[0].events.map((event) => event.event_type).sort()).toEqual([
      "detected",
      "reopened",
      "resolved",
      "stale_analysis",
    ]);

    // An older analysis is history only; it cannot overwrite the reopened current state.
    const stale = v2Payload({
      slug,
      head: "6".repeat(40),
      measuredAt: "2026-08-04T03:30:00Z",
      findings: [FINDING_A],
    });
    expect((await post(key, seed.teamSlug, stale)).status).toBe(201);
    detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.findings[0]).toMatchObject({
      status: "reopened",
      last_seen_sha: "4".repeat(40),
      occurrence_count: 2,
    });
    expect(detail?.findings[0].events.some((event) => event.event_type === "stale_analysis")).toBe(
      true
    );
  });

  it("v2 ledger rows remain isolated between teams for the same repository slug", async () => {
    const one = await seedTeam();
    const two = await seedTeam();
    const oneKey = await issueKeyFor(one, "team");
    const twoKey = await issueKeyFor(two, "team");
    const slug = `shared-${randomUUID().slice(0, 6)}`;
    const findingB = { ...FINDING_A, fingerprint: "b".repeat(64), check_id: "eslint_warning_count" };

    expect(
      (
        await post(
          oneKey.key,
          one.teamSlug,
          v2Payload({
            slug,
            head: "6".repeat(40),
            measuredAt: "2026-08-04T05:00:00Z",
            findings: [FINDING_A],
          })
        )
      ).status
    ).toBe(201);
    expect(
      (
        await post(
          twoKey.key,
          two.teamSlug,
          v2Payload({
            slug,
            head: "7".repeat(40),
            measuredAt: "2026-08-04T05:00:00Z",
            findings: [findingB],
          })
        )
      ).status
    ).toBe(201);

    const oneDetail = await getCodebaseDetail(db(), one.teamId, slug, "90d", "team");
    const twoDetail = await getCodebaseDetail(db(), two.teamId, slug, "90d", "team");
    expect(oneDetail?.findings.map((finding) => finding.fingerprint)).toEqual([
      FINDING_A.fingerprint,
    ]);
    expect(twoDetail?.findings.map((finding) => finding.fingerprint)).toEqual([
      findingB.fingerprint,
    ]);
  });

  it("retains a previously unseen older fingerprint as history, never as active debt", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");
    const slug = `stale-new-${randomUUID().slice(0, 6)}`;
    const latestClean = v2Payload({
      slug,
      head: "a".repeat(40),
      measuredAt: "2026-08-04T08:00:00Z",
    });
    expect((await post(key, seed.teamSlug, latestClean)).status).toBe(201);

    const olderDirty = v2Payload({
      slug,
      head: "b".repeat(40),
      measuredAt: "2026-08-04T07:00:00Z",
      findings: [FINDING_A],
    });
    expect((await post(key, seed.teamSlug, olderDirty)).status).toBe(201);

    const detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.findings).toHaveLength(1);
    expect(detail?.findings[0]).toMatchObject({
      fingerprint: FINDING_A.fingerprint,
      status: "stale_analysis",
      occurrence_count: 1,
    });
    expect(detail?.findings[0].events.map((event) => event.event_type)).toEqual([
      "stale_analysis",
    ]);
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

  it("422 mismatched v2 head: lifecycle evidence cannot target a different metrics head", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");
    const slug = `head-mismatch-${randomUUID().slice(0, 6)}`;
    const body = v2Payload({
      slug,
      head: "8".repeat(40),
      measuredAt: "2026-08-04T06:00:00Z",
      findings: [FINDING_A],
    });
    (body.metrics.codebase_health as { head_sha: string }).head_sha = "9".repeat(40);

    const res = await post(key, seed.teamSlug, body);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("invalid_payload");
    expect(await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team")).toBeNull();
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
