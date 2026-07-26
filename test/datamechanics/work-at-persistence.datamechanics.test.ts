import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam } from "./helpers";

/**
 * Spec (Pass-1 review R1): work-time is DATA, not a per-surface derivation.
 *
 * `resolveWorkTime` already made the *derivation* single-sourced, but nothing persisted the answer — so
 * every surface still re-derived it from `frontmatter` at read time, and anything that couldn't (SQL
 * windows, ORDER BY, the recency legs) fell back to `synced_at`. `synced_at` is bumped by EVERY re-sync
 * tick, so that fallback re-dates old work as today: the graph stamps months-old docs "now" and floods
 * the newest-facts pool (H4), the timeline's window/limit is really "most recently PUSHED" (H5), and
 * "latest docs" answers resurface old content after any re-scan (M3).
 *
 * The fix is to write it down at ingest:
 *   • `work_at`             — when the work happened. Never `synced_at`.
 *   • `work_at_from_source` — whether the SOURCE told us, or we fell back. Surfaces differ on what to do
 *                             with a guess (the timeline drops it, the projector accepts it), and that
 *                             difference is legitimate — so it has to be readable, not re-derived.
 * The honest fallback is the EXISTING `items.created_at` — set once on insert and never bumped, so it
 * already IS the "when did this first exist here" column. No new one for it; these specs say
 * `created_at` wherever the review report says "first-seen".
 */

describe("items.work_at is persisted at ingest (real Postgres)", () => {
  const stored = async (teamId: string, path: string) => {
    const { data } = await db()
      .from("items")
      .select("work_at, work_at_from_source, created_at, synced_at")
      .eq("team_id", teamId)
      .eq("path", path)
      .maybeSingle();
    return data as {
      work_at: string | Date;
      work_at_from_source: boolean;
      created_at: string | Date;
      synced_at: string | Date;
    };
  };
  const ms = (v: string | Date) => new Date(v).getTime();

  it("takes the source's own timestamp, not the sync time", async () => {
    const seed = await seedTeam();
    const committedAt = "2026-06-01T09:00:00.000Z"; // ~8 weeks before this push
    await ingest(seed, {
      kind: "artifact",
      path: "commits/abc.md",
      body: "fix the payment retry",
      access: "team",
      frontmatter: { committed_at: committedAt },
    });

    const row = await stored(seed.teamId, "commits/abc.md");
    expect(new Date(row.work_at).toISOString()).toBe(committedAt);
    expect(row.work_at_from_source).toBe(true);
    // The distinction that matters: sync time is now, work time is not.
    expect(ms(row.synced_at) - ms(row.work_at)).toBeGreaterThan(24 * 60 * 60_000);
  });

  it("does NOT move work_at or created_at when a re-sync tick re-pushes the same item", async () => {
    // The core of R1. Every connector re-pushes every item every 30 minutes; `synced_at` moves each
    // time. Anything derived from it therefore ages forward, which is how months-old work resurfaces as
    // "today". Both persisted timestamps must be immune.
    const seed = await seedTeam();
    const committedAt = "2026-06-01T09:00:00.000Z";
    const push = () =>
      ingest(seed, {
        kind: "artifact",
        path: "commits/abc.md",
        body: "fix the payment retry",
        access: "team",
        frontmatter: { committed_at: committedAt },
      });

    await push();
    const first = await stored(seed.teamId, "commits/abc.md");
    await push(); // identical body → the unchanged fast path
    const second = await stored(seed.teamId, "commits/abc.md");

    expect(ms(second.work_at)).toBe(ms(first.work_at));
    expect(ms(second.created_at)).toBe(ms(first.created_at));
    expect(ms(second.synced_at)).toBeGreaterThanOrEqual(ms(first.synced_at)); // …while sync time did move
  });

  it("falls back to created_at — never the bumped synced_at — when the source dates nothing", async () => {
    const seed = await seedTeam();
    await ingest(seed, { kind: "deliverable", path: "docs/undated.md", body: "no date anywhere", access: "team" });

    const row = await stored(seed.teamId, "docs/undated.md");
    expect(row.work_at_from_source).toBe(false);
    expect(ms(row.work_at)).toBe(ms(row.created_at));
  });

  it("heals work_at when only the FRONTMATTER's timestamp changes", async () => {
    // `content_sha256` covers the body alone, so a source that corrects its own date without touching
    // the prose takes the unchanged fast path. Without a heal the item keeps its first-ingest work-time
    // forever — the same class as the attribution and tier heals already on that path.
    const seed = await seedTeam();
    await ingest(seed, {
      kind: "deliverable",
      path: "docs/spec.md",
      body: "the spec",
      access: "team",
      frontmatter: { source_ts: "2026-05-01T00:00:00.000Z" },
    });
    await ingest(seed, {
      kind: "deliverable",
      path: "docs/spec.md",
      body: "the spec", // identical
      access: "team",
      frontmatter: { source_ts: "2026-06-15T00:00:00.000Z" }, // corrected upstream
    });

    const row = await stored(seed.teamId, "docs/spec.md");
    expect(new Date(row.work_at).toISOString()).toBe("2026-06-15T00:00:00.000Z");
    expect(row.work_at_from_source).toBe(true);
  });

  it("converges a BACKFILLED row to its real work-time on the next sync tick", async () => {
    // The migration deliberately doesn't parse dates out of source-controlled jsonb (no `try_cast` in
    // PG16, and one bad row would fail the whole deploy). It backfills every existing row to
    // `created_at`/not-from-source and relies on THIS to fix them: every connector re-pushes every item
    // each 30-minute tick, and the unchanged-path heal recomputes through the one resolver. If that
    // didn't hold, the entire existing corpus would sit at first-seen forever — so the migration's
    // safety argument rests on this spec.
    const seed = await seedTeam();
    const sourceTs = "2026-03-14T12:00:00.000Z";
    await ingest(seed, {
      kind: "deliverable",
      path: "docs/spec.md",
      body: "the spec",
      access: "team",
      frontmatter: { source_ts: sourceTs },
    });

    // Reproduce the exact post-migration state: the row's frontmatter ALREADY carries its date, but
    // work_at sits at the backfilled fallback because no code had resolved it when the column landed.
    const { data: before } = await db()
      .from("items")
      .select("created_at")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    const firstSeen = new Date((before as { created_at: string | Date }).created_at).toISOString();
    await db()
      .from("items")
      .update({ work_at: firstSeen, work_at_from_source: false })
      .eq("team_id", seed.teamId);

    // One ordinary re-sync tick — same body, nothing else changed.
    await ingest(seed, {
      kind: "deliverable",
      path: "docs/spec.md",
      body: "the spec",
      access: "team",
      frontmatter: { source_ts: sourceTs },
    });

    const row = await stored(seed.teamId, "docs/spec.md");
    expect(new Date(row.work_at).toISOString()).toBe(sourceTs);
    expect(row.work_at_from_source).toBe(true);
  });

  it("re-derives work_at when the body changes too", async () => {
    const seed = await seedTeam();
    await ingest(seed, {
      kind: "deliverable",
      path: "docs/spec.md",
      body: "v1",
      access: "team",
      frontmatter: { source_ts: "2026-05-01T00:00:00.000Z" },
    });
    await ingest(seed, {
      kind: "deliverable",
      path: "docs/spec.md",
      body: "v2 — edited",
      access: "team",
      frontmatter: { source_ts: "2026-06-15T00:00:00.000Z" },
    });

    const row = await stored(seed.teamId, "docs/spec.md");
    expect(new Date(row.work_at).toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("ignores an unparseable source timestamp rather than storing garbage", async () => {
    // Frontmatter comes from sources we don't control. A junk value must degrade to the honest fallback,
    // not to `Invalid Date` (which would land as NULL and silently drop the item from every work view).
    const seed = await seedTeam();
    await ingest(seed, {
      kind: "deliverable",
      path: "docs/junk.md",
      body: "junk date",
      access: "team",
      frontmatter: { source_ts: "not a date at all" },
    });

    const row = await stored(seed.teamId, "docs/junk.md");
    expect(row.work_at).not.toBeNull();
    expect(row.work_at_from_source).toBe(false);
    expect(ms(row.work_at)).toBe(ms(row.created_at));
  });
});
