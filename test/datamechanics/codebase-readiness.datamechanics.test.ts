import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ingestCodebaseScan } from "@/lib/codebases/ingest";
import { getCodebaseDetail, getCodebaseSummaries } from "@/lib/metrics/codebases";
import { codebaseScanPayloadSchema } from "@/lib/api/schemas";
import { db, seedTeam } from "./helpers";
import { fullMetrics } from "@/test/fixtures/codebase-scan";

// Spec: the scanner scores AEM agent-readiness (scanner-side, against the canonical
// rubric) and pushes it on the metrics payload; the brain persists it verbatim and
// surfaces it on both the codebase summary (list) and detail (breakdown). These are
// new code_metrics columns with no RLS backstop — assert the observable DB outcome.

function scanWithReadiness(slug: string) {
  return codebaseScanPayloadSchema.parse({
    codebase: { slug, full_name: `acme/${slug}`, open_issues: 0 },
    metrics: fullMetrics({
      head_sha: "b".repeat(40),
      commits_window: 4,
      ai_commits_window: 2,
      readiness_level: "L3",
      readiness_pct: 67,
      readiness_pillars: {
        testing: { passed: 2, total: 2 },
        docs: { passed: 2, total: 3 },
      },
      readiness_rubric_version: "1.0.0",
    }),
    contributions: [],
    issues: [],
  });
}

describe("codebase agent-readiness persistence (real Postgres)", () => {
  it("round-trips readiness through ingest → summary + detail breakdown", async () => {
    const seed = await seedTeam();
    const slug = `repo-${randomUUID().slice(0, 6)}`;

    await ingestCodebaseScan(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
      scanWithReadiness(slug)
    );

    // Summary (list view) carries level + pct.
    const { codebases } = await getCodebaseSummaries(db(), seed.teamId, "90d", "team");
    const summary = codebases.find((c) => c.slug === slug);
    expect(summary?.readiness_level).toBe("L3");
    expect(summary?.readiness_pct).toBe(67);

    // Detail breakdown carries the per-pillar map too.
    const detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.breakdown?.readiness_level).toBe("L3");
    expect(detail?.breakdown?.readiness_pct).toBe(67);
    expect(detail?.breakdown?.readiness_pillars?.testing).toEqual({ passed: 2, total: 2 });
  });

  it("readiness is team-tier only — an external viewer never sees it", async () => {
    const seed = await seedTeam();
    const slug = `repo-${randomUUID().slice(0, 6)}`;
    await ingestCodebaseScan(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
      scanWithReadiness(slug)
    );

    // The codebase-analytics choke-point returns empty for external — no leak path.
    const { codebases } = await getCodebaseSummaries(db(), seed.teamId, "90d", "external");
    expect(codebases.length).toBe(0);
    const detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "external");
    expect(detail).toBeNull();
  });
});
