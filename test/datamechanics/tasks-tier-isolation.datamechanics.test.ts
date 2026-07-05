import { describe, expect, it } from "vitest";
import { retrieve } from "@/lib/query/retrieve";
import { db, seedTeam } from "./helpers";

/**
 * Spec for audit finding H1: `tasks` had no tier column, so an `external`-tier principal read every
 * internal task board through the retrieval digest (and the pull API / dashboard box). Tasks now
 * carry `audience` (inheriting the materializing item's access) and every tier-scoped read filters
 * it via `visibleTasks`. Derived from the tier-isolation invariant (CLAUDE.md §5), not the impl:
 * with no RLS backstop this app-code filter is the SOLE thing stopping the leak.
 */

async function seedProject(teamId: string, slug: string): Promise<string> {
  const { data } = await db()
    .from("projects")
    .insert({ team_id: teamId, slug, name: slug })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

async function seedTask(
  teamId: string,
  projectId: string,
  rowKey: string,
  title: string,
  audience: "team" | "external"
): Promise<void> {
  await db().from("tasks").insert({
    team_id: teamId,
    project_id: projectId,
    row_key: rowKey,
    title,
    status: "in_progress",
    origin: "sync",
    audience,
    updated_at: "2026-06-26T10:00:00Z",
  });
}

describe("tasks tier isolation in retrieval (real Postgres)", () => {
  it("hides team-audience tasks from an external principal but shows them to a team principal", async () => {
    const seed = await seedTeam();
    const proj = await seedProject(seed.teamId, "apollo");
    await seedTask(seed.teamId, proj, "T-INTERNAL", "Internal roadmap planning", "team");
    await seedTask(seed.teamId, proj, "T-SHARED", "Client-shared deliverable", "external");

    // External principal: must NOT see the internal task, may see the external one.
    const ext = await retrieve(db(), seed.teamId, "external", "what is the team working on");
    expect(ext.structured).not.toContain("Internal roadmap planning");
    expect(ext.structured).not.toContain("T-INTERNAL");
    expect(ext.structured).toContain("Client-shared deliverable");

    // Team principal: sees the full board (the filter is not over-restrictive).
    const team = await retrieve(db(), seed.teamId, "team", "what is the team working on");
    expect(team.structured).toContain("Internal roadmap planning");
    expect(team.structured).toContain("Client-shared deliverable");
  });

  it("omits untier'd graph entities from an external principal's context", async () => {
    const seed = await seedTeam();
    // A commitment graph entity has no tier column, so external context must exclude it entirely.
    await db().from("graph_entities").insert({
      team_id: seed.teamId,
      entity_id: "ent-1",
      entity_type: "commitment",
      name: "Deliver the internal Q3 plan",
      attrs: {},
    });
    const ext = await retrieve(db(), seed.teamId, "external", "what commitments exist");
    expect(ext.structured).not.toContain("Deliver the internal Q3 plan");
  });
});
