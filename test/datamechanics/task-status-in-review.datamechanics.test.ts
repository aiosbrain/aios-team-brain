import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSql } from "@/lib/db/pg/pool";
import { TASK_STATUSES } from "@/lib/api/schemas";
import { db, seedTeam } from "./helpers";

/**
 * Spec: `in_review` is a REAL `task_status` enum label on a real Postgres, reachable by an actual
 * insert, and the migration that adds it survives the replay `npm run pg:schema` performs on every
 * deploy.
 *
 * Why this tier and not unit (CLAUDE §4): everything about this change is a persistence claim. A
 * unit test can only prove the TypeScript union grew — it cannot see `invalid input value for enum
 * task_status`, which is what a missing/incorrect migration actually produces, and which would
 * surface as a failed release rather than a red test. `alter type … add value` is also the one
 * statement class with transaction-block restrictions, so "does it apply at all" is only answerable
 * against a live server.
 *
 * The migrate-from-zero path (`npm run db:test:up` loads schema.sql then every migration in order)
 * is what this suite runs against, so reaching this file at all already proves the pair composes.
 */

const MIGRATION = join(
  import.meta.dirname,
  "..",
  "..",
  "postgres",
  "migrations",
  "20260817120000_task_status_in_review.sql",
);

async function enumLabels(): Promise<string[]> {
  // Ordered by `enumsortorder`, NOT alphabetically — the physical order is what `order by status`
  // and any range comparison read off, and it is the thing `before 'blocked'` exists to control.
  const { rows } = await runSql<{ label: string }>(
    `select e.enumlabel as label
       from pg_enum e join pg_type t on t.oid = e.enumtypid
      where t.typname = 'task_status'
      order by e.enumsortorder`,
    [],
  );
  return rows.map((r) => r.label);
}

describe("task_status enum: in_review", () => {
  it("exists as an enum label, in the same order as the canonical TASK_STATUSES", () => {
    // Asserting the full ORDERED list, not just membership: a label appended at the end would pass a
    // `toContain` while sorting after `done`, silently disagreeing with a from-zero load of
    // schema.sql. That divergence is invisible until something orders by status.
    return expect(enumLabels()).resolves.toEqual([...TASK_STATUSES]);
  });

  it("a task row can actually be stored and read back as in_review", async () => {
    // The observable outcome, not a catalog reading: the enum is only real if a write lands.
    const seed = await seedTeam();
    const { data: project } = await db()
      .from("projects")
      .insert({ team_id: seed.teamId, slug: `p-${seed.teamSlug}`, name: "P" })
      .select("id")
      .single();

    await runSql(
      `insert into tasks (team_id, project_id, row_key, title, status, origin)
         values ($1, $2, $3, $4, 'in_review', 'sync')`,
      [seed.teamId, project!.id, `k-${seed.teamSlug}`, "Awaiting review"],
    );
    const { rows } = await runSql<{ status: string }>(
      `select status from tasks where team_id = $1 and row_key = $2`,
      [seed.teamId, `k-${seed.teamSlug}`],
    );
    expect(rows.map((r) => r.status)).toEqual(["in_review"]);
  });

  it("the migration is idempotent — pg:schema replays every file on every deploy", async () => {
    // THE failure this guards. There is no applied-migrations table: `pg:schema` runs every file in
    // postgres/migrations/ on EVERY rollout, so a non-idempotent `alter type … add value` would
    // throw `enum label "in_review" already exists` on the SECOND deploy and abort the release —
    // long after the PR that introduced it looked fine. Running it twice more here is the only way
    // to see that; the suite's own migrate-from-zero has applied it exactly once.
    const sql = readFileSync(MIGRATION, "utf8");
    await expect(runSql(sql, [])).resolves.toBeDefined();
    await expect(runSql(sql, [])).resolves.toBeDefined();
    // Replay must not duplicate the label or disturb the order either.
    await expect(enumLabels()).resolves.toEqual([...TASK_STATUSES]);
  });
});
