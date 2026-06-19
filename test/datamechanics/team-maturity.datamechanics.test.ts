import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ingestCodebaseScan } from "@/lib/codebases/ingest";
import { getTeamMaturity } from "@/lib/metrics/maturity";
import { codebaseScanPayloadSchema } from "@/lib/api/schemas";
import { db, seedTeam } from "./helpers";

// Spec: the team rollup aggregates per-repo agent-readiness into "% at L3+" and is
// team-tier only (no leak to external), reusing the codebase choke-point.

function scan(slug: string, level: string, pct: number) {
  return codebaseScanPayloadSchema.parse({
    codebase: { slug, full_name: `acme/${slug}`, open_issues: 0 },
    metrics: {
      head_sha: "c".repeat(40),
      window_days: 90,
      readiness_level: level,
      readiness_pct: pct,
      readiness_rubric_version: "1.0.0",
    },
    contributions: [],
    issues: [],
  });
}

describe("team maturity rollup (real Postgres)", () => {
  it("computes % of repos at L3+ and lists worst-first", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    const a = `repo-${randomUUID().slice(0, 6)}`;
    const b = `repo-${randomUUID().slice(0, 6)}`;
    await ingestCodebaseScan(db(), auth, scan(a, "L4", 80)); // agent-ready+
    await ingestCodebaseScan(db(), auth, scan(b, "L1", 40)); // not ready

    const m = await getTeamMaturity(db(), seed.teamId, "90d", "team");
    expect(m.reposScored).toBe(2);
    expect(m.atL3Plus).toBe(1);
    expect(m.pctAtL3Plus).toBe(50);
    expect(m.distribution.L4).toBe(1);
    expect(m.distribution.L1).toBe(1);
    // worst-first: L1 repo leads the "what to fix" queue
    expect(m.repos[0].slug).toBe(b);
  });

  it("is team-tier only — external viewer gets an empty rollup", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    await ingestCodebaseScan(db(), auth, scan(`repo-${randomUUID().slice(0, 6)}`, "L4", 80));

    const m = await getTeamMaturity(db(), seed.teamId, "90d", "external");
    expect(m.reposScored).toBe(0);
    expect(m.pctAtL3Plus).toBe(0);
    expect(m.repos).toEqual([]);
  });
});
