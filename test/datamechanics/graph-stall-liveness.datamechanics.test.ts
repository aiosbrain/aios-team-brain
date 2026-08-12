import { describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import { extractorActivity } from "@/lib/graph/extraction-health";

/**
 * STALLPROBE-1 / AIO-876 — the Postgres half of "did the extractor actually RUN?".
 *
 * The stall alarm used to infer liveness from graph NOVELTY (`max(RELATES_TO.created_at)` in Neo4j),
 * which freezes whenever extraction runs and every new edge deduplicates — prod runs ~6.1
 * `dedupe_edges` per `extract_edges`, so that is the normal case on a mature graph, not an edge case.
 * `extractorActivity` replaces the inference with LATE-STAGE evidence. A bare `source='graph'` row is
 * NOT proof of success: `meterGraphCall` records whatever `usage` arrives whatever the HTTP status (so
 * billed non-2xx generations aren't invisible spend), and a truncated extraction is a 200 carrying
 * usage. The pipeline runs `extract_nodes` → `dedupe_nodes` → `extract_edges` → `dedupe_edges`, and the
 * 2026-07 outage failed at stage 2 — so only a stage-3/4 row proves the job cleared the failing stage.
 *
 * Real Postgres because the thing under test is a READ against a real table with real scoping — the
 * failure modes are a wrong `source` filter, a wrong team scope, and mistaking "no rows" for "unknown".
 * A fake would encode whatever the reader already believed.
 *
 * NOT covered here (stated rather than implied): the end-to-end verdict through
 * `getGraphExtractionHealth`, which early-returns before this probe when `neo4jConfigured()` is false —
 * and this tier has no Neo4j. Composing the two is pinned by the pure tests in
 * `test/graph-extraction-health.test.ts`.
 */

async function insertGraphUsage(
  teamId: string,
  at: Date,
  source = "graph",
  callKind = "dedupe_edges"
): Promise<void> {
  const { error } = await db()
    .from("llm_usage")
    .insert({
      team_id: teamId,
      member_id: null,
      source,
      provider: "openrouter",
      model: "qwen/qwen3.7-plus",
      input_tokens: 100,
      output_tokens: 10,
      cost_usd: 0.001,
      estimated: false,
      call_kind: callKind,
      created_at: at.toISOString(),
    });
  if (error) throw new Error(`seed llm_usage failed: ${error.message}`);
}

describe("extractorActivity (real Postgres)", () => {
  it("an empty ledger is READABLE with no timestamp — 'nothing ran' is not 'unknown'", async () => {
    // The distinction the whole fix rests on. A readable-but-empty ledger is positive evidence of
    // silence (→ a real stall when facts also lag); an unreadable one is ignorance (→ never accuse).
    const seed = await seedTeam();
    const got = await extractorActivity(seed.teamId);
    expect(got.readable).toBe(true);
    expect(got.newestAtMs).toBeNull();
  });

  it("returns the NEWEST successful graph call", async () => {
    const seed = await seedTeam();
    const older = new Date(Date.now() - 5 * 3_600_000);
    const newest = new Date(Date.now() - 30 * 60_000);
    await insertGraphUsage(seed.teamId, older);
    await insertGraphUsage(seed.teamId, newest);
    const got = await extractorActivity(seed.teamId);
    expect(got.readable).toBe(true);
    // Second-resolution compare: the column is timestamptz and the driver round-trips through text.
    expect(Math.abs((got.newestAtMs ?? 0) - newest.getTime())).toBeLessThan(2000);
  });

  it("ignores OTHER sources — a busy Q&A box must not vouch for a dead extractor", async () => {
    // The filter that makes this evidence mean what it says. Without it, `timeline-summary` or
    // `query` traffic would keep the alarm quiet while graph extraction was completely dead.
    const seed = await seedTeam();
    await insertGraphUsage(seed.teamId, new Date(), "query");
    await insertGraphUsage(seed.teamId, new Date(), "timeline-summary");
    const got = await extractorActivity(seed.teamId);
    expect(got.readable).toBe(true);
    expect(got.newestAtMs).toBeNull();
  });

  it("is TEAM-SCOPED — another team's extractor never vouches for this one", async () => {
    // Same class as the source filter: borrowed liveness is worse than none, because it silences the
    // alarm on precisely the instance that is broken.
    const mine = await seedTeam();
    const theirs = await seedTeam();
    await insertGraphUsage(theirs.teamId, new Date());
    expect((await extractorActivity(mine.teamId)).newestAtMs).toBeNull();
    expect((await extractorActivity(theirs.teamId)).newestAtMs).not.toBeNull();
  });

  it("does NOT drop old activity — a quiet team's last real extraction still counts", async () => {
    // An earlier draft bounded this to `now() - 30 days`, which re-imported the wall-clock bug the lag
    // budget exists to avoid: a team quiet for two months would report "no activity" → stall, while the
    // reason string claimed episodes were still arriving. The caller compares against the newest
    // EPISODE, so an old row can only vouch when the episode is equally old — the correct verdict.
    const seed = await seedTeam();
    const ancient = new Date(Date.now() - 45 * 86_400_000);
    await insertGraphUsage(seed.teamId, ancient);
    const got = await extractorActivity(seed.teamId);
    expect(got.readable).toBe(true);
    expect(Math.abs((got.newestAtMs ?? 0) - ancient.getTime())).toBeLessThan(2000);
  });

  it("an EARLY-stage row alone never vouches — the truncation class must stay visible", async () => {
    // The Fable HIGH, as an outcome test. A job that dies in `resolve_extracted_nodes` still meters
    // `extract_nodes` (200 + usage, finish_reason=length), so accepting any graph row would blind the
    // probe to the exact 2026-07 outage it was built for.
    const seed = await seedTeam();
    await insertGraphUsage(seed.teamId, new Date(), "graph", "extract_nodes");
    await insertGraphUsage(seed.teamId, new Date(), "graph", "dedupe_nodes");
    expect((await extractorActivity(seed.teamId)).newestAtMs).toBeNull();
  });

  it("an UNLABELLED row (pre-GRAPHCOST-5) never vouches — it cannot be shown to be a late stage", async () => {
    const seed = await seedTeam();
    await insertGraphUsage(seed.teamId, new Date(), "graph", "");
    expect((await extractorActivity(seed.teamId)).newestAtMs).toBeNull();
  });
});
