import { describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import { recordLlmUsage } from "@/lib/costs/llm-usage";
import { runSql } from "@/lib/db/pg/pool";
import { getGraphEfficiency } from "@/lib/metrics/graph-efficiency";

const ADMIN = { isAdmin: true, memberId: "00000000-0000-0000-0000-000000000000" };

/**
 * Spec (real Postgres): the ratio is built from the two ledgers it claims to read, and the denominator
 * is the one that does not move.
 *
 * A unit test over `foldGraphEfficiency` proves the arithmetic; it cannot prove the query reads
 * `ingest_runs.created` for episodes. That choice is the whole point — `graph_episodes.projected_at` is
 * LAST-TOUCHED, so a ratio built on it silently changes when the projector re-touches a row, and a
 * `graph_episodes` row is one ITEM (chunked into up to 16 episodes) rather than one episode. Both
 * mistakes produced confidently wrong numbers while this regression was being diagnosed.
 */
describe("graph efficiency (data-mechanics)", () => {
  /** `created` is ITEMS and is deliberately a different number from `meta.episodes` here, so a query
   *  that reads the wrong column produces the wrong ratio instead of coincidentally matching. */
  async function pushRun(teamId: string, episodes: number, source = "graph_project") {
    const { error } = await db().from("ingest_runs").insert({
      team_id: teamId, source, trigger: "test", ok: true,
      created: episodes * 7 + 1, updated: 0, unchanged: 0,
      meta: { episodes },
    });
    if (error) throw new Error(error.message);
  }

  it("reads episodes from ingest_runs and calls from llm_usage", async () => {
    const seed = await seedTeam();
    await pushRun(seed.teamId, 6);
    await pushRun(seed.teamId, 4); // the projector ticks many times a day — they must sum
    for (let i = 0; i < 30; i++) {
      await recordLlmUsage(db(), {
        teamId: seed.teamId, memberId: null, source: "graph", provider: "openrouter",
        model: "m", inputTokens: 100, outputTokens: 10, costUsd: 0.002, estimated: false,
      });
    }
    const eff = await getGraphEfficiency(db(), seed.teamId, "30d", ADMIN);
    expect(eff.callsPerEpisode).toBe(3); // 30 calls / 10 episodes
    expect(eff.costPerEpisode).toBeCloseTo(0.006, 6);
    expect(eff.degrading).toBe(false);
  });

  it("counts every graph call after the old 200,000-row cap", async () => {
    // Regression for AIO-688/#471: cap+1 detected truncation but then hid the metric. That still
    // discarded the exact signal in the high-volume regime the metric exists to diagnose. A literal
    // row count keeps this decisive if somebody later reintroduces a differently named cap.
    const seed = await seedTeam();
    await pushRun(seed.teamId, 1);
    await runSql(
      `insert into llm_usage
         (id, team_id, member_id, source, provider, model, cost_usd, input_tokens, output_tokens, estimated, created_at)
       select gen_random_uuid(), $1, null, 'graph', 'openrouter', 'm', 0.001, 1, 1, false, now()
         from generate_series(1, 200001)`,
      [seed.teamId]
    );

    const eff = await getGraphEfficiency(db(), seed.teamId, "30d", ADMIN);
    expect(eff.callsPerEpisode).toBe(200_001);
    expect(eff.costPerEpisode).toBeCloseTo(200.001, 6);
  }, 15_000);

  it("counts only the GRAPH source and this team's rows", async () => {
    const seed = await seedTeam();
    const other = await seedTeam();
    await pushRun(seed.teamId, 2);
    await pushRun(other.teamId, 100); // another team's episodes must not dilute the ratio
    // Same team, DIFFERENT ingest source: a Slack run also carries episode-ish counts. Without the
    // source filter this lands in the denominator and understates the ratio — previously unpinned.
    await pushRun(seed.teamId, 500, "slack");
    await recordLlmUsage(db(), {
      teamId: seed.teamId, memberId: null, source: "graph", provider: "openrouter",
      model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0.001, estimated: false,
    });
    // Another team's GRAPH call must not enter this team's numerator — previously unpinned.
    await recordLlmUsage(db(), {
      teamId: other.teamId, memberId: null, source: "graph", provider: "openrouter",
      model: "m", inputTokens: 1, outputTokens: 1, costUsd: 9, estimated: false,
    });
    // A timeline summary is not extraction work — counting it would make the ratio meaningless.
    await recordLlmUsage(db(), {
      teamId: seed.teamId, memberId: null, source: "timeline-summary", provider: "openrouter",
      model: "m", inputTokens: 1, outputTokens: 1, costUsd: 5, estimated: false,
    });
    const eff = await getGraphEfficiency(db(), seed.teamId, "30d", ADMIN);
    expect(eff.callsPerEpisode).toBe(0.5); // 1 graph call / 2 episodes
    expect(eff.costPerEpisode).toBeCloseTo(0.0005, 6); // the $5 summary is excluded
  });

  it("a NON-ADMIN gets unknown, not a flattering zero", async () => {
    // Graph work is system-initiated (member_id null), so a member-scoped read returns no rows — and
    // "0 calls over N episodes" would render as perfectly efficient. The admin gate lives inside the
    // function precisely so a future caller cannot forget it.
    const seed = await seedTeam();
    await pushRun(seed.teamId, 5);
    await recordLlmUsage(db(), {
      teamId: seed.teamId, memberId: null, source: "graph", provider: "openrouter",
      model: "m", inputTokens: 1, outputTokens: 1, costUsd: 1, estimated: false,
    });
    const asMember = await getGraphEfficiency(db(), seed.teamId, "30d", { isAdmin: false, memberId: seed.memberId });
    expect(asMember.callsPerEpisode).toBeNull();
    expect(asMember.days).toEqual([]);
    expect((await getGraphEfficiency(db(), seed.teamId, "30d", ADMIN)).callsPerEpisode).toBe(0.2);
  });

  it("a team that has never projected reports UNKNOWN, not zero", async () => {
    const seed = await seedTeam();
    const eff = await getGraphEfficiency(db(), seed.teamId, "30d", ADMIN);
    expect(eff.callsPerEpisode).toBeNull();
    expect(eff.degrading).toBe(false);
  });
});
