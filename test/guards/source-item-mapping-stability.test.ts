import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * A provider mapping, once it names an item, keeps naming it (AIO-1167).
 *
 * `source_item_mappings` is the trust root for one access decision that is made WITHOUT locking the
 * mapping: the common attribution repair (`lib/ingest/reattribute.ts`) admits an `external` row
 * only when a same-team `gdrive` mapping exists for it, rechecks that under the item lock, and then
 * relies on it staying true until its transaction commits. It cannot lock the mapping or the
 * provider there — both come BEFORE the item in the ingest order.
 *
 * That is sound only while no application path can take a mapping away from its item:
 *
 *   1. one writer — `lib/ingest/index.ts`, the ingest owner;
 *   2. it INSERTS (do-nothing on conflict) and afterwards updates only where the row lives —
 *      never `item_id`, `source`, `team_id` or `provider_id`;
 *   3. nothing deletes a mapping, in application code or in a migration. The row outlives its
 *      item's purge as the tombstone a restore reuses.
 *
 * A change that breaks any of these needs a lock the repair does not take today; this guard makes
 * that a build failure instead of a silent stale read.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNER = join("lib", "ingest", "index.ts");
const TABLE = "source_item_mappings";
const IDENTITY_COLUMNS = ["item_id", "source", "team_id", "provider_id"];

const BUILDER_WRITE = new RegExp(`from\\(\\s*["'\`]${TABLE}["'\`]\\s*\\)\\s*\\.\\s*(insert|update|upsert|delete)\\b`, "g");
const RAW_DML = new RegExp(`\\b(insert\\s+into|update|delete\\s+from)\\s+(?:public\\.)?${TABLE}\\b`, "i");
const SQL_DELETE = new RegExp(`\\bdelete\\s+from\\s+(?:public\\.)?${TABLE}\\b`, "i");
const SQL_UPDATE = new RegExp(`\\bupdate\\s+(?:public\\.)?${TABLE}\\b[^;]*`, "gi");

function walk(dir: string, match: RegExp, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, match, out);
    else if (match.test(name)) out.push(p);
  }
  return out;
}

/** Every builder write to the table in one source: the verb and the call's argument text. */
function builderWrites(source: string): { verb: string; call: string }[] {
  const writes: { verb: string; call: string }[] = [];
  for (const m of source.matchAll(BUILDER_WRITE)) {
    const open = source.indexOf("(", m.index! + m[0].length);
    let depth = 0;
    let end = open;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")" && --depth === 0) break;
    }
    writes.push({ verb: m[1], call: source.slice(open, end + 1) });
  }
  return writes;
}

describe("source_item_mappings: a mapping never leaves its item", () => {
  it("only the ingest owner writes the table, and no raw SQL DML touches it", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(join(ROOT, dir), /\.(ts|tsx|mjs)$/)) {
        const rel = relative(ROOT, file);
        const source = readFileSync(file, "utf8");
        if (rel !== OWNER) for (const write of builderWrites(source)) offenders.push(`${rel}: .${write.verb}(`);
        if (RAW_DML.test(source)) offenders.push(`${rel}: raw SQL DML`);
      }
    }
    expect(offenders, `source_item_mappings written outside ${OWNER}:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the owner only inserts-if-absent and relocates: no delete, no change of identity", () => {
    const writes = builderWrites(readFileSync(join(ROOT, OWNER), "utf8"));
    // Non-vacuous: the insert and the relocation are both really there.
    expect(writes.map((write) => write.verb).sort()).toEqual(["update", "upsert"]);
    for (const write of writes) {
      if (write.verb === "upsert") {
        // Insert-only: a conflicting row is left exactly as it is.
        expect(write.call, "the mapping upsert may overwrite an existing row").toMatch(/ignoreDuplicates:\s*true/);
      } else {
        for (const column of IDENTITY_COLUMNS) {
          expect(write.call, `the mapping update rewrites ${column}`).not.toMatch(new RegExp(`\\b${column}\\s*:`));
        }
      }
    }
  });

  it("no schema file or migration deletes a mapping or rewrites which item it names", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "postgres"), /\.sql$/)) {
      const rel = relative(ROOT, file);
      const sql = readFileSync(file, "utf8").replace(/--[^\n]*/g, "");
      if (SQL_DELETE.test(sql)) offenders.push(`${rel}: delete`);
      for (const update of sql.matchAll(SQL_UPDATE)) {
        const assignments = update[0].slice(update[0].search(/\bset\b/i));
        for (const column of IDENTITY_COLUMNS) {
          if (new RegExp(`\\b${column}\\s*=`, "i").test(assignments.split(/\b(?:from|where)\b/i)[0])) {
            offenders.push(`${rel}: update sets ${column}`);
          }
        }
      }
    }
    expect(offenders, `SQL that takes a mapping away from its item:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the matchers discriminate", () => {
    expect(builderWrites(`db.from("${TABLE}").delete().eq("item_id", id)`)).toEqual([{ verb: "delete", call: "()" }]);
    expect(builderWrites(`db\n  .from("${TABLE}")\n  .update({ item_id: other })`)[0]).toMatchObject({ verb: "update" });
    expect(builderWrites(`db.from("${TABLE}").select("item_id")`)).toEqual([]);
    expect(RAW_DML.test(`runSql("delete from ${TABLE} where item_id=$1")`)).toBe(true);
    expect(RAW_DML.test(`runSql("select item_id from ${TABLE} where team_id=$1 for update")`)).toBe(false);
    expect(SQL_DELETE.test(`DELETE FROM public.${TABLE};`)).toBe(true);
  });
});
