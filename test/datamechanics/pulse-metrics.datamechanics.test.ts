import { describe, expect, it } from "vitest";
import { getPulseMetrics } from "@/lib/metrics/pulse";
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

describe("getPulseMetrics (real Postgres date windowing)", () => {
  it("counts freshly-synced items and recent queries as CURRENT (not prior)", async () => {
    const seed = await seedTeam();
    // Three items ingested now → synced_at = now(), squarely inside the 30d window.
    await ingest(seed, { path: "a.md", body: "alpha", access: "team", kind: "deliverable" });
    await ingest(seed, { path: "b.md", body: "bravo", access: "team", kind: "deliverable" });
    await ingest(seed, { path: "c.md", body: "charlie", access: "team", kind: "transcript" });
    await seedQuery(seed.teamId, seed.memberId, 0.42);
    await seedQuery(seed.teamId, seed.memberId, 0.08);

    const pulse = await getPulseMetrics(db(), seed.teamId, "30d", {
      isAdmin: true,
      memberId: seed.memberId,
    });

    const kpi = (key: string) => pulse.kpis.find((k) => k.key === key);

    // KPI band is the trimmed meaningful set — Queries / Tasks in flight / Spend. "Items synced"
    // was removed (it counted synced_at churn, not real growth), so it must NOT be present.
    expect(pulse.kpis.map((k) => k.key)).toEqual(["queries", "tasks", "spend"]);
    // Queries KPI: 2 recent queries, not 0.
    expect(Number(kpi("queries")!.value)).toBe(2);
    // Spend rolls up the recent queries' cost.
    expect(kpi("spend")!.value).toBe("$0.50");

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
    });

    // It's still within the 30d window (created 10d ago), so exactly one item lands in knowledge growth…
    const total = pulse.knowledge.reduce((s, p) => s + p.deliverable, 0);
    expect(total).toBe(1);
    // …but on its CREATION day (10 days ago), never on today (synced_at). Today's bucket is the last one.
    const today = pulse.knowledge[pulse.knowledge.length - 1];
    expect(today.deliverable).toBe(0);
  });
});
