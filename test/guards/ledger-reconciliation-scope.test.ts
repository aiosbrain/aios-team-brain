import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GUARD: the ledger sum compared against a provider's billing figure must be scoped to THAT provider,
 * and must never be short.
 *
 * The provider total comes from one provider's API. Summing every provider against it dilutes the gap
 * toward zero — an Anthropic list-price estimate is real ledger spend that OpenRouter never charged,
 * so counting it "accounts for" money that key never saw and quietly erases the shortfall this whole
 * feature exists to expose. It shipped that way in review and would have been invisible the moment a
 * second provider key was added: today every row is `openrouter`, so no behavioural test can catch it.
 *
 * BOTH INVARIANTS SURVIVED A CHANGE OF MECHANISM, which is why this guard is now phrased against the
 * behaviour rather than the old code shape. The lifetime total used to be a 500,000-row fetch summed
 * in JS, which returned `null` on hitting the cap rather than report a short sum. That refusal was
 * the right instinct — and it is precisely why this reconciliation banner stayed correct while the
 * /costs headline beside it truncated at 100,000 rows and under-reported by $10 (AIO-687). The
 * implementation is now an exact SQL `SUM`, so there is no cap left to refuse at: "never short" is
 * satisfied by construction instead of by a guard clause. What must never come back is a capped fetch.
 */
const ROOT = process.cwd();
const COSTS = readFileSync(join(ROOT, "lib", "metrics", "llm-costs.ts"), "utf8");

/** Comments describe the hazard; they are not the hazard. A `.limit(` inside prose must not trip this. */
function stripComments(src: string): string {
  return src
    .replace(/(^|[\s(,;=:[{])\/\*[\s\S]*?\*\//g, "$1 ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const SPEND = stripComments(readFileSync(join(ROOT, "lib", "metrics", "llm-spend.ts"), "utf8"));

/**
 * The lifetime-sum implementation ONLY — bounded to the function, not sliced to end-of-file. An
 * open-ended slice would silently start asserting against whatever function is appended below it.
 */
function sliceFn(name: string): string {
  const start = SPEND.indexOf(`export async function ${name}`);
  if (start === -1) throw new Error(`${name} not found — the guard is looking at the wrong shape`);
  const rest = SPEND.slice(start + 1);
  const next = rest.indexOf("\nexport ");
  return next === -1 ? SPEND.slice(start) : SPEND.slice(start, start + 1 + next);
}

const impl = sliceFn("getLedgerLifetimeUsdExact");
/**
 * The MONTH sum has the identical hazard this guard exists for — an unscoped provider sum shipped in
 * review once, and no behavioural test can catch it while every row in the table is openrouter. Added
 * with the month reconciliation (AIO-805) so dropping `provider = $2` from EITHER query reddens.
 */
const monthImpl = sliceFn("getLedgerMonthUsdExact");

describe("guard: the lifetime ledger sum is provider-scoped and never short", () => {
  it("filters llm_usage by provider", () => {
    // The one filter that makes the comparison meaningful at all.
    expect(impl).toMatch(/provider = \$\d/);
    expect(impl).toMatch(/team_id = \$\d/); // and never crosses teams
  });

  it("the MONTH sum carries the same scoping, and a session-independent boundary", () => {
    expect(monthImpl).toMatch(/provider = \$\d/);
    expect(monthImpl).toMatch(/team_id = \$\d/);
    expect(monthImpl).toMatch(/sum\(cost_usd\)/);
    // The double AT TIME ZONE is what makes the boundary independent of the session TimeZone (nothing
    // pins it in lib/db/pg/pool). Truncating without converting back is correct only by coincidence
    // of server config, and moves up to +/-14h of spend across the boundary when that changes.
    expect(monthImpl).toMatch(/at time zone 'utc'\)\)? at time zone 'utc'/);
  });

  it("computes an exact SUM rather than fetching rows", () => {
    // Fetch-and-sum is what put a cap in the path in the first place. `SUM` has no cap to outgrow.
    expect(impl).toMatch(/sum\(cost_usd\)/);
    expect(impl).not.toMatch(/\.limit\(/);
    expect(impl).not.toMatch(/\.reduce\(/);
  });

  it("cannot return a short sum — there is no row cap left in the path", () => {
    // The original invariant restated for the new mechanism: previously "refuse at the cap", now
    // "there is no cap". Either satisfies it; a capped fetch that sums anyway satisfies neither.
    expect(impl).not.toMatch(/ROW_CAP/);
  });

  it("still returns null when the query fails, so the caller shows nothing rather than a wrong figure", () => {
    // A confident overstatement is worse than showing no reconciliation at all.
    expect(impl).toMatch(/catch\s*\{[\s\S]*return null/);
  });

  it("the public entry point delegates to that implementation", () => {
    // Guarding the implementation is worthless if the page calls something else.
    const entry = COSTS.slice(COSTS.indexOf("export async function getLedgerLifetimeUsd("));
    expect(entry).toMatch(/getLedgerLifetimeUsdExact\(/);
  });
});
