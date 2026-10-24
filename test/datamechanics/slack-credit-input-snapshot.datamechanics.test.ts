import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { runSql } from "@/lib/db/pg/pool";
import { readSlackCreditInputSnapshot } from "@/lib/ingest/slack-credit-input-snapshot";
import { readSlackItemCreditLedger } from "@/lib/ingest/slack-item-credit-ledger-read";
import { ingest, seedTeam, type Seed } from "./helpers";

const HASH = "a".repeat(64);

async function item(team: Seed, name: string): Promise<string> {
  return (await ingest(team, {
    path: `slack/TSNAPSHOT/CSNAPSHOT/${name}.md`, body: name, access: "team",
    frontmatter: { source: "slack" },
  })).id;
}

async function message(teamId: string, itemId: string, ts: string): Promise<void> {
  await runSql(
    `insert into slack_messages
       (team_id,item_id,workspace_id,channel_id,message_ts,root_ts,author_external_id,
        occurred_at,is_root,eligible,source_hash)
     values ($1,$2,'TSNAPSHOT','CSNAPSHOT',$3,'1718900000.000001','U1',
             '2024-06-20T16:13:20Z'::timestamptz +
               split_part($3,'.',2)::integer * interval '1 microsecond',
             ($3='1718900000.000001'),true,$4)`,
    [teamId, itemId, ts, HASH]
  );
}

async function identity(teamId: string, memberId: string, provider: string, externalId: string): Promise<string> {
  const { rows } = await runSql<{ id: string }>(
    `insert into member_identities (team_id,member_id,provider,external_id,handle,email)
     values ($1,$2,$3,$4,'private-handle','private@example.test') returning id`,
    [teamId, memberId, provider, externalId]
  );
  return rows[0].id;
}

async function member(teamId: string, kind: "human" | "agent" | "offroster", connector = false): Promise<string> {
  const key = randomUUID();
  const { rows } = await runSql<{ id: string }>(
    `insert into members (team_id,email,display_name,actor_handle,status,kind,is_connector)
     values ($1,$2,'Private Person',$3,'active',$4,$5) returning id`,
    [teamId, `${key}@test.local`, `actor-${key}`, kind, connector]
  );
  return rows[0].id;
}

describe("inactive atomic Slack credit input snapshot on real Postgres", () => {
  it("exhausts message, identity and human pages; preserves variants and excludes other teams/nonhumans", async () => {
    const team = await seedTeam();
    const other = await seedTeam();
    const target = await item(team, "paged");
    const absent = await item(team, "absent");
    const otherItem = await item(other, "other");
    for (const n of [1, 2, 3]) await message(team.teamId, target, `1718900000.${String(n).padStart(6, "0")}`);
    await message(other.teamId, otherItem, "1718900000.000001");
    const human2 = await member(team.teamId, "human");
    const human3 = await member(team.teamId, "human");
    const connector = await member(team.teamId, "human", true);
    const agent = await member(team.teamId, "agent");
    await member(team.teamId, "offroster");
    await identity(team.teamId, team.memberId, "slack", "TSNAPSHOT:U1");
    await identity(team.teamId, human2, " Slack ", "TSNAPSHOT:U2");
    await identity(team.teamId, connector, "\u00a0SlAcK\u00a0", "U3");
    await identity(team.teamId, agent, "slack", "U4");
    await identity(team.teamId, human3, "linear", "U5");
    await identity(other.teamId, other.memberId, "slack", "UOTHER");
    await runSql(
      `insert into slack_team_state(team_id,data_generation,identity_generation,presentation_generation)
       values ($1,7,11,13),($2,99,99,99)`, [team.teamId, other.teamId]
    );

    const result = await readSlackCreditInputSnapshot(team.teamId, [target, absent, otherItem], { pageSize: 2 });
    expect(result.teamId).toBe(team.teamId);
    expect(result.ledgers).toEqual(await readSlackItemCreditLedger(team.teamId, [target, absent, otherItem],
      { pageSize: 2 }));
    expect(result.ledgers[0].status).toBe("present");
    if (result.ledgers[0].status !== "present") throw new Error("expected present ledger");
    expect(result.ledgers[0].authors.map((author) => author.messageTs)).toEqual([
      "1718900000.000001", "1718900000.000002", "1718900000.000003",
    ]);
    expect(result.ledgers[0].authors.every((author) => author.rawUserId === "U1")).toBe(true);
    expect(result.ledgers[1]).toEqual({ itemId: absent, status: "absent" });
    expect(result.ledgers[2]).toEqual({ itemId: otherItem, status: "absent" });
    expect(result.mappings).toHaveLength(4);
    expect(result.mappings).toEqual(expect.arrayContaining([
      { teamId: team.teamId, memberId: human2, provider: " Slack ", externalId: "TSNAPSHOT:U2", state: "live" },
      { teamId: team.teamId, memberId: connector, provider: "\u00a0SlAcK\u00a0", externalId: "U3", state: "live" },
    ]));
    expect(result.humanMemberIds).toEqual(new Set([team.memberId, human2, human3]));
    expect(result.generations).toEqual({ dataGeneration: "7", identityGeneration: "11",
      presentationGeneration: "13" });
    const upper = await readSlackCreditInputSnapshot(team.teamId.toUpperCase(), [target]);
    expect(upper.teamId).toBe(team.teamId);
    expect(upper.mappings.every((row) => row.teamId === upper.teamId)).toBe(true);
    expect(upper.ledgers[0].status).toBe("present");
    expect(JSON.stringify(result)).not.toMatch(/private-handle|private@example|UOTHER|token|email/i);
  });

  it("has no identity or human total cap beyond page size", async () => {
    const team = await seedTeam();
    await runSql(
      `insert into members(team_id,email,display_name,actor_handle,status)
       select $1::uuid, 'bulk-' || n || '-' || $2 || '@test.local', 'Private Person',
              'bulk-' || n || '-' || $2, 'active' from generate_series(1, 515) n`,
      [team.teamId, randomUUID()]
    );
    await runSql(
      `insert into member_identities(team_id,member_id,provider,external_id)
       select $1::uuid,id,'slack','U' || replace(id::text,'-','') from members
        where team_id=$1::uuid`, [team.teamId]
    );
    const result = await readSlackCreditInputSnapshot(team.teamId, [], { pageSize: 37 });
    expect(result.teamId).toBe(team.teamId);
    expect(result.ledgers).toEqual([]);
    expect(result.mappings).toHaveLength(516);
    expect(result.humanMemberIds.size).toBe(516);
    expect(result.generations).toEqual({ dataGeneration: "0", identityGeneration: "0",
      presentationGeneration: "0" });
  });

  it("reads identities, members and generations from the first message page's view", async () => {
    const team = await seedTeam();
    const target = await item(team, "concurrent-message");
    await message(team.teamId, target, "1718900000.000001");
    await message(team.teamId, target, "1718900000.000003");
    await identity(team.teamId, team.memberId, "slack", "TSNAPSHOT:U1");
    let changed = false;
    const result = await readSlackCreditInputSnapshot(team.teamId, [target], {
      pageSize: 1,
      afterPage: async (part, page) => {
        if (part !== "messages" || page !== 1) return;
        changed = true;
        await message(team.teamId, target, "1718900000.000002");
        await identity(team.teamId, team.memberId, "slack", "TSNAPSHOT:U2");
        await member(team.teamId, "human");
        await runSql(`insert into slack_team_state(team_id,data_generation) values($1,4)`, [team.teamId]);
      },
    });
    expect(changed).toBe(true);
    expect(result.ledgers[0]).toMatchObject({ status: "present", authors: [
      { messageTs: "1718900000.000001" }, { messageTs: "1718900000.000003" },
    ] });
    expect(result.mappings.map((row) => row.externalId)).toEqual(["TSNAPSHOT:U1"]);
    expect(result.humanMemberIds).toEqual(new Set([team.memberId]));
    expect(result.generations.dataGeneration).toBe("0");
    const next = await readSlackCreditInputSnapshot(team.teamId, [target]);
    expect(next.mappings).toHaveLength(2);
    expect(next.humanMemberIds.size).toBe(2);
    expect(next.generations.dataGeneration).toBe("4");
  });

  it("keeps later identity pages, roster and generations on one view across identity changes", async () => {
    const team = await seedTeam();
    await identity(team.teamId, team.memberId, "slack", "UA");
    await identity(team.teamId, team.memberId, "slack", "UB");
    let changed = false;
    const result = await readSlackCreditInputSnapshot(team.teamId, [], {
      pageSize: 1,
      afterPage: async (part, page) => {
        if (part !== "identities" || page !== 1) return;
        changed = true;
        await runSql(`delete from member_identities where team_id=$1 and external_id='UB'`, [team.teamId]);
        await identity(team.teamId, team.memberId, "slack", "UC");
        await member(team.teamId, "human");
        await runSql(`insert into slack_team_state(team_id,identity_generation) values($1,5)`, [team.teamId]);
      },
    });
    expect(changed).toBe(true);
    expect(result.mappings.map((row) => row.externalId).sort()).toEqual(["UA", "UB"]);
    expect(result.humanMemberIds).toEqual(new Set([team.memberId]));
    expect(result.generations.identityGeneration).toBe("0");
  });

  it("rejects bad bounds, any later-page failure, and writes inside the read-only transaction", async () => {
    const team = await seedTeam();
    const target = await item(team, "failure");
    await message(team.teamId, target, "1718900000.000001");
    await message(team.teamId, target, "1718900000.000002");
    await identity(team.teamId, team.memberId, "slack", "UA");
    await identity(team.teamId, team.memberId, "slack", "UB");
    await member(team.teamId, "human");
    for (const [badTeam, ids, pageSize] of [["bad", [target], 1],
      [team.teamId, ["bad"], 1], [team.teamId, [target], 0],
      [team.teamId, Array.from({ length: 513 }, randomUUID), 1]] as const) {
      await expect(readSlackCreditInputSnapshot(badTeam, ids, { pageSize })).rejects.toThrow();
    }
    for (const part of ["messages", "identities", "members"] as const) {
      await expect(readSlackCreditInputSnapshot(team.teamId, [target], {
        pageSize: 1,
        afterPage: async (current, page, query) => {
          if (current === part && page === 1) await query("select * from aio_1170_missing_snapshot_page");
        },
      })).rejects.toThrow();
    }
    await expect(readSlackCreditInputSnapshot(team.teamId, [target], {
      pageSize: 1,
      afterPage: async (part, page, query) => {
        if (part === "messages" && page === 1) {
          await query("update slack_team_state set data_generation=9 where team_id=$1", [team.teamId]);
        }
      },
    })).rejects.toMatchObject({ code: "25006" });
    const fresh = await readSlackCreditInputSnapshot(team.teamId, [target]);
    expect(fresh.ledgers[0].status).toBe("present");
  });
});
