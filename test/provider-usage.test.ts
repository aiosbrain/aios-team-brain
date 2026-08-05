import { describe, expect, it } from "vitest";
import { parseKeyUsageBody, reconcileLedger } from "@/lib/costs/provider-usage";

/**
 * Spec: the costs surface must not present the ledger's FLOOR as the total.
 *
 * Measured on prod 2026-07-30 — the ledger said $51.46, OpenRouter said $96.67. 47% of real spend was
 * invisible, and the dashboard reported the floor with no hint that anything was missing. The cause is
 * structural: a call that times out or fails after the provider generated is billed upstream and
 * returns no `usage` for us to read, so no amount of fixing the meter can make the ledger complete on
 * its own. Only the provider knows the total.
 *
 * The SOURCE of the provider figure is itself load-bearing (2026-08-05): this read `/credits`, whose
 * `total_usage` is ACCOUNT-wide, while three comments called it key-scoped. Account $202.69 vs this
 * key $194.36 — $8.33 of an unrelated key's spend inflating the very number that reports how much we
 * failed to explain, uncloseable by any metering fix. `/key` → `data.usage` is the per-key figure.
 */

describe("parseKeyUsageBody — 'unknown' must never read as 'zero'", () => {
  it("reads this key's spend and its calendar-month slice from a real /key body", () => {
    // Recorded verbatim from prod 2026-08-05, not hand-written: the fields this parser depends on
    // exist in the shape the provider actually returns.
    const got = parseKeyUsageBody({
      data: {
        label: "sk-or-v1-959...5ef",
        limit: null,
        usage: 194.39890159,
        usage_daily: 0.049143255,
        usage_weekly: 53.519963315,
        usage_monthly: 70.29084969,
        is_free_tier: false,
      },
    });
    expect(got).toEqual({ provider: "openrouter", totalUsageUsd: 194.39890159, monthUsageUsd: 70.29084969 });
  });

  it("keeps the lifetime figure when the month slice is absent — they answer different questions", () => {
    expect(parseKeyUsageBody({ data: { usage: 12.5 } })?.monthUsageUsd).toBeNull();
    expect(parseKeyUsageBody({ data: { usage: 12.5 } })?.totalUsageUsd).toBe(12.5);
  });

  it("refuses a NEGATIVE total rather than rendering '$-5.00 spent'", () => {
    expect(parseKeyUsageBody({ data: { usage: -5 } })).toBeNull();
  });

  it("a /credits-shaped body parses to NULL — a silent revert must not read as a plausible figure", () => {
    // THE guard with real history. `/credits.total_usage` is ACCOUNT-wide; reading it as this key's
    // spend inflated the unattributed gap by every other key's lifetime spend. If someone points this
    // back at /credits, the shape must be unrecognised ("we don't know"), never quietly parsed.
    expect(parseKeyUsageBody({ data: { total_usage: 202.69, total_credits: 110 } })).toBeNull();
  });

  it("returns NULL — not 0 — for a shape it doesn't recognise", () => {
    for (const junk of [null, undefined, {}, { data: {} }, { data: { usage: "96.67" } }, { data: { usage: NaN } }]) {
      expect(parseKeyUsageBody(junk)).toBeNull();
    }
  });
});

describe("reconcileLedger — how much spend the ledger could not attribute", () => {
  it("reports the real gap measured in production", () => {
    const r = reconcileLedger(96.67, 51.46);
    expect(r.unattributedUsd).toBeCloseTo(45.21, 2);
    expect(r.unattributedFraction).toBeCloseTo(0.4677, 3);
    expect(r.material).toBe(true);
    expect(r.status).toBe("unattributed");
  });

  it("stays quiet for a rounding-sized difference", () => {
    // Timing skew between a page render and the provider's accounting is not a missing-spend story;
    // flagging it every time would train everyone to ignore the flag that matters.
    const r = reconcileLedger(50.2, 50.0);
    expect(r.material).toBe(false);
  });

  it("stays quiet when the gap is a large AMOUNT but a trivial fraction", () => {
    // $10 adrift on $1,000 of spend is accounting noise, not a missing-spend story. I claimed this leg
    // was mutation-covered when it was not: dropping `fraction >= MATERIAL_FRACTION` passed every test,
    // because every other case that clears $1 also clears 5%. This is the case that pins it.
    expect(reconcileLedger(1000, 990).material).toBe(false);
    expect(reconcileLedger(1000, 990).status).toBe("reconciled");
  });

  it("stays quiet when the gap is a large FRACTION but a trivial amount", () => {
    // A brand-new instance: $0.30 provider, $0.05 ledger. 83% unattributed and completely uninteresting.
    expect(reconcileLedger(0.3, 0.05).material).toBe(false);
  });

  it("CLAMPS at zero and says WHY — a ledger above the provider total is not negative spend", () => {
    // Now that the ledger sum is filtered to this provider, ledger > provider is no longer routine —
    // it means the key was rotated (old spend, fresh key) or something double-metered. Rendering the
    // clamped "accounts for $X of it" there is a literally false sentence, so it gets its own state.
    const r = reconcileLedger(10, 25);
    expect(r.unattributedUsd).toBe(0);
    expect(r.unattributedFraction).toBe(0);
    expect(r.material).toBe(false);
    expect(r.status).toBe("ledger-exceeds");
  });

  it("does not divide by zero on a provider that has charged nothing", () => {
    const r = reconcileLedger(0, 0);
    expect(r.unattributedFraction).toBe(0);
    expect(r.material).toBe(false);
  });
});
