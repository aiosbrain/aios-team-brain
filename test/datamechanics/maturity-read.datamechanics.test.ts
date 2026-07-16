import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ingestMaturitySnapshot } from "@/lib/metrics/individual-maturity-ingest";
import { getTeamMaturity, getMemberMaturity } from "@/lib/metrics/individual-maturity";
import { createMember } from "@/lib/admin/members";
import { maturitySnapshotPayloadSchema } from "@/lib/api/schemas";
import { db, seedTeam } from "./helpers";

// Spec-first, verified to the DB: the dashboard read layer aggregates latest
// snapshots per member, builds the team radar + Spine distribution, exposes a
// member timeline — and HARD-GATES external-tier viewers to nothing (no RLS).

const DEFAULT_SIGNALS = {
  delegation_ratio: 0.3, correction_loop_avg: 1, error_rate: 0,
  cost_per_task: 0.4, tokens_per_task: 30_000, cache_hit_rate: 0.8,
  tool_diversity: 8, verify_tool_rate: 0.3, subagent_usage: 0.5,
};

function snap(member: string, date: string, over: Record<string, unknown> = {}) {
  return maturitySnapshotPayloadSchema.parse({
    member, metric: "aem-individual", date, window_days: 1,
    signals: DEFAULT_SIGNALS,
    provisional: { spine: "L4", axes: {} },
    sessions: 10, tasks: 50, ...over,
  });
}
async function ingest(teamId: string, memberId: string, payload: ReturnType<typeof snap>) {
  return ingestMaturitySnapshot(db(), { teamId, memberId, apiKeyId: randomUUID() }, payload);
}

describe("agentic-maturity dashboard reads (real Postgres)", () => {
  it("team view aggregates each member's latest snapshot + Spine distribution", async () => {
    const seed = await seedTeam();
    const alex = await createMember(db(), seed.teamId, { email: "a@x.test", displayName: "Alex", actorHandle: "alex", role: "member" });
    const sam = await createMember(db(), seed.teamId, { email: "s@x.test", displayName: "Sam", actorHandle: "sam", role: "member" });

    // alex: two days — the later one (strong verify → L4+) must win over the earlier
    await ingest(seed.teamId, alex.id, snap("alex", "2026-06-17", { signals: { ...DEFAULT_SIGNALS, verify_tool_rate: 0 } }));
    await ingest(seed.teamId, alex.id, snap("alex", "2026-06-18"));
    await ingest(seed.teamId, sam.id, snap("sam", "2026-06-18", { signals: { ...DEFAULT_SIGNALS, verify_tool_rate: 0 } }));

    const team = await getTeamMaturity(db(), seed.teamId, "team");
    expect(team.members.length).toBe(2);
    const alexCard = team.members.find((m) => m.handle === "alex")!;
    expect(alexCard.date).toBe("2026-06-18"); // latest wins
    expect(alexCard.axes.verification).toBe(4);
    // Sam was gated to L3 (verification 0); distribution reflects both members
    const total = Object.values(team.spineDistribution).reduce((a, b) => a + b, 0);
    expect(total).toBe(2);
    expect(team.teamAxes.verification).toBeGreaterThan(0);
  });

  it("member deep-dive returns an ordered timeline + the latest placement", async () => {
    const seed = await seedTeam();
    const alex = await createMember(db(), seed.teamId, { email: "a@x.test", displayName: "Alex", actorHandle: "alex", role: "member" });
    await ingest(seed.teamId, alex.id, snap("alex", "2026-06-16"));
    await ingest(seed.teamId, alex.id, snap("alex", "2026-06-18"));

    const m = await getMemberMaturity(db(), seed.teamId, "alex", "team");
    expect(m).not.toBeNull();
    expect(m!.timeline.map((t) => t.date)).toEqual(["2026-06-16", "2026-06-18"]); // ascending
    expect(m!.latest.date).toBe("2026-06-18");
    expect(m!.prescription).toBeTruthy();
  });

  it("GATE: an external-tier viewer sees an empty board and no member detail", async () => {
    const seed = await seedTeam();
    const alex = await createMember(db(), seed.teamId, { email: "a@x.test", displayName: "Alex", actorHandle: "alex", role: "member" });
    await ingest(seed.teamId, alex.id, snap("alex", "2026-06-18"));

    const team = await getTeamMaturity(db(), seed.teamId, "external");
    expect(team.members).toEqual([]);
    expect(await getMemberMaturity(db(), seed.teamId, "alex", "external")).toBeNull();
  });

  it("an unknown handle returns null (not a crash)", async () => {
    const seed = await seedTeam();
    expect(await getMemberMaturity(db(), seed.teamId, "ghost", "team")).toBeNull();
  });

  it("exposes ce_band on cards and timeline without affecting teamAxes or spineDistribution", async () => {
    const seed = await seedTeam();
    const alex = await createMember(db(), seed.teamId, {
      email: "a@x.test",
      displayName: "Alex",
      actorHandle: "alex",
      role: "member",
    });
    await ingest(seed.teamId, alex.id, snap("alex", "2026-06-16", { ce_band: null }));
    await ingest(seed.teamId, alex.id, snap("alex", "2026-06-18", { ce_band: 3 }));

    const team = await getTeamMaturity(db(), seed.teamId, "team");
    const alexCard = team.members.find((m) => m.handle === "alex")!;
    expect(alexCard.ce_band).toBe(3);
    expect(team.teamAxes).toBeTruthy();
    expect(Object.keys(team.spineDistribution).length).toBeGreaterThan(0);

    const m = await getMemberMaturity(db(), seed.teamId, "alex", "team");
    expect(m!.timeline.map((t) => t.ce_band)).toEqual([null, 3]);
    expect(m!.latest.ce_band).toBe(3);

    const ext = await getTeamMaturity(db(), seed.teamId, "external");
    expect(ext.members).toEqual([]);
    expect(await getMemberMaturity(db(), seed.teamId, "alex", "external")).toBeNull();
  });

  function contextHealth(score: number, over: Record<string, unknown> = {}) {
    return {
      score, mode: "workspace", drift_count: 0, versions_behind: 0,
      coverage_pct: 100, broken_link_count: 0, checked_at: "2026-06-18", ...over,
    };
  }

  it("exposes context_health_score on cards + averages it across the team (latest per member)", async () => {
    const seed = await seedTeam();
    const alex = await createMember(db(), seed.teamId, { email: "a@x.test", displayName: "Alex", actorHandle: "alex", role: "member" });
    const sam = await createMember(db(), seed.teamId, { email: "s@x.test", displayName: "Sam", actorHandle: "sam", role: "member" });

    // alex: earlier snapshot has no scan, the latest carries a score of 4 (latest wins).
    await ingest(seed.teamId, alex.id, snap("alex", "2026-06-16"));
    await ingest(seed.teamId, alex.id, snap("alex", "2026-06-18", { context_health: contextHealth(4) }));
    await ingest(seed.teamId, sam.id, snap("sam", "2026-06-18", { context_health: contextHealth(2) }));

    const team = await getTeamMaturity(db(), seed.teamId, "team");
    expect(team.members.find((mm) => mm.handle === "alex")!.context_health_score).toBe(4);
    expect(team.members.find((mm) => mm.handle === "sam")!.context_health_score).toBe(2);
    // Mean of the latest-per-member non-null scores: (4 + 2) / 2.
    expect(team.averageContextHealth).toBe(3);

    const m = await getMemberMaturity(db(), seed.teamId, "alex", "team");
    expect(m!.latest.context_health_score).toBe(4);
  });

  it("averageContextHealth is null until a member scans, and skips members with no scan", async () => {
    const seed = await seedTeam();
    const alex = await createMember(db(), seed.teamId, { email: "a@x.test", displayName: "Alex", actorHandle: "alex", role: "member" });
    const sam = await createMember(db(), seed.teamId, { email: "s@x.test", displayName: "Sam", actorHandle: "sam", role: "member" });

    // No scans yet → no scores to average.
    await ingest(seed.teamId, alex.id, snap("alex", "2026-06-18"));
    await ingest(seed.teamId, sam.id, snap("sam", "2026-06-18"));
    const before = await getTeamMaturity(db(), seed.teamId, "team");
    expect(before.members.every((mm) => mm.context_health_score == null)).toBe(true);
    expect(before.averageContextHealth).toBeNull();

    // Only alex scans → the average reflects alex alone (unscanned sam is skipped, not counted as 0).
    await ingest(seed.teamId, alex.id, snap("alex", "2026-06-18", { context_health: contextHealth(3) }));
    const after = await getTeamMaturity(db(), seed.teamId, "team");
    expect(after.averageContextHealth).toBe(3);
  });
});
