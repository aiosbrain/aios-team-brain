import { describe, it, expect, vi } from "vitest";
import { commitArcs } from "@/lib/graph/arcs";
import { ARC_CACHE_TTL_MS, arcTtlMs } from "@/lib/graph/arc-cache";
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

/**
 * An untrustworthy result must be persisted with a SHORT life — fresh for a few minutes, then stale so
 * the next view retries. Both extremes are bugs: a full TTL pins a failure for 4h with no retry (H12),
 * while "already stale" makes every page view fire another recompute for as long as the failure lasts.
 */
function expectShortLived(row: unknown): void {
  const r = row as { computed_at: string; degraded?: boolean };
  // The mechanism changed (R2/M6) but the REQUIREMENT is identical: an untrustworthy row must go stale in
  // minutes, not hours. It used to be encoded by backdating `computed_at`; it is now the `degraded`
  // column plus the shorter TTL `arcTtlMs` derives from it. Asserted through `arcTtlMs` so this test
  // tracks the rule rather than restating a duration.
  expect(r.degraded).toBe(true);
  const at = Date.parse(r.computed_at);
  // …and the timestamp is now HONEST: written at the time of the write, not pushed into the past.
  expect(Date.now() - at).toBeLessThan(60_000);
  const remaining = arcTtlMs(true) - (Date.now() - at);
  expect(remaining).toBeGreaterThan(0); // not already stale — a persistent failure must not thrash
  expect(remaining).toBeLessThanOrEqual(10 * 60_000); // …but it retries within minutes, not hours
}

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
    expect(out.arcs.map((a) => a.title)).toEqual(["payments migration"]); // prior kept
    expect(upserts).toHaveLength(0); // NOT overwritten
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("keeping 1 cached"));
    warn.mockRestore();
  });

  it("reports the PRIOR's computed_at when it keeps the prior — not the commit time (R2/M6)", async () => {
    // The freshness contract, at the branch most likely to break it. When commitArcs refuses a bad
    // synthesis and hands back the cached set, those arcs are hours old; a caller that assumed
    // "commitArcs returned, so this is current" would re-create the exact M6 lie one branch deep —
    // which is what `getArcs`/`recomputeArcs` build their envelope from.
    const priorAt = Date.now() - 3 * HOUR;
    const { db } = fakeDb([arc("payments migration")], priorAt);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const kept = await commitArcs(db, "team-1", "freshness-keep-prior", [], null);
    expect(kept.arcs.map((a) => a.title)).toEqual(["payments migration"]);
    expect(kept.computedAt).toBe(priorAt); // the prior's time, to the millisecond

    // Same rule on the DEGRADED keep-prior branch (H11), which is a separate early return.
    const { db: db2 } = fakeDb([arc("payments migration")], priorAt);
    const keptDegraded = await commitArcs(db2, "team-1", "freshness-keep-degraded", [arc("noise")], "h9", {
      degraded: true,
    });
    expect(keptDegraded.computedAt).toBe(priorAt);
    warn.mockRestore();
  });

  it("reports the HONEST computation time for degraded and healthy alike (R2/M6)", async () => {
    // This assertion used to allow an untrustworthy result to under-claim its age, because the only way
    // to shorten its life was to backdate the timestamp. With `degraded` as its own column that trade is
    // gone: BOTH cases now report when the write actually happened, and the short retry window comes
    // from `arcTtlMs`. Strictly stronger than the old "never LATER" — this is "exactly right".
    const { db } = fakeDb(null);
    const before = Date.now();
    const healthy = await commitArcs(db, "team-1", "freshness-healthy", [arc("a")], "h1");
    expect(healthy.untrustworthy).toBe(false);
    expect(healthy.computedAt).toBeGreaterThanOrEqual(before);
    expect(healthy.computedAt).toBeLessThanOrEqual(Date.now());

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db: db2 } = fakeDb(null);
    const beforeDegraded = Date.now();
    const degraded = await commitArcs(db2, "team-1", "freshness-degraded-cold", [arc("b")], "h1", {
      degraded: true,
    });
    expect(degraded.untrustworthy).toBe(true);
    expect(degraded.computedAt).toBeGreaterThanOrEqual(beforeDegraded); // NOT pushed into the past
    expect(degraded.computedAt).toBeLessThanOrEqual(Date.now());
    // …and it still expires in minutes, which is the behaviour the backdating existed to produce.
    expect(arcTtlMs(degraded.untrustworthy)).toBeLessThanOrEqual(10 * 60_000);
    warn.mockRestore();
  });

  it("separates 'this attempt failed' from 'these bytes are bad' on the keep-prior branch", async () => {
    // A refused synthesis hands back a HEALTHY cached set (H11). Both facts are true at once and they
    // are not the same fact: the attempt failed, the payload is fine. Collapsing them scores a good 1h-old
    // prior against the 5-minute untrusted window — so the caller badges fresh data stale and every viewer
    // re-fires the recompute that just failed.
    const priorAt = Date.now() - 1 * HOUR;
    const { db } = fakeDb([arc("payments migration")], priorAt);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const kept = await commitArcs(db, "team-1", "split-keep-prior", [arc("noise")], "h9", { degraded: true });
    expect(kept.arcs.map((a) => a.title)).toEqual(["payments migration"]);
    expect(kept.untrustworthy).toBe(true); // the attempt
    expect(kept.payloadDegraded).toBe(false); // …but the bytes are the healthy prior
    expect(kept.computedAt).toBe(priorAt);
    warn.mockRestore();
  });

  it("…and when there is no prior to keep, the bytes ARE the bad ones", async () => {
    // The control: without it the split could be hardcoded to `false` and the test above still passes.
    const { db } = fakeDb(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const written = await commitArcs(db, "team-1", "split-no-prior", [arc("partial")], "h9", { degraded: true });
    expect(written.untrustworthy).toBe(true);
    expect(written.payloadDegraded).toBe(true); // persisted degraded — nothing healthier to fall back to
    warn.mockRestore();
  });

  it("writes through when synthesis returns real arcs", async () => {
    const { db, upserts } = fakeDb(null);
    const out = await commitArcs(db, "team-1", "write-good-1", [arc("a"), arc("b")], "h1");
    expect(out.arcs).toHaveLength(2);
    expect(upserts).toHaveLength(1); // persisted
  });

  it("writes empty on a genuine cold miss (no prior to protect)", async () => {
    const { db, upserts } = fakeDb(null);
    const out = await commitArcs(db, "team-1", "cold-empty-1", [], null);
    expect(out.arcs).toEqual([]);
    expect(upserts).toHaveLength(1); // first-ever load may legitimately be empty
  });

  it("H12: an empty result that HAD facts is written PRE-AGED, so the next view retries", async () => {
    // The cold-miss trap. `factsHash !== null` means there WERE facts in the window, so producing zero
    // arcs is the model failing — not the truth. Stamped `computed_at = now` it would read FRESH for the
    // full 4h TTL and SWR would never re-fire: one LLM timeout pinned an empty panel for four hours with
    // no retry. The distinguishing signal was already being computed and thrown away.
    const { db, upserts } = fakeDb(null);
    const out = await commitArcs(db, "team-1", "h12-model-failed", [], "facts-were-present");

    expect(out.arcs).toEqual([]); // nothing to show right now — honest
    expect(upserts).toHaveLength(1);
    expectShortLived(upserts[0]);
  });

  it("…but a genuinely empty window (no facts at all) is written FRESH", async () => {
    // The other side of the same signal: `factsHash === null` means the window really had nothing to
    // synthesize from. That IS the answer, so it should settle rather than re-running the LLM on every
    // view of a quiet team.
    const { db, upserts } = fakeDb(null);
    await commitArcs(db, "team-1", "h12-genuinely-empty", [], null);
    expect(upserts).toHaveLength(1);
    // Fresh: it should settle for the full window, not re-run the model on every view of a quiet team.
    const remaining = ARC_CACHE_TTL_MS - (Date.now() - Date.parse((upserts[0] as { computed_at: string }).computed_at));
    expect(remaining).toBeGreaterThan(ARC_CACHE_TTL_MS / 2);
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
    expect(out.arcs.map((a) => a.title)).toEqual(["payments migration"]); // prior wins
    expect(upserts).toHaveLength(0);
    warn.mockRestore();
  });

  it("H11: a DEGRADED result with no prior is written PRE-AGED, not fresh", async () => {
    // Nothing to protect, so showing it beats a blank panel — but it must not be trusted for a full TTL.
    const { db, upserts } = fakeDb(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await commitArcs(db, "team-1", "h11-degraded-cold", [arc("partial")], "h9", { degraded: true });
    expect(upserts).toHaveLength(1);
    expectShortLived(upserts[0]);
    warn.mockRestore();
  });

  it("ACCEPTS empty when the prior is older than the clobber cap (persistently-empty is genuine)", async () => {
    // A prior beyond the 48h cap is no longer trustworthy as transient-failure cover — a quiet team /
    // deleted content / graph reset should be allowed to blank the panel instead of pinning stale arcs.
    const { db, upserts } = fakeDb([arc("ancient migration")], Date.now() - 50 * HOUR);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await commitArcs(db, "team-1", "old-prior-1", [], null);
    expect(out.arcs).toEqual([]); // empty accepted
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
