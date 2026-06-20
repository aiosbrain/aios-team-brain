import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ingestCodebaseScan } from "@/lib/codebases/ingest";
import { getCodebaseFreshness } from "@/lib/metrics/codebases";
import { codebaseScanPayloadSchema } from "@/lib/api/schemas";
import { db, seedTeam, type Seed } from "./helpers";

// W1.3.3/4 — scan freshness read path, on real Postgres (NO RLS backstop). Two invariants:
//  1. Freshness reports the team's codebases with the NEWEST scanned head_sha (what the page
//     compares against the live branch HEAD).
//  2. Tier isolation: codebase intel is team-tier only, so an `external` viewer reads NOTHING —
//     the app-code gate (canSeeCodebases) is the sole enforcement.

function buildScan(over: { slug: string; head_sha?: string; scanned_at?: string }) {
  const p = codebaseScanPayloadSchema.parse({
    codebase: { slug: over.slug, full_name: `acme/${over.slug}`, default_branch: "main", primary_language: "TypeScript" },
    metrics: {
      head_sha: over.head_sha ?? "a".repeat(40),
      window_days: 90,
      loc: 1000,
      files: 50,
      commits_window: 10,
      ai_commits_window: 5,
      additions_window: 100,
      deletions_window: 20,
      test_coverage_pct: 70,
      has_claude_md: true,
      has_agents_md: true,
      agents_md_count: 1,
      skills_count: 3,
      commands_count: 1,
      active_days: 5,
      days_since_last_commit: 1,
      recent_commits: [],
    },
    contributions: [],
    issues: [],
  });
  if (over.scanned_at) p.metrics.scanned_at = over.scanned_at;
  return p;
}

async function ingestScan(seed: Seed, payload: ReturnType<typeof buildScan>) {
  return ingestCodebaseScan(db(), { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() }, payload);
}

describe("codebase scan freshness (real Postgres)", () => {
  it("reports the newest scanned head_sha and full_name for a team viewer", async () => {
    const seed = await seedTeam();
    const slug = `repo-${randomUUID().slice(0, 6)}`;
    await ingestScan(seed, buildScan({ slug, head_sha: "a".repeat(40), scanned_at: "2026-06-10T00:00:00Z" }));
    await ingestScan(seed, buildScan({ slug, head_sha: "b".repeat(40), scanned_at: "2026-06-16T00:00:00Z" }));

    const rows = await getCodebaseFreshness(db(), seed.teamId, "team");
    const row = rows.find((r) => r.slug === slug);
    expect(row).toBeTruthy();
    expect(row!.full_name).toBe(`acme/${slug}`);
    expect(row!.default_branch).toBe("main");
    expect(row!.last_scanned_sha).toBe("b".repeat(40)); // newest scan wins
    expect(row!.last_scan_at).not.toBeNull();
  });

  it("external tier reads NOTHING; team tier sees the codebase (crown jewel)", async () => {
    const seed = await seedTeam();
    const slug = `repo-${randomUUID().slice(0, 6)}`;
    await ingestScan(seed, buildScan({ slug }));

    expect(await getCodebaseFreshness(db(), seed.teamId, "external")).toEqual([]);
    const asTeam = await getCodebaseFreshness(db(), seed.teamId, "team");
    expect(asTeam.length).toBe(1); // non-vacuity: the data IS there for team
  });

  it("a never-scanned codebase reports a null last_scanned_sha (not an error)", async () => {
    const seed = await seedTeam();
    const slug = `repo-${randomUUID().slice(0, 6)}`;
    // Insert a codebases row with no code_metrics.
    await db()
      .from("codebases")
      .insert({ team_id: seed.teamId, slug, full_name: `acme/${slug}`, default_branch: "main" });

    const rows = await getCodebaseFreshness(db(), seed.teamId, "team");
    const row = rows.find((r) => r.slug === slug);
    expect(row?.last_scanned_sha).toBeNull();
  });
});
