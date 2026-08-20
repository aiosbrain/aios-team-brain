import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runSql } from "@/lib/db/pg/pool";
import { db, ingest, seedTeam } from "./helpers";

/**
 * Spec: brain-api **v1.21** (AIO-950; aios-workspace PR #603) — the canonical task status set gains
 * `in_review`, between `in_progress` and `blocked`.
 *
 * This is the END-TO-END proof, against real Postgres, that the unit-level normalization change is
 * actually reachable through a push. It exists because the failure mode here is NOT in the fold —
 * `tasks.status` is the postgres ENUM `task_status`, and `schema.sql` creates that type inside a
 * `duplicate_object`-swallowing guard, i.e. a NO-OP on any existing database. So a change that
 * passes every in-memory test can still fail on the first real write with `invalid input value for
 * enum task_status`. Only a DB-backed assertion can see that, which is why the widening ships as
 * `postgres/migrations/20260819180000_task_status_in_review.sql`.
 *
 * Asserted to the observable outcome: the row read back out of Postgres after a push.
 */

const pushTasks = (seed: Awaited<ReturnType<typeof seedTeam>>, rows: Record<string, unknown>[]) =>
  ingest(seed, {
    kind: "task",
    path: "3-log/tasks.md",
    // Every field goes into the body so a status-only change still shifts content_sha256; otherwise
    // ingest short-circuits as "unchanged" and never re-materializes, exactly as a real tasks.md would.
    body: rows.map((r) => `| ${r.row_key} | ${r.title} | ${r.status} |`).join("\n"),
    access: "team",
    rows,
  } as never);

const readTask = async (teamId: string, rowKey: string) => {
  const { data } = await db()
    .from("tasks")
    .select("status, raw_status")
    .eq("team_id", teamId)
    .eq("row_key", rowKey)
    .maybeSingle();
  return data as { status: string; raw_status: string | null } | null;
};

describe("task status `in_review` (brain-api v1.21, real Postgres)", () => {
  it("every spelling of In Review pushes through to the `in_review` enum value, raw_status NULL", async () => {
    const seed = await seedTeam();
    await pushTasks(seed, [
      { row_key: "R-1", title: "canonical", status: "in_review" },
      { row_key: "R-2", title: "titled", status: "In Review" },
      { row_key: "R-3", title: "dashed", status: "in-review" },
      { row_key: "R-4", title: "shouted", status: "IN REVIEW" },
    ]);

    for (const key of ["R-1", "R-2", "R-3", "R-4"]) {
      const row = await readTask(seed.teamId, key);
      expect(row, `${key} should exist`).not.toBeNull();
      // raw_status NULL is the load-bearing half: a non-null raw_status is the client's echo-guard
      // signal, so folding to `in_review` while STILL stamping raw_status would make the workspace
      // skip its own merge. Landing on the canonical value must clear it.
      expect({ key, ...row }).toEqual({ key, status: "in_review", raw_status: null });
    }
  });

  it("leaves the other five statuses, and the unknown-status fallback, exactly as they were", async () => {
    const seed = await seedTeam();
    await pushTasks(seed, [
      { row_key: "S-backlog", title: "a", status: "backlog" },
      { row_key: "S-ready", title: "b", status: "Ready" },
      { row_key: "S-progress", title: "c", status: "In Progress" },
      { row_key: "S-blocked", title: "d", status: "blocked" },
      { row_key: "S-done", title: "e", status: "DONE" },
      { row_key: "S-unknown", title: "f", status: "waiting on legal" },
      // Deliberately adjacent to the new member without being it — the fold is exact-match after
      // trimming/casing/dash-folding, never a prefix or fuzzy match.
      { row_key: "S-near", title: "g", status: "in reviewing" },
    ]);

    expect(await readTask(seed.teamId, "S-backlog")).toEqual({ status: "backlog", raw_status: null });
    expect(await readTask(seed.teamId, "S-ready")).toEqual({ status: "ready", raw_status: null });
    expect(await readTask(seed.teamId, "S-progress")).toEqual({ status: "in_progress", raw_status: null });
    expect(await readTask(seed.teamId, "S-blocked")).toEqual({ status: "blocked", raw_status: null });
    expect(await readTask(seed.teamId, "S-done")).toEqual({ status: "done", raw_status: null });
    // Unknown still falls back to backlog with the original preserved — unchanged by 1.21.
    expect(await readTask(seed.teamId, "S-unknown")).toEqual({
      status: "backlog",
      raw_status: "waiting on legal",
    });
    expect(await readTask(seed.teamId, "S-near")).toEqual({
      status: "backlog",
      raw_status: "in reviewing",
    });
  });

  // The static half of the migration's protection lives in test/guards/task-status-vocabulary.test.ts
  // (a fresh `db:test:up` loads schema.sql, whose create-type list already has the value, so no
  // DB-backed test can notice a DELETED migration). What a real database CAN prove is the other two
  // properties the deploy depends on, and they are asserted here against live Postgres.
  it("the migration file is a clean NO-OP when replayed on an already-widened database", async () => {
    // postgres/migrations/ is replayed IN FULL on every deploy with no applied-tracking table, so
    // "runs twice without error" is not a nicety — it is the rollout contract for this directory.
    const sql = readFileSync(
      join(import.meta.dirname, "..", "..", "postgres", "migrations", "20260819180000_task_status_in_review.sql"),
      "utf8"
    );
    await expect(runSql(sql)).resolves.toBeDefined();
    await expect(runSql(sql)).resolves.toBeDefined();
  });

  it("the enum's SORT order is the contract's canonical order, not append-at-the-end", () => {
    // `order by status` sorts on enumsortorder, so a missing `before 'blocked'` would silently
    // re-order every status-sorted surface while every membership assertion stayed green.
    return runSql<{ enumlabel: string }>(
      `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
        where t.typname = 'task_status' order by e.enumsortorder`
    ).then((r) => {
      expect(r.rows.map((x) => x.enumlabel)).toEqual([
        "backlog",
        "ready",
        "in_progress",
        "in_review",
        "blocked",
        "done",
      ]);
    });
  });
});
