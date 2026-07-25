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

/** `.from(<identifier or member expression>)` immediately followed by a mutating verb. A string literal
 *  is deliberately NOT matched — that's what the per-table single-writer guards already cover. */
const DYNAMIC_WRITE_RE =
  /\.from\(\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*\)\s*(?:\r?\n\s*)?\.\s*(insert|update|upsert|delete)\b/g;

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

  it("is non-vacuous: the pattern it looks for is actually detectable", () => {
    // Pins the regex itself. A refactor that broke the match would otherwise make this guard silently
    // pass forever — the exact failure mode it exists to prevent, one level up.
    const sample = `await db.from(table).update({ access: "team" }).eq("id", id);`;
    expect([...sample.matchAll(DYNAMIC_WRITE_RE)]).toHaveLength(1);
    // …and that a literal table name is left to the per-table guards.
    const literal = `await db.from("media_assets").update({ access: "team" });`;
    expect([...literal.matchAll(DYNAMIC_WRITE_RE)]).toHaveLength(0);
  });
});
