import { describe, expect, it } from "vitest";

import { runSql } from "@/lib/db/pg/pool";
import { ITEM_LIMIT } from "@/lib/dashboard/work-timeline";
import { readVisibleSlackMessages } from "@/lib/ingest/slack-message-read";
import { projectSlackPersonDays } from "@/lib/ingest/slack-person-day";
import { ingest, seedTeam } from "./helpers";

const SINCE = new Date("2024-06-20T00:00:00.000Z");
const AS_OF = new Date("2024-06-21T00:00:00.000Z");
const HASH = "a".repeat(64);

async function item(seed: Awaited<ReturnType<typeof seedTeam>>, name: string): Promise<string> {
  return (await ingest(seed, {
    path: `slack/TREAD/CREAD/${name}.md`, body: name, access: "team",
    frontmatter: { source: "slack" },
  })).id;
}

async function insertMessage(input: {
  teamId: string; itemId: string; workspace?: string; channel?: string;
  ts: string; at: string; rootTs?: string; author?: string | null;
  eligible?: boolean; reason?: string | null; deleted?: boolean;
}): Promise<void> {
  const eligible = input.eligible ?? true;
  await runSql(
    `insert into slack_messages
      (team_id,item_id,workspace_id,channel_id,message_ts,root_ts,author_external_id,
       occurred_at,is_root,eligible,exclusion_reason,deleted_at,source_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$5=$6,$9,$10,
             case when $11::boolean then now() else null end,$12)`,
    [input.teamId, input.itemId, input.workspace ?? "TREAD", input.channel ?? "CREAD",
      input.ts, input.rootTs ?? input.ts, input.author === undefined ? "U1" : input.author,
      input.at, eligible, input.reason ?? null, input.deleted ?? false, HASH]
  );
}

async function insertFlood(teamId: string, itemId: string, workspace: string, firstSecond: number, count: number): Promise<void> {
  await runSql(
    `insert into slack_messages
      (team_id,item_id,workspace_id,channel_id,message_ts,root_ts,author_external_id,
       occurred_at,is_root,eligible,source_hash)
     select $1::uuid,$2::uuid,$3::text,'CFLOOD',
            (v.second::text || '.000001'),(v.second::text || '.000001'),
            'U1',to_timestamp(v.second) + interval '1 microsecond',true,true,$4
       from generate_series($5::bigint,$5::bigint + $6::bigint - 1) as v(second)`,
    [teamId, itemId, workspace, HASH, firstSecond, count]
  );
}

describe("inactive visible Slack message read on real Postgres", () => {
  it("projects a long-running thread's recent replies on their actual UTC days through the reader", async () => {
    const seed = await seedTeam();
    const visible = await item(seed, "long-thread-projection");
    const root = "1700000000.000001";
    await insertMessage({ teamId: seed.teamId, itemId: visible, ts: root,
      at: "2023-11-14T22:13:20.000001Z", workspace: "TLONG", channel: "CLONG", author: "UROOT" });
    const replies = [
      ["1718841599.999999", "2024-06-19T23:59:59.999999Z", "U1"],
      ["1718841600.000001", "2024-06-20T00:00:00.000001Z", "U1"],
      ["1718841600.000002", "2024-06-20T00:00:00.000002Z", "U2"],
      ["1727740800.000001", "2024-10-01T00:00:00.000001Z", "U2"],
      ["1727740800.000002", "2024-10-01T00:00:00.000002Z", "UUNKNOWN"],
    ] as const;
    for (const [ts, at, author] of replies) await insertMessage({ teamId: seed.teamId,
      itemId: visible, ts, at, rootTs: root, workspace: "TLONG", channel: "CLONG", author });
    await runSql("update items set synced_at = $2::timestamptz where id = $1::uuid", [
      visible, "2023-11-15T00:00:00Z",
    ]);
    const rows = await readVisibleSlackMessages({ teamId: seed.teamId,
      since: new Date("2024-06-19T00:00:00Z"), asOf: new Date("2024-10-02T00:00:00Z"),
      visibleItemIds: new Set([visible]) }, { pageSize: 2 });
    expect(rows).toHaveLength(5);
    const seen: string[] = [];
    const projected = projectSlackPersonDays(rows, (qualified) => {
      seen.push(qualified);
      return qualified === "TLONG:U1" || qualified === "TLONG:U2" ? "member-one" : null;
    });
    expect(seen).toEqual(["TLONG:U1", "TLONG:U1", "TLONG:U2", "TLONG:U2", "TLONG:UUNKNOWN"]);
    expect(projected.map((row) => [row.day, row.messageCount, row.at, row.rootAuthored])).toEqual([
      ["2024-10-01", 1, "2024-10-01T00:00:00.000001Z", false],
      ["2024-06-20", 2, "2024-06-20T00:00:00.000002Z", false],
      ["2024-06-19", 1, "2024-06-19T23:59:59.999999Z", false],
    ]);
    expect(projected.every((row) => row.sourceItemId === visible && row.rootTs === root &&
      row.workspaceId === "TLONG" && row.channelId === "CLONG")).toBe(true);
  });

  it("removes deleted-root authorship without removing live mapped replies", async () => {
    const seed = await seedTeam();
    const visible = await item(seed, "deleted-root-projection");
    const root = "1718841599.999999";
    await insertMessage({ teamId: seed.teamId, itemId: visible, ts: root,
      at: "2024-06-19T23:59:59.999999Z", author: "UROOT" });
    await insertMessage({ teamId: seed.teamId, itemId: visible, ts: "1718841600.000001",
      rootTs: root, at: "2024-06-20T00:00:00.000001Z", author: "U1" });
    await insertMessage({ teamId: seed.teamId, itemId: visible, ts: "1718841600.000002",
      rootTs: root, at: "2024-06-20T00:00:00.000002Z", author: "UAMBIG" });
    const window = { teamId: seed.teamId,
      since: new Date("2024-06-19T00:00:00Z"), asOf: new Date("2024-06-21T00:00:00Z"),
      visibleItemIds: new Set([visible]) };
    const resolve = (qualified: string) => qualified === "TREAD:U1" ? "member-one" :
      qualified === "TREAD:UROOT" ? "member-root" : null;
    const before = projectSlackPersonDays(await readVisibleSlackMessages(window), resolve);
    expect(before).toHaveLength(2);
    expect(before[0]).toMatchObject({ day: "2024-06-20", messageCount: 1, rootAuthored: false });
    expect(before[1]).toMatchObject({ day: "2024-06-19", messageCount: 1, rootAuthored: true,
      memberId: "member-root" });
    await runSql("update slack_messages set deleted_at = now() where team_id = $1 and message_ts = $2", [
      seed.teamId, root,
    ]);
    const after = projectSlackPersonDays(await readVisibleSlackMessages(window), resolve);
    expect(after).toEqual(before.slice(0, 1));
    expect(after[0].messages).toEqual([{ messageTs: "1718841600.000001",
      occurredAt: "2024-06-20T00:00:00.000001Z" }]);
  });

  it("does not let more than ITEM_LIMIT old or invisible messages starve an unchanged old thread's recent reply", async () => {
    const seed = await seedTeam();
    const visible = await item(seed, "old-root");
    const invisible = await item(seed, "hidden");
    await insertFlood(seed.teamId, visible, "TOLD", 1700000000, ITEM_LIMIT + 9);
    await insertFlood(seed.teamId, invisible, "THIDDEN", 1718900000, ITEM_LIMIT + 9);
    // The canonical item has not been re-synced into the requested window. The reply is still work.
    await runSql("update items set synced_at = $2::timestamptz where id = $1::uuid", [
      visible, "2023-11-15T00:00:00Z",
    ]);
    await insertMessage({ teamId: seed.teamId, itemId: visible, ts: "1718900000.123456",
      rootTs: "1700000000.000001", at: "2024-06-20T16:13:20.123456Z", workspace: "TOLD", channel: "CFLOOD" });
    const rows = await readVisibleSlackMessages({ teamId: seed.teamId, since: SINCE, asOf: AS_OF,
      visibleItemIds: new Set([visible]) }, { pageSize: 7 });
    expect(rows).toMatchObject([{ itemId: visible, messageTs: "1718900000.123456",
      occurredAt: "2024-06-20T16:13:20.123456Z", isRoot: false,
      workspaceId: "TOLD", channelId: "CFLOOD", rootTs: "1700000000.000001" }]);
  });

  it("exhausts multiple pages on one UTC day, including equal instants, exactly once", async () => {
    const seed = await seedTeam();
    const a = await item(seed, "a");
    const b = await item(seed, "b");
    const base = 1718900000;
    await insertFlood(seed.teamId, a, "TPAGE", base, 45);
    await insertMessage({ teamId: seed.teamId, itemId: b, workspace: "TOTHER", channel: "COTHER",
      ts: `${base}.000001`, at: "2024-06-20T16:13:20.000001Z", author: "U2" });
    const rows = await readVisibleSlackMessages({ teamId: seed.teamId, since: SINCE, asOf: AS_OF,
      visibleItemIds: new Set([a, b]) }, { pageSize: 5 });
    expect(rows).toHaveLength(46);
    expect(new Set(rows.map((r) => `${r.itemId}:${r.messageTs}`)).size).toBe(46);
    expect(rows.filter((r) => r.occurredAt === "2024-06-20T16:13:20.000001Z")).toHaveLength(2);
    expect(rows.every((r) => r.occurredAt.startsWith("2024-06-20"))).toBe(true);
    expect(rows.map((r) => r.occurredAt)).toEqual([...rows.map((r) => r.occurredAt)].sort());
    expect(rows.find((r) => r.itemId === b)?.authorExternalId).toBe("U2");
  });

  it("traverses equal item, instant and message timestamp across workspace/channel scopes with pageSize 1", async () => {
    const seed = await seedTeam();
    const visible = await item(seed, "scope-collision");
    const ts = "1718900000.123456";
    const at = "2024-06-20T16:13:20.123456Z";
    for (const [workspace, channel] of [["TA", "CA"], ["TA", "CB"], ["TB", "CA"], ["TB", "CB"]]) {
      await insertMessage({ teamId: seed.teamId, itemId: visible, ts, at, workspace, channel });
    }
    const rows = await readVisibleSlackMessages({ teamId: seed.teamId, since: SINCE, asOf: AS_OF,
      visibleItemIds: new Set([visible]) }, { pageSize: 1 });
    expect(rows.map((r) => [r.workspaceId, r.channelId])).toEqual([
      ["TA", "CA"], ["TA", "CB"], ["TB", "CA"], ["TB", "CB"],
    ]);
    expect(rows.every((r) => r.messageTs === ts && r.occurredAt === at)).toBe(true);
  });

  it("keeps one committed snapshot when an atomic publication straddles the cursor between pages", async () => {
    const seed = await seedTeam();
    const visible = await item(seed, "snapshot");
    await insertMessage({ teamId: seed.teamId, itemId: visible, ts: "1718900000.000002",
      at: "2024-06-20T16:13:20.000002Z" });
    await insertMessage({ teamId: seed.teamId, itemId: visible, ts: "1718900000.000004",
      at: "2024-06-20T16:13:20.000004Z" });
    let mutations = 0;
    const rows = await readVisibleSlackMessages({ teamId: seed.teamId, since: SINCE, asOf: AS_OF,
      visibleItemIds: new Set([visible]) }, { pageSize: 1, afterPage: async (pageNumber) => {
      if (pageNumber !== 1) return;
      // One statement commits both rows. READ COMMITTED pagination would skip .000001 yet
      // include .000003, a combination that never existed in a committed database state.
      await runSql(
        `insert into slack_messages
          (team_id,item_id,workspace_id,channel_id,message_ts,root_ts,author_external_id,
           occurred_at,is_root,eligible,source_hash)
         values ($1,$2,'TREAD','CREAD','1718900000.000001','1718900000.000001','U1',
                 '2024-06-20T16:13:20.000001Z'::timestamptz,true,true,$3),
                ($1,$2,'TREAD','CREAD','1718900000.000003','1718900000.000003','U1',
                 '2024-06-20T16:13:20.000003Z'::timestamptz,true,true,$3)`,
        [seed.teamId, visible, HASH]
      );
      mutations++;
    } });
    expect(mutations).toBe(1);
    expect(rows.map((r) => r.messageTs)).toEqual(["1718900000.000002", "1718900000.000004"]);
    const stored = await runSql<{ message_ts: string }>(
      "select message_ts from slack_messages where team_id = $1 and item_id = $2 order by message_ts",
      [seed.teamId, visible]
    );
    expect(stored.rows.map((r) => r.message_ts)).toEqual([
      "1718900000.000001", "1718900000.000002", "1718900000.000003", "1718900000.000004",
    ]);
  });

  it("includes both rolling-window edges and excludes deleted, ineligible, future and other-team rows", async () => {
    const seed = await seedTeam();
    const other = await seedTeam();
    const visible = await item(seed, "edges");
    const otherItem = await item(other, "other-team");
    const cases = [
      ["1718841599.999999", "2024-06-19T23:59:59.999999Z"],
      ["1718841600.000000", "2024-06-20T00:00:00.000000Z"],
      ["1718928000.000000", "2024-06-21T00:00:00.000000Z"],
      ["1718928000.000001", "2024-06-21T00:00:00.000001Z"],
    ] as const;
    for (const [ts, at] of cases) await insertMessage({ teamId: seed.teamId, itemId: visible, ts, at });
    await insertMessage({ teamId: seed.teamId, itemId: visible, ts: "1718900000.000001",
      at: "2024-06-20T16:13:20.000001Z", deleted: true });
    await insertMessage({ teamId: seed.teamId, itemId: visible, ts: "1718900000.000002",
      at: "2024-06-20T16:13:20.000002Z", eligible: false, reason: "bot_message" });
    await insertMessage({ teamId: other.teamId, itemId: otherItem, ts: "1718900000.000003",
      at: "2024-06-20T16:13:20.000003Z" });
    const rows = await readVisibleSlackMessages({ teamId: seed.teamId, since: SINCE, asOf: AS_OF,
      visibleItemIds: new Set([visible, otherItem]) }, { pageSize: 1 });
    expect(rows.map((r) => r.messageTs)).toEqual([cases[1][0], cases[2][0]]);
  });

  it("rejects a SQL failure after a real first page instead of returning partial rows", async () => {
    const seed = await seedTeam(); const visible = await item(seed, "failure");
    await insertFlood(seed.teamId, visible, "TFAIL", 1718900000, 4);
    let pages = 0;
    await expect(readVisibleSlackMessages({ teamId: seed.teamId, since: SINCE, asOf: AS_OF,
      visibleItemIds: new Set([visible]) }, { pageSize: 2, afterPage: async (pageNumber, query) => {
      pages = pageNumber;
      if (pageNumber === 1) await query("select * from aio_1170_missing_read_relation");
    } })).rejects.toThrow();
    expect(pages).toBe(1);
  });
});
