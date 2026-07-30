import { describe, expect, it } from "vitest";
import { parseCreditsBody, reconcileLedger } from "@/lib/costs/provider-usage";

/**
 * Spec: the costs surface must not present the ledger's FLOOR as the total.
 *
 * Measured on prod 2026-07-30 — the ledger said $51.46, OpenRouter's own `/credits` said $96.67 on
 * the same key. 47% of real spend was invisible, and the dashboard reported the floor with no hint
 * that anything was missing. The cause is structural: a call that times out or fails after the
 * provider generated is billed upstream and returns no `usage` for us to read, so no amount of
 * fixing the meter can make the ledger complete on its own. Only the provider knows the total.
 */

describe("parseCreditsBody — 'unknown' must never read as 'zero'", () => {
  it("reads the provider's cumulative spend", () => {
    const got = parseCreditsBody({ data: { total_credits: 110, total_usage: 96.670187517 } });
    expect(got).toEqual({ provider: "openrouter", totalUsageUsd: 96.670187517, totalCreditsUsd: 110 });
  });

  it("keeps usage when credits are absent — they answer different questions", () => {
    expect(parseCreditsBody({ data: { total_usage: 12.5 } })?.totalCreditsUsd).toBeNull();
    expect(parseCreditsBody({ data: { total_usage: 12.5 } })?.totalUsageUsd).toBe(12.5);
  });

  it("returns NULL — not 0 — for a shape it doesn't recognise", () => {
    // A missing number must read as "we don't know what the provider charged". Zero would be the
    // same false reassurance this module exists to end.
    for (const junk of [null, undefined, {}, { data: {} }, { data: { total_usage: "96.67" } }, { data: { total_usage: NaN } }]) {
      expect(parseCreditsBody(junk)).toBeNull();
    }
  });
});

describe("reconcileLedger — how much spend the ledger could not attribute", () => {
  it("reports the real gap measured in production", () => {
    const r = reconcileLedger(96.67, 51.46);
    expect(r.unattributedUsd).toBeCloseTo(45.21, 2);
    expect(r.unattributedFraction).toBeCloseTo(0.4677, 3);
    expect(r.material).toBe(true);
  });

  it("stays quiet for a rounding-sized difference", () => {
    // Timing skew between a page render and the provider's accounting is not a missing-spend story;
    // flagging it every time would train everyone to ignore the flag that matters.
    const r = reconcileLedger(50.2, 50.0);
    expect(r.material).toBe(false);
  });

  it("stays quiet when the gap is a large FRACTION but a trivial amount", () => {
    // A brand-new instance: $0.30 provider, $0.05 ledger. 83% unattributed and completely uninteresting.
    expect(reconcileLedger(0.3, 0.05).material).toBe(false);
  });

  it("CLAMPS at zero — a ledger above the provider total is not negative spend", () => {
    // Anthropic calls are list-price ESTIMATES counted in the ledger that contribute nothing to
    // OpenRouter's number, so ledger > provider is legitimate and means "nothing unattributed here".
    const r = reconcileLedger(10, 25);
    expect(r.unattributedUsd).toBe(0);
    expect(r.unattributedFraction).toBe(0);
    expect(r.material).toBe(false);
  });

  it("does not divide by zero on a provider that has charged nothing", () => {
    const r = reconcileLedger(0, 0);
    expect(r.unattributedFraction).toBe(0);
    expect(r.material).toBe(false);
  });
});
