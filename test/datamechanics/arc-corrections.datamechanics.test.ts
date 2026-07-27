import { describe, expect, it } from "vitest";
import { recordArcCorrections, listArcCorrections } from "@/lib/graph/arc-corrections";
import { db, seedTeam } from "./helpers";

/**
 * Spec (Pass-1 review H13): a human correction to a narrative arc is the ONLY human-authored input in
 * the learning layer, and it lived exclusively in Neo4j.
 *
 * `recomputeArcs` wrote each correction as a `correction:<arc_id>` episode inside a swallowed `catch`,
 * with no Postgres row and no ledger entry for reconcile to heal. Two consequences, both real:
 *   • a Graphiti rollback (which has actually happened here) permanently destroyed every correction;
 *   • a failed episode write silently reverted the user's edit within one cache TTL — they saw their
 *     change land, then watched it disappear, with nothing logged.
 *
 * Both are the same root cause: a projection was being used as the record. Postgres is the record now,
 * and the graph is a derived copy — so the durability question is "does it survive the graph", which is
 * what these specs ask.
 */

describe("arc corrections are durable in Postgres (real Postgres)", () => {
  it("persists a correction and reads it back — with no Graphiti involved at all", async () => {
    // The whole point: this path must not touch the graph. `GRAPHITI_URL` is unset in this tier, so a
    // correction that only survives via an episode would be gone.
    const seed = await seedTeam();
    await recordArcCorrections(db(), seed.teamId, seed.memberId, [
      { arc_id: "arc-abc", arc_title: "Payments migration", corrected_text: "Dana led this, not Alex." },
    ]);

    const { corrections: stored, ok } = await listArcCorrections(db(), seed.teamId);
    expect(ok).toBe(true);
    expect(stored.map((c) => c.corrected_text)).toEqual(["Dana led this, not Alex."]);
  });

  it("keeps the LATEST correction per arc rather than stacking duplicates", async () => {
    // A user correcting the same arc twice means the second supersedes the first — feeding both to the
    // prompt would have them argue with each other.
    const seed = await seedTeam();
    const one = { arc_id: "arc-abc", arc_title: "Payments migration", corrected_text: "first take" };
    await recordArcCorrections(db(), seed.teamId, seed.memberId, [one]);
    await recordArcCorrections(db(), seed.teamId, seed.memberId, [{ ...one, corrected_text: "second take" }]);

    const { corrections: stored, ok } = await listArcCorrections(db(), seed.teamId);
    expect(ok).toBe(true);
    expect(stored).toHaveLength(1);
    expect(stored[0].corrected_text).toBe("second take");
  });

  it("scopes corrections to their team", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    await recordArcCorrections(db(), a.teamId, a.memberId, [
      { arc_id: "x", arc_title: "t", corrected_text: "team A only" },
    ]);
    expect((await listArcCorrections(db(), b.teamId)).corrections).toEqual([]);
  });

  it("records WHO corrected it, so the edit is attributable", async () => {
    const seed = await seedTeam();
    await recordArcCorrections(db(), seed.teamId, seed.memberId, [
      { arc_id: "x", arc_title: "t", corrected_text: "mine" },
    ]);
    const { data } = await db()
      .from("arc_corrections")
      .select("created_by, arc_title")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    const row = data as { created_by: string; arc_title: string };
    expect(row.created_by).toBe(seed.memberId);
    // The TITLE is stored alongside the id because `arc_id` is a hash of the title and churns on every
    // recompute (M7). Without it a correction becomes an un-diagnosable orphan the moment arcs re-rank.
    expect(row.arc_title).toBe("t");
  });

  it("a failed write is NOT swallowed — the user must not be told an edit saved when it didn't", async () => {
    const seed = await seedTeam();
    await expect(
      // No such member → FK violation. Previously the whole writeback lived in a bare `catch {}`.
      recordArcCorrections(db(), seed.teamId, "00000000-0000-4000-8000-000000000000", [
        { arc_id: "x", arc_title: "t", corrected_text: "should not silently vanish" },
      ])
    ).rejects.toThrow();
  });
});
