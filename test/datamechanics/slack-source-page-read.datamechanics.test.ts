import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { runSql } from "@/lib/db/pg/pool";
import { readSlackSourcePage, type SlackSourcePageRequest } from "@/lib/ingest/slack-source-page-read";
import { ingest, seedTeam, type Seed } from "./helpers";

const SINCE = new Date("2024-06-20T00:00:00Z");
const AS_OF = new Date("2024-06-21T00:00:00Z");
const HASH = "a".repeat(64);

async function item(team: Seed, name: string, source = "slack"): Promise<string> {
  return (await ingest(team, {
    path: `slack/TSOURCE/CSOURCE/${name}.md`, body: name, access: "team",
    frontmatter: { source },
  })).id;
}

async function message(teamId: string, itemId: string, ts: string, options: {
  rootTs?: string; channel?: string; eligible?: boolean; deleted?: boolean;
} = {}): Promise<void> {
  await runSql(
    `insert into slack_messages
       (team_id,item_id,workspace_id,channel_id,message_ts,root_ts,author_external_id,
        occurred_at,is_root,eligible,exclusion_reason,deleted_at,source_hash)
     values ($1,$2,'TSOURCE',$3,$4,$5,'U1',
             to_timestamp(split_part($4,'.',1)::bigint) +
               split_part($4,'.',2)::integer * interval '1 microsecond',
             $4=$5,$6,case when $6 then null else 'bot_message' end,
             case when $7 then now() else null end,$8)`,
    [teamId, itemId, options.channel ?? `C${itemId.slice(0, 8)}`, ts,
      options.rootTs ?? ts, options.eligible ?? true, options.deleted ?? false, HASH]
  );
}

function request(teamId: string, visibleItemIds: Set<string>, pageSize = 2): SlackSourcePageRequest {
  return { teamId, visibleItemIds, since: new Date(SINCE), asOf: new Date(AS_OF), pageSize };
}

describe("inactive Slack source keyset page on real Postgres", () => {
  it("finds a recent reply under an old unchanged root", async () => {
    const team = await seedTeam();
    const target = await item(team, "old-root-reply");
    const root = "1718755200.000000";
    await message(team.teamId, target, root);
    await message(team.teamId, target, "1718900000.123456", { rootTs: root });
    await runSql(
      `update items set work_at='2024-06-19',synced_at='2024-06-19'
        where id=$1`, [target]
    );
    expect(await readSlackSourcePage(request(team.teamId, new Set([target])))).toEqual({
      itemIds: [target], hasMore: false, nextCursor: null,
    });
  });

  it("holds one read-only repeatable-read page against caller mutation", async () => {
    const team = await seedTeam();
    const target = await item(team, "fixed-input");
    await message(team.teamId, target, "1718900000.123456");
    const input = request(team.teamId, new Set([target]), 1);
    const page = await readSlackSourcePage(input, {
      beforeRead: async (query) => {
        const isolation = await query<{ transaction_isolation: string }>("show transaction_isolation");
        const readOnly = await query<{ transaction_read_only: string }>("show transaction_read_only");
        expect(isolation.rows[0].transaction_isolation).toBe("repeatable read");
        expect(readOnly.rows[0].transaction_read_only).toBe("on");
        input.teamId = randomUUID();
        (input.visibleItemIds as Set<string>).clear();
        input.since.setUTCFullYear(2025);
        input.asOf.setUTCFullYear(2025);
        input.pageSize = 512;
      },
    });
    expect(page).toEqual({ itemIds: [target], hasMore: false, nextCursor: null });
  });

  it("filters an invisible recent storm before LIMIT", async () => {
    const team = await seedTeam();
    const visible = await item(team, "visible-oldest");
    const hiddenBase = await item(team, "hidden-template");
    await message(team.teamId, visible, "1718900000.000001");
    const hidden = await runSql<{ id: string }>(
      `insert into items
        (team_id,project_id,path,kind,access,frontmatter,body,content_sha256)
       select i.team_id,i.project_id,i.path || '-hidden-' || n,i.kind,i.access,
              i.frontmatter,i.body,i.content_sha256
         from items i cross join generate_series(1,30) n where i.id=$1
       returning id`, [hiddenBase]
    );
    await runSql(
      `insert into slack_messages
        (team_id,item_id,workspace_id,channel_id,message_ts,root_ts,author_external_id,
         occurred_at,is_root,eligible,source_hash)
       select $1,id,'TSOURCE','C' || left(id::text,8),
              (1718900100 + row_number() over (order by id))::text || '.000001',
              (1718900100 + row_number() over (order by id))::text || '.000001',
              'U1',to_timestamp(1718900100 + row_number() over (order by id)) +
              interval '1 microsecond',true,true,$2
         from items where id=any($3::uuid[])`,
      [team.teamId, HASH, hidden.rows.map((row) => row.id)]
    );
    const page = await readSlackSourcePage(request(team.teamId, new Set([visible]), 1));
    expect(page).toEqual({ itemIds: [visible], hasMore: false, nextCursor: null });
  });

  it("paginates equal microsecond instants by descending UUID exactly once to exhaustion", async () => {
    const team = await seedTeam();
    const ids: string[] = [];
    for (let n = 0; n < 7; n++) ids.push(await item(team, `tie-${n}`));
    for (const id of ids) await message(team.teamId, id, "1718900000.123456");
    const input = request(team.teamId, new Set(ids), 2);
    const seen: string[] = [];
    let cursor: SlackSourcePageRequest["cursor"];
    for (;;) {
      const page = await readSlackSourcePage({ ...input, cursor });
      expect(page.itemIds.length).toBeLessThanOrEqual(2);
      seen.push(...page.itemIds);
      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      expect(page.nextCursor?.occurredAt).toBe("2024-06-20T16:13:20.123456Z");
      cursor = page.nextCursor ?? undefined;
    }
    expect(seen).toEqual([...ids].sort().reverse());
    expect((await readSlackSourcePage({ ...input, cursor: {
      occurredAt: "2024-06-20T16:13:20.123456Z", itemId: seen.at(-1)!,
    } })).itemIds).toEqual([]);
  });

  it("excludes other teams, non-Slack items, outside-window, deleted and ineligible rows", async () => {
    const team = await seedTeam();
    const other = await seedTeam();
    const valid = await item(team, "boundary-valid");
    const nonSlack = await item(team, "source-other", "github");
    const old = await item(team, "out-of-window");
    const deleted = await item(team, "deleted");
    const ineligible = await item(team, "ineligible");
    const foreign = await item(other, "foreign-team");
    await message(team.teamId, valid, "1718841600.000000");
    await message(team.teamId, valid, "1718928000.000000", { rootTs: "1718841600.000000" });
    await message(team.teamId, nonSlack, "1718900000.000001");
    await message(team.teamId, old, "1718841599.999999");
    await message(team.teamId, deleted, "1718900000.000002", { deleted: true });
    await message(team.teamId, ineligible, "1718900000.000003", { eligible: false });
    await message(other.teamId, foreign, "1718900000.000004");
    const page = await readSlackSourcePage(request(team.teamId,
      new Set([valid, nonSlack, old, deleted, ineligible, foreign]), 1));
    expect(page).toEqual({ itemIds: [valid], hasMore: false, nextCursor: null });
  });

  it("validates every bound and rejects failed or attempted writing reads", async () => {
    const team = await seedTeam();
    const target = await item(team, "validation");
    const valid = request(team.teamId, new Set([target]));
    for (const invalid of [
      { ...valid, teamId: "wrong" },
      { ...valid, visibleItemIds: new Set(["wrong"]) },
      { ...valid, visibleItemIds: [target] as unknown as Set<string> },
      { ...valid, since: new Date("invalid") },
      { ...valid, since: new Date("2024-06-22") },
      { ...valid, pageSize: 0 },
      { ...valid, pageSize: 513 },
      { ...valid, pageSize: 1.5 },
      { ...valid, cursor: { occurredAt: "2024-06-20T16:13:20.123Z", itemId: target } },
      { ...valid, cursor: { occurredAt: "2024-06-20T16:13:20.123456Z", itemId: randomUUID() } },
    ]) await expect(readSlackSourcePage(invalid)).rejects.toThrow();
    await expect(readSlackSourcePage(valid, {
      beforeRead: async (query) => { await query("select * from aio_1170_missing_source_page"); },
    })).rejects.toThrow();
    await expect(readSlackSourcePage(valid, {
      beforeRead: async (query) => {
        await query("update items set body='forbidden' where id=$1", [target]);
      },
    })).rejects.toMatchObject({ code: "25006" });
    expect((await readSlackSourcePage(valid)).itemIds).toEqual([]);
  });

  it("accepts more than 512 authorized IDs while bounding each output page", async () => {
    const team = await seedTeam();
    const template = await item(team, "bulk-template");
    const bulk = await runSql<{ id: string }>(
      `insert into items
        (team_id,project_id,path,kind,access,frontmatter,body,content_sha256)
       select i.team_id,i.project_id,i.path || '-bulk-' || n,i.kind,i.access,
              i.frontmatter,i.body,i.content_sha256
         from items i cross join generate_series(1,513) n where i.id=$1
       returning id`, [template]
    );
    const ids = bulk.rows.map((row) => row.id);
    expect(ids).toHaveLength(513);
    await message(team.teamId, ids[0], "1718900000.000001");
    await message(team.teamId, ids[1], "1718900000.000002");
    const input = request(team.teamId, new Set(ids), 1);
    const first = await readSlackSourcePage(input);
    expect(first.itemIds).toEqual([ids[1]]);
    expect(first.hasMore).toBe(true);
    const second = await readSlackSourcePage({ ...input, cursor: first.nextCursor! });
    expect(second).toEqual({ itemIds: [ids[0]], hasMore: false, nextCursor: null });
  });
});
