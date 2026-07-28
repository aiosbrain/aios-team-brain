import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { freshness, computedNow, freshnessWire } from "@/lib/freshness";

/**
 * BUILD-FAILING GUARD: a route may not FABRICATE its own freshness stamp (Pass-1 review R2 / M6).
 *
 * The bug this pins was not a missing field, it was a false one. Four routes answered "how old is this?"
 * with `as_of: new Date().toISOString()` over payloads read from a cache table — `arc_cache` has a FOUR
 * HOUR TTL and deliberately serves rows older still. Worse, it destroyed a signal built on purpose
 * underneath it: `commitArcs` backdates `computed_at` so an untrustworthy synthesis reads stale (H11/H12),
 * and the wire overwrote that with "now".
 *
 * Why a guard and not just the four fixes: nothing about writing `as_of: new Date()` looks wrong at the
 * call site. It reads like filling in a required field, it is one line, and it type-checks. The next route
 * to serve cached data will reach for it again — so the durable artifact is a rule that the freshness a
 * route publishes must come from the data layer that knows it.
 *
 * KNOWN BLIND SPOTS (a source scan can't be complete; named rather than implied):
 *   • A route could assign `new Date()` to a local and publish that local — two statements, not matched.
 *   • A NEW freshness key name (`fresh_as_of`, `generated_at` on a cached payload) is not in KEYS below.
 *     `generated_at` is deliberately absent: `/api/v1/okf-bundle` builds it from a live read, where
 *     stamping now() is correct. Adding a cached surface under that name would slip past.
 *   • A route can fabricate THROUGH this module — `...freshnessWire(computedNow())` over cache-backed
 *     data reads as legitimate and matches nothing here. The primitive makes the honest path easy, not
 *     the dishonest path impossible.
 * All three are places a reviewer should still look by hand.
 *
 * The allowlist below is deliberately SHORT and each entry is asserted to still exist (below), so a
 * renamed route can't leave an exemption behind that quietly covers a real offender under the old path.
 * `/api/v1/okf-bundle` is NOT listed: it only uses `generated_at`, which isn't in KEYS, so listing it
 * would exempt nothing today while pre-authorising a real `as_of: new Date()` there tomorrow.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const ROUTES = join(ROOT, "app", "api");

/** The wire keys that mean "this is how old the payload is". */
const KEYS = ["as_of", "computed_at", "computedAt"];

/**
 * `<key>: new Date()…` / `Date.now()` on one line — the exact shape all four instances had.
 * `[^,;]{0,40}` allows the `.toISOString()` tail without spanning to the next property.
 */
const FABRICATED_RE = new RegExp(
  String.raw`\b(${KEYS.join("|")})\s*:\s*(new\s+Date\s*\([^)]*\)|Date\.now\s*\(\s*\))[^,;]{0,40}`,
  "g"
);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/**
 * Routes allowed to stamp their own time, with the reason. Each is a LIVE read — there is no cache row
 * whose age could be reported instead, so `now()` is the honest answer rather than a stand-in for one.
 */
const LIVE_READ_ALLOWLIST: Record<string, string> = {
  [join("app", "api", "brain", "facts", "route.ts")]:
    "live Neo4j read; degradation comes from recentFacts().ok, which IS now reported",
  [join("app", "api", "brain", "events", "route.ts")]: "live Neo4j read, no cache behind it",
};

function offenders(): string[] {
  const hits: string[] = [];
  for (const file of walk(ROUTES)) {
    const rel = file.slice(ROOT.length + 1);
    if (rel in LIVE_READ_ALLOWLIST) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(FABRICATED_RE)) hits.push(`${rel}: ${m[0].replace(/\s+/g, " ")}`);
  }
  return [...new Set(hits)].sort();
}

describe("guard: routes report freshness, they don't invent it", () => {
  it("no route stamps its own as_of/computed_at over cache-backed data", () => {
    expect(
      offenders(),
      `A route is fabricating a freshness stamp. If the payload came from a cache/data layer, return that ` +
        `layer's Freshness (lib/freshness) and render it with freshnessWire() — a computed_at read from ` +
        `the row is the only honest answer. If it is genuinely a LIVE read, add it to ` +
        `LIVE_READ_ALLOWLIST in this file with the reason:\n${offenders().join("\n")}`
    ).toEqual([]);
  });

  it("is non-vacuous: the pattern it looks for is detectable, and the scan reaches real routes", () => {
    // Pins the regex against the four shapes that actually shipped, plus plausible variants. A broken
    // pattern would leave this guard green forever while the lie walked back in.
    for (const drift of [
      `as_of: new Date().toISOString(),`, // the exact line removed from /api/brain/arcs
      `return Response.json({ people, as_of: new Date().toISOString() });`,
      `computed_at: new Date().toISOString(),`,
      `computedAt: Date.now(),`,
      `as_of: new Date(Date.now()).toISOString(),`,
    ]) {
      expect([...drift.matchAll(FABRICATED_RE)], drift).toHaveLength(1);
    }
    // Legitimate shapes must NOT match: reporting a value the data layer supplied, or a non-freshness
    // timestamp field.
    for (const ok of [
      `as_of: wire.as_of,`,
      `...freshnessWire(freshness),`,
      `const wire = freshnessWire(f);`,
      `derived_at: new Date().toISOString(),`, // per-arc provenance, not a cache age
      `expires_at: new Date(Date.now() + TTL).toISOString(),`,
    ]) {
      expect([...ok.matchAll(FABRICATED_RE)], ok).toHaveLength(0);
    }
    // The scan reaches the file the bug was actually in — otherwise `offenders()` is green because it
    // walked nothing.
    const scanned = walk(ROUTES);
    expect(scanned).toContain(join(ROOT, "app", "api", "brain", "arcs", "route.ts"));
    expect(scanned.length).toBeGreaterThan(20);
    // …and every allowlisted path exists, so a rename can't silently turn an exemption into dead weight
    // that hides a real offender under the old name.
    for (const rel of Object.keys(LIVE_READ_ALLOWLIST)) {
      expect(scanned, `${rel} is allowlisted but not found — stale exemption`).toContain(join(ROOT, rel));
    }
  });
});

describe("freshness primitive", () => {
  it("derives stale from age vs TTL, at the boundary", () => {
    const now = 1_000_000;
    expect(freshness(now - 99, 100, { now }).stale).toBe(false);
    expect(freshness(now - 100, 100, { now }).stale).toBe(true); // >= TTL is stale
    expect(freshness(now - 500, 100, { now }).computedAt).toBe(now - 500);
  });

  it("treats an undateable row as INFINITELY old, never as now", () => {
    // The failure direction matters: defaulting to `now` would report a row we cannot date as fresh —
    // the exact class of lie this module removes.
    const now = 1_000_000;
    expect(freshness(NaN, 100, { now }).stale).toBe(true);
    expect(freshness(NaN, 100, { now }).computedAt).toBe(0);
  });

  it("keeps stale and degraded independent", () => {
    const now = 1_000_000;
    // Freshly computed but untrustworthy — the cold-miss timeline case.
    const f = computedNow({ now, degraded: true });
    expect(f.stale).toBe(false);
    expect(f.degraded).toBe(true);
    // Old but perfectly trustworthy.
    const g = freshness(now - 10_000, 100, { now });
    expect(g.stale).toBe(true);
    expect(g.degraded).toBe(false);
  });

  it("renders the wire shape without any diagnostic detail (tier safety)", () => {
    const wire = freshnessWire(freshness(0, 100, { now: 1000, degraded: true }));
    expect(Object.keys(wire).sort()).toEqual(["as_of", "degraded", "stale"]);
    expect(wire.as_of).toBe(new Date(0).toISOString());
    // No free-text field exists to leak an internal subsystem name to an external-tier caller.
    expect(Object.values(wire).some((v) => typeof v === "string" && v.length > 30)).toBe(false);
  });
});
