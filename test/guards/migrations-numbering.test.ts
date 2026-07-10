import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Migration numbering/replay hygiene (playbook §4/§7). `npm run pg:schema` applies the
 * files in `postgres/migrations/` in lexical filename order (after `schema.sql`); a duplicate
 * or malformed timestamp prefix silently changes apply order and breaks replay-from-zero
 * (which `npm run db:test:up` exercises). This guard fails the build on a bad prefix so the
 * error surfaces in review, not on the next deploy.
 */

const MIG_DIR = join(import.meta.dirname, "..", "..", "postgres", "migrations");
const NAME_RE = /^(\d{14})_[a-z0-9_]+\.sql$/; // YYYYMMDDHHMMSS_snake_name.sql

function migrationFiles(): string[] {
  return readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

describe("migration numbering", () => {
  it("every migration has a valid 14-digit timestamp prefix", () => {
    const bad = migrationFiles().filter((f) => !NAME_RE.test(f));
    expect(bad, `Malformed migration names (need YYYYMMDDHHMMSS_name.sql):\n${bad.join("\n")}`).toEqual(
      []
    );
  });

  it("no duplicate timestamp prefixes (apply order is unambiguous)", () => {
    const prefixes = migrationFiles().map((f) => f.slice(0, 14));
    const dupes = prefixes.filter((p, i) => prefixes.indexOf(p) !== i);
    expect([...new Set(dupes)], `Duplicate migration prefixes:\n${dupes.join("\n")}`).toEqual([]);
  });

  it("lexical order equals chronological order (replay-safe)", () => {
    const files = migrationFiles();
    const byPrefix = [...files].sort((a, b) => a.slice(0, 14).localeCompare(b.slice(0, 14)));
    expect(files).toEqual(byPrefix);
  });

  it("the matchers discriminate (non-vacuity)", () => {
    expect(NAME_RE.test("20260614190000_policy_engine.sql")).toBe(true);
    expect(NAME_RE.test("001_policy.sql")).toBe(false); // not a 14-digit timestamp
    expect(NAME_RE.test("20260614190000-policy.sql")).toBe(false); // wrong separator
  });
});
