import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { resolveGraphProxyTeamId, isRefusal } from "@/lib/llm/graph-proxy";
import { db, seedTeam } from "./helpers";

/**
 * Whose key the graph leg spends — against real Postgres, because the answer is a query.
 *
 * Graphiti's completion calls carry no team context (the `group_id` is on the episode, not the chat
 * request), so this cannot be resolved per-request. AIOS is self-hosted per organization, so an
 * instance-level answer is correct — but "whichever row came back first" would be a silent, arbitrary
 * choice about which team's money gets spent. On a multi-team instance that must refuse, not guess.
 */
describe("graph proxy team resolution (real Postgres)", () => {
  it("resolves automatically when the instance has exactly one team", async () => {
    // Isolate: this table is shared with every other suite, so pin to a slug we just made.
    const seed = await seedTeam();
    const got = await resolveGraphProxyTeamId(db(), seed.teamSlug);
    expect(isRefusal(got)).toBe(false);
    if (isRefusal(got)) return;
    expect(got.teamId).toBe(seed.teamId);
  });

  it("REFUSES when GRAPH_LLM_TEAM names a team that doesn't exist", async () => {
    // A typo in the slug must not silently fall through to some other team's key.
    const got = await resolveGraphProxyTeamId(db(), `missing-${randomUUID().slice(0, 8)}`);
    expect(isRefusal(got)).toBe(true);
    if (!isRefusal(got)) return;
    expect(got.code).toBe("graph_proxy_team_unknown");
    expect(got.message).toMatch(/GRAPH_LLM_TEAM/);
  });

  it("REFUSES to guess when several teams exist and no slug is set", async () => {
    // The data-mechanics database accumulates teams across suites, which is exactly the ambiguous
    // shape this must refuse. Seed two more so the condition holds regardless of run order.
    await seedTeam();
    await seedTeam();
    const got = await resolveGraphProxyTeamId(db(), undefined);
    expect(isRefusal(got)).toBe(true);
    if (!isRefusal(got)) return;
    expect(got.code).toBe("graph_proxy_team_ambiguous");
    expect(got.message).toMatch(/GRAPH_LLM_TEAM/);
  });
});
