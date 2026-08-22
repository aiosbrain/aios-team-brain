import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * GUARD: ONE definition of "can any eligible principal read this item" (AUDITFIX-15A AC8).
 *
 * The defect this exists for: `findUnpartitionedItems` carried its own idea of reachability — a
 * `project_groups` grant was enough — while the oracle requires an eligible principal to hold a
 * `group_members` row in a granted group. Two definitions of one predicate, and the weaker one fed
 * the health check.
 *
 * ⚠️ WHY A CALL-GRAPH CHECK AND NOT A STRING COUNT. The spec's first mechanism was "the predicate
 * appears at exactly one definition site", which a review killed as satisfiable vacuously: one SQL
 * template can delegate to duplicated fragments, and both readers can share one WRONG constant. So
 * this asserts the STRUCTURE — every substrate read in the module flows through the one exported
 * function — and leaves the MEANING to the truth-table matrix in
 * `test/datamechanics/reachability-predicate.datamechanics.test.ts`, which is where meaning belongs.
 *
 * ⚠️ WHAT IT DOES NOT CATCH, stated rather than implied (Fable diff review). It sees only literal
 * string SQL: a template with a `${…}` substitution, or `"from " + "items"`, is invisible to it. And
 * the call-graph half inspects only the direct body of `findUnpartitionedItems`, so a HELPER
 * elsewhere in this module doing its own grant-only read — the original defect's exact shape — would
 * pass both assertions. The residual protection is the dm matrix, which pins the reader's behaviour
 * for every enumerated case, so behaviour-changing drift still reddens. Read this as a tripwire on
 * the module's structure, not a proof that one definition exists.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const COVERAGE = "lib/projects/context/coverage.ts";
const src = () => readFileSync(join(ROOT, COVERAGE), "utf8");
const parse = (code: string) => ts.createSourceFile(COVERAGE, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** Every string literal in the file that is a SQL statement reading the access substrate. */
function substrateQueries(code: string): string[] {
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /\bfrom\s+items\b|\bproject_context_units\b|\bproject_context_memberships\b|\bproject_groups\b|\bgroup_members\b/i.test(n.text)) {
      found.push(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(parse(code));
  return found;
}

describe("AUDITFIX-15A — one owner of the reachability predicate", () => {
  it("the module holds exactly ONE substrate query, and it is the canonical one", () => {
    const qs = substrateQueries(src());
    expect(qs, "a second substrate query here IS the drift this guard exists to stop").toHaveLength(1);
    // The clauses a review proved a generic principal join gets wrong. Each is load-bearing:
    // without the builtin arm an agent planted in `everyone` grants reachability it never has.
    expect(qs[0]).toMatch(/group_members/);
    expect(qs[0]).toMatch(/is_builtin\s*=\s*false/);
    expect(qs[0]).toMatch(/kind\s*=\s*'human'/);
    expect(qs[0]).toMatch(/is_connector/);
    expect(qs[0]).toMatch(/state\s*=\s*'active'/);
    expect(qs[0]).toMatch(/decision\s*=\s*'include'/);
    expect(qs[0]).toMatch(/valid_to is null/);
  });

  it("`findUnpartitionedItems` reaches the substrate ONLY through `unreachableItems`", () => {
    const code = src();
    const sf = parse(code);
    let inFn = false;
    let delegates = false;
    const forbidden: string[] = [];
    const visit = (n: ts.Node): void => {
      const isTarget =
        ts.isFunctionDeclaration(n) && n.name?.text === "findUnpartitionedItems";
      if (isTarget) inFn = true;
      if (inFn && ts.isCallExpression(n)) {
        if (ts.isIdentifier(n.expression) && n.expression.text === "unreachableItems") delegates = true;
        if (ts.isIdentifier(n.expression) && n.expression.text === "runSql") forbidden.push("runSql");
      }
      // A re-inlined `db.from("project_context_units")` inside the reader is the regression.
      if (inFn && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "from") {
        const arg = n.arguments[0];
        if (arg && ts.isStringLiteralLike(arg) && arg.text !== "items") forbidden.push(`db.from("${arg.text}")`);
      }
      ts.forEachChild(n, visit);
      if (isTarget) inFn = false;
    };
    visit(sf);
    expect(delegates, "the reader must call the canonical function").toBe(true);
    expect(forbidden, "re-inlining a substrate read here re-creates the two-definitions defect").toEqual([]);
  });
});
