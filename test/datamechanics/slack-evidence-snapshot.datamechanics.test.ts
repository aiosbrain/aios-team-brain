import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { runSql } from "@/lib/db/pg/pool";
import { readSlackEvidenceSnapshot } from "@/lib/ingest/slack-evidence-snapshot";
import { ingest, seedTeam, type Seed } from "./helpers";

const SINCE = new Date("2024-06-20T00:00:00Z");
const AS_OF = new Date("2024-06-21T00:00:00Z");
const HASH = "a".repeat(64);

async function item(team: Seed, name: string): Promise<string> {
  return (await ingest(team, {
    path: `slack/TEVIDENCE/CEVIDENCE/${name}.md`, body: name, access: "team",
    frontmatter: { source: "slack" },
  })).id;
}

async function message(input: {
  teamId: string; itemId: string; ts: string; rootTs?: string;
  deleted?: boolean; eligible?: boolean;
}): Promise<void> {
  await runSql(
    `insert into slack_messages
       (team_id,item_id,workspace_id,channel_id,message_ts,root_ts,author_external_id,
        occurred_at,is_root,eligible,exclusion_reason,deleted_at,source_hash)
     values ($1,$2,'TEVIDENCE','CEVIDENCE',$3,$4,'U1',
             to_timestamp(split_part($3,'.',1)::bigint) +
               split_part($3,'.',2)::integer * interval '1 microsecond',
             $3=$4,$5,case when $5 then null else 'bot_message' end,
             case when $6 then now() else null end,$7)`,
    [input.teamId, input.itemId, input.ts, input.rootTs ?? input.ts,
      input.eligible ?? true, input.deleted ?? false, HASH]
  );
}

function request(teamId: string, itemIds: readonly string[] | ReadonlySet<string>) {
  return { teamId, itemIds, since: new Date(SINCE), asOf: new Date(AS_OF) };
}

describe("inactive Slack evidence snapshot on real Postgres", () => {
  it("holds messages, mappings and generations on one view across a committed write between components", async () => {
    const team = await seedTeam();
    const target = await item(team, "concurrent");
    const first = "1718900000.000001";
    const second = "1718900000.000002";
    await message({ teamId: team.teamId, itemId: target, ts: first });
    await runSql(
      `insert into member_identities(team_id,member_id,provider,external_id)
       values($1,$2,'slack','TEVIDENCE:U1')`, [team.teamId, team.memberId]
    );
    await runSql(
      `insert into slack_team_state(team_id,data_generation,identity_generation)
       values($1,2,3)`, [team.teamId]
    );

    let crossed = false;
    const bounds = request(team.teamId, [target]);
    const snapshot = await readSlackEvidenceSnapshot(bounds, {
      creditPageSize: 1, messagePageSize: 1,
      afterPage: async (part, page) => {
        if (part !== "creditInputs" || page !== 0) return;
        crossed = true;
        bounds.since.setUTCFullYear(2025);
        // One committed statement changes all three later-readable components.
        await runSql(
          `with new_message as (
             insert into slack_messages
               (team_id,item_id,workspace_id,channel_id,message_ts,root_ts,
                author_external_id,occurred_at,is_root,eligible,source_hash)
             values($1,$2,'TEVIDENCE','CEVIDENCE',$3,$4,'U1',
                    '2024-06-20T16:13:20.000002Z',false,true,$5)
             returning id
           ), new_mapping as (
             insert into member_identities(team_id,member_id,provider,external_id)
             values($1,$6,'slack','TEVIDENCE:U2') returning id
           )
           update slack_team_state set data_generation=4,identity_generation=5
            where team_id=$1 and (select count(*) from new_message)=1
              and (select count(*) from new_mapping)=1`,
          [team.teamId, target, second, first, HASH, team.memberId]
        );
      },
    });
    expect(crossed).toBe(true);
    expect(snapshot.teamId).toBe(team.teamId);
    expect(snapshot.ledgers).toMatchObject([{ status: "present", authors: [{ messageTs: first }] }]);
    expect(snapshot.messages.map((row) => row.messageTs)).toEqual([first]);
    expect(snapshot.mappings.map((row) => row.externalId)).toEqual(["TEVIDENCE:U1"]);
    expect(snapshot.generations).toMatchObject({ dataGeneration: "2", identityGeneration: "3" });

    const fresh = await readSlackEvidenceSnapshot(request(team.teamId, new Set([target])));
    expect(fresh.messages.map((row) => row.messageTs)).toEqual([first, second]);
    expect(fresh.ledgers[0]).toMatchObject({ status: "present", authors: [
      { messageTs: first }, { messageTs: second },
    ] });
    expect(fresh.mappings.map((row) => row.externalId).sort()).toEqual([
      "TEVIDENCE:U1", "TEVIDENCE:U2",
    ]);
    expect(fresh.generations).toMatchObject({ dataGeneration: "4", identityGeneration: "5" });
  });

  it("keeps the validated team binding when the caller mutates its request between components", async () => {
    const team = await seedTeam();
    const other = await seedTeam();
    const target = await item(team, "mutable-team");
    const ts = "1718900000.000001";
    await message({ teamId: team.teamId, itemId: target, ts });
    const input = request(team.teamId, [target]);
    const snapshot = await readSlackEvidenceSnapshot(input, {
      afterPage: async (part) => {
        if (part === "creditInputs") input.teamId = other.teamId;
      },
    });
    expect(snapshot.teamId).toBe(team.teamId);
    expect(snapshot.ledgers[0].status).toBe("present");
    expect(snapshot.messages.map((row) => row.messageTs)).toEqual([ts]);
  });

  it("applies team, item, eligibility, deletion and inclusive UTC window bounds before paging", async () => {
    const team = await seedTeam();
    const other = await seedTeam();
    const target = await item(team, "scope-target");
    const hidden = await item(team, "scope-hidden");
    const foreign = await item(other, "scope-foreign");
    const root = "1718841600.000000";
    for (const ts of ["1718841599.999999", root, "1718900000.000001",
      "1718928000.000000", "1718928000.000001"]) {
      await message({ teamId: team.teamId, itemId: target, ts, rootTs: root });
    }
    await message({ teamId: team.teamId, itemId: target,
      ts: "1718900000.000002", rootTs: root, deleted: true });
    await message({ teamId: team.teamId, itemId: target,
      ts: "1718900000.000003", rootTs: root, eligible: false });
    await message({ teamId: team.teamId, itemId: hidden, ts: "1718900000.000004" });
    await message({ teamId: other.teamId, itemId: foreign, ts: "1718900000.000005" });

    const snapshot = await readSlackEvidenceSnapshot(request(team.teamId, [target, foreign, target]), {
      creditPageSize: 2, messagePageSize: 1,
    });
    expect(snapshot.ledgers.map((row) => [row.itemId, row.status])).toEqual([
      [target, "present"], [foreign, "absent"],
    ]);
    expect(snapshot.messages.map((row) => row.messageTs)).toEqual([
      root, "1718900000.000001", "1718928000.000000",
    ]);
    expect(snapshot.messages.every((row) => row.itemId === target)).toBe(true);
  });

  it("propagates failed credit and visible-message pages without returning a partial snapshot", async () => {
    const team = await seedTeam();
    const target = await item(team, "failure");
    const root = "1718900000.000001";
    await message({ teamId: team.teamId, itemId: target, ts: root });
    await message({ teamId: team.teamId, itemId: target,
      ts: "1718900000.000002", rootTs: root });
    for (const part of ["creditMessages", "visibleMessages"] as const) {
      let failedAfter = 0;
      await expect(readSlackEvidenceSnapshot(request(team.teamId, [target]), {
        creditPageSize: 1, messagePageSize: 1,
        afterPage: async (current, page, query) => {
          if (current === part && page === 1) {
            failedAfter++;
            await query("select * from aio_1170_missing_evidence_page");
          }
        },
      })).rejects.toThrow();
      expect(failedAfter).toBe(1);
    }
    await expect(readSlackEvidenceSnapshot(request(team.teamId, [target]), {
      afterPage: async (part) => {
        if (part === "creditInputs") throw new Error("between components");
      },
    })).rejects.toThrow("between components");
    await expect(readSlackEvidenceSnapshot(request(team.teamId, [target]), {
      afterPage: async (part, _page, query) => {
        if (part === "creditInputs") {
          await query("update slack_messages set eligible=true where team_id=$1", [team.teamId]);
        }
      },
    })).rejects.toMatchObject({ code: "25006" });
    const fresh = await readSlackEvidenceSnapshot(request(team.teamId, [target]));
    expect(fresh.messages).toHaveLength(2);
  });

  it("returns zero ledgers and messages but still reads mappings, roster and generations for no IDs", async () => {
    const team = await seedTeam();
    await runSql(
      `insert into member_identities(team_id,member_id,provider,external_id)
       values($1,$2,'slack','TEVIDENCE:U1')`, [team.teamId, team.memberId]
    );
    await runSql(
      `insert into slack_team_state(team_id,data_generation,identity_generation,presentation_generation)
       values($1,7,8,9)`, [team.teamId]
    );
    const snapshot = await readSlackEvidenceSnapshot(request(team.teamId.toUpperCase(), []));
    expect(snapshot.teamId).toBe(team.teamId);
    expect(snapshot.ledgers).toEqual([]);
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.mappings.map((row) => row.externalId)).toEqual(["TEVIDENCE:U1"]);
    expect(snapshot.humanMemberIds).toEqual(new Set([team.memberId]));
    expect(snapshot.generations).toEqual({ dataGeneration: "7", identityGeneration: "8",
      presentationGeneration: "9" });
  });

  it("rejects invalid request bounds", async () => {
    const team = await seedTeam();
    const valid = request(team.teamId, []);
    for (const input of [
      { ...valid, teamId: "bad" },
      { ...valid, itemIds: ["bad"] },
      { ...valid, itemIds: Array.from({ length: 513 }, randomUUID) },
      { ...valid, since: new Date("invalid") },
      { ...valid, since: new Date("2024-06-22T00:00:00Z") },
    ]) await expect(readSlackEvidenceSnapshot(input)).rejects.toThrow();
    await expect(readSlackEvidenceSnapshot(valid, { creditPageSize: 0 })).rejects.toThrow();
    await expect(readSlackEvidenceSnapshot(valid, { messagePageSize: 513 })).rejects.toThrow();
  });
});
