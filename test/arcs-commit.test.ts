import { describe, it, expect, vi } from "vitest";
import { commitArcs } from "@/lib/graph/arcs";
import type { NarrativeArc } from "@/lib/graph/arcs";
import type { DbClient } from "@/lib/db/types";

/** Minimal fake DbClient covering exactly the arc_cache read (select→eq→eq→maybeSingle) and write
 *  (upsert) paths. Records upserts so we can assert whether a clobber happened. */
function fakeDb(existing: NarrativeArc[] | null, computedAt = new Date().toISOString()) {
  const upserts: unknown[] = [];
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => (existing ? { data: { arcs: existing, computed_at: computedAt } } : { data: null }),
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
    const out = await commitArcs(db, "team-1", "keep-good-1", []);
    expect(out.map((a) => a.title)).toEqual(["payments migration"]); // prior kept
    expect(upserts).toHaveLength(0); // NOT overwritten
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("keeping 1 cached"));
    warn.mockRestore();
  });

  it("writes through when synthesis returns real arcs", async () => {
    const { db, upserts } = fakeDb(null);
    const out = await commitArcs(db, "team-1", "write-good-1", [arc("a"), arc("b")]);
    expect(out).toHaveLength(2);
    expect(upserts).toHaveLength(1); // persisted
  });

  it("writes empty on a genuine cold miss (no prior to protect)", async () => {
    const { db, upserts } = fakeDb(null);
    const out = await commitArcs(db, "team-1", "cold-empty-1", []);
    expect(out).toEqual([]);
    expect(upserts).toHaveLength(1); // first-ever load may legitimately be empty
  });

  it("APPLIES an empty result for an explicit recompute (allowEmpty) — a correction that drops the last arc", async () => {
    const { db, upserts } = fakeDb([arc("stale")]);
    const out = await commitArcs(db, "team-1", "allow-empty-1", [], { allowEmpty: true });
    expect(out).toEqual([]); // the user's empty verdict is honored, not silently no-op'd
    expect(upserts).toHaveLength(1);
  });

  it("lets an empty result through once the good prior is older than the keep window (no stale-forever)", async () => {
    // Prior computed 2 days ago (> MAX_KEEP_STALE_MS) — a genuinely-emptied graph must eventually clear.
    const twoDaysAgo = new Date(Date.parse("2026-07-15T00:00:00Z") - 2 * 24 * 60 * 60 * 1000).toISOString();
    const { db, upserts } = fakeDb([arc("ancient")], twoDaysAgo);
    const out = await commitArcs(db, "team-1", "stale-prior-1", []);
    expect(out).toEqual([]); // stale prior no longer shields the empty
    expect(upserts).toHaveLength(1);
  });
});
