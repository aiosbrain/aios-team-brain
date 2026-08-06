import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no types.
import { parseCostText } from "../scripts/graph-window-battery/judge.mjs";

/**
 * The judge's cost-text parsers for PIPEFF-2 (AIO-821).
 *
 * The judge reads C1 and Q5 out of `scripts/graph-ingest-cost.mjs`'s printed output, because the
 * harness is the pre-registered instrument and a second SQL path could quietly disagree with it.
 * Text parsing is fragile, so the contract under test is REFUSAL: a missing line must throw, never
 * default — a parser whose pattern misses and reports zero is indistinguishable from a measurement,
 * which is the exact failure this battery already produced once and caught only by dry run.
 *
 * The fixtures replicate the harness's print statements verbatim (thousands separators included).
 */

const clean = `
window      2026-08-06T07:44:05Z → 2026-08-06T09:40:00Z   (drain 10m)
episodes    112   (extract_nodes calls — one per episode)
cross-check 108 pushed per ingest_runs · 4% apart · +4 attempts over pushes (retries)

calls        1,104        9.9 per episode
input tok   4,327,881      per episode    38,642
cost        $1.62          per episode    $0.0145
MULTIPLE    61.8x the content a full episode carries
`;

describe("parseCostText — extraction from the harness's own output", () => {
  it("reads attempts, cross-check, signed gap and tokens-per-episode from a clean report", () => {
    const got = parseCostText(clean, "fixture");
    expect(got).toMatchObject({
      refused: false,
      crossCheckAvailable: true,
      attempts: 112,
      episodesPushed: 108,
      signedGap: 4,
      inputTokensPerEpisode: 38642,
    });
  });

  it("reads a negative signed gap", () => {
    const got = parseCostText(clean.replace("+4 attempts over pushes (retries)", "-2 — pushes this window did not bill"), "fixture");
    expect(got.signedGap).toBe(-2);
  });

  it("reads an exact cross-check as a zero gap", () => {
    const got = parseCostText(clean.replace("4% apart · +4 attempts over pushes (retries)", "0% apart · exact"), "fixture");
    expect(got.signedGap).toBe(0);
  });

  it("flags a refusal instead of parsing numbers out of a refused report", () => {
    const got = parseCostText(clean + "\nREFUSING TO REPORT A RATIO:\n  · traffic at the leading edge\n", "fixture");
    expect(got.refused).toBe(true);
  });

  it("flags an unavailable cross-check", () => {
    const got = parseCostText(
      clean.replace(/cross-check.*$/m, "cross-check unavailable — no projector runs finished inside this window"),
      "fixture"
    );
    expect(got.crossCheckAvailable).toBe(false);
  });
});

describe("the parsers REFUSE on drift — a missing line throws, never defaults", () => {
  it.each([
    ["attempts line", /episodes\s+112.*\n/],
    ["tokens-per-episode line", /input tok.*\n/],
  ])("throws when the %s is missing", (_label, re) => {
    expect(() => parseCostText(clean.replace(re, ""), "fixture")).toThrow(/format drifted/);
  });

  it("throws when the cross-check line is missing entirely — absence is not availability", () => {
    expect(() => parseCostText(clean.replace(/cross-check.*\n/, ""), "fixture")).toThrow(/no cross-check line/);
  });

  it("throws on an unparseable cross-check sign rather than guessing", () => {
    expect(() => parseCostText(clean.replace("+4 attempts over pushes (retries)", "some future wording"), "fixture")).toThrow(
      /sign unparseable/
    );
  });
});
