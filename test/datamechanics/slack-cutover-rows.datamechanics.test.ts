import { describe, expect, it } from "vitest";

import { runSql } from "@/lib/db/pg/pool";
import { readSlackCutoverIdentityRows } from "@/lib/identity/slack-cutover-rows";
import { seedTeam } from "./helpers";

// Exactly the ECMAScript trim set implemented by the database guard's provider classifier.
const trimCodePoints = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  0xfeff,
];

async function insertIdentity(teamId: string, memberId: string, provider: string, externalId: string) {
  const { rows } = await runSql<{ id: string }>(
    `insert into member_identities (team_id, member_id, provider, external_id, handle, email)
     values ($1, $2, $3, $4, 'private-handle', 'private@example.test') returning id`,
    [teamId, memberId, provider, externalId]
  );
  return rows[0].id;
}

describe("inactive Slack cutover row snapshot on real Postgres", () => {
  it("isolates the team and every DB-recognized provider spelling while retaining stored values", async () => {
    const team = await seedTeam();
    const other = await seedTeam();
    const expected = [
      { id: await insertIdentity(team.teamId, team.memberId, "slack", "URAW"),
        teamId: team.teamId, provider: "slack", memberId: team.memberId, externalId: "URAW" },
      { id: await insertIdentity(team.teamId, team.memberId, "slack", "tMixed:uMixed"),
        teamId: team.teamId, provider: "slack", memberId: team.memberId, externalId: "tMixed:uMixed" },
      { id: await insertIdentity(team.teamId, team.memberId, " Slack ", "TQUAL:UONE"),
        teamId: team.teamId, provider: " Slack ", memberId: team.memberId, externalId: "TQUAL:UONE" },
    ];
    for (const [index, codePoint] of trimCodePoints.entries()) {
      const whitespace = String.fromCodePoint(codePoint);
      const provider = `${whitespace}SlAcK${whitespace}`;
      const externalId = index % 2 === 0 ? `U${index}` : `tMixed:u${index}`;
      expected.push({ id: await insertIdentity(team.teamId, team.memberId, provider, externalId),
        teamId: team.teamId, provider, memberId: team.memberId, externalId });
    }
    await insertIdentity(team.teamId, team.memberId, "linear", "UNRELATED");
    await insertIdentity(team.teamId, team.memberId, "\u200bSlack\u200b", "UINVISIBLE");
    await insertIdentity(other.teamId, other.memberId, "slack", "UOTHERTEAM");

    const rows = await readSlackCutoverIdentityRows(team.teamId, { pageSize: 3 });
    expect(rows).toEqual(expected.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    expect(rows).toHaveLength(trimCodePoints.length + 3);
    expect(JSON.stringify(rows)).not.toMatch(/private-handle|private@example|handle|email|token/i);
  });

  it("exhausts more than the default page size and uses a unique order when external IDs tie", async () => {
    const team = await seedTeam();
    await runSql(
      `insert into member_identities (team_id, member_id, provider, external_id)
       select $1::uuid, $2::uuid, 'slack', 'U' || lpad(n::text, 5, '0')
         from generate_series(1, 517) n`,
      [team.teamId, team.memberId]
    );
    await insertIdentity(team.teamId, team.memberId, " Slack ", "U00001");
    await insertIdentity(team.teamId, team.memberId, "\u00a0slack\u00a0", "U00001");
    const expected = (await runSql<{ id: string }>(
      `select id from member_identities where team_id = $1 and is_slack_identity_provider(provider)
       order by id`, [team.teamId]
    )).rows.map((row) => row.id);

    const rows = await readSlackCutoverIdentityRows(team.teamId, { pageSize: 17 });
    expect(rows).toHaveLength(519);
    expect(rows.map((row) => row.id)).toEqual(expected);
    expect(new Set(rows.map((row) => row.id)).size).toBe(519);
    expect(rows.filter((row) => row.externalId === "U00001")).toHaveLength(3);
  });

  it("keeps one committed snapshot across concurrent insert, update and delete", async () => {
    const team = await seedTeam();
    for (const externalId of ["UA", "UB", "UC"]) {
      await insertIdentity(team.teamId, team.memberId, "slack", externalId);
    }
    const before = (await runSql<{ id: string; external_id: string }>(
      `select id, external_id from member_identities where team_id = $1 order by id`, [team.teamId]
    )).rows;
    let mutations = 0;
    const rows = await readSlackCutoverIdentityRows(team.teamId, {
      pageSize: 1,
      afterPage: async (pageNumber) => {
        if (pageNumber !== 1) return;
        await runSql(`update member_identities set external_id = 'UCHANGED' where id = $1`, [before[1].id]);
        await runSql(`delete from member_identities where id = $1`, [before[2].id]);
        await insertIdentity(team.teamId, team.memberId, "slack", "UNEW");
        mutations++;
      },
    });
    expect(mutations).toBe(1);
    expect(rows.map(({ id, externalId }) => ({ id, external_id: externalId }))).toEqual(before);
    const after = (await runSql<{ external_id: string }>(
      `select external_id from member_identities where team_id = $1`, [team.teamId]
    )).rows.map((row) => row.external_id);
    expect(after).toContain("UCHANGED");
    expect(after).toContain("UNEW");
    expect(after).not.toContain(before[2].external_id);
  });

  it("rejects invalid team IDs, page sizes and a failed later page without partial results", async () => {
    const team = await seedTeam();
    for (const badTeamId of ["", "not-a-uuid", null]) {
      await expect(readSlackCutoverIdentityRows(badTeamId as string)).rejects.toThrow("invalid team ID");
    }
    for (const pageSize of [0, -1, 1.5, 513, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(readSlackCutoverIdentityRows(team.teamId, { pageSize })).rejects.toThrow("invalid page size");
    }
    await insertIdentity(team.teamId, team.memberId, "slack", "U1");
    await insertIdentity(team.teamId, team.memberId, "slack", "U2");
    let pages = 0;
    await expect(readSlackCutoverIdentityRows(team.teamId, {
      pageSize: 1,
      afterPage: async (pageNumber, query) => {
        pages = pageNumber;
        if (pageNumber === 1) await query("select * from aio_1170_missing_cutover_page");
      },
    })).rejects.toThrow();
    expect(pages).toBe(1);

    await expect(readSlackCutoverIdentityRows(team.teamId, {
      pageSize: 1,
      afterPage: async (_pageNumber, query) => {
        await query("update member_identities set handle = 'must-not-write' where team_id = $1", [team.teamId]);
      },
    })).rejects.toMatchObject({ code: "25006" });
    const handles = (await runSql<{ handle: string }>(
      `select handle from member_identities where team_id = $1`, [team.teamId]
    )).rows.map((row) => row.handle);
    expect(handles).toEqual(["private-handle", "private-handle"]);
  });
});
