import { describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import {
  readArcCache,
  writeArcCache,
  arcTtlMs,
  ARC_CACHE_TTL_MS,
  UNTRUSTED_RETRY_AFTER_MS,
} from "@/lib/graph/arc-cache";
import { getArcs, commitArcs, type NarrativeArc } from "@/lib/graph/arcs";
import {
  getCachedWorkTimeline,
  writeTimelineCache,
  readTimelineCache,
  settleTimelineRefreshes,
} from "@/lib/dashboard/timeline-cache";

/**
 * Spec (R2/M6 follow-up): "this payload is untrustworthy" is PERSISTED, and `computed_at` means only
 * "when was this computed".
 *
 * The state before: `writeArcCache` had nowhere to record that a synthesis was degraded, so it encoded
 * the fact in the timestamp — backdating `computed_at` by `TTL - 5min` to shorten the row's life. The
 * retry behaviour was right; the timestamp was a lie, and #426's freshness envelope had no choice but to
 * publish it. It also meant `degraded` survived exactly one request: the NEXT reader of the same row saw
 * `degraded: false` over identical untrustworthy bytes.
 *
 * So there are two claims to hold at once, and they pull against each other — which is why they're
 * asserted together: the timestamp is now HONEST, and the short retry window is UNCHANGED.
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

/**
 * A UNIQUE group set per test. `lib/graph/arcs` memoizes in a module-level map keyed by the group-key
 * ALONE (not by team) — safe in production, where the key embeds the team's unique slug, but a shared
 * literal here lets one test's arcs be served to the next one's team. Two of these tests failed exactly
 * that way before this: `commitArcs` found the previous test's entry via `priorArcs` and kept it instead
 * of writing at all.
 */
let n = 0;
function groupsFor(): { groups: string[]; key: string } {
  const slug = `degtest${++n}`;
  const groups = [`${slug}_team`, `${slug}_external`];
  return { groups, key: groups.slice().sort().join(",") };
}

describe("degraded is persisted, and computed_at stops doubling as a trust dial (R2/M6)", () => {
  it("a degraded write stamps computed_at NOW — the honest time — not a backdated one", async () => {
    const seed = await seedTeam();
    const { key } = groupsFor();
    const before = Date.now();
    await writeArcCache(db(), seed.teamId, key, [arc("a1")], "h1", { degraded: true });

    const row = await readArcCache(db(), seed.teamId, key);
    expect(row).not.toBeNull();
    expect(row!.degraded).toBe(true);
    // The whole point: the row is dated when it was written, NOT ~4h in the past.
    expect(row!.computedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(row!.computedAt).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("…but the SHORT retry window is preserved: a degraded row goes stale in minutes, not hours", async () => {
    // The behaviour the backdating existed to produce. It must survive the refactor exactly, or a
    // failed synthesis gets pinned for a full 4h with no retry — the H12 incident.
    expect(arcTtlMs(true)).toBe(UNTRUSTED_RETRY_AFTER_MS);
    expect(arcTtlMs(false)).toBe(ARC_CACHE_TTL_MS);
    expect(arcTtlMs(true)).toBeLessThan(arcTtlMs(false));

    const seed = await seedTeam();
    const { groups, key } = groupsFor();
    await writeArcCache(db(), seed.teamId, key, [arc("a2")], "h2", { degraded: true });
    // Age it past the SHORT window but nowhere near the full TTL.
    const at = new Date(Date.now() - (UNTRUSTED_RETRY_AFTER_MS + 30_000)).toISOString();
    await db().from("arc_cache").update({ computed_at: at }).eq("team_id", seed.teamId);

    const res = await getArcs(db(), seed.teamId, "acme", "team", groups, {});
    expect(res.freshness.stale).toBe(true); // retries soon, exactly as the backdating used to force
    expect(Date.now() - res.freshness.computedAt).toBeLessThan(ARC_CACHE_TTL_MS); // …while still young
  });

  it("a trustworthy row of the same age is NOT stale — the flag is what shortens the life", async () => {
    // The other half of the previous test: proves staleness came from `degraded`, not from the age.
    const seed = await seedTeam();
    const { groups, key } = groupsFor();
    await writeArcCache(db(), seed.teamId, key, [arc("a3")], "h3", { degraded: false });
    const at = new Date(Date.now() - (UNTRUSTED_RETRY_AFTER_MS + 30_000)).toISOString();
    await db().from("arc_cache").update({ computed_at: at }).eq("team_id", seed.teamId);

    const res = await getArcs(db(), seed.teamId, "acme", "team", groups, {});
    expect(res.freshness.stale).toBe(false);
    expect(res.freshness.degraded).toBe(false);
  });

  it("degraded SURVIVES the cache — a later reader of the same row still sees it", async () => {
    // The reviewer's finding on #426: `degraded` described one request's computation, so request B read
    // the row request A wrote and reported `degraded: false` over identical untrustworthy bytes.
    const seed = await seedTeam();
    const { groups, key } = groupsFor();
    await writeArcCache(db(), seed.teamId, key, [arc("a4")], "h4", { degraded: true });

    const res = await getArcs(db(), seed.teamId, "acme", "team", groups, {});
    expect(res.arcs.map((a) => a.id)).toEqual(["a4"]);
    expect(res.freshness.degraded).toBe(true); // read back from the row, not from this call's work
  });

  it("commitArcs persists its own untrustworthy verdict (H12: empty arcs from a NON-empty fact set)", async () => {
    // End-to-end: the verdict commitArcs already computes is what lands in the column, so the next
    // reader inherits it without recomputing anything.
    const seed = await seedTeam();
    const { key } = groupsFor();
    const out = await commitArcs(db(), seed.teamId, key, [], "facts-were-present");
    expect(out.untrustworthy).toBe(true);

    const row = await readArcCache(db(), seed.teamId, key);
    expect(row!.degraded).toBe(true);
    expect(row!.computedAt).toBeGreaterThan(Date.now() - 60_000); // honest timestamp, not backdated
  });

  it("the timeline's cold miss PERSISTS degraded, so the next reader isn't handed it as healthy", async () => {
    // The cold-miss row is written with the pure ledger — its per-person-day prose is absent (or salvaged
    // from an older payload version). Before the column, request A was told `degraded: true` and request
    // B, served the row A had just written, was told `false` over the identical bytes.
    const seed = await seedTeam();
    const first = await getCachedWorkTimeline(db(), seed.teamId, "team");
    expect(first.freshness.degraded).toBe(true);

    const row = await readTimelineCache(db(), seed.teamId, "team");
    expect(row!.degraded).toBe(true); // …and it's on the ROW, not just in that response
    await settleTimelineRefreshes();
  });

  it("a timeline row written by a healthy summary pass reports degraded=false", async () => {
    // The other direction — otherwise the flag is stuck on and means nothing.
    const seed = await seedTeam();
    await writeTimelineCache(db(), seed.teamId, "team", [], false);
    const res = await getCachedWorkTimeline(db(), seed.teamId, "team");
    expect(res.freshness.degraded).toBe(false);
    await settleTimelineRefreshes();
  });
});
