import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CENSUS_RECENT_MS,
  censusRecentSince,
  deriveEntitiesPerEpisode,
} from "@/lib/graph/extraction-health";

/**
 * GUARD: `entitiesPerEpisode` — the windowed entity-yield sensor added with the same-item
 * predecessor filter (PIPEFF-2 / AIO-821).
 *
 * WHY IT EXISTS. The same-item filter's plausible failure mode is VARIANT-NAME fragmentation ("John"
 * beside "John Smith"). The name-collision census counts SAME-name splits, so it is blind to that by
 * construction — it sees two different names. What variant fragmentation does move is entity yield
 * per episode, which is why this sensor was added rather than the census being leaned on for a job it
 * cannot do. Shipping the patch with no sensor at all was the alternative, and the spec rejected it.
 *
 * WHAT THIS FILE PINS, and each has a real failure behind it:
 *  1. **Both legs use the SAME span.** A ratio whose numerator and denominator are windowed
 *     differently is dimensionally wrong and renders as a perfectly plausible number.
 *  2. **Zero episodes ⇒ `null`, never Infinity/NaN/0.** A divide-by-zero that renders as a number is
 *     indistinguishable from a measurement — the "a parser that matches nothing reports zero" class.
 *  3. **It is NOT wired into any alert path.** Its band is deliberately underived until two weeks of
 *     prod week-over-week variation exist; anything that could fire on it now would fire on a guess.
 */

const HEALTH = join(process.cwd(), "lib/graph/extraction-health.ts");
const RETRIEVAL = join(process.cwd(), "lib/query/retrieval-health.ts");
const ALERT = join(process.cwd(), "lib/graph/extraction-alert.ts");
const CARD = join(process.cwd(), "components/admin/retrieval-health-card.tsx");

const health = readFileSync(HEALTH, "utf8");

describe("the windowed entity count is the query the spec specifies", () => {
  it("counts Entity nodes CREATED in the window, per group", () => {
    expect(health).toContain("MATCH (n:Entity {group_id: $g})");
    expect(health).toContain("WHERE n.created_at >= datetime($since)");
    expect(health).toContain("RETURN count(n) AS entities");
  });

  it("windows on `created_at` (extraction time), never `valid_at` (content time)", () => {
    // Same choice as the census and the stall probe: a backfill of month-old Slack carries month-old
    // `valid_at`, so a `valid_at` window would read a busy extractor as idle.
    expect(health.includes("n.valid_at")).toBe(false);
  });

  it("is scoped per group — so it is tier-scoped, since group_id encodes the tier", () => {
    // There is no RLS backstop (CLAUDE.md §5). The group list comes from the team-scoped ledger and
    // the Cypher is parameterised by ONE group, so a team's card can never count another tier's
    // entities. A query without the `{group_id: $g}` match would silently aggregate the instance.
    expect(health).toContain("recentEntityCount(group, nowMs)");
    expect(health).toContain("{ g: groupId, since: censusRecentSince(nowMs) }");
  });
});

describe("both legs of the ratio are windowed on ONE span", () => {
  it("the ledger leg and the entity leg call the same helper", () => {
    // Structural, not incidental: a second `new Date(nowMs - CENSUS_RECENT_MS)` in the ledger query
    // is exactly how the two spans would drift apart later without either test noticing.
    expect(health).toContain("const recentSince = censusRecentSince(nowMs);");
    expect(health).toContain("since: censusRecentSince(nowMs)");
    // Exactly one place computes the recent boundary from the constant.
    const derivations = health.match(/new Date\(nowMs - CENSUS_RECENT_MS\)/g) ?? [];
    expect(derivations.length).toBe(1);
  });

  it("the helper is CENSUS_RECENT_MS before now, as an ISO instant", () => {
    const now = Date.UTC(2026, 7, 7, 12, 0, 0);
    expect(censusRecentSince(now)).toBe(new Date(now - CENSUS_RECENT_MS).toISOString());
    // Sanity on the direction — a sign error would window the FUTURE and read zero forever.
    expect(Date.parse(censusRecentSince(now))).toBeLessThan(now);
  });
});

describe("deriveEntitiesPerEpisode: a ratio, or an honest null", () => {
  it("divides entities created by episodes projected", () => {
    expect(deriveEntitiesPerEpisode(637, 100)).toBeCloseTo(6.37, 10);
    expect(deriveEntitiesPerEpisode(0, 100)).toBe(0); // a real, measured zero yield
  });

  it("ZERO episodes ⇒ null — never Infinity, never NaN, never 0", () => {
    const out = deriveEntitiesPerEpisode(120, 0);
    expect(out).toBeNull();
    // Stated as three separate assertions because each is a different way the bug renders on a card:
    // `Infinity` shows as "∞", `NaN` shows as "NaN", and `0` shows as a plausible measurement.
    expect(Object.is(out, Infinity)).toBe(false);
    expect(Number.isNaN(out as unknown as number)).toBe(false);
    expect(out === 0).toBe(false);
  });

  it("a negative or non-finite denominator is also null, not a negative yield", () => {
    expect(deriveEntitiesPerEpisode(120, -3)).toBeNull();
    expect(deriveEntitiesPerEpisode(120, Number.NaN)).toBeNull();
    expect(deriveEntitiesPerEpisode(Number.POSITIVE_INFINITY, 10)).toBeNull();
  });

  it("an unreadable leg ⇒ null — unknown must never read as a measurement", () => {
    expect(deriveEntitiesPerEpisode(null, 100)).toBeNull(); // Neo4j unreadable
    expect(deriveEntitiesPerEpisode(120, null)).toBeNull(); // ledger unreadable
    expect(deriveEntitiesPerEpisode(null, null)).toBeNull();
  });
});

describe("OBSERVATIONAL: the sensor must not be able to move any verdict", () => {
  const retrieval = readFileSync(RETRIEVAL, "utf8");
  const alert = readFileSync(ALERT, "utf8");

  it("the pollution derivation never receives it", () => {
    // `NameCollisionInput` is the whole input surface of `deriveNameCollisionPollution`. If the yield
    // ever appears on it, this alarm starts firing on a band nobody has measured.
    const input = health.slice(
      health.indexOf("export interface NameCollisionInput {"),
      health.indexOf("export interface NameCollisionInput {") + 900
    );
    expect(input.includes("entitiesPerEpisode")).toBe(false);
    expect(input.includes("recentEntities")).toBe(false);
  });

  it("the alarm module does not read it at all", () => {
    expect(alert.includes("entitiesPerEpisode")).toBe(false);
    expect(alert.includes("recentEntities")).toBe(false);
  });

  it("the graph leg's state is derived without it", () => {
    // `extractionStalled` is the only channel into `deriveGraphState`, and it is built from the stall
    // probe + the census verdict. Assert on the actual argument, not on the absence of a string.
    expect(retrieval).toContain("extractionStalled: graphExtractionStalled || graphCensusPolluted,");
    expect(retrieval).toContain(
      "const graphCensusPolluted = graphReachable && graphCensus.some((c) => c.judgeable && c.polluted);"
    );
  });

  it("it reaches the card, and the card says it is observational", () => {
    // The other half of the requirement: not wired to an alarm, but genuinely SHIPPED. An exported
    // field nothing renders would make the post-deploy verification table unreadable.
    const card = readFileSync(CARD, "utf8");
    expect(card).toContain("c.entitiesPerEpisode");
    expect(card).toContain("entities/episode");
    expect(card).toContain("observational");
    // The null case renders as words, not as a number.
    expect(card).toContain('n === null ? "no episodes in window"');
  });
});
