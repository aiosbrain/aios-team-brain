import { describe, expect, it } from "vitest";
import { buildPoolConfig } from "@/lib/db/pg/pool";

/**
 * Spec for the pg Pool liveness timeouts (2026-07-13 outage). A pooled backend got wedged holding a
 * `tasks` lock with a transaction open, and — because the pool set NO idle/statement/connect timeout
 * — held it indefinitely, cascading into a full outage when the next deploy's schema ALTER queued
 * behind it. These assert the timeouts exist (so the class can't recur silently) and stay operator-
 * tunable. Derived from what the pool MUST guarantee, not from reading the impl.
 */

const URL = "postgres://app:app@localhost:5432/app";

describe("buildPoolConfig — liveness timeouts", () => {
  it("sets every reaping timeout so a wedged connection can't hold locks forever", () => {
    const cfg = buildPoolConfig({ DATABASE_URL: URL } as NodeJS.ProcessEnv);
    // The direct fix for the outage: Postgres reaps a leaked/zombie open transaction.
    expect(cfg.idle_in_transaction_session_timeout).toBeGreaterThan(0);
    // A runaway single statement can't hold locks forever either.
    expect(cfg.statement_timeout).toBeGreaterThan(0);
    // Checkout fails fast instead of hanging when the pool is exhausted (blast-radius containment).
    expect(cfg.connectionTimeoutMillis).toBeGreaterThan(0);
    // A dead TCP peer's socket gets reaped rather than lingering.
    expect(cfg.keepAlive).toBe(true);
    expect(cfg.connectionString).toBe(URL);
  });

  it("honors env overrides, including 0 to disable a timeout", () => {
    const cfg = buildPoolConfig({
      DATABASE_URL: URL,
      PG_STATEMENT_TIMEOUT_MS: "5000",
      PG_IDLE_TX_TIMEOUT_MS: "0", // operator opt-out
      PG_CONNECT_TIMEOUT_MS: "2500",
      PG_POOL_MAX: "20",
    } as NodeJS.ProcessEnv);
    expect(cfg.statement_timeout).toBe(5000);
    expect(cfg.idle_in_transaction_session_timeout).toBe(0);
    expect(cfg.connectionTimeoutMillis).toBe(2500);
    expect(cfg.max).toBe(20);
  });

  it("falls back to safe defaults on blank/NaN env values", () => {
    const cfg = buildPoolConfig({
      DATABASE_URL: URL,
      PG_STATEMENT_TIMEOUT_MS: "",
      PG_IDLE_TX_TIMEOUT_MS: "not-a-number",
    } as NodeJS.ProcessEnv);
    expect(cfg.statement_timeout).toBe(30_000);
    expect(cfg.idle_in_transaction_session_timeout).toBe(60_000);
  });

  it("enables SSL only when the URL or env asks for it", () => {
    expect(buildPoolConfig({ DATABASE_URL: `${URL}?sslmode=require` } as NodeJS.ProcessEnv).ssl).toEqual({
      rejectUnauthorized: false,
    });
    expect(buildPoolConfig({ DATABASE_URL: URL, PGSSL: "require" } as NodeJS.ProcessEnv).ssl).toEqual({
      rejectUnauthorized: false,
    });
    expect(buildPoolConfig({ DATABASE_URL: URL } as NodeJS.ProcessEnv).ssl).toBeUndefined();
  });

  it("refuses to build a config without DATABASE_URL", () => {
    expect(() => buildPoolConfig({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });
});
