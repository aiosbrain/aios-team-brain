import { describe, expect, it } from "vitest";

import {
  SLACK_SEGMENT_MAX_TICKS,
  canonicalSlackBound,
  nextSlackSegmentAfterTerminal,
  slackTimestampTicks,
  splitSlackSegment,
  type SlackSegment,
} from "@/lib/ingest/slack-history-segments";

/**
 * AIO-1170 AM-F2 + AC-02 deep history — the pure segment arithmetic (accepted consolidated contract
 * `aio1170-am-f2-deep-history-consolidated-accepted-spec-migration-v1-20261023.md`).
 *
 * RED PACKET 1 covers two rows of the contract, and only their pure parts:
 *  - DH-01's REQUIRED deterministic §11 model: its six literal request/split/terminal-segment
 *    triples and the error-free baseline, reproduced from the contract's reference procedure;
 *  - DH-04's exact bounds, adjacency and canonical arithmetic: the midpoint split (`M`/`M+1`), the
 *    adjacent width-doubling segment and its clamp, the width-2-to-singleton sequence, microsecond
 *    and second carry, zero and maximum epoch, and noncanonical provider spellings.
 *
 * WHAT IT IS NOT. No SQL, schema, fence, transport or discovery behaviour is here; DH-04's request
 * parameters and root-at-edge proof through real discovery, and every other DH row, belong to the
 * later packets and suites the contract names. Every expected value is a LITERAL from the contract
 * or worked out by hand below; none is computed with the functions under test.
 */

// ── DH-01: the deterministic §11 model ─────────────────────────────────────

type Sizing = "full_remainder" | "adaptive";
type Mode = "none" | "capacity" | "unrepresentable" | "expiry";

interface ModelResult {
  requests: number;
  splits: number;
  segments: number;
  /** Every root accepted, ascending. */
  roots: bigint[];
  /** Every tick covered by a terminal segment, ascending, with multiplicity. */
  terminalTicks: bigint[];
  /** Any invariant the run broke, by name. Empty when it broke none. */
  violations: string[];
}

/**
 * The contract's §11 reference procedure, exactly: logical indices 0..127 are bigint microsecond
 * ticks 0n..127n, L = 0n, A = 127n, page size 2, continuation-entry cap K = 3, no unrelated faults,
 * empty pages, duplicates or delays. The provider returns the inclusive range [S, U] descending.
 *
 * The cursor is opaque. This fake provider models the position an opaque token would carry with its
 * own local `offset`; there is no literal token-to-offset map, and the algorithm never reads a
 * timestamp or an offset out of a token — the tokens below only fill the bounded history. Every
 * request is counted before its response, failed and rejected ones included.
 *
 * The run stops as soon as an invariant breaks, recording which one, so a wildly wrong helper fails
 * a named assertion instead of building an enormous range or running into a timeout.
 *
 * Only the ADAPTIVE path calls the production helpers. The full-remainder comparison path is the
 * test's own arithmetic — `floor((S+U)/2)+1` and `S_new = L` — so that path is a control of this
 * harness against the contract's literal totals, independent of the module under test.
 */
function runModel(sizing: Sizing, mode: Mode, cap = 3): ModelResult {
  const L = 0n;
  const A = 127n;
  const PAGE = 2;
  let S = L;
  let U = A;
  let offset = 0;
  /** Opaque continuation tokens accepted in this attempt. */
  let history: string[] = [];
  let tokens = 0;
  const roots = new Set<bigint>();
  const terminalTicks: bigint[] = [];
  const violations: string[] = [];
  let requests = 0;
  let splits = 0;
  let segments = 0;
  /** True when every invariant holds; otherwise records the broken one and returns false, which stops the run. */
  const invariantsHold = (where: string): boolean => {
    if (!(L <= S && S <= U && U <= A)) {
      violations.push(`${where}: bounds left 0 <= S <= U <= 127`);
      return false;
    }
    if (history.length > cap) {
      violations.push(`${where}: history exceeded the cap`);
      return false;
    }
    return true;
  };

  for (;;) {
    if (requests >= 2000) {
      violations.push("the run did not finish within 2,000 requests");
      break;
    }
    // Checked BEFORE the range below is materialized: an out-of-domain bound never builds an array.
    if (!invariantsHold("before a request")) break;
    requests += 1;
    const values: bigint[] = [];
    for (let tick = U; tick >= S; tick -= 1n) values.push(tick);
    const page = values.slice(offset, offset + PAGE);
    const more = offset + page.length < values.length;
    // Expiry is an actual provider error: no successful page, and no roots, are accepted from it.
    const bad = (mode === "expiry" && offset > 0) || (more && (mode === "unrepresentable" || history.length === cap));
    if (bad) {
      if (!(S < U)) {
        violations.push("a singleton was asked to split");
        break;
      }
      if (sizing === "adaptive") {
        const next = splitSlackSegment({ lower: S, upper: U });
        if (next === null) {
          violations.push("the production split refused a non-singleton");
          break;
        }
        S = next.lower;
        U = next.upper;
      } else {
        S = (S + U) / 2n + 1n;
      }
      offset = 0;
      history = [];
      splits += 1;
      if (!invariantsHold("after a split")) break;
      continue;
    }
    for (const value of page) roots.add(value);
    if (more) {
      offset += page.length;
      tokens += 1;
      history.push(`opaque-cursor-${tokens}`);
      if (!invariantsHold("after a continuation")) break;
      continue;
    }
    // A genuinely terminal response finishes [S, U].
    segments += 1;
    for (let tick = S; tick <= U; tick += 1n) terminalTicks.push(tick);
    if (S === L) break;
    if (sizing === "adaptive") {
      const next = nextSlackSegmentAfterTerminal(L, { lower: S, upper: U });
      if (next === null) {
        violations.push("the production next segment ended an unfinished envelope");
        break;
      }
      S = next.lower;
      U = next.upper;
    } else {
      U = S - 1n;
      S = L;
    }
    offset = 0;
    history = [];
    if (!invariantsHold("after a terminal segment")) break;
  }

  return {
    requests,
    splits,
    segments,
    roots: [...roots].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    terminalTicks: [...terminalTicks].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    violations,
  };
}

/** 0n..127n, written out by construction rather than by any function under test. */
const EVERY_TICK: bigint[] = Array.from({ length: 128 }, (_, index) => BigInt(index));

/** The run's counts, and the completeness facts every run must also satisfy. */
function summary(result: ModelResult) {
  return {
    counts: { requests: result.requests, splits: result.splits, segments: result.segments },
    rootsAreExactly0To127: result.roots.length === 128 && result.roots.every((tick, index) => tick === EVERY_TICK[index]),
    everyTickInExactlyOneTerminalSegment: result.terminalTicks.length === 128 && result.terminalTicks.every((tick, index) => tick === EVERY_TICK[index]),
    violations: result.violations,
  };
}

const COMPLETE = { rootsAreExactly0To127: true, everyTickInExactlyOneTerminalSegment: true, violations: [] };

describe("DH-01 deterministic §11 segment model — literal request, split and terminal-segment totals", () => {
  it("DH-01 deterministic baseline: with no cap and no error, 64 requests, no split, one terminal envelope", () => {
    expect(summary(runModel("adaptive", "none", Number.POSITIVE_INFINITY))).toEqual({
      counts: { requests: 64, splits: 0, segments: 1 }, ...COMPLETE,
    });
  });

  it("DH-01 deterministic capacity counts", () => {
    expect(summary(runModel("full_remainder", "capacity")), "full-remainder comparison (harness control)").toEqual({
      counts: { requests: 329, splits: 65, segments: 21 }, ...COMPLETE,
    });
    expect(summary(runModel("adaptive", "capacity")), "adaptive, through the production helpers").toEqual({
      counts: { requests: 136, splits: 18, segments: 16 }, ...COMPLETE,
    });
  });

  it("DH-01 deterministic unrepresentable counts", () => {
    expect(summary(runModel("full_remainder", "unrepresentable")), "full-remainder comparison (harness control)").toEqual({
      counts: { requests: 545, splits: 450, segments: 95 }, ...COMPLETE,
    });
    expect(summary(runModel("adaptive", "unrepresentable")), "adaptive, through the production helpers").toEqual({
      counts: { requests: 132, splits: 68, segments: 64 }, ...COMPLETE,
    });
  });

  it("DH-01 deterministic expiry counts", () => {
    expect(summary(runModel("full_remainder", "expiry")), "full-remainder comparison (harness control)").toEqual({
      counts: { requests: 995, splits: 450, segments: 95 }, ...COMPLETE,
    });
    expect(summary(runModel("adaptive", "expiry")), "adaptive, through the production helpers").toEqual({
      counts: { requests: 200, splits: 68, segments: 64 }, ...COMPLETE,
    });
  });
});

// ── DH-04: exact bounds, adjacency and canonical arithmetic ─────────────────

/** A real-looking instant, 1718900000.123456, in ticks. Every value below is worked out by hand. */
const T = 1_718_900_000_123_456n;

describe("DH-04 exact segment arithmetic — midpoint split, adjacent doubling, canonical bounds", () => {
  it.each<[string, SlackSegment, SlackSegment | null]>([
    ["the §11 envelope [0, 127]: M = 63, so the upper half starts at 64", { lower: 0n, upper: 127n }, { lower: 64n, upper: 127n }],
    ["an even-width (width-2) range [3, 4]: M = 3, so the upper half is the singleton 4", { lower: 3n, upper: 4n }, { lower: 4n, upper: 4n }],
    ["an odd-width (width-3) range [0, 2]: M = 1, so the upper half is the singleton 2", { lower: 0n, upper: 2n }, { lower: 2n, upper: 2n }],
    ["an odd-width (width-3) range [T, T + 2]: M = T + 1, so the upper half is the singleton T + 2", { lower: T, upper: T + 2n }, { lower: T + 2n, upper: T + 2n }],
    ["a width-2 range one microsecond apart: the message at M stays below, M+1 goes up", { lower: T, upper: T + 1n }, { lower: T + 1n, upper: T + 1n }],
    ["an even width, [T, T + 999]: M = T + 499, upper half from T + 500", { lower: T, upper: T + 999n }, { lower: T + 500n, upper: T + 999n }],
    ["the whole supported domain [0, max]: exact bigint midpoint, no float rounding",
      { lower: 0n, upper: SLACK_SEGMENT_MAX_TICKS }, { lower: 126_701_150_400_000_000n, upper: SLACK_SEGMENT_MAX_TICKS }],
    ["a singleton cannot be divided", { lower: T, upper: T }, null],
  ])("DH-04 split: %s", (_label, segment, expected) => {
    expect(splitSlackSegment(segment)).toEqual(expected);
  });

  // Corrupt shapes are REFUSED, never read as a singleton: only lower = upper means "cannot divide".
  it.each<[string, SlackSegment]>([
    ["an inverted segment", { lower: 5n, upper: 4n }],
    ["a negative lower bound", { lower: -1n, upper: 4n }],
    ["a negative upper bound", { lower: -2n, upper: -1n }],
  ])("DH-04 split refuses %s with a static RangeError", (_label, segment) => {
    expect(() => splitSlackSegment(segment)).toThrow(new RangeError("slack history segment: invalid segment bounds"));
  });

  it.each<[string, bigint, SlackSegment, SlackSegment | null]>([
    ["after [100, 109] (W = 10): the adjacent older segment has width 2W", 0n, { lower: 100n, upper: 109n }, { lower: 80n, upper: 99n }],
    ["after the upper half [64, 127] (W = 64): clamped at L = 0", 0n, { lower: 64n, upper: 127n }, { lower: 0n, upper: 63n }],
    ["after [10, 19] with L = 0: 2W would pass the envelope bottom, so it clamps to 0", 0n, { lower: 10n, upper: 19n }, { lower: 0n, upper: 9n }],
    ["after [10, 19] with L = 5: it clamps to the envelope lower, not to zero", 5n, { lower: 10n, upper: 19n }, { lower: 5n, upper: 9n }],
    ["after the upper singleton of [T, T + 1]: the adjacent lower singleton", T, { lower: T + 1n, upper: T + 1n }, { lower: T, upper: T }],
    ["after a segment that reaches the envelope lower: the envelope is finished", T, { lower: T, upper: T }, null],
    ["after a deep segment near the maximum epoch: exact bigint, no overflow",
      0n, { lower: SLACK_SEGMENT_MAX_TICKS - 9n, upper: SLACK_SEGMENT_MAX_TICKS },
      { lower: SLACK_SEGMENT_MAX_TICKS - 29n, upper: SLACK_SEGMENT_MAX_TICKS - 10n }],
  ])("DH-04 next segment: %s", (_label, envelopeLower, completed, expected) => {
    expect(nextSlackSegmentAfterTerminal(envelopeLower, completed)).toEqual(expected);
  });

  // Corrupt shapes are REFUSED, never read as a finished envelope: only completed.lower = L means "done".
  it.each<[string, bigint, SlackSegment]>([
    ["a completed segment that starts below the envelope lower", 10n, { lower: 5n, upper: 20n }],
    ["an inverted completed segment", 0n, { lower: 20n, upper: 10n }],
    ["a negative envelope lower", -1n, { lower: 10n, upper: 20n }],
    ["a negative completed lower bound", 0n, { lower: -5n, upper: 20n }],
    ["a negative completed upper bound", -10n, { lower: -5n, upper: -1n }],
  ])("DH-04 next segment refuses %s with a static RangeError", (_label, envelopeLower, completed) => {
    expect(() => nextSlackSegmentAfterTerminal(envelopeLower, completed)).toThrow(new RangeError("slack history segment: invalid completed segment"));
  });

  it("DH-04 next segment at the refusal boundary: a completed segment starting exactly at the envelope lower finishes it", () => {
    expect(nextSlackSegmentAfterTerminal(10n, { lower: 10n, upper: 20n })).toBeNull();
  });

  it.each<[string, bigint, SlackSegment, SlackSegment | null]>([
    ["one tick above the envelope lower: the adjacent older range is just the lower singleton", 10n, { lower: 11n, upper: 20n }, { lower: 10n, upper: 10n }],
  ])("DH-04 next segment at the refusal boundary: %s", (_label, envelopeLower, completed, expected) => {
    expect(nextSlackSegmentAfterTerminal(envelopeLower, completed)).toEqual(expected);
  });

  it("DH-04 width-2 to singleton: [T, T + 1] splits once, then two adjacent singletons finish it", () => {
    const upperHalf = splitSlackSegment({ lower: T, upper: T + 1n });
    expect(upperHalf, "the split keeps U and moves S to M + 1").toEqual({ lower: T + 1n, upper: T + 1n });
    const lowerSingleton = upperHalf === null ? null : nextSlackSegmentAfterTerminal(T, upperHalf);
    expect(lowerSingleton, "the adjacent lower singleton").toEqual({ lower: T, upper: T });
    expect(lowerSingleton === null ? "not reached" : nextSlackSegmentAfterTerminal(T, lowerSingleton), "then the envelope is finished").toBeNull();
  });

  it.each<[string, bigint, string | null]>([
    ["zero", 0n, "0.000000"],
    ["one microsecond below a second", 999_999n, "0.999999"],
    ["the microsecond carry into a whole second", 1_000_000n, "1.000000"],
    ["a provider-looking instant", 1_718_900_000_100_000n, "1718900000.100000"],
    ["microseconds zero-padded to six digits", 1_718_900_000_000_100n, "1718900000.000100"],
    ["all six microsecond digits significant", T, "1718900000.123456"],
    ["the second carry after .999999", 1_718_900_000_999_999n + 1n, "1718900001.000000"],
    ["the largest supported instant", SLACK_SEGMENT_MAX_TICKS, "253402300799.999999"],
    ["one microsecond past the largest supported instant", SLACK_SEGMENT_MAX_TICKS + 1n, null],
    ["a negative tick count", -1n, null],
  ])("DH-04 canonical bound: %s", (_label, ticks, expected) => {
    expect(canonicalSlackBound(ticks)).toBe(expected);
  });

  it.each<[string, string, bigint | null]>([
    ["a noncanonical one-digit fraction", "1718900000.1", 1_718_900_000_100_000n],
    ["a full six-digit fraction", "1718900000.000100", 1_718_900_000_000_100n],
    ["leading zeroes in the seconds (an opaque provider spelling)", "0001718900000.000100", 1_718_900_000_000_100n],
    ["the largest supported instant", "253402300799.999999", SLACK_SEGMENT_MAX_TICKS],
    ["seven fractional digits", "1718900000.1234567", null],
    ["no fraction at all", "1718900000", null],
    ["past the largest supported second", "253402300800.000000", null],
    ["text that is not a timestamp", "not-a-ts", null],
    // Parity with the shared exact parser: strictly positive seconds, the exact grammar, nothing around it.
    ["a zero-second instant with a six-digit fraction", "0.000001", null],
    ["a zero-second instant with a short fraction", "0.1", null],
    ["zero itself", "0.000000", null],
    ["a leading plus sign", "+1718900000.1", null],
    ["a leading minus sign", "-1718900000.1", null],
    ["leading whitespace", " 1718900000.1", null],
    ["trailing whitespace", "1718900000.1 ", null],
    ["a trailing newline", "1718900000.1\n", null],
    ["no seconds before the dot", ".5", null],
    ["no fraction after the dot", "1.", null],
    ["an exponent", "1718900000.1e3", null],
    ["an empty string", "", null],
    ["the smallest positive second, as a positive control", "1.000000", 1_000_000n],
  ])("DH-04 provider timestamp ticks: %s", (_label, ts, expected) => {
    expect(slackTimestampTicks(ts)).toBe(expected);
  });

  it("DH-04 a noncanonical legacy anchor compares equal to its canonical bound, and its original spelling is not rewritten", () => {
    const original = "1718900000.1";
    const ticks = slackTimestampTicks(original);
    expect([typeof ticks, ticks === null ? null : canonicalSlackBound(ticks)]).toEqual(["bigint", "1718900000.100000"]);
    expect(original, "the original root key stays as the provider spelled it").toBe("1718900000.1");
  });
});
