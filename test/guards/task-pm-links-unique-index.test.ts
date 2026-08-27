import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { classifyBackstop } from "@/lib/pm-sync/runs";

/**
 * ADOPTUNIQ-1 — the partial unique index on `task_pm_links` may only ever be created by a GUARDED
 * `do $$ … $$` block, and that block must catch all three demonstrated abort codes.
 *
 * WHY A BUILD-FAILING GUARD RATHER THAN A COMMENT. `scripts/pg-load-schema.mjs` loads
 * `postgres/schema.sql` FIRST (:69) and then the migrations (:72-78), and — unlike a column inside
 * `create table if not exists`, which is a no-op on an existing DB — a top-level
 * `create unique index` DOES execute against an existing database. `schema.sql` is sent as a single
 * multi-statement query, i.e. ONE implicit transaction, so an unguarded failure there aborts the
 * ENTIRE schema load on a deploy where the old app version is still serving and still writing these
 * rows. "Someone tidies the guarded block into a plain create index" is the regression this exists to
 * make impossible, and it is exactly the kind of edit that looks like cleanup in review.
 *
 * Every `when` clause below traces to a STAGED failure against real Postgres 16, not a guess:
 *   • unique_violation (23505)   — duplicate data.
 *   • lock_not_available (55P03) — `pg-load-schema.mjs:66-67` sets `lock_timeout`; a lock wait past it
 *     escaped a 23505-only handler on a CLEAN table and aborted the release.
 *   • deadlock_detected (40P01)  — `deadlock_timeout` defaults to 1s, well before the 15s
 *     `lock_timeout`; a staged cycle picked this transaction as victim and aborted the release, again
 *     with zero dirty data.
 */

const ROOT = join(__dirname, "..", "..");
const SCHEMA = join(ROOT, "postgres", "schema.sql");
const MIGRATIONS_DIR = join(ROOT, "postgres", "migrations");
const MIGRATION = join(MIGRATIONS_DIR, "20260826230000_task_pm_links_provider_resource_uq.sql");

const INDEX_NAME = "task_pm_links_provider_resource_uq";

/**
 * Strip SQL line comments before matching.
 *
 * NOT cosmetic: `20260817164500_task_pm_links_declared_external_id.sql:12-16` already DESCRIBES this
 * index in prose, and this migration's own header quotes the DDL repeatedly. A comment-blind matcher
 * would count those as creators and the "exactly one creator" assertion below would pass for the
 * wrong reason — the guard would then survive the deletion of the real statement.
 */
export function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

/**
 * Count real `create unique index` statements ON `task_pm_links` (comments excluded).
 *
 * Matched on the TABLE, not on our index NAME. Keying on the name let a bare equivalent index under
 * any other spelling escape the guard entirely and restore the preDeploy abort path this whole file
 * exists to prevent — the invariant is "no unguarded unique index on this table", not "no unguarded
 * index called X".
 */
export function countCreators(sql: string): number {
  const code = stripSqlComments(sql).toLowerCase();
  return (code.match(/create\s+unique\s+index[^;]*?\btask_pm_links\b/g) ?? []).length;
}

/**
 * Is every creator in this file inside a `do $$ … $$` body that catches all three codes?
 *
 * Written as a ∀ over the file's DO blocks containing a creator: an existential ("some block has the
 * handlers") is satisfied by a sibling block the regression never touched, which is precisely the
 * failure mode that makes a guard decorative.
 */
export function creatorsAreGuarded(sql: string): boolean {
  const code = stripSqlComments(sql).toLowerCase();
  const blocks = code.match(/do\s+\$\$[\s\S]*?end\s*\$\$/g) ?? [];
  const creatorsInBlocks = blocks.reduce((n, b) => n + countCreators(b), 0);
  if (creatorsInBlocks !== countCreators(code)) return false; // a creator outside any DO block
  return blocks
    .filter((b) => countCreators(b) > 0)
    .every(
      (b) =>
        b.includes("when unique_violation") &&
        b.includes("when lock_not_available") &&
        b.includes("when deadlock_detected"),
    );
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => join(MIGRATIONS_DIR, f));
}

describe("ADOPTUNIQ-1 — the unique index has exactly one guarded creator per target file", () => {
  it("BOTH target files carry exactly ONE real creator", () => {
    // POSITIVE, not merely a rejection. A rejection-only matcher ("no bare create") stays green
    // forever if someone deletes the index entirely — and was green against the pre-change tree,
    // where no such index existed at all.
    expect(countCreators(readFileSync(SCHEMA, "utf8")), "postgres/schema.sql").toBe(1);
    expect(countCreators(readFileSync(MIGRATION, "utf8")), "the ADOPTUNIQ-1 migration").toBe(1);
  });

  it("EVERY other migration file carries ZERO creators", () => {
    for (const f of migrationFiles()) {
      if (f === MIGRATION) continue;
      expect(countCreators(readFileSync(f, "utf8")), f).toBe(0);
    }
  });

  it("every creator in both files is inside a DO block catching all THREE codes", () => {
    for (const f of [SCHEMA, MIGRATION]) {
      expect(creatorsAreGuarded(readFileSync(f, "utf8")), f).toBe(true);
    }
  });

  it("no file reaches the same invariant via `alter table … add constraint … unique`", () => {
    // The index is not the only way to add this constraint, and a UNIQUE CONSTRAINT cannot be
    // partial — it would reject the NULL-resource-id orphan rows the predicate deliberately permits,
    // and it has no `if not exists`, so it would abort every replay. Forbidden outright.
    const forbidden = /alter\s+table[^;]*task_pm_links[^;]*add\s+constraint[^;]*unique/i;
    for (const f of [SCHEMA, ...migrationFiles()]) {
      expect(forbidden.test(stripSqlComments(readFileSync(f, "utf8"))), f).toBe(false);
    }
  });
});

describe("ADOPTUNIQ-1 — the guard is non-vacuous (in-memory fixtures, repo files untouched)", () => {
  const GUARDED = `do $$
begin
  create unique index if not exists ${INDEX_NAME}
    on task_pm_links (team_id, provider, provider_resource_id)
    where provider_resource_id is not null;
exception
  when unique_violation then raise warning 'x';
  when lock_not_available then raise warning 'y';
  when deadlock_detected then raise warning 'z';
end $$;`;

  it("accepts the real shape", () => {
    expect(countCreators(GUARDED)).toBe(1);
    expect(creatorsAreGuarded(GUARDED)).toBe(true);
  });

  it("REJECTS a bare create outside any DO block — the tidy-up regression", () => {
    const bare = `create unique index if not exists ${INDEX_NAME} on task_pm_links (team_id, provider, provider_resource_id) where provider_resource_id is not null;`;
    expect(countCreators(bare)).toBe(1);
    expect(creatorsAreGuarded(bare)).toBe(false);
  });

  /**
   * One condition per fixture: each mutant drops exactly ONE `when` clause, so a fixture cannot pass
   * by tripping a different term than the one it targets.
   */
  it.each([
    ["unique_violation", "when unique_violation then raise warning 'x';"],
    ["lock_not_available", "when lock_not_available then raise warning 'y';"],
    ["deadlock_detected", "when deadlock_detected then raise warning 'z';"],
  ])("REJECTS a block missing `when %s`", (_name, clause) => {
    const mutant = GUARDED.replace(`  ${clause}\n`, "");
    expect(mutant, "the mutation must actually change the fixture").not.toBe(GUARDED);
    expect(creatorsAreGuarded(mutant)).toBe(false);
  });

  it("REJECTS an equivalent unique index under a DIFFERENT name", () => {
    // Keying the matcher on our index NAME let this through, and a bare create on this table is the
    // preDeploy abort path regardless of what it is called.
    const aliased = `create unique index if not exists some_other_name on task_pm_links (team_id, provider, provider_resource_id) where provider_resource_id is not null;`;
    expect(countCreators(aliased)).toBe(1);
    expect(creatorsAreGuarded(aliased)).toBe(false);
  });

  it("is COMMENT-AWARE: prose quoting the DDL is not a creator", () => {
    // 20260817164500 already describes this index in prose; without this, that file would count as a
    // creator and the per-file counts above would be satisfied by a comment.
    const prose = `-- create unique index if not exists ${INDEX_NAME} on task_pm_links (...)
-- (deliberately not shipped here)
select 1;`;
    expect(countCreators(prose)).toBe(0);
  });

  it("a commented-out creator does not satisfy the exactly-one count", () => {
    const commentedOnly = GUARDED.split("\n").map((l) => `-- ${l}`).join("\n");
    expect(countCreators(commentedOnly)).toBe(0);
  });
});

describe("ADOPTUNIQ-1 — backstop classification fails CLOSED", () => {
  const GOOD =
    "CREATE UNIQUE INDEX task_pm_links_provider_resource_uq ON public.task_pm_links USING btree (team_id, provider, provider_resource_id) WHERE (provider_resource_id IS NOT NULL)";

  it("a correct, valid index is `installed`", () => {
    expect(classifyBackstop({ indexdef: GOOD, isvalid: true })).toBe("installed");
  });

  it("an absent index is `missing`, never `installed`", () => {
    expect(classifyBackstop(null)).toBe("missing");
  });

  it("an INVALID index of the right shape is `malformed`", () => {
    // A failed CREATE INDEX CONCURRENTLY leaves an invalid index that enforces nothing.
    expect(classifyBackstop({ indexdef: GOOD, isvalid: false })).toBe("malformed");
  });

  /**
   * These are the cases `create unique index IF NOT EXISTS` silently accepts: it matches on NAME
   * alone, so any same-named relation makes the deploy look successful while enforcing nothing (or
   * the wrong thing). One condition per fixture.
   */
  it.each([
    ["not unique", GOOD.replace("CREATE UNIQUE INDEX", "CREATE INDEX")],
    ["wrong column order", GOOD.replace("(team_id, provider, provider_resource_id)", "(provider, team_id, provider_resource_id)")],
    ["missing a key column", GOOD.replace("(team_id, provider, provider_resource_id)", "(team_id, provider_resource_id)")],
    ["no partial predicate", GOOD.replace(" WHERE (provider_resource_id IS NOT NULL)", "")],
    ["wrong predicate", GOOD.replace("IS NOT NULL", "IS NULL")],
    ["wrong table", GOOD.replace("public.task_pm_links", "public.tasks")],
    ["wrong schema", GOOD.replace("public.task_pm_links", "other.task_pm_links")],
    ["carrying INCLUDE columns", GOOD.replace(" WHERE (", " INCLUDE (task_id) WHERE (")],
    ["carrying a trailing clause we never asked for", GOOD + " NULLS NOT DISTINCT"],
  ])("a same-named index that is %s reads as `malformed`", (_name, indexdef) => {
    expect(indexdef, "the mutation must actually change the fixture").not.toBe(GOOD);
    expect(classifyBackstop({ indexdef, isvalid: true })).toBe("malformed");
  });

  it("whitespace-normalises rather than string-matching our source DDL", () => {
    const noisy = GOOD.replace(/ /g, "  ").replace("USING", "\n  USING");
    expect(classifyBackstop({ indexdef: noisy, isvalid: true })).toBe("installed");
  });
});
