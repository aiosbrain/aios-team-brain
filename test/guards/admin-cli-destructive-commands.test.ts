import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The two admin-CLI commands whose absence forced operators into raw SQL against a production
 * brain. Both are thin shells over an audited primitive, which is exactly why they need pinning:
 * the primitive keeps its own tests green whether or not anything still calls it, and a deleted
 * `case` in a switch statement is invisible to every one of them.
 *
 *  • (PRET-6: the flip command retired — its absence is now itself pinned below.)
 *  • `purge-items` — the ONLY caller of `purgeItemIds` outside the ingest paths, and deliberately
 *    NOT of `purgeItemsByPathPrefix`: the prefix form is team-wide and the workspace path roots are
 *    shared across projects, so exposing it on a command line would let one typo delete a team's
 *    real content. That absence is a decision, so it gets a test.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const cli = () => readFileSync(join(ROOT, "scripts", "admin.ts"), "utf8");

describe("admin CLI — the destructive/one-way commands", () => {
  it("PRET-6: the flip command is GONE and the CLI still never writes teams directly", () => {
    const src = cli();
    expect(src, "the retired flip command must not resurface").not.toMatch(/set-access-enforcement/);
    expect(src, "the CLI must never write the teams table directly").not.toMatch(
      /from\(\s*["']teams["']\s*\)\s*\.\s*update/
    );
    expect(src, "the re-homed health check is documented").toMatch(/access-health <team-slug>/);
  });

  it("purge-items goes through purgeItemIds and never exposes the path-prefix purge", () => {
    const src = cli();
    expect(src).toMatch(/case "purge-items":/);
    expect(src).toMatch(/purgeItemIds\s*\(/);
    // Named in a comment is fine (the absence is documented there); imported or CALLED is not.
    expect(
      src,
      "purgeItemsByPathPrefix is team-wide and path-scoped — it must stay unreachable from a command line"
    ).not.toMatch(/purgeItemsByPathPrefix\s*\(/);
    expect(src, "and it must not even be imported here").not.toMatch(/import\s*\{[^}]*purgeItemsByPathPrefix/);
    expect(src, "must not delete items itself — the primitive retires graph episodes first").not.toMatch(
      /from\(\s*["']items["']\s*\)\s*\.\s*delete/
    );
  });

  it("purge-items is dry-run by default — deleting requires --confirm", () => {
    const src = cli();
    const body = src.slice(src.indexOf('case "purge-items":'));
    const command = body.slice(0, body.indexOf('case "sync-github":'));
    expect(command, "an explicit confirmation flag must gate the delete").toMatch(/flags\.confirm/);
    // The purge call must be UNREACHABLE without --confirm: the early `break` on the dry-run branch
    // has to come first. If someone reorders these, a bare `purge-items` deletes production content.
    expect(command.indexOf("if (!flags.confirm)")).toBeGreaterThan(-1);
    expect(
      command.indexOf("if (!flags.confirm)"),
      "the dry-run guard must precede the purge call"
    ).toBeLessThan(command.indexOf("purgeItemIds("));
  });

});
// PRET-6: the enforcement-mode literal arm retired with the flag (its subject no longer exists).
