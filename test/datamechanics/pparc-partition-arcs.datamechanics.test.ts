import { describe, expect, it } from "vitest";
import { reconcileProjectedEpisodes } from "@/lib/graph/reconcile";
import { writeArcCache, readArcCache, purgePartitionArcCache } from "@/lib/graph/arc-cache";
import { getFusedArcs } from "@/lib/graph/arc-fusion";
import { episodeGroupId } from "@/lib/graph/group";
import { runSql } from "@/lib/db/pg/pool";
import { db, ingest, seedTeam } from "./helpers";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { mkInitiative } from "./graph-helpers";
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
  it("a self-purge clear kills EXACTLY the affected partition's g: row — the neighbor's survives (PPARC-4: the retired p: gate no longer purges; the straggler sweep owns residue)", async () => {
    const seed = await seedTeam();
    // REAL pointers (the PPARC-4 orphan sweep rightly deletes rows for pointer-less groups —
    // the first fixture here seeded exactly such orphans and the sweep ate the "neighbor").
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const teamGroup = episodeGroupId(seed.teamSlug, "team");
    const otherGroup = (await mkInitiative(seed, "neighbor-init")).group;
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
    // The p: row SURVIVES the door now (the team-wide gate retired) — only the 7d straggler
    // sweep collects such residue; nothing can mint new ones (the inverse guard).
    expect(await readArcCache(db(), seed.teamId, `p:${seed.teamId}:${teamGroup}`)).not.toBeNull();
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

describe("PPARC-4 — the orphaned-g:-row sweep (design-assigned lifecycle)", () => {
  it("a g: row whose partition no longer exists is swept by reconcile; a pointered partition's row survives", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const real = (await mkInitiative(seed, "living-init")).group;
    await writeArcCache(db(), seed.teamId, `g:${real}`, ARC as never, "h1");
    await writeArcCache(db(), seed.teamId, `g:g_${"e".repeat(32)}_p_${"f".repeat(32)}`, ARC as never, "h2"); // no pointer — a deleted initiative's residue
    await reconcileProjectedEpisodes(db(), client(new FakeGraphiti()), seed.teamId);
    expect(await readArcCache(db(), seed.teamId, `g:${real}`)).not.toBeNull();
    expect(await readArcCache(db(), seed.teamId, `g:g_${"e".repeat(32)}_p_${"f".repeat(32)}`)).toBeNull();
  });
});

describe("the warming budget through the LIVE path (PPARC-4: warmPartitionArcs retired; getFusedArcs owns scheduling)", () => {
  it("five missing partitions cost 1 inline + at most budget(3) scheduled; a fresh row costs nothing", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const groups = ["cold-a", "cold-b", "cold-c", "cold-d", "cold-e"];
    const panel = await getFusedArcs(db(), seed.teamId, seed.teamSlug, groups, KEYS);
    // EXACT (review Low 1: a band would pass a budget shrink or partial scheduling failure):
    // 5 missing − 1 inline target = 4 candidates, budget 3 → exactly 3 scheduled.
    expect(panel.warmScheduled).toBe(3);

    const fresh = await seedTeam();
    expect((await ensureAccessBootstrap(db(), fresh.teamId)).ok).toBe(true);
    await writeArcCache(db(), fresh.teamId, "g:fresh-x", ARC as never, "h");
    const p2 = await getFusedArcs(db(), fresh.teamId, fresh.teamSlug, ["fresh-x"], KEYS);
    expect(p2.warmScheduled).toBe(0); // fresh rows are never re-minted
  });
});

