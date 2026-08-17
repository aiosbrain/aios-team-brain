import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENFORCEMENT_MODES, isEnforcementMode } from "@/lib/admin/access-enforcement";

/**
 * The two admin-CLI commands whose absence forced operators into raw SQL against a production
 * brain. Both are thin shells over an audited primitive, which is exactly why they need pinning:
 * the primitive keeps its own tests green whether or not anything still calls it, and a deleted
 * `case` in a switch statement is invisible to every one of them.
 *
 *  • `set-access-enforcement` — the ONLY writer of `teams.access_enforcement` outside tests.
 *  • `purge-items` — the ONLY caller of `purgeItemIds` outside the ingest paths, and deliberately
 *    NOT of `purgeItemsByPathPrefix`: the prefix form is team-wide and the workspace path roots are
 *    shared across projects, so exposing it on a command line would let one typo delete a team's
 *    real content. That absence is a decision, so it gets a test.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const cli = () => readFileSync(join(ROOT, "scripts", "admin.ts"), "utf8");

describe("admin CLI — the destructive/one-way commands", () => {
  it("set-access-enforcement is wired to the audited setter and is documented in USAGE", () => {
    const src = cli();
    expect(src).toMatch(/case "set-access-enforcement":/);
    expect(src, "must go through the lib setter, not write the column itself").toMatch(/setAccessEnforcement\s*\(/);
    expect(src, "the CLI must not write teams.access_enforcement directly").not.toMatch(
      /from\(\s*["']teams["']\s*\)\s*\.\s*update/
    );
    expect(src, "an undocumented admin command may as well not exist").toMatch(/set-access-enforcement <team-slug>/);
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

  it("the enforcement mode literals are closed — a typo can never read back as 'off'", () => {
    // `teamEnforcesAccess` treats EVERY non-'enforcing' string as permissive, so a mode the CLI
    // accepted but the reader doesn't recognise would look armed and be off.
    expect([...ENFORCEMENT_MODES]).toEqual(["permissive", "enforcing"]);
    for (const bad of ["enforce", "Enforcing", "ENFORCING", "enforcing ", "", "true", "on", "strict"]) {
      expect(isEnforcementMode(bad), `'${bad}' must be rejected`).toBe(false);
    }
    for (const good of ENFORCEMENT_MODES) expect(isEnforcementMode(good)).toBe(true);
  });
});
