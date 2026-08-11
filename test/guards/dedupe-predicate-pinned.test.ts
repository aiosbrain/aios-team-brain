import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveNameCollisionPollution,
  normalizeEntityName,
  windowNameCensus,
  CENSUS_RECENT_MS,
  CENSUS_BASELINE_MS,
  MIN_NAMES_FOR_CENSUS_SIGNAL,
  type NameCollisionSignals,
} from "@/lib/graph/extraction-health";

/**
 * GUARD: the pollution alarm's evidence must stay pinned to what the DEPLOYED graphiti image
 * actually writes (AIO-693 spec guard #1, re-pinned by ALARMFIX-1 for graphiti_core 0.29.3).
 *
 * The failure mode this file exists for happened for real: graphiti 0.29.3 (deployed by #490)
 * stopped writing `IS_DUPLICATE_OF` entirely, the old edge-share query read a literal zero forever,
 * and the alarm sat silently disabled with no surface saying so. The guard's job — "the query must
 * match what the deployed image writes" — now means matching what 0.29.3 DOES write: Entity NODES,
 * censused per name.
 *
 * The old zero-baseline/zero-recent "unjudgeable" pins are RETIRED with the predicate, not
 * re-pinned: on 0.29.3 exact-normalised-name resolution is deterministic, so ZERO split names over
 * a real sample is the measured healthy steady state (0 splits / 684 names on a fresh graph) — a
 * legal, judged reading. What replaces the old tripwire is the LEDGER CROSS-CHECK below.
 */
describe("name-collision census pinning (graphiti_core 0.29.3)", () => {
  const src = readFileSync(join(process.cwd(), "lib/graph/extraction-health.ts"), "utf8");

  it("the census query asks for PER-NAME rows of what 0.29.3 actually writes: Entity nodes", () => {
    expect(src).toContain("MATCH (n:Entity {group_id: $g})");
    expect(src).toContain("n.name AS name");
    expect(src).toContain("count(n) AS nodes");
    // Extraction time, not `valid_at` — Graphiti backdates valid_at to the episode's WORK time, so a
    // backfill would otherwise be judged by its content's age instead of what the extractor just did.
    expect(src).toContain("max(n.created_at) AS newest");
    expect(src.includes("n.valid_at")).toBe(false);
  });

  it("the dead relation is gone from this module — 0.29.3 never writes IS_DUPLICATE_OF", () => {
    // The one place the string may survive is prose ABOUT the retirement; the predicate itself
    // (`r.name = 'IS_DUPLICATE_OF'`) must not.
    expect(src.includes("r.name = 'IS_DUPLICATE_OF'")).toBe(false);
  });

  it("normalisation mirrors the wheel's _normalize_string_exact: lowercase, trim, AND collapse internal whitespace", () => {
    // `toLower(trim(...))` alone undercounts splits that differ by a whitespace run — the wheel
    // collapses runs before resolving, so the census must too or it measures a different world.
    expect(normalizeEntityName("  John\t\n  Smith ")).toBe("john smith");
    expect(normalizeEntityName("JOHN SMITH")).toBe("john smith");
    expect(normalizeEntityName("john  smith")).toBe("john smith");
  });

  it("normalisation happens TS-side: two raw names that collapse to one are re-merged into a split", () => {
    // Cypher aggregates by the RAW name, so "John Smith" and "john  smith" arrive as two rows of one
    // node each. Normalising after a Cypher-side aggregation cannot re-merge them — the TS layer
    // must, or exactly the whitespace-variant splits the census exists to count read as healthy
    // single-node names.
    const now = Date.UTC(2026, 7, 7);
    const recent = new Date(now - 1000).toISOString();
    const out = windowNameCensus(
      [
        { name: "John Smith", nodes: 1, newest: recent },
        { name: "john  smith", nodes: 1, newest: recent },
        { name: "Acme", nodes: 1, newest: recent },
      ],
      now
    );
    expect(out.recentNames).toBe(2); // john smith + acme — NOT 3
    expect(out.recentSplit).toBe(1); // john smith carries 2 nodes after the re-merge
  });

  it("windows by the name's NEWEST node: recent vs trailing baseline, older ignored", () => {
    const now = Date.UTC(2026, 7, 7);
    const inRecent = new Date(now - CENSUS_RECENT_MS + 60_000).toISOString();
    const inBaseline = new Date(now - CENSUS_RECENT_MS - 60_000).toISOString();
    const ancient = new Date(now - CENSUS_BASELINE_MS - 60_000).toISOString();
    const out = windowNameCensus(
      [
        { name: "alpha", nodes: 2, newest: inRecent },
        { name: "beta", nodes: 1, newest: inBaseline },
        { name: "gamma", nodes: 5, newest: ancient },
      ],
      now
    );
    expect(out).toEqual({ recentNames: 1, recentSplit: 1, baselineNames: 1, baselineSplit: 0 });
  });

  const judgedSignals = (over: Partial<NameCollisionSignals> = {}): NameCollisionSignals => ({
    recentNames: MIN_NAMES_FOR_CENSUS_SIGNAL * 4,
    recentSplit: 0,
    baselineNames: MIN_NAMES_FOR_CENSUS_SIGNAL * 4,
    baselineSplit: 0,
    ...over,
  });

  it("ZERO split names over a real sample is a JUDGED, healthy reading — the old zero⇒unjudgeable rule must not return", () => {
    const out = deriveNameCollisionPollution(
      { configured: true, signals: judgedSignals(), recentEpisodes: 30 },
      true
    );
    expect(out.judgeable).toBe(true);
    expect(out.polluted).toBe(false);
    expect(out.refusal).toBeNull();
  });

  it("the ledger cross-check tripwire: episodes flowing but ZERO census names ⇒ predicate-suspect", () => {
    // A zero-name census is indistinguishable from a young group on its own — which is exactly the
    // silent-death shape the old guard fell to. The `graph_episodes` ledger is the one source that
    // knows whether anything was pushed: episodes in the window + nothing in the census means the
    // query no longer matches what the image writes (a rename) OR the extractor is stalled.
    //
    // 30, not 12: CENSUSFLOOR-1 gave the tripwire an episode floor
    // (`MIN_EPISODES_FOR_CENSUS_SUSPICION = 25`), because at 12 — and at prod's actual ONE — a zero
    // census is not evidence of anything, and the card was accusing a working extractor. This guard
    // pins that the tripwire STILL FIRES once the sample is real; the floor itself is pinned by
    // A2/A3 in test/name-collision-pollution.test.ts. Do NOT resolve a failure here by lowering the
    // floor — that reinstates the false accusation this guard's own subject was corrected for.
    const out = deriveNameCollisionPollution({
      configured: true,
      signals: { recentNames: 0, recentSplit: 0, baselineNames: 0, baselineSplit: 0 },
      recentEpisodes: 30,
    });
    expect(out.judgeable).toBe(false);
    expect(out.refusal).toBe("predicate-suspect");
  });

  it("…and below the floor the SAME signals must NOT accuse — the other half of the same guard", () => {
    // Its own `it`, not a second expect in the one above: under a floor-raising mutation the firing
    // expect fails first and a packed assertion never executes, so it would prove nothing about the
    // half it exists for (one-condition-per-fixture).
    const belowFloor = deriveNameCollisionPollution({
      configured: true,
      signals: { recentNames: 0, recentSplit: 0, baselineNames: 0, baselineSplit: 0 },
      recentEpisodes: 1,
    });
    expect(belowFloor.judgeable).toBe(false);
    expect(belowFloor.refusal).toBe("small-sample");
  });

  it("…and NO episodes either ⇒ a ledger-confirmed young/quiet group (small-sample), never an accusation", () => {
    const out = deriveNameCollisionPollution({
      configured: true,
      signals: { recentNames: 0, recentSplit: 0, baselineNames: 0, baselineSplit: 0 },
      recentEpisodes: 0,
    });
    expect(out.judgeable).toBe(false);
    expect(out.refusal).toBe("small-sample");
  });
});
