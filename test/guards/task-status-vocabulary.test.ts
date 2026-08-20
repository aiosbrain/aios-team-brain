import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TASK_STATUSES } from "@/lib/api/schemas";
import { TASK_STATUSES as KANBAN_TASK_STATUSES, STATUS_LABELS } from "@/components/kanban/types";

/**
 * Guards for the ONE canonical task status vocabulary (brain-api §"Task rows"), which is spelled out
 * in three places that cannot import each other and therefore drift silently:
 *
 *   1. `lib/api/schemas.ts TASK_STATUSES` — the server's fold target. The source of truth.
 *   2. `components/kanban/types.ts TASK_STATUSES` — the board's copy. It is a legitimate separate
 *      array (importing the server module would drag zod into the client bundle), and
 *      `activity-policy-single-source.test.ts` explicitly names `components/` as a blind spot it does
 *      NOT cover. So nothing watched this seam until now.
 *   3. `postgres/schema.sql`'s `create type task_status as enum (…)` — the storage type.
 *
 * ORDER is part of the contract, not cosmetic: it is the board's column order and the enum's sort
 * order (`order by status`), so these compare sequences, not sets.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCHEMA = readFileSync(join(ROOT, "postgres", "schema.sql"), "utf8");
const MIG_DIR = join(ROOT, "postgres", "migrations");

/**
 * The labels `task_status` shipped with, before this repo had a migrations directory. Everything
 * BEYOND this baseline was added to an already-deployed database and therefore needs an explicit
 * `alter type … add value` — see the replay rule below.
 */
const ORIGINALLY_SHIPPED = ["backlog", "ready", "in_progress", "blocked", "done"];

function createTypeLabels(type: string): string[] {
  const m = SCHEMA.match(new RegExp(String.raw`create type ${type} as enum\s*\(([^)]*)\)`, "i"));
  if (!m) throw new Error(`no \`create type ${type} as enum\` in postgres/schema.sql`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** Every `alter type <type> add value … '<label>'` in a blob of SQL. */
function addedValues(sql: string, type: string): string[] {
  const re = new RegExp(String.raw`alter type ${type} add value[^;]*?'([^']+)'`, "gi");
  return [...sql.matchAll(re)].map((m) => m[1]);
}

describe("canonical task status vocabulary", () => {
  it("the kanban board's copy matches the server's, in order", () => {
    expect([...KANBAN_TASK_STATUSES]).toEqual([...TASK_STATUSES]);
  });

  it("every status has a board label — an unlabelled column renders blank", () => {
    for (const status of KANBAN_TASK_STATUSES) expect(STATUS_LABELS[status]).toBeTruthy();
  });

  it("the postgres `task_status` enum matches the server's set, in order", () => {
    expect(createTypeLabels("task_status")).toEqual([...TASK_STATUSES]);
  });

  /**
   * THE ONE THAT MATTERS ON DEPLOY, and the reason this file exists.
   *
   * `create type … as enum` in schema.sql sits inside a `do $$ … exception when duplicate_object then
   * null $$` guard, so on every ALREADY-DEPLOYED database it is a silent NO-OP. Adding a label to that
   * list therefore does NOTHING to prod: `npm run pg:schema` runs green and the first write of the new
   * value dies with `invalid input value for enum task_status`.
   *
   * A DB-backed test cannot see this either — `db:test:up` loads schema.sql onto a FRESH database,
   * where the create-type list is authoritative. Delete the migration and every test still passes
   * while prod breaks. That is exactly the gap this static check closes: any label beyond the
   * originally-shipped set must ALSO be widened in by an `alter type … add value`, in schema.sql (for
   * an existing DB being re-loaded) AND in a file under postgres/migrations/ (the Railway rollout).
   */
  it("every label added after the type first shipped is widened in by BOTH schema.sql and a migration", () => {
    const added = createTypeLabels("task_status").filter((l) => !ORIGINALLY_SHIPPED.includes(l));
    expect(added.length, "no post-ship labels to check — update ORIGINALLY_SHIPPED if that is wrong").toBeGreaterThan(0);

    const inSchema = addedValues(SCHEMA, "task_status");
    const inMigrations = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .flatMap((f) => addedValues(readFileSync(join(MIG_DIR, f), "utf8"), "task_status"));

    for (const label of added) {
      expect(inSchema, `postgres/schema.sql must \`alter type task_status add value '${label}'\``).toContain(label);
      expect(
        inMigrations,
        `a file under postgres/migrations/ must \`alter type task_status add value '${label}'\` — ` +
          `without it an already-deployed brain cannot store '${label}'`
      ).toContain(label);
    }
  });

  it("the migration preserves the canonical ORDER, not just membership", () => {
    // `add value` with no positional clause appends to the end of the enum, which silently re-orders
    // every status-sorted surface. The clause is what keeps the enum's sort order equal to the
    // contract's order, so it is asserted rather than assumed.
    const labels = createTypeLabels("task_status");
    const migrations = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(MIG_DIR, f), "utf8"))
      .join("\n");
    for (const label of labels.filter((l) => !ORIGINALLY_SHIPPED.includes(l))) {
      const successor = labels[labels.indexOf(label) + 1];
      const re = new RegExp(String.raw`add value[^;]*?'${label}'\s+before\s+'([^']+)'`, "i");
      const m = migrations.match(re);
      expect(m, `the migration adding '${label}' must position it with \`before '<next>'\``).not.toBeNull();
      expect(m?.[1], `'${label}' must sort immediately before '${successor}'`).toBe(successor);
    }
  });
});
