import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Closes the escape hatch under EVERY single-writer guard (CLAUDE.md §2).
 *
 * Those guards match a LITERAL table name — `from("media_assets").update(` — so a write through a
 * VARIABLE table name (`db.from(table).update(...)`) passes all of them silently, no matter which table
 * it hits at runtime. This isn't hypothetical: the social tier cascade was first written that way and
 * wrote `media_assets`, `social_publications` and `publication_analytics` from `lib/social/store.ts`
 * with the full unit tier green. The guards only caught it once the writes were made literal.
 *
 * So: a dynamic-table WRITE has to be declared here. Reads are unrestricted — a guard exists to protect
 * a table's invariants, and only writes can break them.
 *
 * Adding a file to `ALLOWED` is a deliberate act: state which tables it writes and why one owner can't
 * hold them. If the tables it touches are single-writer guarded, prefer calling INTO the owner (that's
 * what `narrowSocialChainForItem` does for the three tables below a variant).
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];

/**
 * `.from(<anything that isn't a plain string literal>)` followed by a mutating verb.
 *
 * Written as an EXCLUSION rather than a list of expression shapes on purpose. The first version matched
 * only bare identifiers and member expressions, which left `from(TABLES[i])`, `from(tbl as string)`,
 * `from(getTable())` and `from(\`${t}\`)` walking straight through — and a bracket-indexed loop is one of
 * the most natural ways to write the very thing this guard exists to catch. Anything that isn't a
 * literal is now suspicious by default; literals are left to the per-table single-writer guards.
 *
 * The first character may not be `'` or `"` (those are the plain string literals the per-table guards
 * own) but a BACKTICK is fair game: a template literal is dynamic, and no per-table guard matches one
 * either, so `from(\`${prefix}_items\`)` would otherwise be unguarded by everything. The optional
 * newline lets the verb sit on the next line (prettier wraps these), and one level of nested parens is
 * tolerated so a call expression (`from(getTable())`) doesn't terminate the match early.
 */
const DYNAMIC_WRITE_RE =
  /\.from\(\s*([^)'"\s](?:[^()]|\([^()]*\))*?)\s*\)\s*(?:\r?\n\s*)?\.\s*(insert|update|upsert|delete)\b/g;

const ALLOWED: { file: string; why: string }[] = [
  {
    file: join("lib", "ingest", "reclassify.ts"),
    why: "loops INHERITING_TABLES (tasks, extracted_facts, stakeholder_mentions) to cascade one tier change; none of those has a competing writer and the whole point is that the list is uniform",
  },
  {
    file: join("lib", "ingest", "evidence.ts"),
    why: "shared diff-sync for the two evidence row tables (extracted_facts, stakeholder_mentions) — it IS their single writer",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function offenders(): string[] {
  const hits: string[] = [];
  for (const d of SCAN_DIRS) {
    for (const file of walk(join(ROOT, d))) {
      const rel = file.slice(ROOT.length + 1);
      if (ALLOWED.some((a) => rel === a.file)) continue;
      if (rel.endsWith(".test.ts") || rel.includes("fake-supabase")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(DYNAMIC_WRITE_RE)) {
        hits.push(`${rel}: .from(${m[1]}).${m[2]}(`);
      }
    }
  }
  return hits.sort();
}

describe("guard: dynamic-table writes can't bypass the single-writer guards", () => {
  it("only declared files write through a variable table name", () => {
    expect(
      offenders(),
      `Writing through a variable table name evades every single-writer guard (they match literal ` +
        `table names). Either use a literal table name in that table's owner, call into the owner, ` +
        `or declare the file in ALLOWED with a reason:\n${offenders().join("\n")}`
    ).toEqual([]);
  });

  it("is non-vacuous: catches every dynamic shape, and leaves literals to the per-table guards", () => {
    // Pins the regex itself. A refactor that broke the match would otherwise make this guard silently
    // pass forever — the exact failure mode it exists to prevent, one level up. Each shape below is one
    // a real refactor could plausibly produce; the first version of this guard missed all but the first.
    const caught = [
      `await db.from(table).update({ access: "team" }).eq("id", id);`,
      `await db.from(TABLES[i]).update({ access: "team" });`,
      `await db.from(tbl as string).delete();`,
      `await db.from(getTable()).insert(row);`,
      "await db.from(`${prefix}_items`).upsert(row);",
      `await db\n  .from(cfg.table)\n  .update({ access: "team" });`,
    ];
    for (const src of caught) {
      expect([...src.matchAll(DYNAMIC_WRITE_RE)], src).toHaveLength(1);
    }

    const ignored = [
      `await db.from("media_assets").update({ access: "team" });`, // literal → per-table guards
      `await db.from('media_assets').delete();`,
      `const rows = await db.from(table).select("id");`, // a READ can't break an invariant
    ];
    for (const src of ignored) {
      expect([...src.matchAll(DYNAMIC_WRITE_RE)], src).toHaveLength(0);
    }
  });
});
