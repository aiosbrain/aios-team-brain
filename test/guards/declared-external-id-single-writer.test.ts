import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * ADOPTDECL-1 — `declared_external_id` means "a human named this issue on this row", and it means that
 * ONLY because exactly one writer ever sets it.
 *
 * The column exists because `provider_external_id` has two writers with opposite meanings — `ensureLink`
 * defaults it to `row_key`, ingest writes a human declaration — which made every attempt to read intent
 * out of it wrong. A second writer here would recreate that ambiguity and silently un-fix the slice.
 *
 * SCOPED REPO-WIDE, NOT TO `lib/pm-sync`. Review caught the narrower version: `task_pm_links` is also
 * written from `scripts/brain-tasks.ts`, `lib/meetings/extract-todos.ts`,
 * `scripts/backfill-meeting-todo-rowkeys.ts` and `test/datamechanics/setup.ts` — so a guard over
 * `lib/pm-sync` alone would have guarded the writers that were never the threat.
 */

const ROOT = process.cwd();
const WRITER = "lib/ingest/tasks.ts";
const SCAN_DIRS = ["lib", "app", "scripts"];

function* walk(dir: string): Generator<string> {
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) yield full;
  }
}

/** Strip line and block comments — prose naming the column is not a write. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/**
 * A WRITE is the column as an object key (`declared_external_id: …`) or inside a raw
 * `insert into task_pm_links (…)` column list.
 *
 * The first version of this also flagged any comma-adjacent occurrence — and immediately fired on
 * `project.ts`'s `LINK_COLS` SELECT string, which is a READ and has to name the column for the rung to
 * work at all. Commas cannot tell a select list from an insert list, so the guard now keys on the two
 * forms a write actually takes.
 */
const writesColumn = (src: string): boolean => {
  if (/declared_external_id\s*:/.test(src)) return true;
  const rawInsert = /insert\s+into\s+task_pm_links[\s\S]{0,400}?\)/gi;
  for (const m of src.match(rawInsert) ?? []) if (m.includes("declared_external_id")) return true;
  // A raw `update task_pm_links set …` is the style `inbound.ts` already uses on this table, so a
  // future write in that shape would have slipped past the two forms above (found in review).
  if (/update\s+task_pm_links[\s\S]{0,400}?set[\s\S]{0,400}?declared_external_id/i.test(src)) return true;
  return false;
};

describe("ADOPTDECL-1 — lib/ingest/tasks.ts is the only writer of declared_external_id", () => {
  it("no file outside the single writer writes the column", () => {
    const offenders: string[] = [];
    for (const d of SCAN_DIRS)
      for (const file of walk(join(ROOT, d))) {
        const rel = file.slice(ROOT.length + 1);
        if (rel === WRITER) continue;
        const src = stripComments(readFileSync(file, "utf8"));
        // Reading it is fine and necessary — `lib/pm-sync/linear.ts` resolves the rung from it, and
        // `project.ts` selects it. Only a WRITE recreates the ambiguity this column exists to end.
        if (writesColumn(src)) offenders.push(rel);
      }
    expect(offenders).toEqual([]);
  });

  it("the single writer really does write it — the guard is not quantifying over nothing", () => {
    // Without this, deleting the write from ingest leaves the assertion above trivially true and the
    // column permanently NULL, which reads as "no row ever declares anything".
    const src = stripComments(readFileSync(join(ROOT, WRITER), "utf8"));
    expect(writesColumn(src), `${WRITER} no longer writes declared_external_id`).toBe(true);
  });

  it("the writer both SETS and CLEARS it — a declaration that cannot be withdrawn is a trap", () => {
    // A stale value is load-bearing after this slice: it fails the row on every run. If ingest only
    // ever set the column, removing the declaration from the markdown could never undo that.
    const src = stripComments(readFileSync(join(ROOT, WRITER), "utf8"));
    expect(src).toMatch(/declared_external_id:\s*row\.pm_external_id/);
    expect(src, "clearing must exist and must be an UPDATE, never an insert").toMatch(
      /declared_external_id:\s*null/
    );
  });
});
