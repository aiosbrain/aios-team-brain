import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, seedTeam } from "./helpers";
import { graphHasFacts } from "@/lib/query/retrieval-health";

// Spec (arcs empty-reason diagnosis): graphHasFacts distinguishes "the graph has no facts yet"
// (projector never populated it → the arcs panel says so) from "facts exist but synthesis failed"
// (→ points at the model). Team-scoped.

describe("graphHasFacts (data-mechanics)", () => {
  it("false when the team has no projected episodes", async () => {
    const seed = await seedTeam();
    expect(await graphHasFacts(seed.teamId)).toBe(false);
  });

  it("true once at least one episode is projected; team-scoped", async () => {
    const mine = await seedTeam();
    const other = await seedTeam();
    const { error } = await db().from("graph_episodes").insert({
      team_id: mine.teamId,
      source_table: "items",
      source_id: randomUUID(),
      group_id: `${mine.teamSlug}:team`,
      content_sha256: "abc",
    });
    if (error) throw new Error(error.message);
    expect(await graphHasFacts(mine.teamId)).toBe(true);
    expect(await graphHasFacts(other.teamId)).toBe(false); // other team unaffected
  });
});
