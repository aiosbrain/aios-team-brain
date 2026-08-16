import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard for `chat_turn_runs` (CLAUDE.md §2, QBGSTREAM-1).
 *
 * The table is owner-scoped with NO RLS backstop, so every write must carry the `(team_id, member_id)`
 * filter that `lib/query/turn-runs` applies. `docs/ARCHITECTURE.md` already DECLARES that module the
 * single writer — this test is what makes the claim true rather than aspirational, failing the build if
 * anything else inserts/updates/deletes the table. Sibling of `single-writer-chat`; written now because
 * the map asserts the invariant, and a documented invariant nothing enforces is the exact shape that
 * drifts silently.
 *
 * Reads are not the concern here: the reader helpers in `turn-runs` are the gate, and a stray SELECT is
 * caught by the tier/owner tests. The write path is what this locks down.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNER = join("lib", "query", "turn-runs.ts"); // the only legal writer

/**
 * A FACTORY returning a fresh literal, not a shared `/g` regex.
 *
 * Two reasons, and both bite: a `/g` regex carries `lastIndex`, so reusing one instance across files
 * (or across a scan and an assertion) silently skips matches — a guard that reports zero offenders
 * because of parser state is worse than no guard. And building a fresh one via `new RegExp(src, "g")`
 * trips the non-literal-RegExp rule. A literal in a factory gets both properties for free.
 */
const writeRe = () => /from\(\s*["'](chat_turn_runs)["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g;

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
      if (rel === OWNER) continue; // the sanctioned writer
      if (rel.endsWith(".test.ts") || rel.includes("fake-supabase")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(writeRe())) hits.push(`${rel}: .from("${m[1]}").${m[2]}(`);
    }
  }
  return hits.sort();
}

describe("single-writer: chat_turn_runs", () => {
  it("only lib/query/turn-runs writes the run table", () => {
    const violations = offenders();
    expect(
      violations,
      `Only lib/query/turn-runs may write chat_turn_runs (owner-scoped, no RLS). Offenders:\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    const W = writeRe;
    expect(W().test('await db.from("chat_turn_runs").insert(rec)')).toBe(true);
    expect(W().test('db.from("chat_turn_runs").update({ status: "done" })')).toBe(true);
    expect(W().test('db.from("chat_turn_runs").delete()')).toBe(true);
    // Reads are allowed, and a DIFFERENT table's write must not trip this guard.
    expect(W().test('db.from("chat_turn_runs").select("id")')).toBe(false);
    expect(W().test('db.from("chat_messages").insert(rec)')).toBe(false);
  });

  it("the owner file really does write the table (the guard is guarding something)", () => {
    const src = readFileSync(join(ROOT, OWNER), "utf8");
    const writes = [...src.matchAll(writeRe())];
    expect(writes.length).toBeGreaterThan(0);
  });
});
