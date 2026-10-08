import { describe, expect, it } from "vitest";
import { freshness, freshnessWire } from "@/lib/freshness";

/**
 * AIO-1170 pre-activation correction PA-4 — the envelope can be TOLD a payload is stale.
 *
 * `stale` was derived from age alone, which is right for a cache whose only way to be out of date is
 * to be old. The timeline cache has a second way: a row minutes young whose Slack data or
 * presentation generation already lags the live one. Served through the age rule that row reports
 * fresh — so the producer that knows about the lag has to be able to say so, through `freshness()`
 * itself rather than by hand-building an envelope beside it.
 */

const NOW = Date.parse("2026-10-05T12:00:00Z");
const TTL = 5 * 60_000;

describe("freshness — an explicit stale override", () => {
  it("marks a YOUNG payload stale when its producer says so", () => {
    const told = freshness(NOW - 1_000, TTL, { now: NOW, stale: true });
    expect(told).toEqual({ computedAt: NOW - 1_000, stale: true, degraded: false });
    // …and that is what reaches the wire on the one route that publishes the envelope.
    expect(freshnessWire(told)).toEqual({ as_of: new Date(NOW - 1_000).toISOString(), stale: true, degraded: false });
  });

  it("keeps the two flags independent: a lagging payload can also be degraded", () => {
    const told = freshness(NOW - 1_000, TTL, { now: NOW, stale: true, degraded: true });
    expect(told).toMatchObject({ stale: true, degraded: true });
  });

  // THE CONTROL, and the direction that must never open: the override can only ADD staleness. A
  // payload past its TTL stays stale whatever it is told, and saying nothing leaves the age rule alone.
  it("never lets the override declare an OLD payload fresh, and changes nothing when absent", () => {
    expect(freshness(NOW - TTL, TTL, { now: NOW, stale: false }).stale).toBe(true);
    expect(freshness(NOW - 1_000, TTL, { now: NOW, stale: false }).stale).toBe(false);
    expect(freshness(NOW - TTL, TTL, { now: NOW }).stale).toBe(true);
    expect(freshness(NOW - 1_000, TTL, { now: NOW }).stale).toBe(false);
  });
});
