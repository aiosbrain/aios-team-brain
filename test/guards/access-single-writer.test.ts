import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Access-chain single-writer guard (spec §4, CLAUDE.md §2 principle 2). The edge tables
 * `groups` / `group_members` / `project_groups` ARE the permission model — every invariant the
 * writer enforces (built-ins machine-maintained, eligibility refusals, singleton = exactly its
 * person) is real only while lib/access/groups.ts is the ONLY module that writes them. Reads
 * are unrestricted (the oracle reads two of these tables); this guard flags a WRITE verb
 * chained after `.from("<edge table>")` anywhere outside the single writer.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const SINGLE_WRITER = join("lib", "access", "groups.ts");
const EDGE_TABLES = ["groups", "group_members", "project_groups"];
const WRITE_VERBS = /\.\s*(insert|upsert|update|delete)\s*\(/;

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
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

/** Every `.from("<table>")` occurrence followed (within the same chain, ~200 chars) by a write verb. */
function writesTo(source: string, table: string): boolean {
  const needle = new RegExp(`\\.from\\((["'])${table}\\1\\)`, "g");
  for (let m = needle.exec(source); m; m = needle.exec(source)) {
    const window = source.slice(m.index, m.index + 200);
    if (WRITE_VERBS.test(window)) return true;
  }
  return false;
}

describe("access-chain single writer", () => {
  it("only lib/access/groups.ts writes groups/group_members/project_groups", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (rel === SINGLE_WRITER) continue;
        const source = readFileSync(file, "utf8");
        for (const table of EDGE_TABLES) {
          if (writesTo(source, table)) offenders.push(`${rel} writes ${table}`);
        }
      }
    }
    expect(offenders, `access edges written outside the single writer:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("is non-vacuous: the single writer itself DOES write all three tables", () => {
    const source = readFileSync(join(ROOT, SINGLE_WRITER), "utf8");
    for (const table of EDGE_TABLES) {
      expect(writesTo(source, table), `expected ${SINGLE_WRITER} to write ${table}`).toBe(true);
    }
  });
});

describe("oracle never reads authorship", () => {
  // Spec §5.1: authorship is never an access input — the oracle must not read items at all.
  it("lib/access/oracle.ts contains no items read", () => {
    const source = readFileSync(join(ROOT, "lib", "access", "oracle.ts"), "utf8");
    expect(source).not.toMatch(/\.from\((["'])items\1\)/);
    expect(source).not.toMatch(/items\.member_id/);
  });
});
