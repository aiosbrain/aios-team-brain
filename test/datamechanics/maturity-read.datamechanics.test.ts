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
});
