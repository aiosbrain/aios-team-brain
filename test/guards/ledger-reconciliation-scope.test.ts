import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GUARD: the ledger sum compared against a provider's billing figure must be scoped to THAT provider.
 *
 * The provider total comes from one provider's API. Summing every provider against it dilutes the gap
 * toward zero — an Anthropic list-price estimate is real ledger spend that OpenRouter never charged,
 * so counting it "accounts for" money that key never saw and quietly erases the shortfall this whole
 * feature exists to expose. It shipped that way in review and would have been invisible the moment a
 * second provider key was added: today every row is `openrouter`, so no behavioural test can catch it.
 */
describe("guard: getLedgerLifetimeUsd is provider-scoped", () => {
  const src = readFileSync(join(process.cwd(), "lib", "metrics", "llm-costs.ts"), "utf8");
  const fn = src.slice(src.indexOf("export async function getLedgerLifetimeUsd"));

  it("filters llm_usage by provider", () => {
    expect(fn).toMatch(/\.eq\("provider",\s*provider\)/);
  });

  it("refuses to answer at the row cap rather than returning a short sum", () => {
    // A truncated sum understates the ledger, which INFLATES the unattributed gap — a confident
    // overstatement is worse than showing nothing.
    expect(fn).toMatch(/rows\.length >= LEDGER_LIFETIME_ROW_CAP.*return null/s);
  });
});
