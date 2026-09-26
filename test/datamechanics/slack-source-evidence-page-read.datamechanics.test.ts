import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { runSql } from "@/lib/db/pg/pool";
import { readSlackSourceEvidencePage } from "@/lib/ingest/slack-source-evidence-page-read";
import { ingest, seedTeam, type Seed } from "./helpers";

const HASH = "a".repeat(64);
const SINCE = new Date("2024-06-20T00:00:00Z");
const AS_OF = new Date("2024-06-21T00:00:00Z");

async function item(team: Seed, name: string): Promise<string> {
  return (await ingest(team, {
    path: `slack/TPAGE/CPAGE/${name}.md`, body: name, access: "team",
    frontmatter: { source: "slack" },
  })).id;
}

async function message(teamId: string, itemId: string, ts: string,
  rootTs = ts): Promise<void> {
  await runSql(
    `insert into slack_messages
       (team_id,item_id,workspace_id,channel_id,message_ts,root_ts,author_external_id,
        occurred_at,is_root,eligible,source_hash)
     values ($1,$2::uuid,'TPAGE','CPAGE' || replace(($2::uuid)::text,'-',''),$3,$4,'U1',
             to_timestamp(split_part($3,'.',1)::bigint) +
               split_part($3,'.',2)::integer * interval '1 microsecond',
             $3=$4,true,$5)`,
    [teamId, itemId, ts, rootTs, HASH]
  );
}

function request(teamId: string, visibleItemIds: Set<string>, pageSize = 2) {
  return { teamId, visibleItemIds, since: new Date(SINCE), asOf: new Date(AS_OF), pageSize };
}

describe("inactive Slack source and evidence page on real Postgres", () => {
  it("holds discovery, messages, identities and generations on one snapshot across committed writes", async () => {
    const team = await seedTeam();
    const target = await item(team, "concurrent-target");
    const newlyActive = await item(team, "concurrent-new");
    const first = "1718900000.000001";
    const second = "1718900000.000002";
    await message(team.teamId, target, first);
    await runSql(
      `insert into member_identities(team_id,member_id,provider,external_id)
       values($1,$2,'slack','TPAGE:U1')`, [team.teamId, team.memberId]
    );
    await runSql(
      `insert into slack_team_state(team_id,data_generation,identity_generation)
       values($1,2,3)`, [team.teamId]
    );
    const input = request(team.teamId, new Set([target, newlyActive]), 1);
    const page = await readSlackSourceEvidencePage(input, {
      afterDiscovery: async (query) => {
        expect((await query<{ transaction_isolation: string }>(
          "show transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
        expect((await query<{ transaction_read_only: string }>(
          "show transaction_read_only")).rows[0].transaction_read_only).toBe("on");
        input.teamId = randomUUID();
        input.visibleItemIds.clear();
        input.since.setUTCFullYear(2025);
        input.asOf.setUTCFullYear(2025);
        input.pageSize = 512;
        // This separate committed statement advances both source discovery and later evidence.
        await runSql(
          `with new_messages as (
             insert into slack_messages
               (team_id,item_id,workspace_id,channel_id,message_ts,root_ts,
                author_external_id,occurred_at,is_root,eligible,source_hash)
             values ($1,$2::uuid,'TPAGE','CPAGE' || replace(($2::uuid)::text,'-',''),$4,$5,'U1',
                     '2024-06-20T16:13:20.000002Z',false,true,$6),
                    ($1,$3::uuid,'TPAGE','CPAGE' || replace(($3::uuid)::text,'-',''),$7,$7,'U1',
                     '2024-06-20T16:13:20.000003Z',true,true,$6)
             returning id
           ), new_mapping as (
             insert into member_identities(team_id,member_id,provider,external_id)
             values ($1,$8,'slack','TPAGE:U2') returning id
           )
           update slack_team_state set data_generation=4,identity_generation=5
            where team_id=$1 and (select count(*) from new_messages)=2
              and (select count(*) from new_mapping)=1`,
          [team.teamId, target, newlyActive, second, first, HASH,
            "1718900000.000003", team.memberId]
        );
      },
    });
    expect(page.itemIds).toEqual([target]);
    expect(page.hasMore).toBe(false);
    expect(page.evidence.teamId).toBe(team.teamId);
    expect(page.evidence.ledgers).toMatchObject([{
      itemId: target, status: "present", authors: [{ messageTs: first }],
    }]);
    expect(page.evidence.messages.map((row) => row.messageTs)).toEqual([first]);
    expect(page.evidence.mappings.map((row) => row.externalId)).toEqual(["TPAGE:U1"]);
    expect(page.evidence.generations).toMatchObject({
      dataGeneration: "2", identityGeneration: "3",
    });
    const fresh = await readSlackSourceEvidencePage(request(team.teamId,
      new Set([target, newlyActive]), 1));
    expect(fresh.itemIds).toEqual([newlyActive]);
    expect(fresh.hasMore).toBe(true);
    expect(fresh.evidence.generations).toMatchObject({
      dataGeneration: "4", identityGeneration: "5",
    });
  });

  it("traverses equal-time item tuples exactly once with evidence limited to each page", async () => {
    const team = await seedTeam();
    const ids: string[] = [];
    for (let n = 0; n < 7; n++) ids.push(await item(team, `tie-${n}`));
    for (const id of ids) await message(team.teamId, id, "1718900000.123456");
    let cursor: { occurredAt: string; itemId: string } | undefined;
    const seen: string[] = [];
    for (;;) {
      const page = await readSlackSourceEvidencePage({
        ...request(team.teamId, new Set(ids), 2), cursor,
      });
      expect(page.itemIds.length).toBeLessThanOrEqual(2);
      expect(page.evidence.ledgers.map((row) => row.itemId)).toEqual(page.itemIds);
      expect(new Set(page.evidence.messages.map((row) => row.itemId))).toEqual(
        new Set(page.itemIds));
      seen.push(...page.itemIds);
      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      expect(page.nextCursor?.occurredAt).toBe("2024-06-20T16:13:20.123456Z");
      cursor = page.nextCursor ?? undefined;
    }
    expect(seen).toEqual([...ids].sort().reverse());
  });

  it("accepts over 512 authorized IDs while each source and evidence page stays bounded", async () => {
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
    for (let n = 0; n < 3; n++) await message(team.teamId, ids[n],
      `1718900000.00000${n + 1}`);
    const page = await readSlackSourceEvidencePage(request(team.teamId,
      new Set(ids), 2));
    expect(page.itemIds).toEqual([ids[2], ids[1]]);
    expect(page.hasMore).toBe(true);
    expect(page.evidence.ledgers.map((row) => row.itemId)).toEqual(page.itemIds);
    expect(page.evidence.messages.map((row) => row.itemId).sort()).toEqual(
      [...page.itemIds].sort());
  });

  it("reads mappings, roster and generations even when the source page is empty", async () => {
    const team = await seedTeam();
    const target = await item(team, "empty");
    await runSql(
      `insert into member_identities(team_id,member_id,provider,external_id)
       values($1,$2,'slack','TPAGE:U1')`, [team.teamId, team.memberId]
    );
    await runSql(
      `insert into slack_team_state(team_id,data_generation,identity_generation)
       values($1,7,8)`, [team.teamId]
    );
    const page = await readSlackSourceEvidencePage(request(team.teamId.toUpperCase(),
      new Set([target])));
    expect(page).toMatchObject({ itemIds: [], hasMore: false, nextCursor: null });
    expect(page.evidence.teamId).toBe(team.teamId);
    expect(page.evidence.ledgers).toEqual([]);
    expect(page.evidence.messages).toEqual([]);
    expect(page.evidence.mappings.map((row) => row.externalId)).toEqual(["TPAGE:U1"]);
    expect(page.evidence.humanMemberIds).toEqual(new Set([team.memberId]));
    expect(page.evidence.generations).toMatchObject({
      dataGeneration: "7", identityGeneration: "8",
    });
  });

  it("rejects invalid bounds, failed pages and attempted writes without an empty fallback", async () => {
    const team = await seedTeam();
    const target = await item(team, "failures");
    const root = "1718900000.000001";
    await message(team.teamId, target, root);
    await message(team.teamId, target, "1718900000.000002", root);
    const valid = request(team.teamId, new Set([target]), 1);
    for (const invalid of [
      { ...valid, visibleItemIds: [target] as unknown as Set<string> },
      { ...valid, pageSize: 513 },
      { ...valid, since: new Date("invalid") },
    ]) await expect(readSlackSourceEvidencePage(invalid)).rejects.toThrow();
    await expect(readSlackSourceEvidencePage(valid, {
      creditPageSize: 513,
    })).rejects.toThrow();
    await expect(readSlackSourceEvidencePage(valid, {
      messagePageSize: 0,
    })).rejects.toThrow();
    await expect(readSlackSourceEvidencePage(valid, {
      afterDiscovery: async (query) => {
        await query("select * from aio_1170_missing_page_source");
      },
    })).rejects.toThrow();
    await expect(readSlackSourceEvidencePage(valid, {
      creditPageSize: 1,
      afterPage: async (part, page, query) => {
        if (part === "creditMessages" && page === 1) {
          await query("select * from aio_1170_missing_page_credit");
        }
      },
    })).rejects.toThrow();
    await expect(readSlackSourceEvidencePage(valid, {
      messagePageSize: 1,
      afterPage: async (part, page, query) => {
        if (part === "visibleMessages" && page === 1) {
          await query("select * from aio_1170_missing_page_messages");
        }
      },
    })).rejects.toThrow();
    await expect(readSlackSourceEvidencePage(valid, {
      afterDiscovery: async (query) => {
        await query("update items set body='forbidden' where id=$1", [target]);
      },
    })).rejects.toMatchObject({ code: "25006" });
  });
});
