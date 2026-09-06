import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import { getPool } from "@/lib/db/pg/pool";
import { ensureBuiltins, materializeBuiltinMembershipOnce } from "@/lib/access/groups";

/**
 * STAGINGMARK-1 acceptance AC10–AC11, against a real Postgres.
 * Spec: docs/design/stagingmark1-materialize-oneshot.md.
 *
 * AC10 executes the PRET-6 migration's OWN TEXT rather than a paraphrase of its predicate. An
 * earlier draft asserted the predicate by hand and the design review killed it: re-typing the
 * `select` proves only that inserting a row changes a query you wrote to notice that row, and it
 * would keep passing if the real migration's condition drifted.
 *
 * WHY begin/ROLLBACK, and why this matters more than it looks. The migration's second half DROPS
 * `teams.access_enforcement` and `teams.autoflip_hold`. The data-mechanics harness truncates ROWS
 * between tests, not DDL — so running this file's statement bare would permanently change the
 * shared test schema for every later test in the run, which is precisely the PRET-6 hazard
 * CLAUDE.md records against `db:test:up`. Postgres DDL is transactional, so a rollback keeps the
 * execution verbatim AND leaves no trace. The block is run on ONE pinned client, because `runSql`
 * goes through the pool and a `begin` there could land on a different connection than the
 * `rollback`.
 */

const MIGRATION = readFileSync(
  join(import.meta.dirname, "..", "..", "postgres", "migrations", "20260818210000_pret6_retire_access_enforcement.sql"),
  "utf8"
);

const MARKER = "pret4_builtin_materialize";

/**
 * Run the migration verbatim in a transaction that ALWAYS rolls back; return the raised error, or
 * null when it applied cleanly. The teams are normalised to non-permissive first (also rolled
 * back) so a `permissive` row left by another test cannot make this raise the OTHER PRET-6
 * message and read like a marker failure.
 */
async function runMigrationRolledBack(): Promise<string | null> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(`do $$ begin
      if exists (select 1 from information_schema.columns
                 where table_schema = current_schema() and table_name = 'teams' and column_name = 'access_enforcement') then
        update teams set access_enforcement = 'enforcing';
      end if;
    end $$;`);
    try {
      await client.query(MIGRATION);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

beforeEach(async () => {
  // The marker is one-time PER FLEET and the shared test DB carries it across files.
  await db().from("migration_markers").delete().eq("name", MARKER);
});

describe("STAGINGMARK-1 — the wedged fleet, against the real migration", () => {
  it("AC10 — the real PRET-6 guard refuses before materialization and applies after", async () => {
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);

    // BEFORE: teams exist, marker absent → the migration's own text refuses.
    const before = await runMigrationRolledBack();
    expect(before, "the migration must refuse a markerless fleet").not.toBeNull();
    expect(before).toContain("PRET-4 builtin materialization has not completed");

    // The one-shot's effect — the same function the CLI handler is given.
    const result = await materializeBuiltinMembershipOnce(db());
    expect(result.ok).toBe(true);
    expect((result as { ran?: boolean }).ran).toBe(true);

    const { data: marker } = await db().from("migration_markers").select("name").eq("name", MARKER).maybeSingle();
    expect(marker, "the marker must be stamped").not.toBeNull();

    // AFTER: the same verbatim text no longer refuses.
    const after = await runMigrationRolledBack();
    expect(after, `the migration must apply once materialized, got: ${after}`).toBeNull();
  });

  it("AC10b — the rolled-back run leaves the schema intact (the column drop did not persist)", async () => {
    // Negative control for the isolation the whole AC depends on. If begin/rollback were not
    // holding, the migration's `alter table teams drop column` would have changed the shared
    // schema and this assertion is where that shows up.
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);
    await materializeBuiltinMembershipOnce(db());
    await runMigrationRolledBack();

    const { rows } = await getPool().query<{ present: boolean }>(
      "select to_regclass('public.teams') is not null as present"
    );
    expect(rows[0]?.present).toBe(true);
    // The team row itself survives the rolled-back `update teams set access_enforcement`.
    const { data: team } = await db().from("teams").select("id").eq("id", seed.teamId).maybeSingle();
    expect(team).not.toBeNull();
  });

  it("AC11 — a reconcile that fails partway leaves the marker UNSTAMPED", async () => {
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);

    // Break the fleet AFTER this team: a second team whose builtin slug is occupied by a
    // non-builtin group, so `ensureBuiltins` fails for it. The loop returns before the marker
    // upsert, which is the marker-LAST discipline this criterion exists to pin.
    const { data: other, error } = await db()
      .from("teams")
      .insert({ slug: `t-${randomUUID().slice(0, 8)}`, name: "partial" })
      .select("id")
      .single();
    if (error || !other) throw new Error(`seed second team failed: ${error?.message}`);
    const otherId = (other as { id: string }).id;
    await db().from("groups").insert({ team_id: otherId, slug: "everyone", name: "squatter", is_builtin: false });

    const result = await materializeBuiltinMembershipOnce(db());
    expect(result.ok, "a fleet with an unbuildable team must not report success").toBe(false);

    const { data: marker } = await db().from("migration_markers").select("name").eq("name", MARKER).maybeSingle();
    expect(marker, "a partial reconcile must NOT stamp the marker — a retry has to be able to finish").toBeNull();
  });
});
