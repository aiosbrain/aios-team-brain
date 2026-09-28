import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, it } from "vitest";

it("upgrades populated exact baseline, replays twice and retains identity/audit history", async () => {
  const url = new URL(process.env.DATABASE_TEST_URL!);
  const admin = new Client({ connectionString: url.href });
  await admin.connect();
  const name = "governed_migration_" + randomUUID().replaceAll("-", "");
  await admin.query(`create database "${name}"`);
  url.pathname = "/" + name;
  const db = new Client({ connectionString: url.href });
  await db.connect();
  try {
    const baseline = execFileSync(
      "git",
      ["show", "548d6b62a4f65f7ef1ffb4fa938c89bbc8344e1d:postgres/schema.sql"],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    await db.query(baseline);
    const team = (
      await db.query(
        "insert into teams(slug,name) values('old','Old team') returning id",
      )
    ).rows[0].id;
    const member = (
      await db.query(
        "insert into members(team_id,email,display_name,actor_handle,role,tier,status) values($1,'old@test.local','Old member','old','member','team','active') returning id",
        [team],
      )
    ).rows[0].id;
    const project = (
      await db.query(
        "insert into projects(team_id,slug) values($1,'old') returning id",
        [team],
      )
    ).rows[0].id;
    const key = (
      await db.query(
        "insert into api_keys(team_id,member_id,key_id,key_hash) values($1,$2,'old','old-hash') returning id",
        [team, member],
      )
    ).rows[0].id;
    const audit = (
      await db.query(
        "insert into audit_log(team_id,actor_kind,action) values($1,'system','baseline') returning id",
        [team],
      )
    ).rows[0].id;
    const approval = (
      await db.query(
        "insert into approval_requests(team_id,action,resource) values($1,'legacy','*') returning id",
        [team],
      )
    ).rows[0].id;
    const legacy = (
      await db.query(
        "insert into actions(team_id,member_id,action_type,approval_request_id) values($1,$2,'legacy',$3) returning *",
        [team, member, approval],
      )
    ).rows[0];
    const schema = readFileSync(
      new URL("../../postgres/schema.sql", import.meta.url),
      "utf8",
    );
    const migration = readFileSync(
      new URL(
        "../../postgres/migrations/20260928030000_governed_actions.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await db.query(schema);
    await db.query(migration);
    await db.query(schema);
    await db.query(migration);
    expect(
      (await db.query("select * from actions where id=$1", [legacy.id]))
        .rows[0],
    ).toEqual(legacy);
    expect(
      (await db.query("select action from audit_log where id=$1", [audit]))
        .rows[0].action,
    ).toBe("baseline");
    const identity = (
      await db.query(
        "insert into governed_action_identities(team_id,member_id,project_id,operation_key,canonical_request,request_hash) values($1,$2,$3,'op','{}',$4) returning id",
        [team, member, project, "a".repeat(64)],
      )
    ).rows[0].id;
    await expect(
      db.query(
        "insert into governed_action_identities(team_id,member_id,project_id,operation_key,canonical_request,request_hash) values($1,$2,$3,'op','different',$4)",
        [team, member, project, "b".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await db.query(
      "insert into governed_actions(identity_id,attempt,credential_id,credential_fingerprint,request,status,result,audit_ref,approval_request_id) values($1,1,$2,'old-hash','{}','denied','{}',$3,$4)",
      [identity, key, audit, approval],
    );
    for (const [table, id] of [
      ["governed_action_identities", identity],
      ["api_keys", key],
      ["approval_requests", approval],
      ["projects", project],
    ])
      await expect(
        db.query(`delete from ${table} where id=$1`, [id]),
      ).rejects.toMatchObject({ code: "23503" });
    expect(
      (await db.query("select count(*)::int n from governed_actions")).rows[0]
        .n,
    ).toBe(1);
  } finally {
    await db.end();
    await admin.query(`drop database "${name}"`);
    await admin.end();
  }
}, 30000);
