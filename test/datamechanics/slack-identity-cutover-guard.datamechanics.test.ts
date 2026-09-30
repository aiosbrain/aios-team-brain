import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { runSql } from "@/lib/db/pg/pool";
import { seedTeam } from "./helpers";

const migration = readFileSync(join(import.meta.dirname, "..", "..", "postgres", "migrations",
  "20260919210000_slack_identity_cutover_guard.sql"), "utf8");
const refusal = "Slack identity requires canonical WORKSPACE:USER after team cutover";
// ECMAScript String.trim whitespace and line terminators, matching the SQL classifier.
const trimCodePoints = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  0xfeff,
];

async function insertIdentity(teamId: string, memberId: string, provider: string, externalId: string) {
  return runSql<{ id: string }>(
    `insert into member_identities (team_id, member_id, provider, external_id)
       values ($1, $2, $3, $4) returning id`,
    [teamId, memberId, provider, externalId]
  );
}

async function mark(teamId: string) {
  await runSql(`update teams set slack_identity_cutover_at = clock_timestamp() where id = $1`, [teamId]);
}

beforeAll(async () => {
  const { rows } = await runSql<{ ready: boolean }>(
    `select exists(select 1 from information_schema.columns
       where table_name = 'teams' and column_name = 'slack_identity_cutover_at') as ready`
  );
  if (!rows[0]?.ready) {
    throw new Error("recreate the isolated data-mechanics database to load the cutover guard schema");
  }
});

describe("inactive Slack identity cutover guard (real Postgres)", () => {
  it("preserves pre-marker raw writes and metadata updates", async () => {
    const { teamId, memberId } = await seedTeam();
    const raw = await insertIdentity(teamId, memberId, "slack", "ULEGACY");
    await runSql(`update member_identities set handle = 'old worker' where id = $1`, [raw.rows[0].id]);
    await insertIdentity(teamId, memberId, "slack", "TWORKSPACE:uMixed");
    const noncanonical = await insertIdentity(teamId, memberId, " Slack ", "UMIXEDLEGACY");
    await runSql(`update member_identities set handle = 'legacy variant' where id = $1`,
      [noncanonical.rows[0].id]);
    const { rows } = await runSql<{ handle: string }>(
      `select handle from member_identities where id = $1`, [raw.rows[0].id]
    );
    expect(rows[0].handle).toBe("old worker");
    expect((await runSql<{ handle: string }>(`select handle from member_identities where id = $1`,
      [noncanonical.rows[0].id])).rows[0].handle).toBe("legacy variant");
    const marker = await runSql(`select 1 from teams where id = $1 and slack_identity_cutover_at is null`, [teamId]);
    expect(marker.rows).toHaveLength(1);
  });

  it("rejects post-marker raw INSERT and every UPDATE leaving a raw Slack ID, without echoing it", async () => {
    const { teamId, memberId } = await seedTeam();
    const raw = await insertIdentity(teamId, memberId, "slack", "USECRET987");
    await mark(teamId);

    for (const attempt of [
      () => insertIdentity(teamId, memberId, "slack", "UNEWSECRET987"),
      () => runSql(`update member_identities set handle = 'stale' where id = $1`, [raw.rows[0].id]),
      () => runSql(`update member_identities set external_id = 'USECRET987' where id = $1`,
        [raw.rows[0].id]),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: "23514", message: refusal });
    }
    const { rows } = await runSql<{ handle: string; external_id: string }>(
      `select handle, external_id from member_identities where id = $1`, [raw.rows[0].id]
    );
    expect(rows).toEqual([{ handle: "", external_id: "USECRET987" }]);
    await runSql(`delete from member_identities where id = $1`, [raw.rows[0].id]);
    expect((await runSql(`select 1 from member_identities where id = $1`, [raw.rows[0].id])).rows).toHaveLength(0);
  });

  it("accepts only uppercase, alphanumeric WORKSPACE:USER after the marker", async () => {
    const { teamId, memberId } = await seedTeam();
    await mark(teamId);
    const good = await insertIdentity(teamId, memberId, "slack", "TWORKSPACE:U123ABC");
    expect(good.rows).toHaveLength(1);
    await runSql(`update member_identities set handle = 'renamed' where id = $1`, [good.rows[0].id]);
    for (const bad of ["U123ABC", "tworkspace:U123ABC", "TWORKSPACE:u123ABC",
      "TWORKSPACE:U-123", "TWORKSPACE:U123:EXTRA", "TWORKSPACE:", ":U123", "TWORKSPACE:Ü123"]) {
      await expect(insertIdentity(teamId, memberId, "slack", bad))
        .rejects.toMatchObject({ code: "23514", message: refusal });
    }
    await expect(runSql(`update member_identities set external_id = 'U123ABC' where id = $1`,
      [good.rows[0].id])).rejects.toMatchObject({ code: "23514", message: refusal });
    expect((await runSql<{ handle: string }>(`select handle from member_identities where id = $1`,
      [good.rows[0].id])).rows[0].handle).toBe("renamed");
  });

  it("rejects noncanonical Slack provider spellings and raw IDs after the marker", async () => {
    const { teamId, memberId } = await seedTeam();
    const legacyQualified = await insertIdentity(teamId, memberId, "Slack", "TWORKSPACE:UOLD");
    const legacyRaw = await insertIdentity(teamId, memberId, " slack ", "UOLDRAW");
    const otherProvider = await insertIdentity(teamId, memberId, "linear", "ULINEAR");
    await mark(teamId);
    const canonical = await insertIdentity(teamId, memberId, "slack", "TWORKSPACE:UCANONICAL");

    for (const provider of ["Slack", " slack ", "SLACK"]) {
      for (const externalId of ["USECRETRAW", "TWORKSPACE:UQUALIFIED"]) {
        await expect(insertIdentity(teamId, memberId, provider, externalId))
          .rejects.toMatchObject({ code: "23514", message: refusal });
      }
    }
    await expect(runSql(`update member_identities set provider = ' Slack ',
      external_id = 'UUPDATEDRAW' where id = $1`, [otherProvider.rows[0].id]))
      .rejects.toMatchObject({ code: "23514", message: refusal });
    await expect(runSql(`update member_identities set handle = 'stale variant' where id = $1`,
      [legacyQualified.rows[0].id])).rejects.toMatchObject({ code: "23514", message: refusal });
    await expect(runSql(`update member_identities set handle = 'stale raw' where id = $1`,
      [legacyRaw.rows[0].id])).rejects.toMatchObject({ code: "23514", message: refusal });
    await expect(runSql(`update member_identities set provider = 'Slack' where id = $1`,
      [canonical.rows[0].id])).rejects.toMatchObject({ code: "23514", message: refusal });
    expect((await runSql<{ provider: string; external_id: string }>(
      `select provider, external_id from member_identities where id = $1`,
      [otherProvider.rows[0].id])).rows).toEqual([{ provider: "linear", external_id: "ULINEAR" }]);
  });

  it("fences every provider spelling trimmed by the shared JavaScript resolver", async () => {
    const { teamId, memberId } = await seedTeam();
    const legacy = await insertIdentity(teamId, memberId, "\u00a0Slack\u00a0", "ULEGACYNBSP");
    const other = await insertIdentity(teamId, memberId, "linear", "UOTHER");
    await mark(teamId);

    for (const codePoint of trimCodePoints) {
      const whitespace = String.fromCodePoint(codePoint);
      const provider = `${whitespace}Slack${whitespace}`;
      expect(provider.trim().toLowerCase()).toBe("slack");
      for (const externalId of ["URAW", "TWORKSPACE:UQUALIFIED"]) {
        await expect(insertIdentity(teamId, memberId, provider, externalId))
          .rejects.toMatchObject({ code: "23514", message: refusal });
      }
    }
    await expect(runSql(`update member_identities set handle = 'stale' where id = $1`,
      [legacy.rows[0].id])).rejects.toMatchObject({ code: "23514", message: refusal });
    await expect(runSql(`update member_identities set provider = $1, external_id = 'URAW'
      where id = $2`, ["\tSlack\n", other.rows[0].id]))
      .rejects.toMatchObject({ code: "23514", message: refusal });
    await expect(runSql(`update member_identities set provider = $1 where id = $2`,
      ["\ufeffSlack\ufeff", other.rows[0].id]))
      .rejects.toMatchObject({ code: "23514", message: refusal });
  });

  it("isolates the marker by team and leaves other providers alone", async () => {
    const marked = await seedTeam();
    const untouched = await seedTeam();
    await mark(marked.teamId);
    await insertIdentity(untouched.teamId, untouched.memberId, "slack", "UOTHERRAW");
    await insertIdentity(untouched.teamId, untouched.memberId, "\u00a0Slack\u00a0", "UNBSPRAW");
    await insertIdentity(marked.teamId, marked.memberId, "linear", "UOTHERRAW");
    await insertIdentity(marked.teamId, marked.memberId, "\u00a0linear\u00a0", "ULINEAROTHER");
    // U+200B is not trimmed by ECMAScript and must remain a different provider.
    expect("\u200bSlack\u200b".trim().toLowerCase()).not.toBe("slack");
    await insertIdentity(marked.teamId, marked.memberId, "\u200bSlack\u200b", "UNONSLACK");
    await expect(insertIdentity(marked.teamId, marked.memberId, "slack", "UOTHERRAW"))
      .rejects.toMatchObject({ code: "23514", message: refusal });
    expect((await runSql(`select 1 from member_identities where team_id = $1 and external_id = $2`,
      [untouched.teamId, "UOTHERRAW"])).rows).toHaveLength(1);
  });

  it("waits for a concurrent marker transaction before judging a mixed-case raw insert", async () => {
    const { teamId, memberId } = await seedTeam();
    const marker = new Client({ connectionString: process.env.DATABASE_URL });
    const writer = new Client({ connectionString: process.env.DATABASE_URL });
    const observer = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([marker.connect(), writer.connect(), observer.connect()]);
    let markerOpen = false;
    try {
      await marker.query("begin");
      markerOpen = true;
      await marker.query(`update teams set slack_identity_cutover_at = clock_timestamp() where id = $1`,
        [teamId]);
      const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
      // Attach a rejection handler immediately: the statement runs on another connection while
      // the marker transaction intentionally holds the conflicting team-row lock.
      const attempted = writer.query(`insert into member_identities
        (team_id, member_id, provider, external_id) values ($1, $2, $3, 'UDELAYED')`,
      [teamId, memberId, " Slack "]).then(() => ({ accepted: true, error: null }),
        (error: unknown) => ({ accepted: false, error }));
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const { rows } = await observer.query<{ blockers: number[] }>(
          `select pg_blocking_pids($1) as blockers`, [pid]
        );
        if (rows[0].blockers.length > 0) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await marker.query("commit");
      markerOpen = false;
      expect(await attempted).toMatchObject({ accepted: false,
        error: { code: "23514", message: refusal } });
      expect((await observer.query(`select 1 from member_identities
        where team_id = $1 and external_id = 'UDELAYED'`, [teamId])).rows).toHaveLength(0);
    } finally {
      if (markerOpen) await marker.query("rollback");
      await Promise.all([marker.end(), writer.end(), observer.end()]);
    }
  });

  it("allows row conversion before marking in one transaction and rolls back both together", async () => {
    const { teamId, memberId } = await seedTeam();
    const raw = await insertIdentity(teamId, memberId, "slack", "UROLLBACK");
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query("begin");
      await client.query(`update member_identities set external_id = 'TWORKSPACE:UROLLBACK' where id = $1`,
        [raw.rows[0].id]);
      await client.query(`update teams set slack_identity_cutover_at = clock_timestamp() where id = $1`,
        [teamId]);
      await client.query(`insert into member_identities (team_id, member_id, provider, external_id)
        values ($1, $2, 'slack', 'TWORKSPACE:USECOND')`, [teamId, memberId]);
      await client.query("savepoint after_marker");
      await expect(client.query(`insert into member_identities (team_id, member_id, provider, external_id)
        values ($1, $2, 'slack', 'UAFTERMARKER')`, [teamId, memberId]))
        .rejects.toMatchObject({ code: "23514", message: refusal });
      await client.query("rollback to savepoint after_marker");
      await client.query("rollback");
    } finally {
      await client.end();
    }
    expect((await runSql<{ external_id: string }>(`select external_id from member_identities where id = $1`,
      [raw.rows[0].id])).rows).toEqual([{ external_id: "UROLLBACK" }]);
    expect((await runSql(`select 1 from teams where id = $1 and slack_identity_cutover_at is null`,
      [teamId])).rows).toHaveLength(1);
    expect((await runSql(`select 1 from member_identities where team_id = $1 and external_id = 'TWORKSPACE:USECOND'`,
      [teamId])).rows).toHaveLength(0);
    await insertIdentity(teamId, memberId, "slack", "UAFTERROLLBACK");
  });

  it("replays the migration without resetting the marker, changing rows or duplicating triggers", async () => {
    const { teamId, memberId } = await seedTeam();
    const qualified = await insertIdentity(teamId, memberId, "slack", "TWORKSPACE:UREPLAY");
    await mark(teamId);
    const before = await runSql<{ slack_identity_cutover_at: Date }>(
      `select slack_identity_cutover_at from teams where id = $1`, [teamId]
    );
    await runSql(migration);
    await runSql(migration);
    expect((await runSql<{ slack_identity_cutover_at: Date }>(
      `select slack_identity_cutover_at from teams where id = $1`, [teamId]
    )).rows).toEqual(before.rows);
    expect((await runSql(`select 1 from member_identities where id = $1`, [qualified.rows[0].id])).rows)
      .toHaveLength(1);
    const triggers = await runSql<{ tgname: string }>(
      `select tgname from pg_trigger where tgname in
       ('member_identities_slack_cutover_guard', 'teams_slack_identity_cutover_marker_guard')
       and not tgisinternal order by tgname`
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      "member_identities_slack_cutover_guard", "teams_slack_identity_cutover_marker_guard",
    ]);
    await expect(insertIdentity(teamId, memberId, "slack", "UREPLAYRAW"))
      .rejects.toMatchObject({ code: "23514", message: refusal });
    await expect(insertIdentity(teamId, memberId, " Slack ", "UREPLAYRAW"))
      .rejects.toMatchObject({ code: "23514", message: refusal });
    await expect(runSql(`update teams set slack_identity_cutover_at = null where id = $1`, [teamId]))
      .rejects.toMatchObject({ code: "23514", message: "Slack identity cutover marker cannot be changed" });
  });
});
