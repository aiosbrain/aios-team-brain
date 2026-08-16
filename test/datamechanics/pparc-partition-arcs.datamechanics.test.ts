import { describe, expect, it } from "vitest";
import { reconcileProjectedEpisodes } from "@/lib/graph/reconcile";
import { writeArcCache, readArcCache, purgePartitionArcCache } from "@/lib/graph/arc-cache";
import { warmPartitionArcs } from "@/lib/graph/arcs";
import { episodeGroupId } from "@/lib/graph/group";
import { runSql } from "@/lib/db/pg/pool";
import { db, ingest, seedTeam } from "./helpers";
import { FakeGraphiti, client } from "./fake-graphiti";

/**
 * PPARC-2 — the partition-native (`g:`) arc row's write-path mechanics (design
 * docs/design/per-project-arcs.md §2.1/§2.2/§2.3/§3-last-row; acceptance criteria 7, 8; criterion 5's migration MOVES to PPARC-3 with the read cutover — Fable PPARC-2 Medium 1: re-keying while the p: union still serves (and still WRITES p: corrections) opens an H13 revert window on any enforcing self-host).
 * Criterion 1's full dm binding (fact isolation through a real read) lands with PPARC-3's read
 * path; its input-isolation half is unit-pinned in test/pparc-partition-scope.test.ts.
 */

const ARC = [{ id: "a1", title: "partition arc", confidence: "high", summary: "prose", participants: [], supporting_sources: [], evidence: [], derived_at: new Date().toISOString() }];
const KEYS = { anthropicApiKey: null, openaiApiKey: null } as never;

describe("PPARC-2 — the g: purge door is per-partition (criterion 8)", () => {
  it("a self-purge clear kills EXACTLY the affected partition's g: row — the neighbor's survives, and the p: rows still die team-wide", async () => {
    const seed = await seedTeam();
    const teamGroup = episodeGroupId(seed.teamSlug, "team");
    const otherGroup = `g_${"c".repeat(32)}_p_${"d".repeat(32)}`;
    await writeArcCache(db(), seed.teamId, `g:${teamGroup}`, ARC as never, "h1");
    await writeArcCache(db(), seed.teamId, `g:${otherGroup}`, ARC as never, "h2");
    await writeArcCache(db(), seed.teamId, `p:${seed.teamId}:${teamGroup}`, ARC as never, "h3");

    const r = await ingest(seed, { body: "restricted content", path: "r.md", access: "team" });
    await runSql(
      `insert into graph_episodes (team_id, source_table, source_id, group_id, content_sha256, pending_delete_group_id, pending_delete_at, projected_at)
       values ($1, 'items', $2, $3, '', $3, now() - interval '2 days', now() - interval '2 days')`,
      [seed.teamId, r.id, teamGroup]
    );
    await reconcileProjectedEpisodes(db(), client(new FakeGraphiti()), seed.teamId);

    expect(await readArcCache(db(), seed.teamId, `g:${teamGroup}`)).toBeNull(); // the affected partition
    expect(await readArcCache(db(), seed.teamId, `g:${otherGroup}`)).not.toBeNull(); // the neighbor survives
    expect(await readArcCache(db(), seed.teamId, `p:${seed.teamId}:${teamGroup}`)).toBeNull(); // p: stays team-wide until PPARC-4
  });

  it("purgePartitionArcCache deletes exactly one partition's row, one team's", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    await writeArcCache(db(), a.teamId, "g:gx", ARC as never, "h");
    await writeArcCache(db(), a.teamId, "g:gy", ARC as never, "h");
    await writeArcCache(db(), b.teamId, "g:gx", ARC as never, "h");
    await purgePartitionArcCache(db(), a.teamId, "gx");
    expect(await readArcCache(db(), a.teamId, "g:gx")).toBeNull();
    expect(await readArcCache(db(), a.teamId, "g:gy")).not.toBeNull();
    expect(await readArcCache(db(), b.teamId, "g:gx")).not.toBeNull();
  });
});

describe("PPARC-2 — the warming budget (criterion 7's write half)", () => {
  it("N=5 missing partitions against the default budget of 3 schedules exactly 3; a FRESH g: row is skipped, not re-minted", async () => {
    const seed = await seedTeam();
    // One fresh row — the budget must not be spent re-minting shared state.
    await writeArcCache(db(), seed.teamId, "g:fresh-group", ARC as never, "h");
    const scheduled = await warmPartitionArcs(
      db(),
      seed.teamId,
      ["fresh-group", "cold-1", "cold-2", "cold-3", "cold-4"],
      KEYS
    );
    expect(scheduled).toBe(3); // budget holds; the fresh row consumed none of it

    // The DISCRIMINATING half (a mutation survived the count-only version): a fresh-ONLY warm
    // must schedule NOTHING — the count above can't see WHICH groups spent the budget.
    const freshOnly = await warmPartitionArcs(db(), seed.teamId, ["fresh-group"], KEYS);
    expect(freshOnly).toBe(0);
  });
});
