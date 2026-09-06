import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Access-chain single-writer guard (spec §4, CLAUDE.md §2 principle 2). The edge tables
 * `groups` / `group_members` / `project_groups` ARE the permission model — every invariant the
 * writer enforces (built-ins machine-maintained, eligibility refusals, singleton = exactly its
 * person) is enforced by lib/access/groups.ts for application writes. The frozen SQL
 * historical materializer is the sole SQL exception below. Reads
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
/**
 * Context-substrate tables (spec §4 slice 4): each has ONE owner module. The membership table
 * IS an access edge (the oracle reads it for canSee), so it gets the same single-writer rigor.
 */
const SUBSTRATE: { table: string; writer: string }[] = [
  { table: "project_context_units", writer: join("lib", "projects", "context", "units.ts") },
  { table: "project_context_memberships", writer: join("lib", "projects", "context", "memberships.ts") },
];
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
/**
 * Explicit READ exemptions for the coarse "names + has write verbs" net. Each entry is a
 * cross-table READ that legitimately appears in a file that also writes its OWN table — the
 * precise chain-scan (`writesTo`) confirms these are NOT writes. Auditable by construction:
 * a new entry has to be justified as a read here, and the chain-scan still catches an actual
 * write. `lib/projects/context/memberships.ts` reads `project_groups` (no-widening gate) and
 * `project_context_units` (the unit's inherited audience) while writing only memberships.
 */
const READ_EXEMPT = new Set<string>([
  `${join("lib", "projects", "context", "memberships.ts")}:project_groups`,
  `${join("lib", "projects", "context", "memberships.ts")}:project_context_units`,
  // enforce.ts READS memberships (visibleItemIdsForProjects — the oracle conjunct); its only
  // "write verb" is `createHash(...).update(...)` in the §5.8 visibility hash. Chain-scan clean.
  `${join("lib", "access", "enforce.ts")}:project_context_memberships`,
  // ENFB-1: canSeeItem READS the item's unit directly (the by-id probe — one unit lookup
  // instead of materializing the whole visible set); same file, same zero writes.
  `${join("lib", "access", "enforce.ts")}:project_context_units`,
]);
function mentionsWithWrites(rel: string, source: string, table: string): boolean {
  if (READ_EXEMPT.has(`${rel}:${table}`)) return false;
  const quoted = [`"${table}"`, `'${table}'`, "`" + table + "`"];
  return quoted.some((q) => source.includes(q)) && WRITE_VERBS.test(source);
}

/** SQL DML against an edge/credential table anywhere in postgres/ — migrations never seed access. */
const SQL_DML = new RegExp(
  `(insert\\s+into|update|delete\\s+from)\\s+(public\\.)?(${[...EDGE_TABLES, TOKEN_TABLE, "project_context_memberships"].join("|")})\\b`,
  "i"
);

// Only the named historical body in schema.sql may write access edges. Match its
// closing dollar tag, never an arbitrary next function body.
function stripMaterializer(source: string): string {
  return source.replace(
    /(create\s+or\s+replace\s+function\s+materialize_builtin_membership_once\s*\(\s*\)[\s\S]*?\bas\s+)(\$\w*\$)[\s\S]*?\2\s*;/i,
    "$1$2$2;"
  );
}
function sqlWrites(file: string, source: string): boolean {
  return SQL_DML.test(file === "postgres/schema.sql" ? stripMaterializer(source) : source);
}
const uncomment = (source: string) => source.replace(/--[^\n]*/g, "");

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
          if (!writesTo(source, table) && mentionsWithWrites(rel, source, table)) {
            offenders.push(`${rel} names ${table} in a file with write verbs (variable-table idiom?)`);
          }
        }
        if (rel !== TOKEN_WRITER && (writesTo(source, TOKEN_TABLE) || mentionsWithWrites(rel, source, TOKEN_TABLE))) {
          offenders.push(`${rel} writes/names ${TOKEN_TABLE} outside its single writer`);
        }
        for (const { table, writer } of SUBSTRATE) {
          if (rel !== writer && (writesTo(source, table) || mentionsWithWrites(rel, source, table))) {
            offenders.push(`${rel} writes/names ${table} outside ${writer}`);
          }
        }
      }
    }
    expect(offenders, `access edges written outside the single writer:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("SQL access writes are confined to the frozen schema materializer", () => {
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
      if (sqlWrites(relative(ROOT, file), source)) offenders.push(relative(ROOT, file));
    }
    expect(offenders, `SQL DML against access edges:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("AC7: permits only the named body, with outside, other-body and migration controls", () => {
    const schema = readFileSync(join(ROOT, "postgres/schema.sql"), "utf8");
    expect(schema).toMatch(/create or replace function materialize_builtin_membership_once/i);
    expect(sqlWrites("postgres/schema.sql", schema)).toBe(false);
    for (const write of ["insert into groups (slug) values ('bad');", "delete from group_members;"]) {
      expect(sqlWrites("postgres/schema.sql", schema + write)).toBe(true);
      expect(sqlWrites("postgres/schema.sql", schema.replace(/(function audit_protect\(\)[\s\S]*?as \$\$)/i, `$1\n${write}`))).toBe(true);
      expect(sqlWrites("postgres/migrations/control.sql", write)).toBe(true);
    }
    const migrationPath = "postgres/migrations/20260818210000_pret6_retire_access_enforcement.sql";
    const migration = readFileSync(join(ROOT, migrationPath), "utf8");
    expect(sqlWrites(migrationPath, migration + "\ndelete from group_members;")).toBe(true);
    const tagged = "create or replace function materialize_builtin_membership_once() returns boolean language plpgsql as $historical$ begin insert into groups values (1); end $historical$;";
    expect(sqlWrites("postgres/schema.sql", tagged)).toBe(false);
    expect(sqlWrites("postgres/schema.sql", tagged + "delete from groups;")).toBe(true);
  });

  it("AC7/AC8: migration calls the sole definition, independently of comments", () => {
    const migration = readFileSync(join(ROOT, "postgres/migrations/20260818210000_pret6_retire_access_enforcement.sql"), "utf8");
    const call = /perform\s+materialize_builtin_membership_once\s*\(\s*\)/i;
    expect(uncomment(migration)).toMatch(call);
    const executable = uncomment(migration);
    expect(executable.indexOf("raise exception 'PRET-6 refused: permissive")).toBeLessThan(executable.search(call));
    expect(executable.search(call)).toBeLessThan(executable.indexOf("alter table teams drop column"));
    expect(uncomment(migration.replace(call, ""))).not.toMatch(call);
    const definitions: string[] = [];
    function scan(dir: string) {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        if (statSync(file).isDirectory()) scan(file);
        else if (name.endsWith(".sql")) {
          for (const match of uncomment(readFileSync(file, "utf8")).matchAll(/create\s+(?:or\s+replace\s+)?function\s+materialize_builtin_membership_once\s*\(/gi)) {
            if (match) definitions.push(relative(ROOT, file));
          }
        }
      }
    }
    scan(join(ROOT, "postgres"));
    expect(definitions).toEqual(["postgres/schema.sql"]);
  });

  it("non-vacuous for the substrate: each owner module DOES write its table", () => {
    for (const { table, writer } of SUBSTRATE) {
      const source = readFileSync(join(ROOT, writer), "utf8");
      expect(writesTo(source, table), `expected ${writer} to write ${table}`).toBe(true);
    }
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
