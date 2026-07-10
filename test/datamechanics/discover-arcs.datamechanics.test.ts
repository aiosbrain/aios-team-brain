import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, seedTeam, ingest } from "./helpers";
import { discoverOpportunitiesFromArcs } from "@/lib/social/discover-arcs";
import { listOpportunities } from "@/lib/social/store";
import type { NarrativeArc } from "@/lib/graph/arcs";

// Spec (arc → opportunity discovery on real Postgres): an arc becomes a social opportunity at its
// TIER-SAFE access — a story built from any internal (team) evidence can never be created as an
// external (publicly postable) opportunity. Idempotent by arc id. Injected arcs (getArcs needs Neo4j).

function arc(id: string, itemIds: string[], over: Partial<NarrativeArc> = {}): NarrativeArc {
  return {
    id,
    title: `Arc ${id}`,
    confidence: "high",
    summary: "summary",
    participants: [],
    supporting_sources: [],
    evidence: itemIds.map((itemId) => ({ fact: "f", itemId, source: "slack" })),
    derived_at: "2026-07-10T00:00:00.000Z",
    ...over,
  };
}

async function run(teamId: string, teamSlug: string, arcs: NarrativeArc[]) {
  return discoverOpportunitiesFromArcs(db(), teamId, teamSlug, "team", [], {}, { arcs });
}

describe("discoverOpportunitiesFromArcs (data-mechanics)", () => {
  it("creates an external opportunity when the arc cites only external evidence", async () => {
    const seed = await seedTeam();
    const ext = await ingest(seed, { path: "blog/1.md", body: "public deliverable", access: "external" });

    const s = await run(seed.teamId, seed.teamSlug, [arc("arc-ext", [ext.id])]);
    expect(s.created).toBe(1);
    const [opp] = s.opportunities;
    expect(opp.source_type).toBe("arc");
    expect(opp.dedup_key).toBe("arc:arc-ext");
    expect(opp.access).toBe("external");
    expect(opp.confidence_score).toBe(0.9);
  });

  it("keeps an arc TEAM-tier (no public leak) when any evidence is internal", async () => {
    const seed = await seedTeam();
    const ext = await ingest(seed, { path: "blog/2.md", body: "public", access: "external" });
    const team = await ingest(seed, { path: "internal/1.md", body: "internal", access: "team" });

    const s = await run(seed.teamId, seed.teamSlug, [arc("arc-mixed", [ext.id, team.id])]);
    expect(s.created).toBe(1);
    // Most-restrictive evidence wins: one team item → the whole opportunity is team-tier.
    expect(s.opportunities[0].access).toBe("team");

    // And an external viewer never sees it.
    const extVisible = await listOpportunities(db(), seed.teamId, "external", 100);
    expect(extVisible.map((o) => o.dedup_key)).not.toContain("arc:arc-mixed");
  });

  it("fails closed to TEAM when evidence references a missing item", async () => {
    const seed = await seedTeam();
    const s = await run(seed.teamId, seed.teamSlug, [arc("arc-dangling", [randomUUID()])]);
    expect(s.opportunities[0].access).toBe("team");
  });

  it("is idempotent by arc id — a second run creates nothing new", async () => {
    const seed = await seedTeam();
    const ext = await ingest(seed, { path: "blog/3.md", body: "public", access: "external" });
    const arcs = [arc("arc-dupe", [ext.id])];

    const first = await run(seed.teamId, seed.teamSlug, arcs);
    expect(first.created).toBe(1);
    const second = await run(seed.teamId, seed.teamSlug, arcs);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);

    const all = await listOpportunities(db(), seed.teamId, "team", 100);
    expect(all.filter((o) => o.dedup_key === "arc:arc-dupe").length).toBe(1);
  });
});
