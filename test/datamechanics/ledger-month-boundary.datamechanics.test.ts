import { describe, expect, it } from "vitest";
import { runSql } from "@/lib/db/pg/pool";
import { getLedgerMonthUsdExact, getLedgerLifetimeUsdExact } from "@/lib/metrics/llm-spend";
import { db, seedTeam } from "./helpers";

/**
 * Spec: the CURRENT-MONTH ledger leg covers exactly the provider's month, on a boundary that does not
 * depend on the server's timezone (AIO-805).
 *
 * This belongs in the real-Postgres tier and nowhere else. The subtlety is entirely in SQL semantics:
 * `date_trunc('month', now() at time zone 'utc')` yields a timestamp WITHOUT time zone, and comparing
 * that to a `timestamptz` column coerces it back through the **session** `TimeZone` — which nothing in
 * `lib/db/pg/pool` pins. On a UTC server the naive form is right by coincidence of config; on any
 * other session up to ±14h of month-boundary spend lands on the wrong side of the comparison, in the
 * figure whose only job is to say how much spend is unexplained. A stubbed DB cannot see any of that.
 *
 * The month leg is compared against `/key`'s `usage_monthly`, so a boundary that drifts with server
 * config would manufacture a reconciliation gap out of a timezone.
 */
describe("getLedgerMonthUsdExact — the month boundary", () => {
  it("counts this month and excludes last month, and is provider-scoped", async () => {
    const seed = await seedTeam();
    // Anchored to the month boundary itself rather than to "N days ago", so the fixture means the same
    // thing on the 1st and the 28th.
    await runSql(
      `insert into llm_usage (id, team_id, member_id, source, provider, model, cost_usd, input_tokens, output_tokens, estimated, created_at)
       values
         -- inside this UTC month, right after it opened
         (gen_random_uuid(), $1, null, 'graph', 'openrouter', 'm', 3.00, 1, 1, false,
          date_trunc('month', (now() at time zone 'utc')) at time zone 'utc' + interval '1 minute'),
         -- LAST month, one minute before this one opened: must NOT count
         (gen_random_uuid(), $1, null, 'graph', 'openrouter', 'm', 99.00, 1, 1, false,
          date_trunc('month', (now() at time zone 'utc')) at time zone 'utc' - interval '1 minute'),
         -- this month but ANOTHER provider: must NOT count (the scoping the guard also pins)
         (gen_random_uuid(), $1, null, 'graph', 'anthropic', 'm', 50.00, 1, 1, false,
          date_trunc('month', (now() at time zone 'utc')) at time zone 'utc' + interval '2 minutes')`,
      [seed.teamId]
    );

    const month = await getLedgerMonthUsdExact(db, seed.teamId, "openrouter");
    expect(month, "only this month's openrouter row").toBeCloseTo(3.0, 5);

    // The lifetime leg is the control: it must see the excluded month's spend, proving the month
    // filter is what did the excluding rather than the rows never landing.
    const lifetime = await getLedgerLifetimeUsdExact(db, seed.teamId, "openrouter");
    expect(lifetime, "lifetime spans both months").toBeCloseTo(102.0, 5);
  });

  it("is unmoved by the session timezone — the boundary is the provider's, not the server's", async () => {
    const seed = await seedTeam();
    // A row 30 minutes into the UTC month. Under a session TZ far from UTC, a naive
    // `date_trunc(...) at time zone 'utc'`-less comparison would place the boundary hours away and
    // drop (or wrongly include) it.
    await runSql(
      `insert into llm_usage (id, team_id, member_id, source, provider, model, cost_usd, input_tokens, output_tokens, estimated, created_at)
       values (gen_random_uuid(), $1, null, 'graph', 'openrouter', 'm', 7.00, 1, 1, false,
               date_trunc('month', (now() at time zone 'utc')) at time zone 'utc' + interval '30 minutes')`,
      [seed.teamId]
    );

    const utcAnswer = await getLedgerMonthUsdExact(db, seed.teamId, "openrouter");
    for (const tz of ["Pacific/Kiritimati", "Etc/GMT+12"]) {
      // +14 and -12: the extremes that move a month boundary the furthest in each direction.
      await runSql(`set time zone '${tz}'`);
      try {
        // Prove the session actually took it on the SAME pooled connection the query will use. If the
        // pool ever hands back a different (unshifted) client, this test would otherwise pass
        // vacuously against the naive SQL — asserting nothing while looking like TZ coverage.
        const { rows } = await runSql<{ tz: string }>("select current_setting('TimeZone') as tz");
        expect(rows[0]?.tz, "session TZ did not take — the shifted assertion would be vacuous").toBe(tz);
        const shifted = await getLedgerMonthUsdExact(db, seed.teamId, "openrouter");
        expect(shifted, `month total must not move under session TZ ${tz}`).toBeCloseTo(utcAnswer ?? -1, 5);
      } finally {
        await runSql("set time zone 'UTC'");
      }
    }
    expect(utcAnswer).toBeCloseTo(7.0, 5);
  });
});
