import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { expect, it } from "vitest";
import { fingerprint, diffFingerprints } from "../../scripts/schema-fingerprint.mjs";

// Exercise the migration itself before the current schema can hide a missing additive change.
it("upgrades populated pre-origin schema, preserves legacy rows, and replays immutable origins", async () => {
  const url = new URL(process.env.DATABASE_TEST_URL!);
  const admin = new Client({ connectionString: url.href });
  const name = "origin_migration_" + randomUUID().replaceAll("-", "");
  let created = false;
  let db: Client | undefined;
  await admin.connect();
  try {
    await admin.query(`create database "${name}"`);
    created = true;
    url.pathname = "/" + name;
    db = new Client({ connectionString: url.href });
    await db.connect();
    const baseline = execFileSync("git", ["show", "5349496835cafa74be66e0591cf82452705044cf:postgres/schema.sql"],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    await db.query(baseline);
    expect((await db.query("select to_regclass('governed_item_origins') as origin")).rows[0].origin).toBeNull();
    const team = (await db.query("insert into teams(slug,name) values('prior','Prior team') returning id")).rows[0].id;
    const otherTeam = (await db.query("insert into teams(slug,name) values('other','Other team') returning id")).rows[0].id;
    const member = (await db.query("insert into members(team_id,email,display_name,actor_handle,role,status) values($1,'prior@test.local','Prior member','prior','admin','active') returning id", [team])).rows[0].id;
    const project = (await db.query("insert into projects(team_id,slug) values($1,'prior') returning id", [team])).rows[0].id;
    const otherMember = (await db.query("insert into members(team_id,email,display_name,actor_handle) values($1,'other@test.local','Other member','other') returning id", [otherTeam])).rows[0].id;
    const otherProject = (await db.query("insert into projects(team_id,slug) values($1,'other') returning id", [otherTeam])).rows[0].id;
    const insertItem = async (path: string) => (await db!.query(
      "insert into items(team_id,project_id,path,kind,access,body,content_sha256,member_id) values($1,$2,$3,'decision','team','Prior rationale',$4,$5) returning *",
      [team, project, path, "a".repeat(64), member])).rows[0];
    const legacyItem = await insertItem("decisions.md");
    const legacyDecision = (await db.query("insert into decisions(team_id,project_id,source_item_id,row_key,title,rationale,impact,decided_by,created_by) values($1,$2,$3,'legacy','Prior choice','Prior rationale','Prior impact','prior',$4) returning *", [team, project, legacyItem.id, member])).rows[0];
    const audit = (await db.query("insert into audit_log(team_id,actor_kind,action) values($1,'system','prior.decision') returning *", [team])).rows[0];
    const migration = readFileSync(new URL("../../postgres/migrations/20260928110000_governed_item_origins.sql", import.meta.url), "utf8");
    const assertLegacy = async () => {
      const current = (await db!.query("select * from items where id=$1", [legacyItem.id])).rows[0];
      if ("note_search_title" in current) {
        expect(current.note_search_title).toBe("");
        delete current.note_search_title;
      }
      expect(current).toEqual(legacyItem);
      expect((await db!.query("select * from decisions where id=$1", [legacyDecision.id])).rows[0]).toEqual(legacyDecision);
      expect((await db!.query("select * from audit_log where id=$1", [audit.id])).rows[0]).toEqual(audit);
    };
    await db.query(migration);
    await assertLegacy();
    expect((await db.query("select * from governed_item_origins")).rows).toEqual([]);
    const firstShape = await fingerprint(db);
    const canonicalItem = await insertItem("governed/decision.md");
    const canonicalDecision = (await db.query("insert into decisions(team_id,project_id,source_item_id,row_key,title,rationale,created_by) values($1,$2,$3,'governed','Governed choice','Governed rationale',$4) returning *", [team, project, canonicalItem.id, member])).rows[0];
    const revision = randomUUID();
    const insertOrigin = (itemId: string, memberId = member, projectId = project, entityId = canonicalDecision.id, identityKey = "operation") => db!.query(
      "insert into governed_item_origins(item_id,team_id,member_id,project_id,kind,entity_id,identity_key,revision) values($1,$2,$3,$4,'decision',$5,$7,$6) returning *",
      [itemId, team, memberId, projectId, entityId, revision, identityKey]);
    const origin = (await insertOrigin(canonicalItem.id)).rows[0];
    await db.query(migration); // Replay with actual governed content and provenance already present.
    expect(diffFingerprints(firstShape, await fingerprint(db))).toMatchObject({ missing: [], extra: [] });
    await assertLegacy();
    expect((await db.query("select * from governed_item_origins")).rows).toEqual([origin]);
    // BEFORE UPDATE sees NULL for generated search; harmless sync stamps must still pass.
    const syncedAt = "2026-09-28T00:00:00.000Z";
    await db.query("update items set synced_at=$2 where id=$1", [canonicalItem.id, syncedAt]);
    const stamped = (await db.query("select * from items where id=$1", [canonicalItem.id])).rows[0];
    expect(stamped).toEqual({ ...canonicalItem, synced_at: new Date(syncedAt) });
    const spare = await insertItem("spare.md");
    const otherItem = (await db.query("insert into items(team_id,project_id,path,kind,access,content_sha256) values($1,$2,'other.md','decision','team',$3) returning id", [otherTeam, otherProject, "b".repeat(64)])).rows[0].id;
    await expect(insertOrigin(otherItem, member, project, randomUUID(), "other-item")).rejects.toMatchObject({ code: "23503" });
    await expect(insertOrigin(spare.id, otherMember, project, randomUUID())).rejects.toMatchObject({ code: "23503" });
    await expect(insertOrigin(spare.id, member, otherProject, randomUUID())).rejects.toMatchObject({ code: "23503" });
    await expect(insertOrigin(spare.id, member, project, randomUUID())).rejects.toMatchObject({ code: "23505" });
    await expect(insertOrigin(spare.id, member, project, canonicalDecision.id, "different-operation")).rejects.toMatchObject({ code: "23505" });
    for (const query of [
      "update items set body='changed' where id=$1",
      "delete from items where id=$1",
    ]) await expect(db.query(query, [canonicalItem.id])).rejects.toMatchObject({ code: "23514", message: "immutable_origin" });
    for (const query of [
      "update decisions set rationale='changed' where id=$1",
      "delete from decisions where id=$1",
    ]) await expect(db.query(query, [canonicalDecision.id])).rejects.toMatchObject({ code: "23514", message: "immutable_origin" });
    await expect(db.query("update governed_item_origins set revision=$2 where item_id=$1", [canonicalItem.id, randomUUID()])).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("delete from governed_item_origins where item_id=$1", [canonicalItem.id])).rejects.toMatchObject({ code: "23514" });
    const schema = readFileSync(new URL("../../postgres/schema.sql", import.meta.url), "utf8");
    await db.query(schema);
    await db.query(migration);
    await assertLegacy();
    expect((await db.query("select * from governed_item_origins")).rows).toEqual([origin]);
    expect((await db.query("select * from decisions where id=$1", [canonicalDecision.id])).rows[0]).toEqual(canonicalDecision);
    // Ungoverned rows retain their pre-migration edit/delete behavior.
    await db.query("update decisions set rationale='legacy edit' where id=$1", [legacyDecision.id]);
    await db.query("delete from decisions where id=$1", [legacyDecision.id]);
    await db.query("delete from items where id=$1", [legacyItem.id]);
  } finally {
    try {
      await db?.end();
    } finally {
      try {
        if (created) await admin.query(`drop database "${name}" with (force)`);
      } finally {
        await admin.end();
      }
    }
  }
}, 30000);
