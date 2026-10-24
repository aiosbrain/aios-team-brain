import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPool, runSql } from "@/lib/db/pg/pool";
import { db, ingest, seedTeam } from "./helpers";

/**
 * AIO-1170 — historical Slack name-to-channel-ID migration replay, against real Postgres.
 *
 * `postgres/migrations/` is replayed in full at every schema load. This old migration predates
 * workspace-qualified paths, so its candidate predicate is a data-safety boundary: a scoped item
 * is already canonical state, not a legacy item whose third segment may be treated as a root ts.
 * The frontmatter channel id is deliberately lower-case on the scoped fixture to prove that case
 * normalization cannot turn it back into a migration candidate.
 */

const MIGRATION = readFileSync(
  join(import.meta.dirname, "..", "..", "postgres", "migrations", "20260725180000_slack_paths_by_channel_id.sql"),
  "utf8"
);

async function versions(itemId: string): Promise<{ id: string; body: string }[]> {
  const { rows } = await runSql<{ id: string; body: string }>(
    "select id, body from item_versions where item_id = $1 order by id",
    [itemId]
  );
  return rows;
}

async function item(id: string): Promise<{ id: string; path: string; body: string } | null> {
  const { rows } = await runSql<{ id: string; path: string; body: string }>(
    "select id, path, body from items where id = $1",
    [id]
  );
  return rows[0] ?? null;
}

async function evidence(itemId: string, messageTs: string): Promise<void> {
  await runSql(
    `insert into slack_messages
       (team_id, workspace_id, channel_id, message_ts, root_ts, item_id, author_external_id,
        occurred_at, is_root, eligible, exclusion_reason, source_hash)
     select team_id, 'T0COLLIDE', 'C0COLLIDE', $2, $2, id, 'U0COLLIDE',
            '2024-06-20T00:00:00Z', true, true, null, repeat('a', 64)
       from items where id = $1`,
    [itemId, messageTs]
  );
}

async function collisionError(): Promise<{ code?: string; message: string } | null> {
  // The migration owns an explicit BEGIN. Its fail-closed exception leaves that transaction aborted,
  // so roll it back on the same pooled client before releasing it; otherwise a later assertion could
  // accidentally read a poisoned connection instead of proving the database state survived.
  const client = await getPool().connect();
  try {
    await client.query(MIGRATION);
    return null;
  } catch (error) {
    await client.query("rollback");
    const e = error as { code?: string; message: string };
    return { code: e.code, message: e.message };
  } finally {
    client.release();
  }
}

describe("Slack path migration replay (real Postgres)", () => {
  it("migrates only genuine legacy paths and preserves every scoped item's identity, content, and history", async () => {
    const seed = await seedTeam();
    const legacy = await ingest(seed, {
      path: "slack/general/1718900000.000100.md",
      project: "slack",
      kind: "transcript",
      access: "team",
      body: "legacy original",
      frontmatter: { source: "slack", channel_id: "C0LEGACY" },
    });
    await ingest(seed, {
      path: "slack/general/1718900000.000100.md",
      project: "slack",
      kind: "transcript",
      access: "team",
      body: "legacy revised",
      frontmatter: { source: "slack", channel_id: "C0LEGACY" },
    });

    const scoped = await ingest(seed, {
      path: "slack/T0WORKSPACE/C0SCOPED/1718900000.000200.md",
      project: "slack",
      kind: "transcript",
      access: "team",
      body: "scoped original",
      // A case mismatch is expected to be irrelevant: path shape, not frontmatter, decides legacy.
      frontmatter: { source: "slack", workspace_id: "T0WORKSPACE", channel_id: "c0scoped" },
    });
    const malformed = await ingest(seed, {
      path: "slack/general/not-a-slack-root.md",
      project: "slack",
      kind: "transcript",
      access: "team",
      body: "malformed legacy-looking path",
      frontmatter: { source: "slack", channel_id: "C0MALFORMED" },
    });
    await ingest(seed, {
      path: "slack/T0WORKSPACE/C0SCOPED/1718900000.000200.md",
      project: "slack",
      kind: "transcript",
      access: "team",
      body: "scoped revised",
      frontmatter: { source: "slack", workspace_id: "T0WORKSPACE", channel_id: "c0scoped" },
    });

    const scopedVersions = await versions(scoped.id);
    const legacyVersions = await versions(legacy.id);
    // Record the database's real ledger shape, including any ingest-owned bootstrap version. The
    // migration contract is preservation, so this exact snapshot—not a fixture reimplementation of
    // ingest history—is what must survive.
    expect(scopedVersions).toHaveLength(2);
    expect(legacyVersions).toHaveLength(2);

    await runSql(MIGRATION);

    // The genuine original shape moves IN PLACE: no re-ingest, no replacement item, no lost ledger.
    expect(await item(legacy.id)).toEqual({
      id: legacy.id,
      path: "slack/c0legacy/1718900000.000100.md",
      body: "legacy revised",
    });
    expect(await versions(legacy.id)).toEqual(legacyVersions);

    // Four segments are already workspace-qualified canonical state. Replaying old SQL must leave
    // its path, id, current content, and retained versions exactly intact.
    expect(await item(scoped.id)).toEqual({
      id: scoped.id,
      path: "slack/T0WORKSPACE/C0SCOPED/1718900000.000200.md",
      body: "scoped revised",
    });
    expect(await versions(scoped.id)).toEqual(scopedVersions);
    expect(await item(malformed.id)).toEqual({
      id: malformed.id,
      path: "slack/general/not-a-slack-root.md",
      body: "malformed legacy-looking path",
    });

    // A schema load executes the complete historical directory again. The second invocation also
    // proves the temporary replay view is cleaned up on a pooled connection.
    await runSql(MIGRATION);
    expect(await item(legacy.id)).toEqual({
      id: legacy.id,
      path: "slack/c0legacy/1718900000.000100.md",
      body: "legacy revised",
    });
    expect(await item(scoped.id)).toEqual({
      id: scoped.id,
      path: "slack/T0WORKSPACE/C0SCOPED/1718900000.000200.md",
      body: "scoped revised",
    });

    const { data: all } = await db().from("items").select("id").eq("team_id", seed.teamId);
    expect((all ?? []).map((row) => (row as { id: string }).id).sort()).toEqual([legacy.id, scoped.id, malformed.id].sort());
    expect(await versions(legacy.id)).toEqual(legacyVersions);
    expect(await versions(scoped.id)).toEqual(scopedVersions);
  });

  it("fails closed on an occupied ID-keyed target and rolls back without deleting either history", async () => {
    const seed = await seedTeam();
    const legacy = await ingest(seed, {
      path: "slack/general/1718900000.000300.md",
      project: "slack",
      kind: "transcript",
      access: "team",
      body: "legacy collision original",
      frontmatter: { source: "slack", channel_id: "C0COLLIDE" },
    });
    await ingest(seed, {
      path: "slack/general/1718900000.000300.md",
      project: "slack",
      kind: "transcript",
      access: "team",
      body: "legacy collision revised",
      frontmatter: { source: "slack", channel_id: "C0COLLIDE" },
    });
    const target = await ingest(seed, {
      path: "slack/c0collide/1718900000.000300.md",
      project: "slack",
      kind: "transcript",
      access: "team",
      body: "existing ID-keyed original",
      frontmatter: { source: "slack", channel_id: "C0COLLIDE" },
    });
    await ingest(seed, {
      path: "slack/c0collide/1718900000.000300.md",
      project: "slack",
      kind: "transcript",
      access: "team",
      body: "existing ID-keyed revised",
      frontmatter: { source: "slack", channel_id: "C0COLLIDE" },
    });
    await evidence(legacy.id, "1718900000.000300");
    await evidence(target.id, "1718900000.000301");
    await db().from("graph_episodes").insert([
      { team_id: seed.teamId, source_table: "items", source_id: legacy.id, group_id: "collision_legacy", content_sha256: "b".repeat(64) },
      { team_id: seed.teamId, source_table: "items", source_id: target.id, group_id: "collision_target", content_sha256: "c".repeat(64) },
    ]);

    const legacyBefore = await item(legacy.id);
    const targetBefore = await item(target.id);
    const legacyVersions = await versions(legacy.id);
    const targetVersions = await versions(target.id);
    const { rows: evidenceBefore } = await runSql(
      "select item_id, message_ts, source_hash from slack_messages where item_id = any($1::uuid[]) order by item_id, message_ts",
      [[legacy.id, target.id]]
    );
    const { rows: episodesBefore } = await runSql(
      "select source_id, group_id, content_sha256 from graph_episodes where source_id = any($1::uuid[]) order by source_id, group_id",
      [[legacy.id, target.id]]
    );

    expect(await collisionError()).toEqual({
      code: "P0001",
      message: "slack path migration collision: operator resolution required before replay",
    });
    expect(await item(legacy.id)).toEqual(legacyBefore);
    expect(await item(target.id)).toEqual(targetBefore);
    expect(await versions(legacy.id)).toEqual(legacyVersions);
    expect(await versions(target.id)).toEqual(targetVersions);
    expect(
      (await runSql("select item_id, message_ts, source_hash from slack_messages where item_id = any($1::uuid[]) order by item_id, message_ts", [[legacy.id, target.id]])).rows
    ).toEqual(evidenceBefore);
    expect(
      (await runSql("select source_id, group_id, content_sha256 from graph_episodes where source_id = any($1::uuid[]) order by source_id, group_id", [[legacy.id, target.id]])).rows
    ).toEqual(episodesBefore);
  });
});
