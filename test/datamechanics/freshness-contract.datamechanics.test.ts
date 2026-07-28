import { describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import { writeArcCache, ARC_CACHE_TTL_MS } from "@/lib/graph/arc-cache";
import { getArcs, type NarrativeArc } from "@/lib/graph/arcs";
import {
  getCachedWorkTimeline,
  writeTimelineCache,
  settleTimelineRefreshes,
  TIMELINE_TTL_MS,
} from "@/lib/dashboard/timeline-cache";

/**
 * Spec (Pass-1 review R2 / M6 — the freshness contract): a payload served out of a cache table must
 * report WHEN IT WAS COMPUTED, not when it was served.
 *
 * Both of these layers are serve-stale-while-revalidate: `arc_cache` has a 4-HOUR TTL and explicitly
 * hands back arcs older than that while refreshing behind the request. The routes above them filled in
 * `as_of: new Date().toISOString()`. That isn't an absent contract, it's a false one — and it defeats
 * machinery built deliberately downstream of it: `commitArcs` BACKDATES `computed_at` for an
 * untrustworthy synthesis (H11/H12) precisely so the row reads stale, and stamping `now()` at the wire
 * threw that away. An agent re-reading right after a correction gets the old attribution, marked current.
 *
 * These assert the DATA layer, because that is the layer that knows the answer — a route can only be
 * honest if the function it calls hands it the truth. Written against real Postgres so the assertion is
 * about the actual cache row's `computed_at`, not a mocked clock.
 */

function arc(id: string): NarrativeArc {
  return {
    id,
    title: `Arc ${id}`,
    confidence: "high",
    summary: "s",
    participants: ["Tester"],
    supporting_sources: [],
    evidence: [{ fact: "f", itemId: "i", source: "slack" }],
    derived_at: "2026-07-10T00:00:00.000Z",
  };
}

/** getArcs needs a key set; no Graphiti/LLM is reachable here, so every test seeds the cache first. */
const GROUPS = ["acme_team", "acme_external"];
const KEY = GROUPS.slice().sort().join(",");

/** Backdate a cache row so it is genuinely old in Postgres, rather than faking a clock. */
async function backdateArcCache(teamId: string, ageMs: number): Promise<string> {
  const at = new Date(Date.now() - ageMs).toISOString();
  await db().from("arc_cache").update({ computed_at: at }).eq("team_id", teamId).eq("group_key", KEY);
  return at;
}

describe("freshness contract: a cached payload reports when it was COMPUTED (R2/M6)", () => {
  it("getArcs on a STALE row reports the row's computed_at and stale=true — not now()", async () => {
    const seed = await seedTeam();
    await writeArcCache(db(), seed.teamId, KEY, [arc("a1")], "hash-1");
    // Older than the 4h TTL: the SWR branch hands these back while refreshing behind the request.
    const ageMs = ARC_CACHE_TTL_MS + 30 * 60_000;
    const backdatedIso = await backdateArcCache(seed.teamId, ageMs);

    const res = await getArcs(db(), seed.teamId, "acme", "team", GROUPS, {});

    expect(res.arcs.map((a) => a.id)).toEqual(["a1"]); // still serves the real payload
    // The whole point: the reported time is the ROW's, hours back — not the moment of the call.
    expect(res.freshness.computedAt).toBe(Date.parse(backdatedIso));
    expect(Date.now() - res.freshness.computedAt).toBeGreaterThanOrEqual(ARC_CACHE_TTL_MS);
    expect(res.freshness.stale).toBe(true);
  });

  it("getArcs on a FRESH row reports that row's time and stale=false", async () => {
    const seed = await seedTeam();
    await writeArcCache(db(), seed.teamId, KEY, [arc("a2")], "hash-2");
    const backdatedIso = await backdateArcCache(seed.teamId, 60_000); // 1 min old — well inside 4h

    const res = await getArcs(db(), seed.teamId, "acme", "team", GROUPS, {});

    expect(res.freshness.computedAt).toBe(Date.parse(backdatedIso));
    expect(res.freshness.stale).toBe(false);
    // Fresh must NOT mean "now" — a minute-old row reports a minute ago, or the field is decorative.
    expect(res.freshness.computedAt).toBeLessThan(Date.now() - 30_000);
  });

  it("getCachedWorkTimeline reports the cache row's computed_at, not the serve time", async () => {
    const seed = await seedTeam();
    // Seed Postgres DIRECTLY rather than via a cold-miss call. `getCachedWorkTimeline` populates a
    // process-local memo keyed by (team, tier) and consults it first, so a call-then-backdate sequence
    // reads the memo and never exercises the persisted branch this test is about — the first draft of
    // this test did exactly that and passed against a `computedAt` of `now`.
    await writeTimelineCache(db(), seed.teamId, "team", []);
    const ageMs = TIMELINE_TTL_MS + 60_000; // past the 5-min TTL → the stale-serve branch
    const at = new Date(Date.now() - ageMs).toISOString();
    await db().from("work_timeline_cache").update({ computed_at: at }).eq("team_id", seed.teamId);

    const res = await getCachedWorkTimeline(db(), seed.teamId, "team");

    expect(res.freshness.computedAt).toBe(Date.parse(at));
    expect(res.freshness.stale).toBe(true);
    await settleTimelineRefreshes(); // the stale branch fires a rebuild; don't leak it into the next test
  });

  it("the in-memory memo reports the PERSISTED time, not when this process cached it", async () => {
    // The subtle half. A second process (or a restart) repopulates its memo from a row that may be
    // hours old; if the memo stamped its own fill time, freshness would reset to zero on every deploy —
    // the same lie, just harder to see. So the memo carries the row's `computed_at` through.
    const seed = await seedTeam();
    await writeTimelineCache(db(), seed.teamId, "team", []);
    const at = new Date(Date.now() - 2 * 60_000).toISOString(); // 2 min old: inside the 5-min TTL
    await db().from("work_timeline_cache").update({ computed_at: at }).eq("team_id", seed.teamId);

    await getCachedWorkTimeline(db(), seed.teamId, "team"); // fills the memo from Postgres
    const res = await getCachedWorkTimeline(db(), seed.teamId, "team"); // …and this one is the memo hit

    expect(res.freshness.computedAt).toBe(Date.parse(at));
    expect(res.freshness.stale).toBe(false);
    expect(res.freshness.computedAt).toBeLessThan(Date.now() - 60_000);
  });
});
