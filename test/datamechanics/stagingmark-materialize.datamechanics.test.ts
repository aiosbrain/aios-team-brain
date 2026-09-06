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
    // release(true) DESTROYS the connection when the rollback itself failed, rather than returning
    // a client with a possibly-open aborted transaction to the shared pool (diff-review LOW).
    let rolledBack = true;
    await client.query("rollback").catch(() => {
      rolledBack = false;
    });
    client.release(rolledBack ? undefined : true);
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

  it("AC10b — the rolled-back run leaks neither the column drop nor the enforcement update", async () => {
    // NEGATIVE CONTROL for the isolation the whole AC depends on — rewritten after the diff review
    // showed the first version could not fail: it asserted `to_regclass('public.teams')`, but the
    // migration drops COLUMNS, never the table, so that assertion was green in the leaked world
    // too. It now observes the two things the transaction actually changes: the presence of
    // `teams.access_enforcement` (dropped by the migration's second half) and the value the
    // normalisation writes.
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);
    await materializeBuiltinMembershipOnce(db());

    const snapshot = async () => {
      const col = await getPool().query<{ present: boolean }>(
        `select exists (select 1 from information_schema.columns
           where table_schema = current_schema() and table_name = 'teams'
             and column_name = 'access_enforcement') as present`
      );
      const present = col.rows[0]?.present === true;
      if (!present) return { present, value: null as string | null };
      const val = await getPool().query<{ v: string | null }>(
        "select access_enforcement::text as v from teams where id = $1",
        [seed.teamId]
      );
      return { present, value: val.rows[0]?.v ?? null };
    };

    const before = await snapshot();
    await runMigrationRolledBack();
    const after = await snapshot();

    expect(after.present, "the migration's column drop must not survive the rollback").toBe(before.present);
    expect(after.value, "the normalisation UPDATE must not survive the rollback").toBe(before.value);
    // Recorded honestly: when the column is already absent on this database (the post-PRET-6
    // shape), `present` is false both times and this control only proves the UPDATE did not leak.
    // It is still the strongest observation available, and it reddens whenever the column exists.
  });

  it("AC11 — a reconcile that fails partway leaves the marker UNSTAMPED", async () => {
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);

    // Squat the SECOND builtin slug, not the first. The diff review caught that squatting
    // `everyone` makes this vacuous: `ensureBuiltins` iterates [everyone, external]
    // (lib/access/groups.ts:110-113) and refuses on the squatter BEFORE inserting anything, so no
    // partial write exists and the absent marker proves nothing. Squatting `external` means
    // `everyone` IS inserted — the convergent write — and the refusal lands after it, in either
    // team-iteration order (the `select id from teams` at :213 has no ORDER BY).
    const { data: other, error } = await db()
      .from("teams")
      .insert({ slug: `t-${randomUUID().slice(0, 8)}`, name: "partial" })
      .select("id")
      .single();
    if (error || !other) throw new Error(`seed second team failed: ${error?.message}`);
    const otherId = (other as { id: string }).id;
    await db().from("groups").insert({ team_id: otherId, slug: "external", name: "squatter", is_builtin: false });

    const result = await materializeBuiltinMembershipOnce(db());
    expect(result.ok, "a fleet with an unbuildable team must not report success").toBe(false);

    // BOTH halves, per the spec: the partial write landed …
    const { data: partial } = await db()
      .from("groups")
      .select("id")
      .eq("team_id", otherId)
      .eq("slug", "everyone")
      .eq("is_builtin", true)
      .maybeSingle();
    expect(partial, "the convergent write must have landed — otherwise this proves nothing about ordering").not.toBeNull();

    // … and the marker did NOT.
    const { data: marker } = await db().from("migration_markers").select("name").eq("name", MARKER).maybeSingle();
    expect(marker, "a partial reconcile must NOT stamp the marker — a retry has to be able to finish").toBeNull();
  });
});
