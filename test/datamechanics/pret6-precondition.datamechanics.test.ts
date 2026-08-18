import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import { runSql } from "@/lib/db/pg/pool";

// PRET-6 AC3 (docs/design/pret6-retirement.md §2.1/§4.3): the refusing precondition, proven by
// executing the MIGRATION FILE'S OWN TEXT (never a paraphrase — the mutate-with-the-real-shape
// rule). Three arms: a permissive team refuses; an unmaterialized fleet refuses; an
// all-enforcing materialized fleet drops the columns — and the guard REPLAYS as a no-op after
// the drop (the #251/#495 replay class, proven by running it twice).

const MIGRATION = join(
  import.meta.dirname,
  "..",
  "..",
  "postgres",
  "migrations",
  "20260818210000_pret6_retire_access_enforcement.sql"
);

const migrationSql = () => readFileSync(MIGRATION, "utf8");

async function columnExists(name: string): Promise<boolean> {
  const r = await runSql<{ n: number }>(
    "select count(*)::int as n from information_schema.columns where table_name = 'teams' and column_name = $1",
    [name]
  );
  return r.rows[0].n > 0;
}

async function restoreColumns(): Promise<void> {
  // Re-arm the schema for the next test (the dm harness truncates rows, not DDL).
  await runSql(
    "alter table teams add column if not exists access_enforcement text not null default 'permissive'",
    []
  );
  await runSql("alter table teams add column if not exists autoflip_hold boolean not null default false", []);
}

async function markMaterialized(): Promise<void> {
  await runSql(
    "insert into migration_markers (name) values ('pret4_builtin_materialize') on conflict (name) do nothing",
    []
  );
}

describe("PRET-6 §2.1 — the refusing precondition, executed from the migration's own text", () => {
  it("REFUSES while any team is permissive (H-VANISH made mechanical)", async () => {
    await restoreColumns();
    await seedTeam(); // teams default permissive
    await markMaterialized();
    await expect(runSql(migrationSql(), [])).rejects.toThrow(/PRET-6 refused: permissive/);
    expect(await columnExists("access_enforcement"), "the column survives a refusal").toBe(true);
  });

  it("REFUSES a teams-holding fleet whose PRET-4 materialization never completed (the H2 hole)", async () => {
    await restoreColumns();
    const seed = await seedTeam();
    await db().from("teams").update({ access_enforcement: "enforcing" }).eq("id", seed.teamId);
    await db().from("migration_markers").delete().eq("name", "pret4_builtin_materialize");
    await expect(runSql(migrationSql(), [])).rejects.toThrow(/materialization has not completed/);
    expect(await columnExists("access_enforcement")).toBe(true);
  });

  it("REFUSES a PRE-FLAG-ERA fleet — teams, no marker, the column NEVER existed (diff-review HIGH: a column-gated marker check would skip this class and the whole corpus would go dark at cutover)", async () => {
    // The fleet installed before 20260811160000 existed: no access_enforcement column, no
    // builtin rows, real teams. The marker refusal must fire UNCONDITIONALLY.
    await seedTeam();
    await db().from("migration_markers").delete().eq("name", "pret4_builtin_materialize");
    await runSql("alter table teams drop column if exists access_enforcement", []);
    await runSql("alter table teams drop column if exists autoflip_hold", []);
    await expect(runSql(migrationSql(), [])).rejects.toThrow(/materialization has not completed/);
    await restoreColumns();
  });

  it("DROPS both columns on an all-enforcing materialized fleet — and REPLAYS as a no-op (run twice, the idempotence proof)", async () => {
    await restoreColumns();
    const seed = await seedTeam();
    await db().from("teams").update({ access_enforcement: "enforcing" }).eq("id", seed.teamId);
    await markMaterialized();

    await runSql(migrationSql(), []);
    expect(await columnExists("access_enforcement")).toBe(false);
    expect(await columnExists("autoflip_hold")).toBe(false);

    // The replay: pg-load-schema re-applies every migration on every deploy — the second run
    // must be a clean no-op (the outer existence gate), never undefined_column.
    await runSql(migrationSql(), []);
    expect(await columnExists("access_enforcement")).toBe(false);

    await restoreColumns(); // leave the schema as the suite found it for sibling files
  });

  it("passes vacuously on a from-zero fleet (no teams): the guard reaches the drop with nothing to refuse", async () => {
    await restoreColumns();
    await runSql("delete from teams", []);
    await runSql(migrationSql(), []);
    expect(await columnExists("access_enforcement")).toBe(false);
    await restoreColumns();
  });
});
