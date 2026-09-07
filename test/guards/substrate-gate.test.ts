import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * STAGINGMARK-2 — the substrate gate's SHAPE, which no behavioural test can pin.
 *
 * TWO findings from the diff reviews live here, and both are the repo's recurring classes:
 *
 * 1. THE AUTHORITATIVE COPY HAD NO WITNESS. The gate is checked twice on purpose — a fail-fast
 *    copy before the locks, and an authoritative copy AFTER them. Only the second is load-bearing:
 *    `items` and `project_context_memberships` both cascade from `teams`, so a not-yet-committed
 *    team deletion is invisible to the pre-lock read, and by the time the function has waited for
 *    that transaction's `teams` lock the only partitioned team can be gone. MEASURED: deleting the
 *    post-lock copy leaves every data-mechanics test green (9/9), because no single-transaction
 *    fixture can produce that interleaving. "It must stay repeated" was enforced by a comment.
 *
 * 2. THREE COPIES OF ONE PREDICATE, PINNED BY EYESIGHT. Two in SQL, one in the TypeScript CLI.
 *    Divergence between them is precisely the failure mode this slice claims to have designed
 *    away, so it gets a build-failing guard rather than discipline (CLAUDE.md §2 principle 2).
 *
 * A two-client race test is the stronger witness for (1) and is the right eventual home; this is
 * the sanctioned cheaper form, and it is deterministic.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** The predicate, written ONCE here and asserted to appear verbatim in all three places. */
const PREDICATE = "exists (select 1 from items) and not exists (select 1 from project_context_memberships)";

function functionBody(schema: string): string {
  const m = schema.match(
    /create\s+or\s+replace\s+function\s+materialize_builtin_membership_once\s*\(\s*\)[\s\S]*?\bas\s+(\$\w*\$)([\s\S]*?)\1\s*;/i
  );
  if (!m) throw new Error("materialize_builtin_membership_once definition not found in schema.sql");
  return m[2];
}

describe("STAGINGMARK-2 — the substrate gate's shape", () => {
  it("is checked TWICE in the SQL function — fail-fast, and authoritative", () => {
    const body = functionBody(read("postgres/schema.sql"));
    const hits = body.split(PREDICATE).length - 1;
    expect(hits, "the gate must appear exactly twice: fail-fast before the locks, authoritative after").toBe(2);
  });

  it("…and the AUTHORITATIVE one is after the LAST lock — the copy nothing else can catch", () => {
    const body = functionBody(read("postgres/schema.sql"));
    const lastLock = body.lastIndexOf("lock table");
    expect(lastLock, "the function must still take its locks").toBeGreaterThan(-1);
    expect(
      body.indexOf(PREDICATE, lastLock),
      "a substrate check must follow the last `lock table`: the pre-lock copy alone admits a " +
        "committing team deletion, because both tables it reads cascade from `teams`"
    ).toBeGreaterThan(lastLock);
  });

  it("the CLI enforces the SAME predicate, byte for byte", () => {
    // Three copies of one rule; a guard, not eyesight. The CLI wraps it in `select … as bad`.
    expect(read("lib/access/materialize-command.ts")).toContain(PREDICATE);
  });

  describe("negative controls — each mutation must be caught", () => {
    const body = functionBody(read("postgres/schema.sql"));
    const lastLock = body.lastIndexOf("lock table");

    it("deleting the authoritative copy leaves only a pre-lock check", () => {
      // Simulate the exact mutation that left dm 9/9 green.
      const mutated = body.slice(0, lastLock) + body.slice(lastLock).replace(PREDICATE, "false");
      expect(mutated.split(PREDICATE).length - 1, "the mutant must drop to one copy").toBe(1);
      expect(mutated.indexOf(PREDICATE, mutated.lastIndexOf("lock table"))).toBe(-1);
    });

    it("deleting the fail-fast copy is also caught by the count", () => {
      const mutated = body.slice(0, lastLock).replace(PREDICATE, "false") + body.slice(lastLock);
      expect(mutated.split(PREDICATE).length - 1).toBe(1);
    });

    it("a reworded CLI predicate no longer matches the SQL", () => {
      const drifted = read("lib/access/materialize-command.ts").replace(PREDICATE, "exists (select 1 from items)");
      expect(drifted).not.toContain(PREDICATE);
    });
  });
});
