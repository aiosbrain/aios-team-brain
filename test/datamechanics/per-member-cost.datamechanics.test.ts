import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getPerMemberCosts, getThroughputVsCost } from "@/lib/metrics/members";
import { createMember } from "@/lib/admin/members";
import { ingestCodebaseScan } from "@/lib/codebases/ingest";
import { codebaseScanPayloadSchema } from "@/lib/api/schemas";
import { db, seedTeam } from "./helpers";

// W1.2.4 — per-member brain spend, verified to the observable outcome on real Postgres
// (DB_BACKEND=postgres → no RLS). SPEC: a non-admin member must NOT see another member's
// cost; an admin sees the whole team's. These reads route through scopeQueryLog; this tier
// proves the app-code enforcement against the real DB (there is no RLS backstop).

async function logQuery(
  teamId: string,
  memberId: string,
  over: { cost_usd: number; input_tokens?: number; output_tokens?: number }
) {
  const { error } = await db()
    .from("query_log")
    .insert({
      team_id: teamId,
      member_id: memberId,
      question: "q",
      answer_preview: "",
      cost_usd: over.cost_usd,
      input_tokens: over.input_tokens ?? 0,
      output_tokens: over.output_tokens ?? 0,
    });
  if (error) throw new Error(`seed query_log failed: ${error.message}`);
}

function scan(slug: string, contributions: { author_key: string; author_email: string; day: string; commits: number; ai_commits: number }[]) {
  return codebaseScanPayloadSchema.parse({
    codebase: { slug, full_name: `acme/${slug}`, open_issues: 0 },
    metrics: {
      // Core raw-scan fields are REQUIRED since #35 (reject sparse pushes) — send the full block.
      head_sha: "a".repeat(40), window_days: 90,
      loc: 1000, files: 50, commits_window: 8, ai_commits_window: 8,
      additions_window: 100, deletions_window: 20, recent_commits: [],
      has_claude_md: true, has_agents_md: true, agents_md_count: 1, skills_count: 3, commands_count: 1,
      active_days: 3, days_since_last_commit: 1,
    },
    contributions,
    issues: [],
  });
}

describe("getPerMemberCosts() on real Postgres (W1.2)", () => {
  it("a member sees only their own cost; an admin sees every member's", async () => {
    const seed = await seedTeam(); // seed.memberId is a plain 'member'
    const other = await createMember(db(), seed.teamId, {
      email: "other@x.test", displayName: "Other", actorHandle: "other", role: "member",
    });

    await logQuery(seed.teamId, seed.memberId, { cost_usd: 2.0, input_tokens: 100, output_tokens: 50 });
    await logQuery(seed.teamId, other.id, { cost_usd: 5.0, input_tokens: 300, output_tokens: 200 });

    // Non-admin member: only their own row, no leak of the other member's $.
    const mine = await getPerMemberCosts(db(), seed.teamId, "90d", {
      isAdmin: false,
      memberId: seed.memberId,
    });
    expect(mine.selfOnly).toBe(true);
    expect(mine.rows.map((r) => r.member_id)).toEqual([seed.memberId]);
    expect(mine.rows[0].cost_usd).toBeCloseTo(2.0, 5);
    expect(mine.totals.cost_usd).toBeCloseTo(2.0, 5); // NOT 7.0 — no other-member leak
    // hard assertion: the other member's spend is absent entirely
    expect(mine.rows.some((r) => r.member_id === other.id)).toBe(false);

    // Admin: team-wide, one row per member, totals sum both.
    const all = await getPerMemberCosts(db(), seed.teamId, "90d", {
      isAdmin: true,
      memberId: seed.memberId,
    });
    expect(all.selfOnly).toBe(false);
    const byId = new Map(all.rows.map((r) => [r.member_id, r]));
    expect(byId.get(seed.memberId)?.cost_usd).toBeCloseTo(2.0, 5);
    expect(byId.get(other.id)?.cost_usd).toBeCloseTo(5.0, 5);
    expect(all.totals.cost_usd).toBeCloseTo(7.0, 5);
    expect(byId.get(other.id)?.total_tokens).toBe(500); // 300 in + 200 out
  });
});

describe("getThroughputVsCost() on real Postgres (W1.2.3)", () => {
  it("joins AI-commit throughput × brain spend per contributor; member sees only self", async () => {
    const seed = await seedTeam();
    const admin = await createMember(db(), seed.teamId, {
      email: "admin@x.test", displayName: "Admin", actorHandle: "adm", role: "admin",
    });
    // seed.memberId authors commits matched by email; give that member a known email.
    await db().from("members").update({ email: "dev@x.test" }).eq("id", seed.memberId);

    const slug = `repo-${randomUUID().slice(0, 6)}`;
    await ingestCodebaseScan(
      db(),
      { teamId: seed.teamId, memberId: admin.id, apiKeyId: randomUUID() },
      scan(slug, [
        { author_key: "dev@x.test", author_email: "dev@x.test", day: "2026-06-10", commits: 10, ai_commits: 8 },
      ])
    );
    // the dev member spends $4 on brain queries
    await logQuery(seed.teamId, seed.memberId, { cost_usd: 4.0 });
    // another member spends too, but has no contributions
    await logQuery(seed.teamId, admin.id, { cost_usd: 9.0 });

    const all = await getThroughputVsCost(db(), seed.teamId, "90d", {
      isAdmin: true,
      memberId: admin.id,
    });
    const dev = all.rows.find((r) => r.member_id === seed.memberId);
    expect(dev).toBeTruthy();
    expect(dev!.ai_commits).toBe(8);
    expect(dev!.commits).toBe(10);
    expect(dev!.cost_usd).toBeCloseTo(4.0, 5);
    // $4 brain spend over 8 AI commits = $0.50 / AI commit
    expect(dev!.cost_per_ai_commit).toBeCloseTo(0.5, 4);

    // a non-admin OTHER member must not see the dev's throughput/cost
    const other = await createMember(db(), seed.teamId, {
      email: "nobody@x.test", displayName: "Nobody", actorHandle: "nob", role: "member",
    });
    const scoped = await getThroughputVsCost(db(), seed.teamId, "90d", {
      isAdmin: false,
      memberId: other.id,
    });
    expect(scoped.selfOnly).toBe(true);
    expect(scoped.rows.some((r) => r.member_id === seed.memberId)).toBe(false);
  });
});
