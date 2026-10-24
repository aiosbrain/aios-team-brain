import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { runSql } from "@/lib/db/pg/pool";
import { readSlackItemCreditLedger } from "@/lib/ingest/slack-item-credit-ledger-read";
import { ingest, seedTeam } from "./helpers";

const HASH = "a".repeat(64);

async function item(team: Awaited<ReturnType<typeof seedTeam>>, name: string): Promise<string> {
  return (await ingest(team, {
    path: `slack/TCREDIT/CCREDIT/${name}.md`, body: name, access: "team",
    frontmatter: { source: "slack" },
  })).id;
}

async function message(input: {
  teamId: string; itemId: string; ts: string; rootTs?: string; at?: string | null;
  workspace?: string; channel?: string; author?: string | null;
  eligible?: boolean; reason?: string | null; deleted?: boolean;
}): Promise<void> {
  const eligible = input.eligible ?? true;
  await runSql(
    `insert into slack_messages
       (team_id,item_id,workspace_id,channel_id,message_ts,root_ts,author_external_id,
        occurred_at,is_root,eligible,exclusion_reason,deleted_at,source_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,($5=$6),$9,$10,
             case when $11::boolean then now() else null end,$12)`,
    [input.teamId, input.itemId, input.workspace ?? "TCREDIT", input.channel ?? "CCREDIT",
      input.ts, input.rootTs ?? input.ts, input.author === undefined ? "U1" : input.author,
      input.at ?? null,
      eligible, input.reason ?? null, input.deleted ?? false, HASH]
  );
}

describe("inactive Slack item credit ledger reader on real Postgres", () => {
  it("distinguishes absence from deleted, excluded and authorless present rows", async () => {
    const team = await seedTeam();
    const absent = await item(team, "absent");
    const deleted = await item(team, "deleted");
    const excluded = await item(team, "excluded");
    const authorless = await item(team, "authorless");
    const mixed = await item(team, "mixed");
    await message({ teamId: team.teamId, itemId: deleted, ts: "1718900000.000001",
      at: "2024-06-20T16:13:20.000001Z", deleted: true });
    await message({ teamId: team.teamId, itemId: excluded, ts: "1718900000.000002",
      at: "2024-06-20T16:13:20.000002Z", eligible: false, reason: "bot_message" });
    await message({ teamId: team.teamId, itemId: authorless, ts: "1718900000.000003",
      at: "2024-06-20T16:13:20.000003Z", author: null, eligible: false, reason: "no_author" });
    await message({ teamId: team.teamId, itemId: mixed, ts: "1718900000.000004",
      at: "2024-06-20T16:13:20.000004Z", author: null, eligible: false, reason: "no_author" });
    await message({ teamId: team.teamId, itemId: mixed, ts: "1718900000.000005",
      rootTs: "1718900000.000004", at: "2024-06-20T16:13:20.000005Z", author: "U5" });

    const result = await readSlackItemCreditLedger(team.teamId,
      [absent, deleted, excluded, authorless, mixed], { pageSize: 2 });
    expect(result.slice(0, 4)).toEqual([
      { itemId: absent, status: "absent" },
      { itemId: deleted, status: "present", authors: [] },
      { itemId: excluded, status: "present", authors: [] },
      { itemId: authorless, status: "present", authors: [] },
    ]);
    expect(result[4]).toEqual({ itemId: mixed, status: "present", authors: [{
      workspaceId: "TCREDIT", channelId: "CCREDIT", messageTs: "1718900000.000005",
      rootTs: "1718900000.000004", rawUserId: "U5",
      occurredAt: "2024-06-20T16:13:20.000005Z", isRoot: false,
    }] });
  });

  it("keeps only requested items in the requested team and deduplicates IDs", async () => {
    const team = await seedTeam();
    const other = await seedTeam();
    const requested = await item(team, "requested");
    const hidden = await item(team, "not-requested");
    const otherItem = await item(other, "other-team");
    for (const [teamId, itemId, ts] of [[team.teamId, requested, "1718900000.000001"],
      [team.teamId, hidden, "1718900000.000002"],
      [other.teamId, otherItem, "1718900000.000001"]]) {
      await message({ teamId, itemId, ts,
        at: `2024-06-20T16:13:20.${ts.split(".")[1]}Z` });
    }
    const result = await readSlackItemCreditLedger(team.teamId,
      [requested, otherItem, requested.toUpperCase()]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ itemId: requested, status: "present" });
    expect(result[1]).toEqual({ itemId: otherItem, status: "absent" });
    expect(JSON.stringify(result)).not.toContain(hidden);
  });

  it("exhausts more than a default page within one thread and orders tied instants", async () => {
    const team = await seedTeam();
    const target = await item(team, "many-ties");
    await runSql(
      `insert into slack_messages
         (team_id,item_id,workspace_id,channel_id,message_ts,root_ts,
          author_external_id,occurred_at,is_root,eligible,source_hash)
       select $1::uuid,$2::uuid,'TCREDIT','CCREDIT',
              '1718900000.' || case n when 1 then '1' when 2 then '100000'
                                       else lpad(n::text, 6, '0') end,
              '1718900000.000003','U1',
              '2024-06-20T16:13:20Z'::timestamptz +
                (case when n <= 2 then 100000 else n end) * interval '1 microsecond',
              (n = 3),true,$3
         from generate_series(1, 519) n`,
      [team.teamId, target, HASH]
    );
    const result = await readSlackItemCreditLedger(team.teamId, new Set([target]));
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("present");
    if (result[0].status !== "present") throw new Error("expected present ledger");
    expect(result[0].authors).toHaveLength(519);
    expect(result[0].authors.map((row) => row.messageTs).slice(0, 2))
      .toEqual(["1718900000.000003", "1718900000.000004"]);
    expect(result[0].authors.map((row) => row.messageTs).slice(-2))
      .toEqual(["1718900000.1", "1718900000.100000"]);
    expect(new Set(result[0].authors.map((row) => row.messageTs)).size).toBe(519);
    expect(new Set(result[0].authors.map((row) =>
      `${row.workspaceId}:${row.channelId}:${row.rootTs}`))).toEqual(
      new Set(["TCREDIT:CCREDIT:1718900000.000003"])
    );
  });

  it("keeps one repeatable-read snapshot across a concurrent insert", async () => {
    const team = await seedTeam();
    const target = await item(team, "snapshot");
    for (const ts of ["1718900000.000001", "1718900000.000003"]) {
      await message({ teamId: team.teamId, itemId: target, ts,
        rootTs: "1718900000.000001",
        at: `2024-06-20T16:13:20.${ts.split(".")[1]}Z` });
    }
    let inserts = 0;
    const result = await readSlackItemCreditLedger(team.teamId, [target], {
      pageSize: 1, afterPage: async (pageNumber) => {
        if (pageNumber !== 1) return;
        await message({ teamId: team.teamId, itemId: target, ts: "1718900000.000002",
          rootTs: "1718900000.000001",
          at: "2024-06-20T16:13:20.000002Z" });
        inserts++;
      },
    });
    expect(inserts).toBe(1);
    expect(result[0].status).toBe("present");
    if (result[0].status !== "present") throw new Error("expected present ledger");
    expect(result[0].authors.map((row) => row.messageTs))
      .toEqual(["1718900000.000001", "1718900000.000003"]);
    const next = await readSlackItemCreditLedger(team.teamId, [target]);
    if (next[0].status !== "present") throw new Error("expected present ledger");
    expect(next[0].authors.map((row) => row.messageTs))
      .toEqual(["1718900000.000001", "1718900000.000002", "1718900000.000003"]);
  });

  it("rejects an eligible instant that disagrees with its source timestamp", async () => {
    const team = await seedTeam();
    const target = await item(team, "mismatched-instant");
    // The table checks nullability but cannot prove this source timestamp equality on its own.
    await message({ teamId: team.teamId, itemId: target, ts: "1718900000.000001",
      at: "2024-06-20T16:13:20.000002Z" });
    await expect(readSlackItemCreditLedger(team.teamId, [target]))
      .rejects.toThrow("invalid eligible source identity or instant");
  });

  it.each([
    ["workspace", "TOTHER", "CCREDIT", "1718900000.000001"],
    ["channel", "TCREDIT", "COTHER", "1718900000.000001"],
    ["root", "TCREDIT", "CCREDIT", "1718900000.000002"],
  ])("rejects an item bound to another %s even when the conflicting row is deleted", async (
    _dimension, workspace, channel, rootTs
  ) => {
    const team = await seedTeam();
    const target = await item(team, `conflicting-${_dimension}`);
    await message({ teamId: team.teamId, itemId: target, ts: "1718900000.000001",
      at: "2024-06-20T16:13:20.000001Z" });
    await message({ teamId: team.teamId, itemId: target, ts: "1718900000.000002",
      rootTs, workspace, channel, at: "2024-06-20T16:13:20.000002Z", deleted: true });
    await expect(readSlackItemCreditLedger(team.teamId, [target], { pageSize: 1 }))
      .rejects.toThrow("item spans multiple source threads");
  });

  it("rejects malformed eligible raw account IDs", async () => {
    const team = await seedTeam();
    const target = await item(team, "malformed-author");
    await message({ teamId: team.teamId, itemId: target, ts: "1718900000.000001",
      at: "2024-06-20T16:13:20.000001Z", author: "u1" });
    await expect(readSlackItemCreditLedger(team.teamId, [target]))
      .rejects.toThrow("invalid eligible source identity or instant");
  });

  it("rejects invalid input, a failed later page, and writes in the read-only transaction", async () => {
    const team = await seedTeam();
    const target = await item(team, "failure");
    for (const ts of ["1718900000.000001", "1718900000.000002"]) {
      await message({ teamId: team.teamId, itemId: target, ts,
        rootTs: "1718900000.000001",
        at: `2024-06-20T16:13:20.${ts.split(".")[1]}Z` });
    }
    await expect(readSlackItemCreditLedger("bad", [target])).rejects.toThrow("invalid team ID");
    await expect(readSlackItemCreditLedger(team.teamId, ["bad"])).rejects.toThrow("invalid item ID");
    await expect(readSlackItemCreditLedger(team.teamId, Array.from({ length: 513 }, randomUUID)))
      .rejects.toThrow("too many item IDs");
    for (const pageSize of [0, 1.5, 513, Number.NaN, null]) {
      await expect(readSlackItemCreditLedger(team.teamId, [target], { pageSize: pageSize as number }))
        .rejects.toThrow("invalid page size");
    }
    let pages = 0;
    await expect(readSlackItemCreditLedger(team.teamId, [target], {
      pageSize: 1, afterPage: async (pageNumber, query) => {
        pages = pageNumber;
        await query("select * from aio_1170_missing_credit_page");
      },
    })).rejects.toThrow();
    expect(pages).toBe(1);
    await expect(readSlackItemCreditLedger(team.teamId, [target], {
      pageSize: 1, afterPage: async (_pageNumber, query) => {
        await query("update slack_messages set deleted_at = now() where team_id = $1", [team.teamId]);
      },
    })).rejects.toMatchObject({ code: "25006" });
    const rows = await runSql<{ count: string }>(
      "select count(*)::text as count from slack_messages where team_id = $1 and deleted_at is null",
      [team.teamId]
    );
    expect(rows.rows[0].count).toBe("2");
  });
});
