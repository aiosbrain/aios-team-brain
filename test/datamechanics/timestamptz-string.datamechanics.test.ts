import { describe, expect, it } from "vitest";
import { db, seedTeam, ingest } from "./helpers";

/**
 * Guard: every timestamptz / date / timestamp column returned by the pg adapter through the
 * query builder must be a plain string, never a Date object. The normalization lives in
 * lib/db/pg/pool.ts (pg type parsers for OIDs 1082/1114/1184, set at import time), so this
 * test verifies the observable outcome through the real PgQuery chain.
 *
 * If this test is RED, the type parser in pool.ts stopped working or a new date-like column
 * type slipped past. The fix should live in the adapter, not in every consumer.
 */

describe("pg adapter returns strings for date/time columns", () => {
  it("synced_at (timestamptz) from items is a string, not a Date", async () => {
    const seed = await seedTeam();
    const admin = db();

    const result = await ingest(seed, {
      body: "hello",
      path: "slack/test/1.md",
      access: "team",
    });
    if (!result.id) throw new Error(`ingest failed: ${JSON.stringify(result)}`);

    const { data, error } = await admin
      .from("items")
      .select("synced_at, updated_at")
      .eq("id", result.id)
      .maybeSingle();

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    const row = data as { synced_at: unknown; updated_at: unknown };
    expect(typeof row.synced_at).toBe("string");
    expect(typeof row.updated_at).toBe("string");
    expect(isNaN(Date.parse(row.synced_at as string))).toBe(false);
    expect(isNaN(Date.parse(row.updated_at as string))).toBe(false);
  });

  it("created_at (timestamptz) from members is a string, not a Date", async () => {
    const seed = await seedTeam();
    const admin = db();

    const { data, error } = await admin
      .from("members")
      .select("created_at")
      .eq("id", seed.memberId)
      .maybeSingle();

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    const row = data as { created_at: unknown };
    expect(typeof row.created_at).toBe("string");
    expect(isNaN(Date.parse(row.created_at as string))).toBe(false);
  });

  // Date-only columns (Postgres `date` type) must arrive as YYYY-MM-DD strings, not Date objects
  // and not full ISO timestamps — toDateStr / dayStr consumers slice(0,10) on ISO strings, but a
  // UTC-midnight toISOString() on a date column can shift the calendar day in non-UTC timezones.
  // The pg type parser for OID 1082 returns the raw wire string directly.
  it("starts_on (date) from member_time_off is a string, not a Date", async () => {
    const seed = await seedTeam();
    const admin = db();

    const { error: insErr } = await admin.from("member_time_off").insert({
      team_id: seed.teamId,
      member_id: seed.memberId,
      starts_on: "2026-07-08",
      ends_on: "2026-07-10",
    });

    expect(insErr).toBeNull();

    const { data, error } = await admin
      .from("member_time_off")
      .select("starts_on")
      .eq("team_id", seed.teamId)
      .limit(1);

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    const row = (data as Array<{ starts_on: unknown }>)[0];
    expect(typeof row.starts_on).toBe("string");
    // Date columns must be YYYY-MM-DD, not a full ISO timestamp — the toISOString() path
    // for date values can shift the calendar day across UTC boundaries.
    expect(row.starts_on).toBe("2026-07-08");
  });
});
