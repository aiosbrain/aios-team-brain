import { describe, expect, it } from "vitest";
import { getFusedArcs } from "@/lib/graph/arc-fusion";
import { writeArcCache, readArcCache } from "@/lib/graph/arc-cache";
import { runSql } from "@/lib/db/pg/pool";
import { db, seedTeam } from "./helpers";

/**
 * PPARC-3 — the fused read path (design §2.2/§2.3; criteria 1-read-side, 3, 5, 7, 10).
 * Criterion 1's re-disposition, recorded: `recentFacts` rides Neo4j bolt, which the dm tier does
 * not run, so the "fact in A never in B" binding through a REAL synthesis is structurally
 * impossible here. The read-side half — a partition's arcs reach ONLY readers whose scope
 * includes it, byte-wise from its own row — is what this file pins (real PG, no synthesis);
 * the input-isolation half is unit-pinned (test/pparc-partition-scope.test.ts).
 */

const arcRow = (id: string, summary: string) => [{ id, title: `arc ${id}`, confidence: "high", summary, participants: [], supporting_sources: [], evidence: [], derived_at: new Date().toISOString() }];
const KEYS = { anthropicApiKey: null, openaiApiKey: null } as never;

describe("PPARC-3 — fusion serves ONLY the reader's partitions (criteria 1/3)", () => {
  it("a partition outside the scope never reaches the panel; inside, its arcs arrive byte-wise with sourceGroup", async () => {
    const seed = await seedTeam();
    await writeArcCache(db(), seed.teamId, "g:part-a", arcRow("a1", "A prose") as never, "ha");
    await writeArcCache(db(), seed.teamId, "g:part-b", arcRow("b1", "B prose") as never, "hb");

    const only = await getFusedArcs(db(), seed.teamId, seed.teamSlug, ["part-a"], KEYS);
    expect(only.arcs.map((a) => a.id)).toEqual(["a1"]);
    expect(only.arcs[0].sourceGroup).toBe("part-a");
    expect(only.arcs[0].summary).toBe("A prose"); // byte-wise from the row — fusion writes no prose
    expect(JSON.stringify(only.arcs)).not.toContain("B prose");

    const both = await getFusedArcs(db(), seed.teamId, seed.teamSlug, ["part-a", "part-b"], KEYS);
    expect(both.arcs.map((a) => a.id).sort()).toEqual(["a1", "b1"]);
    // A reader who LOSES a partition mid-session fails closed on the next read (criterion 3).
    const lost = await getFusedArcs(db(), seed.teamId, seed.teamSlug, ["part-b"], KEYS);
    expect(JSON.stringify(lost.arcs)).not.toContain("A prose");
  });
});

describe("PPARC-3 — coverage disclosure + the fused envelope (criteria 7/10)", () => {
  it("covered/total reflect rows present; the envelope's as_of is the OLDEST row and stale is any-row-stale", async () => {
    const seed = await seedTeam();
    await writeArcCache(db(), seed.teamId, "g:cov-a", arcRow("a1", "A") as never, "ha");
    await writeArcCache(db(), seed.teamId, "g:cov-b", arcRow("b1", "B") as never, "hb");
    // Age B past the TTL — the fused panel must report stale (any-row-stale) and as_of = B's time.
    await runSql("update arc_cache set computed_at = now() - interval '5 hours' where team_id = $1 and group_key = 'g:cov-b'", [seed.teamId]);

    const panel = await getFusedArcs(db(), seed.teamId, seed.teamSlug, ["cov-a", "cov-b"], KEYS);
    expect(panel.covered).toBe(2);
    expect(panel.total).toBe(2);
    expect(panel.freshness.stale).toBe(true); // any-row-stale
    expect(panel.freshness.computedAt).toBeLessThan(Date.now() - 4 * 60 * 60_000); // the OLDEST row's clock, not a fabricated now
  });

  it("an empty scope is a computedNow neutral panel; a missing partition costs at most ONE inline attempt", async () => {
    const seed = await seedTeam();
    const empty = await getFusedArcs(db(), seed.teamId, seed.teamSlug, [], KEYS);
    expect(empty.arcs).toEqual([]);
    expect(empty.covered).toBe(0);

    // Three partitions, one seeded: the inline attempt targets ONE missing partition (with no
    // Neo4j the synthesis commits an empty row — still counted as covered, honestly), the rest go
    // to background warming; total discloses everything the reader could see.
    await writeArcCache(db(), seed.teamId, "g:cold-a", arcRow("a1", "A") as never, "ha");
    const panel = await getFusedArcs(db(), seed.teamId, seed.teamSlug, ["cold-a", "cold-b", "cold-c"], KEYS);
    expect(panel.total).toBe(3);
    expect(panel.covered).toBeGreaterThanOrEqual(1);
    expect(panel.covered).toBeLessThanOrEqual(2); // seeded + at most the one inline attempt
  });
});

describe("PPARC-3 — stale-present partitions REVALIDATE (Fable High 2: SWR needs its R)", () => {
  it("a stale g: row schedules a background warm; a fresh one schedules nothing", async () => {
    const seed = await seedTeam();
    await writeArcCache(db(), seed.teamId, "g:swr-a", arcRow("a1", "A") as never, "ha");
    await runSql("update arc_cache set computed_at = now() - interval '5 hours' where team_id = $1 and group_key = 'g:swr-a'", [seed.teamId]);
    const stalePanel = await getFusedArcs(db(), seed.teamId, seed.teamSlug, ["swr-a"], KEYS);
    expect(stalePanel.warmScheduled).toBeGreaterThanOrEqual(1); // the stale row IS revalidated

    const fresh = await seedTeam();
    await writeArcCache(db(), fresh.teamId, "g:swr-b", arcRow("b1", "B") as never, "hb");
    const freshPanel = await getFusedArcs(db(), fresh.teamId, fresh.teamSlug, ["swr-b"], KEYS);
    expect(freshPanel.warmScheduled).toBe(0); // fresh rows cost nothing
  });
});

describe("PPARC-3 — the p:→g: corrections migration (criterion 5, moved from PPARC-2)", () => {
  it("re-keys single-group rows, keeps multi-group rows counted, WIPES all g: cache rows, replays idempotently, deletes no correction", async () => {
    const seed = await seedTeam();
    const g = `g_${"a".repeat(32)}_p_${"b".repeat(32)}`;
    for (const row of [
      { arc_id: "single", group_key: `p:${seed.teamId}:${g}` },
      { arc_id: "multi", group_key: `p:${seed.teamId}:${g},${g.replace("_p_", "_q_")}` },
      { arc_id: "legacy", group_key: "" },
    ]) {
      const { error } = await db()
        .from("arc_corrections")
        .insert({ team_id: seed.teamId, arc_id: row.arc_id, arc_title: "t", corrected_text: "take", group_key: row.group_key });
      expect(error).toBeNull();
    }
    // A pre-cutover g: row: anything computed before the MARKER's first-run stamp (Codex PPARC-3
    // High 2: a source-code date was wrong for a self-host that warmed rows between taking
    // PPARC-2 and PPARC-3 — the marker is deployment-relative by construction). Rows written
    // AFTER the first run must survive replay (Fable High 3: the unbounded wipe cold-wiped the
    // cache on every deploy).
    await writeArcCache(db(), seed.teamId, `g:${g}`, arcRow("x", "pre-cutover") as never, "h");
    await runSql("update arc_cache set computed_at = now() - interval '1 minute' where team_id = $1 and group_key = $2", [seed.teamId, `g:${g}`]);

    const MIG = (await import("node:fs")).readFileSync("postgres/migrations/20260816150000_arc_corrections_partition_scope.sql", "utf8");
    // The container's schema load already stamped the marker at setup — clear it so THIS test
    // exercises a genuine first run (the fixture was time-fragile against the container-age
    // marker; caught by the full-tier run).
    await runSql("delete from migration_markers where name = 'pparc3_g_wipe'");
    await runSql(MIG); // first run stamps the marker + wipes pre-cutover rows
    await writeArcCache(db(), seed.teamId, "g:post-cutover", arcRow("y", "post-cutover") as never, "h");
    await runSql(MIG); // replay-safe: the marker never restamps

    const rows = await runSql<{ arc_id: string; group_key: string }>(
      "select arc_id, group_key from arc_corrections where team_id = $1 order by arc_id",
      [seed.teamId]
    );
    expect(rows.rows).toHaveLength(3);
    const byArc = Object.fromEntries(rows.rows.map((r) => [r.arc_id, r.group_key]));
    expect(byArc["single"]).toBe(`g:${g}`);
    expect(byArc["multi"]).toContain("p:");
    expect(byArc["legacy"]).toBe("");
    expect(await readArcCache(db(), seed.teamId, `g:${g}`)).toBeNull(); // pre-cutover: wiped — the cutover re-warms
    expect(await readArcCache(db(), seed.teamId, "g:post-cutover")).not.toBeNull(); // post-cutover: SURVIVES replay — deploys must not cold-wipe the cache
  });
});
