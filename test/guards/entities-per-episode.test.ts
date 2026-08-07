import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CENSUS_RECENT_MS,
  CENSUS_UNBOUNDED_UNTIL,
  censusRecentSince,
  censusRecentUntil,
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
    expect(health).toContain("RETURN count(n) AS entities");
  });

  it("the window is a SPAN — both edges, in one query text", () => {
    // The upper bound is not decoration (spec §"the backstop question"). The retroactive pre-deploy
    // baseline is a span, and a lower-bound-only query sweeps POST-deploy nodes into the "before"
    // side — i.e. it reads the patched extractor's own behaviour as the baseline it is being
    // compared against, and reads as a perfectly plausible number while doing it.
    expect(health).toContain(
      "WHERE n.created_at >= datetime($since) AND n.created_at < datetime($until)"
    );
    // Asserted as a whole clause, not two substrings: `>= $since` alone is exactly the deviating
    // form this test exists to reject, and it would pass a pair of independent `toContain`s.
    expect(health).toContain("{ g: groupId, since: censusRecentSince(nowMs), until: censusRecentUntil(untilMs) }");
    // ONE query text. A second, unbounded variant is how the bounded form ends up never executed.
    expect(health.match(/RETURN count\(n\) AS entities/g)?.length).toBe(1);
  });

  it("the live read is unbounded via a sentinel, not via a dropped clause", () => {
    // A Cypher `n.created_at < datetime(null)` evaluates to null and silently filters EVERY row out,
    // so "no upper bound" cannot be expressed by passing null through. The sentinel keeps one query
    // text; this pins that it is genuinely far-future rather than an arbitrary date that will one day
    // start truncating the live window.
    expect(censusRecentUntil(null)).toBe(CENSUS_UNBOUNDED_UNTIL);
    expect(Date.parse(CENSUS_UNBOUNDED_UNTIL)).toBeGreaterThan(Date.UTC(9000, 0, 1));
    expect(censusRecentUntil(Date.UTC(2026, 7, 1))).toBe(new Date(Date.UTC(2026, 7, 1)).toISOString());
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
    expect(health).toContain("recentEntityCount(group, nowMs, untilMs)");
    expect(health).toContain("MATCH (n:Entity {group_id: $g})");
  });
});

describe("both legs of the ratio are windowed on ONE span", () => {
  it("the ledger leg and the entity leg call the same helper — for BOTH edges", () => {
    // Structural, not incidental: a second `new Date(nowMs - CENSUS_RECENT_MS)` in the ledger query
    // is exactly how the two spans would drift apart later without either test noticing.
    expect(health).toContain("const recentSince = censusRecentSince(nowMs);");
    expect(health).toContain("since: censusRecentSince(nowMs)");
    // The upper edge too. Bounding only the numerator would build the mismatched-span bug this whole
    // describe exists to prevent — a bounded entity count over an unbounded episode count.
    expect(health).toContain("const recentUntil = censusRecentUntil(untilMs);");
    expect(health).toContain("until: censusRecentUntil(untilMs)");
    // Exactly one place computes each recent boundary from its source.
    expect((health.match(/new Date\(nowMs - CENSUS_RECENT_MS\)/g) ?? []).length).toBe(1);
    expect((health.match(/new Date\(untilMs\)/g) ?? []).length).toBe(1);
  });

  it("the ledger's RECENT leg carries the same right edge the entity leg does", () => {
    // The retroactive read is `groupCensuses(team, now, preDeployMs)`; if the SQL recent filter had
    // no `< $3`, that call would return (bounded entities) / (unbounded episodes) — a ratio that is
    // wrong by exactly the post-deploy episodes it was supposed to exclude, and looks fine.
    expect(health).toContain(
      "count(*) filter (where projected_at >= $1 and projected_at < $3 and content_sha256 <> '')::int as recent"
    );
    expect(health).toContain("groupEpisodeFlows(teamId, nowMs, untilMs)");
  });

  it("the baseline and span legs are NOT bounded — they are live-alarm concepts", () => {
    // Deliberate asymmetry, pinned so it reads as a decision rather than an oversight: bounding the
    // trailing baseline or the release valve would change what the pollution alarm judges, and this
    // sensor is explicitly not allowed to do that.
    expect(health).toContain(
      "count(*) filter (where projected_at >= $2 and projected_at < $1 and content_sha256 <> '')::int as baseline"
    );
    expect(health).toContain(
      "count(*) filter (where projected_at >= $2 and content_sha256 <> '')::int as span"
    );
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
  });

  it("the two causes of a null ratio render as DIFFERENT sentences", () => {
    // "no episodes in window" is a claim about the LEDGER. Printing it when the entity Cypher failed
    // is simply false — and in the census-judged / entity-leg-failed state there is no refusal copy
    // on the line above to disambiguate, so the card would state a wrong fact with nothing beside it
    // to contradict. The numerator's own null is what separates them.
    // Pinned as ONE contiguous expression rather than three `toContain`s plus an index comparison:
    // the doc comment above this function names both strings, so an index-ordering assertion is
    // satisfied by prose and proves nothing about the branch that actually runs.
    const card = readFileSync(CARD, "utf8");
    expect(card).toContain(
      `    : c.recentEntities === null\n      ? "graph unreadable"\n      : "no episodes in window";`
    );
  });
});

describe("a missing row is unknown, not a measured zero", () => {
  it("the Neo4j read does not default a missing count to 0", () => {
    // Contained today (a `count(*)` always returns a row), pinned anyway because this file's own rule
    // is that a zero which looks like a measurement is worse than an admitted unknown — and a future
    // query shape change is exactly when a `?? 0` would start lying.
    expect(health).toContain("const raw = rows[0]?.entities;");
    expect(health).toContain("if (raw === undefined || raw === null) return null;");
    expect(health.includes("rows[0]?.entities ?? 0")).toBe(false);
  });
});
