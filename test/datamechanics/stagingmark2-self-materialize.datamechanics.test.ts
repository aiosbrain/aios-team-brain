import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPool } from "@/lib/db/pg/pool";

const root = join(import.meta.dirname, "../..");
const migration = readFileSync(join(root, "postgres/migrations/20260818210000_pret6_retire_access_enforcement.sql"), "utf8");
const query = (sql: string, values: unknown[] = []) => getPool().query(sql, values);
const marker = async () => (await query("select * from migration_markers where name = 'pret4_builtin_materialize'")).rows;
const edges = async () => (await query("select * from group_members order by team_id, group_id, member_id")).rows;

beforeAll(async () => {
  // Install the FILE, even on a reused dm container; a source mutation must execute.
  const source = readFileSync(join(root, "postgres/schema.sql"), "utf8");
  const block = source.match(/create\s+or\s+replace\s+function\s+materialize_builtin_membership_once\s*\(\s*\)[\s\S]*?\bas\s+(\$\w*\$)[\s\S]*?\1\s*;/i);
  if (!block) throw new Error("schema materializer definition missing");
  await query("drop function if exists materialize_builtin_membership_once()");
  await query(block[0]);
});
beforeEach(async () => {
  await query("delete from migration_markers where name = 'pret4_builtin_materialize'");
  await query("alter table teams drop column if exists access_enforcement");
  await query("alter table teams drop column if exists autoflip_hold");
});

// Independent product matrix: all kinds, connector flags, statuses and tiers,
// across two teams. Intentionally NEVER seedTeam: that would create builtins.
async function fleet() {
  const expected: { team_id: string; member_id: string; slug: string }[] = [];
  const teams: string[] = [];
  for (let i = 0; i < 2; i++) {
    const team = (await query("insert into teams (slug, name) values ($1, 'historical') returning id", [randomUUID()])).rows[0].id as string;
    teams.push(team);
    for (const kind of ["human", "agent", "offroster"]) {
      for (const connector of [false, true]) {
        for (const status of ["invited", "active", "disabled"]) {
          for (const tier of ["team", "external"]) {
            const id = randomUUID();
            // actor_handle gets its own placeholder: reusing $3 for both `email` (citext) and
            // `actor_handle` (text) makes Postgres refuse with "inconsistent types deduced for
            // parameter $3" — the fixture never ran. Found by running the dm tier, which the
            // author is forbidden.
            await query(`insert into members (id, team_id, email, display_name, actor_handle, kind, is_connector, status, tier)
              values ($1, $2, $3, 'fixture', $4, $5, $6, $7, $8)`, [id, team, `${id}@test.local`, `h-${id.slice(0, 8)}`, kind, connector, status, tier]);
            expected.push({ team_id: team, member_id: id, slug: tier === "team" ? "everyone" : "external" });
          }
        }
      }
    }
  }
  expect((await query("select * from groups")).rows).toEqual([]);
  expect(await edges()).toEqual([]);
  return { teams, expected };
}
async function builtins() {
  await query(`insert into groups (team_id, slug, name, is_builtin)
    select t.id, b.slug, b.name, true from teams t cross join
    (values ('everyone', 'Everyone'), ('external', 'External')) b(slug, name)`);
}
async function exact(expected: { team_id: string; member_id: string; slug: string }[]) {
  const actual = (await query(`select gm.team_id, gm.member_id, g.slug from group_members gm
    join groups g on g.id = gm.group_id where g.is_builtin order by gm.member_id, g.slug`)).rows;
  const sort = (rows: typeof expected) => rows.map(r => `${r.team_id}/${r.member_id}/${r.slug}`).sort();
  // Exact equality is also the inverse: no member in the opposite builtin or another team.
  expect(sort(actual)).toEqual(sort(expected));
  expect(await marker()).toHaveLength(1);
}

describe("STAGINGMARK-2 — migration self-materialization", () => {
  it("AC1b: creates absent builtins before placing every member, including the inverse", async () => {
    const { teams, expected } = await fleet();
    await query(migration);
    expect((await query("select team_id, slug, name, is_builtin from groups order by team_id, slug")).rows).toEqual(
      teams.sort().flatMap(team_id => [
        { team_id, slug: "everyone", name: "Everyone", is_builtin: true },
        { team_id, slug: "external", name: "External", is_builtin: true },
      ])
    );
    await exact(expected);
  });

  it("AC1/AC2: adds missing, deletes refuted, preserves correct timestamps and unrelated edges", async () => {
    const { teams, expected } = await fleet();
    await builtins();
    const [correct, wrong, missing] = expected;
    await query(`insert into group_members (team_id, group_id, member_id, created_at)
      select $1, id, $2, '2001-01-01T00:00:00Z' from groups where team_id = $1 and slug = 'everyone'`, [correct.team_id, correct.member_id]);
    await query(`insert into group_members (team_id, group_id, member_id)
      select $1, id, $2 from groups where team_id = $1 and slug = 'everyone'`, [wrong.team_id, wrong.member_id]);
    const before = await edges();
    expect(before).toHaveLength(2);
    expect(before.some(r => r.member_id === missing.member_id)).toBe(false);
    expect(wrong.slug).toBe("external"); // the seeded everyone row is refuted
    for (const singleton of [false, true]) {
      const group = (await query(`insert into groups (team_id, slug, name, person_member_id)
        values ($1, $2, 'untouched', $3) returning id`, [teams[0], randomUUID(), singleton ? correct.member_id : null])).rows[0].id;
      await query("insert into group_members (team_id, group_id, member_id) values ($1, $2, $3)", [teams[0], group, wrong.member_id]);
      const project = (await query("insert into projects (team_id, slug, name) values ($1, $2, 'untouched') returning id", [teams[0], randomUUID()])).rows[0].id;
      await query("insert into project_groups (team_id, project_id, group_id) values ($1, $2, $3)", [teams[0], project, group]);
    }
    const unrelated = (await query("select gm.* from group_members gm join groups g on g.id = gm.group_id where not g.is_builtin order by gm.group_id")).rows;
    const grants = (await query("select * from project_groups order by project_id")).rows;
    const tiers = (await query("select id, tier from members order by id")).rows;
    await query(migration);
    await exact(expected);
    expect((await edges()).find(r => r.member_id === correct.member_id)).toEqual(before[0].member_id === correct.member_id ? before[0] : before[1]);
    expect((await query("select gm.* from group_members gm join groups g on g.id = gm.group_id where not g.is_builtin order by gm.group_id")).rows).toEqual(unrelated);
    expect((await query("select * from project_groups order by project_id")).rows).toEqual(grants);
    expect((await query("select id, tier from members order by id")).rows).toEqual(tiers);
    expect((await query("select * from audit_log where action = 'access.builtin_materialized'")).rows).toHaveLength(4);
  });

  it("AC3/AC4: a reserved external squatter refuses without any membership or marker mutation", async () => {
    const { teams, expected } = await fleet();
    await builtins();
    await query("update groups set is_builtin = false where team_id = $1 and slug = 'external'", [teams[1]]);
    await query(`insert into group_members (team_id, group_id, member_id)
      select $1, id, $2 from groups where team_id = $1 and slug = 'external'`, [teams[0], expected[0].member_id]);
    const before = await edges();
    expect(before).toHaveLength(1);
    await expect(query(migration)).rejects.toThrow(/non-builtin.*reserved slug/i);
    expect(await edges()).toEqual(before);
    expect(await marker()).toEqual([]);
  });

  it("AC5: a failing column drop rolls back both membership and marker", async () => {
    await fleet();
    await builtins();
    await query("alter table teams add column access_enforcement text not null default 'enforcing'");
    await query("create view stagingmark2_drop_blocker as select access_enforcement from teams");
    try {
      expect(await edges()).toEqual([]);
      await expect(query(migration)).rejects.toThrow(/depend/i);
      expect(await marker()).toEqual([]);
      expect(await edges()).toEqual([]);
      expect((await query("select * from audit_log where action = 'access.builtin_materialized'")).rows).toEqual([]);
    } finally {
      await query("drop view if exists stagingmark2_drop_blocker");
      await query("alter table teams drop column if exists access_enforcement");
    }
  });

  it("AC6: a marked fleet preserves deliberate disagreement byte-for-byte and emits no audit", async () => {
    const { expected } = await fleet();
    await builtins();
    await query(`insert into group_members (team_id, group_id, member_id)
      select $1, id, $2 from groups where team_id = $1 and slug = 'external'`, [expected[0].team_id, expected[0].member_id]);
    await query("insert into migration_markers (name) values ('pret4_builtin_materialize')");
    const before = await edges();
    expect(before).toHaveLength(1);
    await query(migration);
    expect(await edges()).toEqual(before);
    expect((await query("select * from audit_log where action = 'access.builtin_materialized'")).rows).toEqual([]);
    expect((await query("select materialize_builtin_membership_once() as ran")).rows).toEqual([{ ran: false }]);
  });

  it("stamps a zero-team fleet and returns true only once", async () => {
    expect((await query("select * from teams")).rows).toEqual([]);
    expect((await query("select materialize_builtin_membership_once() as ran")).rows).toEqual([{ ran: true }]);
    expect(await marker()).toHaveLength(1);
    expect((await query("select materialize_builtin_membership_once() as ran")).rows).toEqual([{ ran: false }]);
  });
});
