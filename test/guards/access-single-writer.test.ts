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
/** agent_tokens is credential material — same single-writer treatment, its own owner module. */
const TOKEN_WRITER = join("lib", "access", "agent-tokens.ts");
const TOKEN_TABLE = "agent_tokens";
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
  const needle = new RegExp(`\\.from\\((["'\`])${table}\\1\\)`, "g");
  for (let m = needle.exec(source); m; m = needle.exec(source)) {
    const window = source.slice(m.index, m.index + 200);
    if (WRITE_VERBS.test(window)) return true;
  }
  return false;
}

/**
 * Coarser second net for the two globally-unambiguous table names: the literal appearing
 * ANYWHERE in a file that also contains a write verb. Catches the variable-table-name idiom
 * (`.from(table).insert(...)`) that the chain scan cannot see — that idiom is live in this
 * repo (lib/ingest/reclassify.ts, lib/social/store.ts), so a generic helper pointed at an
 * edge table must not stay green. "groups" is too common a word for this net; its chain scan
 * plus these two suffice, since a membership/grant write is what confers access.
 */
const UNAMBIGUOUS = ["group_members", "project_groups"];
function mentionsWithWrites(source: string, table: string): boolean {
  const quoted = [`"${table}"`, `'${table}'`, "`" + table + "`"];
  return quoted.some((q) => source.includes(q)) && WRITE_VERBS.test(source);
}

/** SQL DML against an edge/credential table anywhere in postgres/ — migrations never seed access. */
const SQL_DML = new RegExp(
  `(insert\\s+into|update|delete\\s+from)\\s+(public\\.)?(${[...EDGE_TABLES, TOKEN_TABLE].join("|")})\\b`,
  "i"
);

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
        for (const table of UNAMBIGUOUS) {
          if (!writesTo(source, table) && mentionsWithWrites(source, table)) {
            offenders.push(`${rel} names ${table} in a file with write verbs (variable-table idiom?)`);
          }
        }
        if (rel !== TOKEN_WRITER && (writesTo(source, TOKEN_TABLE) || mentionsWithWrites(source, TOKEN_TABLE))) {
          offenders.push(`${rel} writes/names ${TOKEN_TABLE} outside its single writer`);
        }
      }
    }
    expect(offenders, `access edges written outside the single writer:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("no SQL file seeds or mutates the access edges — built-ins are app-code-created only", () => {
    const offenders: string[] = [];
    const sqlFiles: string[] = [];
    (function walkSql(dir: string) {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walkSql(p);
        else if (name.endsWith(".sql")) sqlFiles.push(p);
      }
    })(join(ROOT, "postgres"));
    for (const file of sqlFiles) {
      const source = readFileSync(file, "utf8");
      if (SQL_DML.test(source)) offenders.push(relative(ROOT, file));
    }
    expect(offenders, `SQL DML against access edges:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("is non-vacuous: the single writer itself DOES write all three tables", () => {
    const source = readFileSync(join(ROOT, SINGLE_WRITER), "utf8");
    for (const table of EDGE_TABLES) {
      expect(writesTo(source, table), `expected ${SINGLE_WRITER} to write ${table}`).toBe(true);
    }
  });

  it("non-vacuous for tokens too, and the admin actions actually wire to the lib layer", () => {
    const tokenSource = readFileSync(join(ROOT, TOKEN_WRITER), "utf8");
    expect(writesTo(tokenSource, TOKEN_TABLE)).toBe(true);
    // Pin the call site, not just the function: the mint/revoke actions must call the lib
    // layer — deleting the wiring should redden this, not stay green (the repo's recurring
    // failure mode).
    const actions = readFileSync(join(ROOT, "app", "t", "[team]", "admin", "agents", "actions.ts"), "utf8");
    expect(actions).toMatch(/mintAgentToken\s*\(/);
    expect(actions).toMatch(/revokeAgentToken\s*\(/);
    expect(actions).toMatch(/requireAdmin\s*\(/);
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
