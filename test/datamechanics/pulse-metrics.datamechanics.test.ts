import { describe, expect, it } from "vitest";
import { getPulseMetrics } from "@/lib/metrics/pulse";
import { recordLlmUsage } from "@/lib/costs/llm-usage";
import { db, seedTeam, ingest } from "./helpers";

/**
 * Spec for the dashboard "pulse" metrics on REAL Postgres. The deployed pg adapter returns
 * timestamptz columns as Date objects (the legacy Supabase-js client returned strings); the window
 * math compared them as strings (`Date >= isoString` → coerces to NaN → always false), so every
 * recent row was bucketed as "prior" and the dashboard read 0 items / 0 queries with ↓100% — while
 * the data was clearly present. This tier is the ONLY one that reproduces it (the FakeSupabase test
 * double, matching the old client's shape, returns strings same as it always did).
 * Derived from the product contract (recent activity must count as current), not the implementation.
 */

async function seedQuery(teamId: string, memberId: string, cost: number): Promise<void> {
  const { error } = await db().from("query_log").insert({
    team_id: teamId,
    member_id: memberId,
    question: "what happened today?",
    answer_preview: "…",
    cost_usd: cost,
  });
  if (error) throw new Error(`seed query_log failed: ${error.message}`);
}

/** Spend is now metered in llm_usage (ALL inference), not query_log — seed a ledger row for it. */
async function seedSpend(
  teamId: string,
  memberId: string | null,
  source: "query" | "arcs" | "meeting-extract",
  cost: number
): Promise<void> {
  await recordLlmUsage(db(), {
    teamId,
    memberId,
    source,
    provider: "openrouter",
    model: "test/model",
    inputTokens: 100,
    outputTokens: 20,
    costUsd: cost,
    estimated: false,
  });
}

describe("getPulseMetrics (real Postgres date windowing)", () => {
  it("counts freshly-synced items and recent queries as CURRENT (not prior)", async () => {
    const seed = await seedTeam();
    // Three items ingested now → synced_at = now(), squarely inside the 30d window.
    await ingest(seed, { path: "a.md", body: "alpha", access: "team", kind: "deliverable" });
    await ingest(seed, { path: "b.md", body: "bravo", access: "team", kind: "deliverable" });
    await ingest(seed, { path: "c.md", body: "charlie", access: "team", kind: "transcript" });
    await seedQuery(seed.teamId, seed.memberId, 0.42);
    await seedQuery(seed.teamId, seed.memberId, 0.08);
    // Spend now comes from llm_usage (ALL inference), so seed the ledger — including a system/background
    // arc row (null member) that only shows in the ADMIN (team-wide) view.
    await seedSpend(seed.teamId, seed.memberId, "query", 0.42);
    await seedSpend(seed.teamId, seed.memberId, "query", 0.08);
    await seedSpend(seed.teamId, null, "arcs", 0.5);

    const pulse = await getPulseMetrics(db(), seed.teamId, "30d", {
      isAdmin: true,
      memberId: seed.memberId,
      tier: "team",
    });

    const kpi = (key: string) => pulse.kpis.find((k) => k.key === key);

    // KPI band is the trimmed meaningful set — Queries / Tasks in flight / Spend. "Items synced"
    // was removed (it counted synced_at churn, not real growth), so it must NOT be present.
    expect(pulse.kpis.map((k) => k.key)).toEqual(["queries", "tasks", "spend"]);
    // Queries KPI: 2 recent queries, not 0 (still counts query_log — interactive adoption).
    expect(Number(kpi("queries")!.value)).toBe(2);
    // Spend rolls up ALL inference from llm_usage: $0.42 + $0.08 (queries) + $0.50 (background arc) = $1.00.
    expect(kpi("spend")!.value).toBe("$1.00");

    // Time-series charts must have data in the window (they showed "No data in this window").
    // These items were just ingested, so created_at = now() → all 3 count as new knowledge in-window.
    const knowledgeTotal = pulse.knowledge.reduce(
      (s, p) => s + p.deliverable + p.transcript + p.decision + p.task + p.artifact + p.skill,
      0
    );
    expect(knowledgeTotal).toBe(3);
    const usageTotal = pulse.usage.reduce((s, p) => s + p.queries, 0);
    expect(usageTotal).toBe(2);

    // Sanity: a −100% delta is the exact bug signature (current=0, prior>0); must NOT reproduce.
    expect(kpi("queries")!.delta).not.toBe(-100);
  });

  it("buckets knowledge growth by first-seen created_at, NOT by re-sync churn (synced_at)", async () => {
    const seed = await seedTeam();
    // An item first seen 10 days ago, then re-synced TODAY (the 30-min scheduler bumps synced_at every
    // tick). The old code bucketed on synced_at, so this old item wrongly counted as "new" today.
    const { id } = await ingest(seed, { path: "old.md", body: "seen long ago", access: "team", kind: "deliverable" });
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const now = new Date().toISOString();
    const { error } = await db()
      .from("items")
      .update({ created_at: tenDaysAgo, synced_at: now, updated_at: now })
      .eq("id", id);
    if (error) throw new Error(`backdate failed: ${error.message}`);

    const pulse = await getPulseMetrics(db(), seed.teamId, "30d", {
      isAdmin: true,
      memberId: seed.memberId,
      tier: "team",
    });

    // It's still within the 30d window (created 10d ago), so exactly one item lands in knowledge growth…
    const total = pulse.knowledge.reduce((s, p) => s + p.deliverable, 0);
    expect(total).toBe(1);
    // …but on its CREATION day (10 days ago), never on today (synced_at). Today's bucket is the last one.
    const today = pulse.knowledge[pulse.knowledge.length - 1];
    expect(today.deliverable).toBe(0);
  });

  it("H3: an external-tier viewer's metrics exclude team-only items and tasks (no RLS backstop)", async () => {
    // Regression for the Pass-1 leak. getPulseMetrics used to read items/tasks by team_id only, and the
    // home page routes an external member WITH their own API key into the dashboard — so team-wide
    // knowledge-growth (by kind) and the task funnel/in-flight count leaked internal activity to a
    // client. The metrics must now be tier-scoped exactly like every other dashboard read.
    const seed = await seedTeam();
    // One internal + one client-shared deliverable, and one internal + one client-shared task board.
    await ingest(seed, { path: "internal.md", body: "internal only", access: "team", kind: "deliverable" });
    await ingest(seed, { path: "shared.md", body: "shared with client", access: "external", kind: "deliverable" });
    // Distinct projects: materializeTasks diff-syncs task rows within a (team, project), so two boards
    // in one project would cross-delete each other's rows. Separate projects keep both alive.
    await ingest(seed, {
      project: "internal-proj",
      path: "internal-board.md",
      body: "| row_key | title | status |\n|---|---|---|\n| I-1 | internal task | in_progress |",
      access: "team",
      kind: "task",
      rows: [{ row_key: "I-1", title: "internal task", status: "in_progress" }],
    });
    await ingest(seed, {
      project: "client-proj",
      path: "client-board.md",
      body: "| row_key | title | status |\n|---|---|---|\n| C-1 | client task | in_progress |",
      access: "external",
      kind: "task",
      rows: [{ row_key: "C-1", title: "client task", status: "in_progress" }],
    });

    const external = await getPulseMetrics(db(), seed.teamId, "30d", {
      isAdmin: false,
      memberId: seed.memberId,
      tier: "external",
    });
    // Knowledge growth: only the one external deliverable is visible (the task item also has
    // access='external', so it counts too) — the internal deliverable + internal task item must not.
    const knowledgeTotal = external.knowledge.reduce(
      (s, p) => s + p.deliverable + p.transcript + p.decision + p.task + p.artifact + p.skill,
      0
    );
    expect(knowledgeTotal).toBe(2); // external deliverable + external task item
    // Tasks in flight: only the client task, not the internal one.
    const kpi = (key: string) => external.kpis.find((k) => k.key === key);
    expect(Number(kpi("tasks")!.value)).toBe(1);
    const inProgress = external.funnel.find((f) => f.status === "in_progress");
    expect(inProgress!.count).toBe(1);

    // Sanity: a team-tier viewer sees BOTH of each — proving the filter, not an empty DB, drove the above.
    const team = await getPulseMetrics(db(), seed.teamId, "30d", {
      isAdmin: true,
      memberId: seed.memberId,
      tier: "team",
    });
    const teamKnowledge = team.knowledge.reduce(
      (s, p) => s + p.deliverable + p.transcript + p.decision + p.task + p.artifact + p.skill,
      0
    );
    expect(teamKnowledge).toBe(4);
    expect(Number(team.kpis.find((k) => k.key === "tasks")!.value)).toBe(2);
  });
});
