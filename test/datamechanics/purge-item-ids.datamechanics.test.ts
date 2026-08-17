import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { purgeItemIds } from "@/lib/ingest/purge";
import type { GraphitiClient } from "@/lib/graph/graphiti-client";
import { db, seedTeam, ingest } from "./helpers";

/**
 * `purgeItemIds` as an ENTRY POINT, not as the shared core of the prefix purge.
 *
 * The prefix form is covered by `purge-items.datamechanics.test.ts`. This file exists because the
 * admin CLI (`scripts/admin.ts purge-items`) reaches the id form DIRECTLY — that is the deliberate
 * choice: the workspace path roots (`0-context/`, `2-work/`, `3-log/`) are shared by every project
 * in a team, so a prefix purge from a command line would delete unrelated real content, while an
 * explicit id list can only ever remove what the operator named.
 *
 * The properties that choice depends on, asserted here rather than assumed:
 *  • the purge is bounded to the ids given AND team-scoped (a foreign id cannot delete anything);
 *  • `graph_episodes` is retired FIRST — it has no FK to `items`, so a raw `delete from items`
 *    orphans the ledger and leaves live nodes in Neo4j with nothing pointing at them. This is the
 *    single reason the CLI must exist at all rather than an operator running SQL;
 *  • the removal is audited with its reason and the paths it took, read BEFORE the delete.
 */

async function episodeRows(teamId: string) {
  const { data } = await db()
    .from("graph_episodes")
    .select("id, source_id, content_sha256, pending_delete_group_id")
    .eq("team_id", teamId);
  return (data ?? []) as { id: string; source_id: string; content_sha256: string; pending_delete_group_id: string | null }[];
}

async function seedEpisode(teamId: string, itemId: string, groupId = "acme_team") {
  await db().from("graph_episodes").insert({
    team_id: teamId,
    source_table: "items",
    source_id: itemId,
    group_id: groupId,
    content_sha256: "a".repeat(64),
    episode_uuid: randomUUID(),
  });
}

/** A Graphiti stub recording what was deleted — enough for `deleteItemEpisodes`. */
function stubGraphiti(episodes: { uuid: string; name: string }[]) {
  const deleted: string[] = [];
  const client = {
    configured: true,
    listEpisodes: async () => episodes.filter((e) => !deleted.includes(e.uuid)),
    deleteEpisode: async (uuid: string) => {
      deleted.push(uuid);
    },
  } as unknown as GraphitiClient;
  return { client, deleted };
}

async function livePaths(teamId: string): Promise<string[]> {
  const { data } = await db().from("items").select("path").eq("team_id", teamId);
  return (data ?? []).map((r) => (r as { path: string }).path).sort();
}

describe("purgeItemIds (the admin CLI's entry point)", () => {
  it("removes exactly the ids given and nothing else", async () => {
    const seed = await seedTeam();
    const doomed = await ingest(seed, { path: "2-work/gone.md", body: "remove me", access: "team", project: "src" });
    await ingest(seed, { path: "2-work/keep.md", body: "keep me", access: "team", project: "src" });
    await ingest(seed, { path: "3-log/keep.md", body: "keep me too", access: "team", project: "src" });

    const res = await purgeItemIds(db(), seed.teamId, [doomed.id], "operator purge");

    expect(res.items).toBe(1);
    expect(
      await livePaths(seed.teamId),
      "sibling content under the SAME path roots survives — the reason the CLI takes ids, not a prefix"
    ).toEqual(["2-work/keep.md", "3-log/keep.md"]);
  });

  it("is team-scoped: another team's item id deletes nothing", async () => {
    const mine = await seedTeam();
    const theirs = await seedTeam();
    await ingest(mine, { path: "2-work/mine.md", body: "mine", access: "team", project: "src" });
    const foreign = await ingest(theirs, { path: "2-work/theirs.md", body: "theirs", access: "team", project: "src" });

    await purgeItemIds(db(), mine.teamId, [foreign.id], "wrong team");

    expect(await livePaths(theirs.teamId), "a foreign id must not delete across the team boundary").toEqual([
      "2-work/theirs.md",
    ]);
  });

  it("retires the item's graph episodes — the step a raw `delete from items` skips", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "2-work/projected.md", body: "projected", access: "team", project: "src" });
    await seedEpisode(seed.teamId, item.id);
    const { client, deleted } = stubGraphiti([
      { uuid: "u-1", name: `items:${item.id}` },
      { uuid: "u-other", name: `items:${randomUUID()}` },
    ]);

    const res = await purgeItemIds(db(), seed.teamId, [item.id], "operator purge", { client });

    expect(deleted, "the FACTS in Graphiti are what a purge has to remove").toEqual(["u-1"]);
    expect(res.episodes).toBe(1);
    // The ledger row survives as a tombstone so reconcile has something to retry — but it is no
    // longer a live projection, which is precisely what an orphaned row after raw SQL would be.
    const rows = await episodeRows(seed.teamId);
    expect(rows).toHaveLength(1);
    expect(rows[0].pending_delete_group_id).toBe("acme_team");
    expect(rows[0].content_sha256).toBe("");
    expect(await livePaths(seed.teamId)).toEqual([]);
  });

  it("audits the removal with its reason and the paths it took", async () => {
    const seed = await seedTeam();
    const a = await ingest(seed, { path: "2-work/a.md", body: "a", access: "team", project: "src" });
    const b = await ingest(seed, { path: "2-work/b.md", body: "b", access: "team", project: "src" });

    await purgeItemIds(db(), seed.teamId, [a.id, b.id], "client asked for these to be removed");

    const { data } = await db().from("audit_log").select("action, target_type, meta").eq("team_id", seed.teamId);
    const row = (data ?? []).find((r) => (r as { action: string }).action === "items.purged") as
      | { target_type: string; meta: Record<string, unknown> }
      | undefined;
    expect(row, "an irreversible removal is always audited").toBeDefined();
    expect(row!.target_type).toBe("item_ids");
    expect(row!.meta.reason).toBe("client asked for these to be removed");
    expect(row!.meta.items).toBe(2);
    // Paths are read BEFORE the delete — afterwards nothing on the box can answer "what went?".
    expect(row!.meta.paths).toEqual(["2-work/a.md", "2-work/b.md"]);
  });
});
