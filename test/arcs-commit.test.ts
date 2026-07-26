import { describe, it, expect, vi } from "vitest";
import { commitArcs } from "@/lib/graph/arcs";
import { ARC_CACHE_TTL_MS } from "@/lib/graph/arc-cache";
import type { NarrativeArc } from "@/lib/graph/arcs";
import type { DbClient } from "@/lib/db/types";

/** Minimal fake DbClient covering exactly the arc_cache read (select→eq→eq→maybeSingle) and write
 *  (upsert) paths. Records upserts so we can assert whether a clobber happened. */
function fakeDb(existing: NarrativeArc[] | null, computedAtMs = Date.now()) {
  const upserts: unknown[] = [];
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () =>
              existing
                ? { data: { arcs: existing, computed_at: new Date(computedAtMs).toISOString() } }
                : { data: null },
          }),
        }),
      }),
      upsert: async (row: unknown) => {
        upserts.push(row);
        return { error: null };
      },
    }),
  } as unknown as DbClient;
  return { db, upserts };
}

const HOUR = 60 * 60 * 1000;

const arc = (title: string): NarrativeArc => ({
  id: "arc-" + title,
  title,
  confidence: "low",
  summary: "",
  participants: [],
  supporting_sources: [],
  evidence: [],
  derived_at: "2026-07-15T00:00:00Z",
});

describe("commitArcs — an empty synthesis must never clobber a good cache", () => {
  it("keeps the persisted non-empty arcs when synthesis returns [] (transient upstream failure)", async () => {
    const { db, upserts } = fakeDb([arc("payments migration")]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Unique key so the module-level in-memory cache from other tests can't leak in.
    const out = await commitArcs(db, "team-1", "keep-good-1", [], null);
    expect(out.map((a) => a.title)).toEqual(["payments migration"]); // prior kept
    expect(upserts).toHaveLength(0); // NOT overwritten
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("keeping 1 cached"));
    warn.mockRestore();
  });

  it("writes through when synthesis returns real arcs", async () => {
    const { db, upserts } = fakeDb(null);
    const out = await commitArcs(db, "team-1", "write-good-1", [arc("a"), arc("b")], "h1");
    expect(out).toHaveLength(2);
    expect(upserts).toHaveLength(1); // persisted
  });

  it("writes empty on a genuine cold miss (no prior to protect)", async () => {
    const { db, upserts } = fakeDb(null);
    const out = await commitArcs(db, "team-1", "cold-empty-1", [], null);
    expect(out).toEqual([]);
    expect(upserts).toHaveLength(1); // first-ever load may legitimately be empty
  });

  it("H12: an empty result that HAD facts is written PRE-AGED, so the next view retries", async () => {
    // The cold-miss trap. `factsHash !== null` means there WERE facts in the window, so producing zero
    // arcs is the model failing — not the truth. Stamped `computed_at = now` it would read FRESH for the
    // full 4h TTL and SWR would never re-fire: one LLM timeout pinned an empty panel for four hours with
    // no retry. The distinguishing signal was already being computed and thrown away.
    const { db, upserts } = fakeDb(null);
    const out = await commitArcs(db, "team-1", "h12-model-failed", [], "facts-were-present");

    expect(out).toEqual([]); // nothing to show right now — honest
    expect(upserts).toHaveLength(1);
    const at = Date.parse((upserts[0] as { computed_at: string }).computed_at);
    // Older than the TTL ⇒ the very next read treats it as stale and recomputes.
    expect(Date.now() - at).toBeGreaterThan(ARC_CACHE_TTL_MS);
  });

  it("…but a genuinely empty window (no facts at all) is written FRESH", async () => {
    // The other side of the same signal: `factsHash === null` means the window really had nothing to
    // synthesize from. That IS the answer, so it should settle rather than re-running the LLM on every
    // view of a quiet team.
    const { db, upserts } = fakeDb(null);
    await commitArcs(db, "team-1", "h12-genuinely-empty", [], null);
    expect(upserts).toHaveLength(1);
    const at = Date.parse((upserts[0] as { computed_at: string }).computed_at);
    expect(Date.now() - at).toBeLessThan(ARC_CACHE_TTL_MS);
  });

  it("H11: a DEGRADED result never freshens over a healthy prior", async () => {
    // The subtler half. Every resolution leg used to swallow its failure, so one blip produced a
    // plausible but attribution-less arc set — non-empty, so the empty-clobber guard didn't apply — that
    // overwrote correct arcs and was served as FRESH for 4h. Degradation has to be data the commit can
    // refuse, not a silent fallback.
    const { db, upserts } = fakeDb([arc("payments migration")]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await commitArcs(db, "team-1", "h11-degraded-prior", [arc("unattributed noise")], "h9", {
      degraded: true,
    });
    expect(out.map((a) => a.title)).toEqual(["payments migration"]); // prior wins
    expect(upserts).toHaveLength(0);
    warn.mockRestore();
  });

  it("H11: a DEGRADED result with no prior is written PRE-AGED, not fresh", async () => {
    // Nothing to protect, so showing it beats a blank panel — but it must not be trusted for a full TTL.
    const { db, upserts } = fakeDb(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await commitArcs(db, "team-1", "h11-degraded-cold", [arc("partial")], "h9", { degraded: true });
    expect(upserts).toHaveLength(1);
    const at = Date.parse((upserts[0] as { computed_at: string }).computed_at);
    expect(Date.now() - at).toBeGreaterThan(ARC_CACHE_TTL_MS);
    warn.mockRestore();
  });

  it("ACCEPTS empty when the prior is older than the clobber cap (persistently-empty is genuine)", async () => {
    // A prior beyond the 48h cap is no longer trustworthy as transient-failure cover — a quiet team /
    // deleted content / graph reset should be allowed to blank the panel instead of pinning stale arcs.
    const { db, upserts } = fakeDb([arc("ancient migration")], Date.now() - 50 * HOUR);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await commitArcs(db, "team-1", "old-prior-1", [], null);
    expect(out).toEqual([]); // empty accepted
    expect(upserts).toHaveLength(1); // written through, not kept
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("accepting empty"));
    warn.mockRestore();
  });
});

describe("resolveEpisodeItems — 'not configured' is not a failure", () => {
  it("reports ok:true with an empty map when there is nothing to ask", async () => {
    // The distinction the H11 fix rests on. This leg returns an empty map in two very different
    // situations: the graph legitimately has no episodes for these uuids, and the query FAILED. Only the
    // second means "the synthesis inputs are incomplete, don't publish". Conflating them is what let a
    // blip look like a quiet week and overwrite good arcs.
    const { resolveEpisodeItems } = await import("@/lib/graph/learning");
    for (const [groups, uuids] of [
      [[], ["u1"]],
      [["g"], []],
    ] as [string[], string[]][]) {
      const res = await resolveEpisodeItems(groups, uuids);
      expect(res.ok).toBe(true); // nothing to do ≠ broken
      expect(res.items.size).toBe(0);
    }
  });
});
