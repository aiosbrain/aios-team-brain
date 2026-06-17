import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ingestCodebaseScan } from "@/lib/codebases/ingest";
import { getCodebaseSummaries, getCodebaseDetail } from "@/lib/metrics/codebases";
import { codebaseScanPayloadSchema } from "@/lib/api/schemas";
import { db, seedTeam, type Seed } from "./helpers";

// CLAUDE.md §5 invariant on the postgres target (NO RLS): codebase analytics are
// team-tier only, so an `external` principal must read NOTHING. This app-code gate
// is the SOLE enforcement. Spec-first; verified to the observable outcome (rows).

function buildScan(over: {
  slug: string;
  head_sha?: string;
  contributions?: { author_key: string; author_email?: string; day: string; commits: number; ai_commits?: number }[];
}) {
  return codebaseScanPayloadSchema.parse({
    codebase: { slug: over.slug, full_name: `acme/${over.slug}`, open_issues: 3, primary_language: "TypeScript" },
    metrics: {
      head_sha: over.head_sha ?? "a".repeat(40),
      window_days: 90,
      loc: 40_000,
      files: 300,
      commits_window: 100,
      ai_commits_window: 60,
      test_coverage_pct: 70,
      has_claude_md: true,
      has_agents_md: true,
      agents_md_count: 1,
      skills_count: 6,
      commands_count: 2,
      active_days: 30,
      days_since_last_commit: 1,
    },
    contributions: over.contributions ?? [],
    issues: [{ number: 1, title: "first", state: "open" }],
  });
}

async function ingestScan(seed: Seed, payload: ReturnType<typeof buildScan>) {
  return ingestCodebaseScan(
    db(),
    { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
    payload
  );
}

async function memberEmail(memberId: string): Promise<string> {
  const { data } = await db().from("members").select("email").eq("id", memberId).maybeSingle();
  return (data as { email: string }).email;
}

describe("codebase tier isolation (real Postgres, no RLS backstop)", () => {
  it("external tier sees no codebases; team tier sees them", async () => {
    const seed = await seedTeam();
    await ingestScan(seed, buildScan({ slug: `repo-${randomUUID().slice(0, 6)}` }));

    const asTeam = await getCodebaseSummaries(db(), seed.teamId, "90d", "team");
    expect(asTeam.codebases.length).toBe(1);
    expect(asTeam.codebases[0].agentic_score).toBeGreaterThan(0); // non-vacuity: data IS there

    const asExternal = await getCodebaseSummaries(db(), seed.teamId, "90d", "external");
    expect(asExternal.codebases.length).toBe(0); // the crown jewel: no leak to external
    expect(asExternal.kpis.length).toBe(0);
  });

  it("detail is null for an external viewer, present for a team viewer", async () => {
    const seed = await seedTeam();
    const slug = `repo-${randomUUID().slice(0, 6)}`;
    await ingestScan(seed, buildScan({ slug }));

    expect(await getCodebaseDetail(db(), seed.teamId, slug, "90d", "external")).toBeNull();
    const detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.slug).toBe(slug);
    expect(detail?.breakdown?.agentic_score).toBeGreaterThan(0);
  });
});

describe("codebase scan idempotency (real Postgres)", () => {
  it("same head_sha re-scan adds no new metrics point; a new head_sha adds one", async () => {
    const seed = await seedTeam();
    const slug = `repo-${randomUUID().slice(0, 6)}`;
    const res = await ingestScan(seed, buildScan({ slug, head_sha: "a".repeat(40) }));

    await ingestScan(seed, buildScan({ slug, head_sha: "a".repeat(40) })); // identical commit
    const after1 = await db().from("code_metrics").select("id").eq("codebase_id", res.codebase_id);
    expect((after1.data ?? []).length).toBe(1);

    await ingestScan(seed, buildScan({ slug, head_sha: "b".repeat(40) })); // new commit
    const after2 = await db().from("code_metrics").select("id").eq("codebase_id", res.codebase_id);
    expect((after2.data ?? []).length).toBe(2);
  });

  it("contributions recompute + upsert by (author_key, day), and map to a member", async () => {
    const seed = await seedTeam();
    const slug = `repo-${randomUUID().slice(0, 6)}`;
    const email = await memberEmail(seed.memberId);
    const day = "2026-06-10";

    const res = await ingestScan(
      seed,
      buildScan({ slug, contributions: [{ author_key: email, author_email: email, day, commits: 5 }] })
    );
    const first = await db()
      .from("code_contributions")
      .select("commits, member_id")
      .eq("codebase_id", res.codebase_id);
    expect((first.data ?? []).length).toBe(1);
    expect((first.data as { commits: number; member_id: string | null }[])[0].commits).toBe(5);
    // author identity maps to the roster member by email
    expect((first.data as { member_id: string | null }[])[0].member_id).toBe(seed.memberId);

    // re-scan with a changed count for the same (author_key, day) → upsert, not dup
    await ingestScan(
      seed,
      buildScan({ slug, contributions: [{ author_key: email, author_email: email, day, commits: 8 }] })
    );
    const second = await db()
      .from("code_contributions")
      .select("commits")
      .eq("codebase_id", res.codebase_id);
    expect((second.data ?? []).length).toBe(1);
    expect((second.data as { commits: number }[])[0].commits).toBe(8);
  });
});
