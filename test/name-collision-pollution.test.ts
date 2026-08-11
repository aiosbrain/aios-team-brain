import { describe, expect, it } from "vitest";
import {
  deriveNameCollisionPollution,
  CENSUS_ABSOLUTE_FLOOR,
  MIN_NAMES_FOR_CENSUS_SIGNAL,
  MIN_EPISODES_FOR_CENSUS_SUSPICION,
  type NameCollisionInput,
} from "@/lib/graph/extraction-health";

/**
 * Spec (docs/design/dedupe-alarm-0293.md): catch an extraction stack that accumulates same-name
 * entity splits — the surviving pollution shape on graphiti_core 0.29.3, where exact-normalised-name
 * dedup is deterministic and a same-name split can only mean candidate retrieval missed the
 * existing node.
 *
 * Every uncertain case must return NOT polluted, and must say WHY via the machine-readable
 * `refusal` — the blindness meta-alarm keys its clock on it, so a refusal that mislabels its cause
 * mis-parks or mis-runs a pager. The alarm ships UNARMED (`CENSUS_ALARM_ARMED = false`) until the
 * margin/floor constants are measured from prod (rollout step 3); tests pass `armed: true`
 * explicitly to pin the armed mechanics without waiting for that flip.
 */

const MIN = MIN_NAMES_FOR_CENSUS_SIGNAL;

const input = (
  recentSplit: number,
  recentNames: number,
  baselineSplit: number,
  baselineNames: number,
  over: Partial<NameCollisionInput> = {}
): NameCollisionInput => ({
  configured: true,
  signals: { recentNames, recentSplit, baselineNames, baselineSplit },
  recentEpisodes: 25,
  ...over,
});

// A recent share comfortably over both the floor and the margin against this baseline.
const hot = () =>
  input(
    Math.ceil(MIN * 4 * Math.max(CENSUS_ABSOLUTE_FLOOR * 2, 0.5)),
    MIN * 4,
    Math.ceil(MIN * 4 * 0.02),
    MIN * 4
  );

describe("deriveNameCollisionPollution — armed mechanics", () => {
  it("flags a split share over both the floor and the margin (armed)", () => {
    const out = deriveNameCollisionPollution(hot(), true);
    expect(out.polluted).toBe(true);
    expect(out.judgeable).toBe(true);
    expect(out.refusal).toBeNull();
    expect(out.reason).toMatch(/same-name duplicate entities/i);
    // The message must name the action, not just the observation.
    expect(out.reason).toMatch(/Extraction model/i);
  });

  it("needs BOTH: above the floor AND above the baseline by the margin", () => {
    const names = MIN * 20;
    // Above the floor but NOT a rise: baseline share equals recent share.
    const flatSplit = Math.ceil(names * (CENSUS_ABSOLUTE_FLOOR + 0.05));
    const flat = deriveNameCollisionPollution(input(flatSplit, names, flatSplit, names), true);
    expect(flat.polluted, "high-but-flat is this graph's nature, not a regression").toBe(false);
    expect(flat.judgeable, "judged-healthy, not refused — this CAN clear an active alarm").toBe(true);
    // A big relative rise UNDER the floor: 1% → 3% is 3x and completely meaningless.
    const noisy = deriveNameCollisionPollution(
      input(Math.ceil(names * 0.03), names, Math.ceil(names * 0.01), names),
      true
    );
    expect(noisy.polluted, "a relative margin alone fires on noise").toBe(false);
  });

  it("at a ZERO baseline share the relative margin rejects nothing — the absolute floor judges alone", () => {
    // The healthy steady state on 0.29.3 is zero splits, so a zero baseline is NORMAL, not
    // predicate-suspect: the stated judging rule is `baselineShare === 0 ⇒ only the floor applies`.
    const names = MIN * 20;
    const overFloor = deriveNameCollisionPollution(
      input(Math.ceil(names * (CENSUS_ABSOLUTE_FLOOR + 0.05)), names, 0, names),
      true
    );
    expect(overFloor.polluted).toBe(true);
    const underFloor = deriveNameCollisionPollution(
      input(Math.floor(names * CENSUS_ABSOLUTE_FLOOR) - 1, names, 0, names),
      true
    );
    expect(underFloor.polluted).toBe(false);
    expect(underFloor.judgeable).toBe(true);
  });

  it("zero split names is judged HEALTHY — 0 splits / 684 names is the measured steady state", () => {
    const out = deriveNameCollisionPollution(input(0, 684, 0, 684), true);
    expect(out).toMatchObject({ polluted: false, judgeable: true, refusal: null });
    expect(out.recentShare).toBe(0);
  });
});

describe("deriveNameCollisionPollution — the unarmed clamp (rollout step 1)", () => {
  it("while unarmed the verdict is never polluted, even on a share that would fire", () => {
    // Default `armed` = CENSUS_ALARM_ARMED = false until the constants are measured (rollout).
    const out = deriveNameCollisionPollution(hot());
    expect(out.polluted).toBe(false);
    expect(out.reason).toBeNull();
  });

  it("…but judgeable and refusal still compute — the blindness meta-alarm needs them", () => {
    expect(deriveNameCollisionPollution(hot()).judgeable).toBe(true);
    // 30, not 10: CENSUSFLOOR-1 gave the accusation an episode floor
    // (`MIN_EPISODES_FOR_CENSUS_SUSPICION`), so 10 now reads `small-sample`. This test is about
    // refusals still computing while unarmed, so it needs a fixture that genuinely reaches the
    // tripwire — the floor is pinned separately by A2/A3, and must NOT be lowered to keep this green.
    const suspect = deriveNameCollisionPollution({
      configured: true,
      signals: { recentNames: 0, recentSplit: 0, baselineNames: 0, baselineSplit: 0 },
      recentEpisodes: 30,
    });
    expect(suspect.refusal).toBe("predicate-suspect");
  });
});

describe("deriveNameCollisionPollution — refusal taxonomy", () => {
  it("no Neo4j configured ⇒ graph-unconfigured (nothing to protect)", () => {
    const out = deriveNameCollisionPollution({ ...hot(), configured: false }, true);
    expect(out).toMatchObject({ polluted: false, judgeable: false, refusal: "graph-unconfigured" });
  });

  it("unreadable graph (null signals) ⇒ graph-unreadable, never degraded", () => {
    const out = deriveNameCollisionPollution({
      configured: true,
      signals: { recentNames: null, recentSplit: null, baselineNames: null, baselineSplit: null },
      recentEpisodes: 25,
    });
    expect(out).toMatchObject({ polluted: false, judgeable: false, refusal: "graph-unreadable" });
  });

  it("a recent sample under the NAME minimum ⇒ small-sample — 1 split of 3 names means nothing", () => {
    const out = deriveNameCollisionPollution(input(3, 3, 10, MIN * 4), true);
    expect(out).toMatchObject({ polluted: false, judgeable: false, refusal: "small-sample" });
    // Shares are still computed (they exist for display); `judgeable` is what says they carry no
    // verdict — the alarm's edge machine keys on THAT (the quiet-Saturday false recovery).
    expect(out.recentShare).not.toBeNull();
  });

  it("a baseline under the name minimum ⇒ no-baseline — a young graph has no history to judge against", () => {
    const out = deriveNameCollisionPollution(input(MIN, MIN * 4, 2, 5), true);
    expect(out).toMatchObject({ polluted: false, judgeable: false, refusal: "no-baseline" });
  });

  it("an unreadable LEDGER with a zero-name census reads small-sample, not predicate-suspect — unknown never accuses", () => {
    const out = deriveNameCollisionPollution({
      configured: true,
      signals: { recentNames: 0, recentSplit: 0, baselineNames: 0, baselineSplit: 0 },
      recentEpisodes: null,
    });
    expect(out.refusal).toBe("small-sample");
  });
});

describe("the configured flag is checked before the signals", () => {
  it("unconfigured outranks unreadable — no Neo4j means PARK, not a 6h-grace pager", () => {
    const out = deriveNameCollisionPollution({
      configured: false,
      signals: { recentNames: null, recentSplit: null, baselineNames: null, baselineSplit: null },
      recentEpisodes: 0,
    });
    expect(out.refusal).toBe("graph-unconfigured");
  });
});

/**
 * CENSUSFLOOR-1 (docs/design/census-sample-floor.md): the zero-name tripwire accused on a sample of
 * ONE episode, while its sibling judgement in the same file refuses below 25
 * (`MIN_EPISODES_FOR_EXTRACTION_SIGNAL`) with the reason in its own docstring. Found live: prod's
 * `aios_external` group held exactly one 196-char boilerplate index stub in the 7-day window and the
 * admin card read "rename or stalled extractor". Neo4j confirmed 16 entities all-time in that group —
 * extraction was fine; the zero was windowing.
 */
describe("deriveNameCollisionPollution — the accusation needs a sample (CENSUSFLOOR-1)", () => {
  const zeroNames = (recentEpisodes: number | null): NameCollisionInput => ({
    configured: true,
    signals: { recentNames: 0, recentSplit: 0, baselineNames: 0, baselineSplit: 0 },
    recentEpisodes,
  });

  // A1 — prod's exact shape must not accuse.
  it("A1: zero names with ONE recent episode reads small-sample, never an accusation", () => {
    const out = deriveNameCollisionPollution(zeroNames(1));
    expect(out.refusal).toBe("small-sample");
    expect(out.judgeable).toBe(false);
    expect(out.polluted).toBe(false);
  });

  // A2 — LITERAL 25, not the constant: if every test read the constant, a mutation raising the
  // floor to 10_000 (killing detection outright) would leave the whole suite green.
  it("A2: zero names with a literal 25 recent episodes still trips predicate-suspect", () => {
    expect(deriveNameCollisionPollution(zeroNames(25)).refusal).toBe("predicate-suspect");
  });

  // A3 — the boundary, wherever the constant sits.
  it("A3: the boundary is exact at the exported constant", () => {
    expect(deriveNameCollisionPollution(zeroNames(MIN_EPISODES_FOR_CENSUS_SUSPICION - 1)).refusal).toBe(
      "small-sample"
    );
    expect(deriveNameCollisionPollution(zeroNames(MIN_EPISODES_FOR_CENSUS_SUSPICION)).refusal).toBe(
      "predicate-suspect"
    );
  });

  // A6 — prod's measured state, as a fixture.
  it("A6: prod's measured aios_external state (1 episode, 0 names) reads small-sample", () => {
    expect(deriveNameCollisionPollution(zeroNames(1)).refusal).toBe("small-sample");
  });

  // A4's null case already pinned above; re-asserted here against the new predicate's `??`.
  it("A4: an unreadable ledger still reads small-sample under the floor comparison", () => {
    expect(deriveNameCollisionPollution(zeroNames(null)).refusal).toBe("small-sample");
  });
});
