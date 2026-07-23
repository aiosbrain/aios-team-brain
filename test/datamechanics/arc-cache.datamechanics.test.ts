import { describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import { readArcCache, writeArcCache } from "@/lib/graph/arc-cache";
import type { NarrativeArc } from "@/lib/graph/arcs";

// Spec (arc_cache persistence, real Postgres): the Layer-3 narrative-arc cache round-trips the
// fully-attributed arcs JSON, upserts in place (one row per team+group_key), and is team-scoped.
// This is what lets getArcs serve-stale-while-revalidate instead of recomputing every visit.

function arc(id: string, title: string): NarrativeArc {
  return {
    id,
    title,
    confidence: "high",
    summary: "s",
    participants: ["Claude Code (Chetan Nandakumar)"],
    supporting_sources: [],
    evidence: [{ fact: "f", itemId: "i", source: "slack" }],
    derived_at: "2026-07-10T00:00:00.000Z",
  };
}

const KEY = "acme_team,acme_external";

describe("arc_cache persistence (data-mechanics)", () => {
  it("round-trips arcs JSON and stamps computed_at", async () => {
    const seed = await seedTeam();
    const arcs = [arc("arc-1", "Context-Management Enhancements")];
    const before = Date.now();
    await writeArcCache(db(), seed.teamId, KEY, arcs, null);

    const got = await readArcCache(db(), seed.teamId, KEY);
    expect(got).not.toBeNull();
    expect(got!.arcs).toEqual(arcs);
    // computed_at is a real, recent timestamp (not the 0 fallback).
    expect(got!.computedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(got!.computedAt).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("round-trips facts_hash (the stability key) — null and a real hash", async () => {
    const seed = await seedTeam();
    await writeArcCache(db(), seed.teamId, KEY, [arc("a", "A")], null);
    expect((await readArcCache(db(), seed.teamId, KEY))!.factsHash).toBeNull();
    await writeArcCache(db(), seed.teamId, KEY, [arc("a", "A")], "deadbeef");
    expect((await readArcCache(db(), seed.teamId, KEY))!.factsHash).toBe("deadbeef");
  });

  it("upserts in place — a second write replaces, not duplicates", async () => {
    const seed = await seedTeam();
    await writeArcCache(db(), seed.teamId, KEY, [arc("arc-1", "First")], null);
    await writeArcCache(db(), seed.teamId, KEY, [arc("arc-2", "Second"), arc("arc-3", "Third")], null);

    const got = await readArcCache(db(), seed.teamId, KEY);
    expect(got!.arcs.map((a) => a.title)).toEqual(["Second", "Third"]);

    const { data } = await db()
      .from("arc_cache")
      .select("group_key")
      .eq("team_id", seed.teamId)
      .eq("group_key", KEY);
    expect((data ?? []).length).toBe(1); // one row, not two
  });

  it("is team-scoped — another team's key never resolves", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    await writeArcCache(db(), a.teamId, KEY, [arc("arc-1", "Team A")], null);

    expect(await readArcCache(db(), b.teamId, KEY)).toBeNull();
  });

  it("returns null on a miss", async () => {
    const seed = await seedTeam();
    expect(await readArcCache(db(), seed.teamId, "nonexistent_key")).toBeNull();
  });

  it("distinct group_keys under one team are independent rows", async () => {
    const seed = await seedTeam();
    await writeArcCache(db(), seed.teamId, "acme_team", [arc("arc-t", "Team view")], null);
    await writeArcCache(db(), seed.teamId, "acme_external", [arc("arc-e", "External view")], null);

    expect((await readArcCache(db(), seed.teamId, "acme_team"))!.arcs[0].title).toBe("Team view");
    expect((await readArcCache(db(), seed.teamId, "acme_external"))!.arcs[0].title).toBe("External view");
  });
});
