import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { purgeItemsByPathPrefix } from "@/lib/ingest/purge";
import type { GraphitiClient } from "@/lib/graph/graphiti-client";
import { db, seedTeam, ingest } from "./helpers";

/**
 * Spec: REMOVAL of already-ingested content. The brain had no removal path at all — sync only adds or
 * replaces — so content that should no longer exist (a private channel configured by mistake, a
 * message deleted at the source) stayed in the store, in retrieval, and in the graph forever.
 *
 * Two things only real Postgres can prove, and both are the point of the feature:
 *  • `item_versions` CASCADES. That table retains every superseded body, so a deleted message
 *    survives the re-render that dropped it from the current body — deleting the item is what
 *    actually removes it.
 *  • `graph_episodes` does NOT cascade (no FK to `items`; it's an idempotency ledger keyed by
 *    `source_id`), so an item deleted on its own strands the row AND leaves the extracted facts
 *    answering questions in Graphiti with nothing pointing at them.
 */
async function episodeRows(teamId: string) {
  const { data } = await db()
    .from("graph_episodes")
    .select("id, source_id, content_sha256, pending_delete_group_id")
    .eq("team_id", teamId);
  return (data ?? []) as {
    id: string;
    source_id: string;
    content_sha256: string;
    pending_delete_group_id: string | null;
  }[];
}

async function versionCount(itemId: string): Promise<number> {
  const { data } = await db().from("item_versions").select("id").eq("item_id", itemId);
  return (data ?? []).length;
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

describe("purgeItemsByPathPrefix (real Postgres)", () => {
  it("removes the items under the prefix and their versions, leaving siblings untouched", async () => {
    const seed = await seedTeam();
    const priv = await ingest(seed, { path: "slack/c0priv/1.md", project: "slack", kind: "transcript", access: "team", body: "secret" });
    await ingest(seed, { path: "slack/c0pub/1.md", project: "slack", kind: "transcript", access: "team", body: "public" });
    expect(await versionCount(priv.id)).toBe(1);

    const res = await purgeItemsByPathPrefix(db(), seed.teamId, "slack/c0priv/", "test");

    expect(res.items).toBe(1);
    expect(await versionCount(priv.id)).toBe(0); // cascaded — the retained bodies go too
    const { data: survivors } = await db().from("items").select("path").eq("team_id", seed.teamId);
    expect((survivors ?? []).map((r) => (r as { path: string }).path)).toEqual(["slack/c0pub/1.md"]);
  });

  it("deletes the item's episodes from Graphiti and keeps a tombstone until cleanup is verified", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "slack/c0priv/1.md", project: "slack", kind: "transcript", access: "team", body: "secret" });
    await seedEpisode(seed.teamId, item.id);
    const { client, deleted } = stubGraphiti([
      { uuid: "u-1", name: `items:${item.id}` },
      { uuid: "u-other", name: `items:${randomUUID()}` },
    ]);

    const res = await purgeItemsByPathPrefix(db(), seed.teamId, "slack/c0priv/", "private", { client });

    // The FACTS are what a purge has to remove — the ledger row is only bookkeeping.
    expect(deleted).toEqual(["u-1"]); // and only this item's
    expect(res.episodes).toBe(1);
    // The row SURVIVES, flagged: the inline delete is best-effort (Graphiti blips; its async worker
    // can create a straggler chunk after we listed), so reconcile must have something to retry.
    const rows = await episodeRows(seed.teamId);
    expect(rows).toHaveLength(1);
    expect(rows[0].pending_delete_group_id).toBe("acme_team");
    expect(rows[0].content_sha256).toBe(""); // no longer a live projection
  });

  it("drops the ledger row outright when Graphiti isn't configured (nothing to retry)", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "slack/c0priv/1.md", project: "slack", kind: "transcript", access: "team", body: "secret" });
    await seedEpisode(seed.teamId, item.id);
    const client = { configured: false } as unknown as GraphitiClient;

    await purgeItemsByPathPrefix(db(), seed.teamId, "slack/c0priv/", "private", { client });

    expect(await episodeRows(seed.teamId)).toHaveLength(0); // no tombstone left "pending" forever
  });

  it("treats '_' in a prefix as a literal, not a LIKE wildcard", async () => {
    // `_` matches ANY single character in LIKE, and `safeSegment` keeps `_` in paths — so an
    // unescaped prefix silently widens the purge onto a neighbouring source. Deleting MORE than
    // asked is the one failure here with no recovery.
    const seed = await seedTeam();
    await ingest(seed, { path: "slack/a_b/1.md", project: "slack", kind: "transcript", access: "team", body: "target" });
    await ingest(seed, { path: "slack/axb/1.md", project: "slack", kind: "transcript", access: "team", body: "bystander" });

    const res = await purgeItemsByPathPrefix(db(), seed.teamId, "slack/a_b/", "test");

    expect(res.items).toBe(1);
    const { data: survivors } = await db().from("items").select("path").eq("team_id", seed.teamId);
    expect((survivors ?? []).map((r) => (r as { path: string }).path)).toEqual(["slack/axb/1.md"]);
  });

  it("refuses a prefix that doesn't end in '/' (it would catch sibling channels)", async () => {
    const seed = await seedTeam();
    await expect(purgeItemsByPathPrefix(db(), seed.teamId, "slack/c0pri", "test")).rejects.toThrow(/must end in/);
  });

  it("is a no-op when nothing matches", async () => {
    const seed = await seedTeam();
    expect(await purgeItemsByPathPrefix(db(), seed.teamId, "slack/nothing/", "test")).toEqual({ items: 0, episodes: 0 });
  });

  it("audits the removal with its reason and scope", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "slack/c0gone/1.md", project: "slack", kind: "transcript", access: "team", body: "x" });
    await purgeItemsByPathPrefix(db(), seed.teamId, "slack/c0gone/", "slack channel is private");
    const { data } = await db().from("audit_log").select("action, meta").eq("team_id", seed.teamId);
    const row = (data ?? []).find((r) => (r as { action: string }).action === "items.purged") as
      | { meta: Record<string, unknown> }
      | undefined;
    expect(row?.meta?.reason).toBe("slack channel is private");
    expect(row?.meta?.items).toBe(1);
  });
});
