import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * AIO-1167 R86 F1 — no reader projects `query_log`'s GENERATED text.
 *
 * `query_log.answer_preview` and `query_log.cited_item_ids` are generated output derived from the
 * sources an answer was grounded in. Historical rows carry NULL provenance, which is uncertified
 * (`outputReadable`), and no reader applies the provenance gate to this table — so the only safe reader
 * is none: every `query_log` read selects metric/structural columns only (cost, tokens, counts, time,
 * member). This guard fails the build when any app/lib/components/scripts read selects either generated
 * column or `*`; a future preview reader must first route through the output-provenance gate and then
 * change this guard deliberately.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "components", "scripts"].map((d) => join(ROOT, d));
const GENERATED = /\b(answer_preview|cited_item_ids)\b|\*/;
/** A query-builder read: `.from("query_log")` … `.select("<cols>")` in the same statement. */
const BUILDER_READ = /from\(\s*["']query_log["']\s*\)([^;]*?)\.select\(\s*(["'`])([\s\S]*?)\2/g;
/** A raw SQL read: `select <cols> from query_log`. */
const SQL_READ = /select\s+([\s\S]{0,400}?)\s+from\s+query_log\b/gi;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(p)) out.push(p);
  }
  return out;
}

function reads(src: string): string[] {
  const columns: string[] = [];
  for (const m of src.matchAll(BUILDER_READ)) columns.push(m[3]);
  for (const m of src.matchAll(SQL_READ)) columns.push(m[1]);
  return columns;
}

function scan(): { reads: number; offenders: string[] } {
  let count = 0;
  const offenders: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      for (const cols of reads(readFileSync(file, "utf8"))) {
        count++;
        if (GENERATED.test(cols)) offenders.push(`${relative(ROOT, file)}: select ${cols.trim()}`);
      }
    }
  }
  return { reads: count, offenders };
}

describe("query_log generated text is never projected (AIO-1167 R86 F1)", () => {
  it("every query_log read selects metric/structural columns only", () => {
    const { reads: count, offenders } = scan();
    expect(count, "the scan found no query_log reads — the matcher is measuring nothing").toBeGreaterThan(3);
    expect(offenders, `query_log reads that project generated text:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the matchers discriminate (non-vacuity)", () => {
    const flagged = (src: string) => reads(src).some((cols) => GENERATED.test(cols));
    expect(flagged(`db.from("query_log").select("cost_usd, created_at")`)).toBe(false);
    expect(flagged(`db.from("query_log").select("question, answer_preview")`)).toBe(true);
    expect(flagged(`db.from("query_log")\n  .eq("team_id", t)\n  .select("cited_item_ids")`)).toBe(true);
    expect(flagged(`db.from("query_log").select("*")`)).toBe(true);
    expect(flagged("runSql(`select answer_preview from query_log where team_id=$1`)")).toBe(true);
    expect(flagged("runSql(`select count(*) as n from query_log`)")).toBe(true); // `*` is refused even in count(*)
    expect(flagged("runSql(`select cost_usd from query_log`)")).toBe(false);
    // A write is not a read.
    expect(flagged(`db.from("query_log").insert({ answer_preview: a })`)).toBe(false);
  });
});
