import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CodebaseHealth } from "@/lib/api/schemas";
import {
  decideCodebaseFinding,
  reconcileCodebaseFindings,
} from "@/lib/codebases/finding-ledger";
import { getCodebaseDetail } from "@/lib/metrics/codebases";
import { db, seedTeam, type Seed } from "./helpers";

async function seedFinding(seed: Seed, fingerprint = "d".repeat(64)) {
  const { data: codebase, error: codebaseError } = await db()
    .from("codebases")
    .insert({ team_id: seed.teamId, slug: `debt-${randomUUID().slice(0, 8)}` })
    .select("id, slug")
    .single();
  if (codebaseError || !codebase)
    throw new Error(`codebase seed failed: ${codebaseError?.message}`);

  const observedAt = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const { data: finding, error: findingError } = await db()
    .from("codebase_findings")
    .insert({
      team_id: seed.teamId,
      codebase_id: codebase.id,
      fingerprint,
      status: "open",
      check_id: "coverage_lines_pct",
      axis: "test_rigor",
      kind: "quality_issue",
      severity: "high",
      evidence_status: "complete",
      remediation_tier: 1,
      occurrence_count: 2,
      first_seen_sha: "1".repeat(40),
      last_seen_sha: "2".repeat(40),
      first_seen_at: observedAt,
      last_seen_at: observedAt,
    })
    .select("id")
    .single();
  if (findingError || !finding)
    throw new Error(`finding seed failed: ${findingError?.message}`);
  return {
    codebaseId: codebase.id as string,
    codebaseSlug: codebase.slug as string,
    findingId: finding.id as string,
  };
}

async function seedOwner(seed: Seed): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: "Finding Owner",
      actor_handle: `owner-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`owner seed failed: ${error?.message}`);
  return data.id as string;
}

function futureExpiry(days = 30): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

describe("codebase finding decisions (real Postgres)", () => {
  it("requires a lead/admin actor and an active same-team owner", async () => {
    const seed = await seedTeam();
    const target = await seedFinding(seed);
    const ownerId = await seedOwner(seed);
    const input = {
      teamId: seed.teamId,
      codebaseId: target.codebaseId,
      findingId: target.findingId,
      actorMemberId: seed.memberId,
      ownerMemberId: ownerId,
      status: "risk_accepted" as const,
      reason: "The owner will revisit this after the coverage migration lands.",
      expiresAt: futureExpiry(),
    };

    await expect(decideCodebaseFinding(db(), input)).rejects.toThrow(
      "lead or admin",
    );

    await db().from("members").update({ role: "lead" }).eq("id", seed.memberId);
    const otherTeam = await seedTeam();
    await expect(
      decideCodebaseFinding(db(), {
        ...input,
        ownerMemberId: otherTeam.memberId,
      }),
    ).rejects.toThrow("active team member");
  });

  it("persists the decision and appends every operator audit event", async () => {
    const seed = await seedTeam();
    await db().from("members").update({ role: "lead" }).eq("id", seed.memberId);
    const target = await seedFinding(seed);
    const ownerId = await seedOwner(seed);
    const base = {
      teamId: seed.teamId,
      codebaseId: target.codebaseId,
      findingId: target.findingId,
      actorMemberId: seed.memberId,
      ownerMemberId: ownerId,
      reason: "The owner will revisit this after the coverage migration lands.",
      expiresAt: futureExpiry(),
    };

    await decideCodebaseFinding(db(), { ...base, status: "risk_accepted" });
    await decideCodebaseFinding(db(), {
      ...base,
      status: "accepted",
      reason:
        "Accepted into the next hardening cycle with the same accountable owner.",
    });

    const { data: finding } = await db()
      .from("codebase_findings")
      .select(
        "status, decision_reason, decision_owner_member_id, decision_by_member_id, decision_expires_at",
      )
      .eq("id", target.findingId)
      .single();
    expect(finding).toMatchObject({
      status: "accepted",
      decision_owner_member_id: ownerId,
      decision_by_member_id: seed.memberId,
    });
    expect(
      new Date(finding.decision_expires_at as string).getTime(),
    ).toBeGreaterThan(Date.now());

    const { data: events } = await db()
      .from("codebase_finding_events")
      .select("event_type, metrics_id, details")
      .eq("finding_id", target.findingId)
      .order("observed_at", { ascending: true });
    expect(events).toHaveLength(2);
    expect(events?.map((event) => event.event_type)).toEqual([
      "risk_accepted",
      "accepted",
    ]);
    expect(events?.every((event) => event.metrics_id == null)).toBe(true);
    expect(events?.[1].details).toMatchObject({
      owner_member_id: ownerId,
      actor_member_id: seed.memberId,
    });
  });

  it("keeps tenant boundaries and re-enters an expired decision in the report", async () => {
    const one = await seedTeam();
    const two = await seedTeam();
    await db().from("members").update({ role: "lead" }).eq("id", one.memberId);
    await db().from("members").update({ role: "lead" }).eq("id", two.memberId);
    const target = await seedFinding(one);
    const ownerId = await seedOwner(one);

    await expect(
      decideCodebaseFinding(db(), {
        teamId: two.teamId,
        codebaseId: target.codebaseId,
        findingId: target.findingId,
        actorMemberId: two.memberId,
        ownerMemberId: two.memberId,
        status: "accepted",
        reason: "A different tenant must never be able to decide this finding.",
        expiresAt: futureExpiry(),
      }),
    ).rejects.toThrow("finding not found");

    await decideCodebaseFinding(db(), {
      teamId: one.teamId,
      codebaseId: target.codebaseId,
      findingId: target.findingId,
      actorMemberId: one.memberId,
      ownerMemberId: ownerId,
      status: "risk_accepted",
      reason:
        "Temporary acceptance while the migration is actively owned and reviewed.",
      expiresAt: futureExpiry(),
    });
    await db()
      .from("codebase_findings")
      .update({
        decision_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        decision_expires_at: new Date(Date.now() - 86_400_000).toISOString(),
      })
      .eq("id", target.findingId);

    const detail = await getCodebaseDetail(
      db(),
      one.teamId,
      target.codebaseSlug,
      "90d",
      "team",
    );
    expect(detail?.findings[0]).toMatchObject({ status: "risk_accepted" });
    expect(detail?.debtPatrol).toMatchObject({
      rollups: { active: 1, suppressed: 0, expired: 1 },
    });
    expect(detail?.debtPatrol.ranked[0]).toMatchObject({
      findingId: target.findingId,
      effectiveStatus: "reopened",
      decisionExpired: true,
    });
  });

  it("resolves a decided finding when a later complete scan proves it absent", async () => {
    const seed = await seedTeam();
    await db().from("members").update({ role: "lead" }).eq("id", seed.memberId);
    const target = await seedFinding(seed);
    const ownerId = await seedOwner(seed);
    await decideCodebaseFinding(db(), {
      teamId: seed.teamId,
      codebaseId: target.codebaseId,
      findingId: target.findingId,
      actorMemberId: seed.memberId,
      ownerMemberId: ownerId,
      status: "risk_accepted",
      reason:
        "Temporary acceptance while the coverage migration is still in progress.",
      expiresAt: futureExpiry(),
    });

    const headSha = "9".repeat(40);
    const measuredAt = new Date().toISOString();
    const health = {
      schema_version: "2",
      head_sha: headSha,
      measured_at: measuredAt,
      evidence_status: "complete",
      findings: [],
    } as unknown as CodebaseHealth;
    const { data: metrics, error } = await db()
      .from("code_metrics")
      .insert({
        team_id: seed.teamId,
        codebase_id: target.codebaseId,
        head_sha: headSha,
        scanned_at: measuredAt,
        codebase_health: health,
      })
      .select("id")
      .single();
    if (error || !metrics)
      throw new Error(`metrics seed failed: ${error?.message}`);

    await reconcileCodebaseFindings(db(), {
      teamId: seed.teamId,
      codebaseId: target.codebaseId,
      metricsId: metrics.id as string,
      health,
    });

    const { data: findingRow } = await db()
      .from("codebase_findings")
      .select(
        "status, resolved_at, decision_reason, decision_owner_member_id, decision_expires_at",
      )
      .eq("id", target.findingId)
      .single();
    expect(findingRow).toMatchObject({
      status: "resolved",
      decision_reason: null,
      decision_owner_member_id: null,
      decision_expires_at: null,
    });
    const { data: events } = await db()
      .from("codebase_finding_events")
      .select("event_type")
      .eq("finding_id", target.findingId)
      .order("observed_at", { ascending: true });
    expect(events?.map((event) => event.event_type)).toEqual([
      "risk_accepted",
      "resolved",
    ]);
  });

  it("does not let an older clean measurement erase a newer operator decision", async () => {
    const seed = await seedTeam();
    await db().from("members").update({ role: "lead" }).eq("id", seed.memberId);
    const target = await seedFinding(seed);
    const ownerId = await seedOwner(seed);
    const headSha = "8".repeat(40);
    const measuredAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const health = {
      schema_version: "2",
      head_sha: headSha,
      measured_at: measuredAt,
      evidence_status: "complete",
      findings: [],
    } as unknown as CodebaseHealth;
    const { data: metrics, error } = await db()
      .from("code_metrics")
      .insert({
        team_id: seed.teamId,
        codebase_id: target.codebaseId,
        head_sha: headSha,
        scanned_at: measuredAt,
        codebase_health: health,
      })
      .select("id")
      .single();
    if (error || !metrics)
      throw new Error(`metrics seed failed: ${error?.message}`);

    await decideCodebaseFinding(db(), {
      teamId: seed.teamId,
      codebaseId: target.codebaseId,
      findingId: target.findingId,
      actorMemberId: seed.memberId,
      ownerMemberId: ownerId,
      status: "risk_accepted",
      reason:
        "This decision is newer than the queued scan and must remain authoritative.",
      expiresAt: futureExpiry(),
    });
    await reconcileCodebaseFindings(db(), {
      teamId: seed.teamId,
      codebaseId: target.codebaseId,
      metricsId: metrics.id as string,
      health,
    });

    const { data: findingRow } = await db()
      .from("codebase_findings")
      .select("status, decision_reason, decision_owner_member_id")
      .eq("id", target.findingId)
      .single();
    expect(findingRow).toMatchObject({
      status: "risk_accepted",
      decision_owner_member_id: ownerId,
    });
    const { data: events } = await db()
      .from("codebase_finding_events")
      .select("event_type")
      .eq("finding_id", target.findingId);
    expect(events?.map((event) => event.event_type)).toEqual(["risk_accepted"]);
  });
});
