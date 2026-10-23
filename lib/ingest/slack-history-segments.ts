/**
 * AIO-1170 AM-F2 + AC-02 deep history — the PURE timestamp-segment arithmetic for a channel
 * history lane (accepted consolidated contract
 * `aio1170-am-f2-deep-history-consolidated-accepted-spec-migration-v1-20261023.md`, §4–§7, §11).
 *
 * Timestamps here are exact integer MICROSECOND ticks (`bigint`): seconds × 1,000,000 + micros.
 * Never `Number`, floats, `Date` or string order. The channel-state writer stays authoritative for
 * every durable transition; these helpers only compute bounds.
 *
 * ⚠️ RED PLACEHOLDER — RED PACKET 1. Every function below is DELIBERATELY WRONG, bounded and
 * non-throwing, so that `test/slack-history-segments.test.ts` fails on named behavioral assertions
 * rather than on a missing export or an exception:
 *  - `splitSlackSegment` jumps straight to the upper singleton instead of `[floor((S+U)/2)+1, U]`;
 *  - `nextSlackSegmentAfterTerminal` returns the whole remaining range (`S_new = L`) instead of the
 *    adjacent width-doubling segment;
 *  - `canonicalSlackBound` renders bare ticks and never refuses an out-of-domain value;
 *  - `slackTimestampTicks` parses nothing.
 * Nothing imports this module; nothing is wired or activated. The real implementation replaces
 * these bodies in a later packet.
 */

/** The largest supported instant, `253402300799.999999`, in microsecond ticks. */
export const SLACK_SEGMENT_MAX_TICKS = BigInt("253402300799999999");

/** One inclusive request interval `[lower, upper]`, in microsecond ticks. */
export interface SlackSegment {
  readonly lower: bigint;
  readonly upper: bigint;
}

/**
 * The upper half of a non-singleton segment after a capacity, unrepresentable-cursor or actual
 * `invalid_cursor` refusal: `M = floor((S+U)/2)`, next `[M+1, U]`. `null` for a singleton, which
 * cannot be divided.
 *
 * RED PLACEHOLDER: returns the upper singleton `[U, U]`.
 */
export function splitSlackSegment(segment: SlackSegment): SlackSegment | null {
  if (segment.lower >= segment.upper) return null;
  return { lower: segment.upper, upper: segment.upper };
}

/**
 * The next segment after a GENUINELY TERMINAL response finished `[S, U]` inside an envelope whose
 * lower bound is `envelopeLower`: `W = U − S + 1`, next `[max(L, S − 2W), S − 1]`. `null` when
 * `S = L`: the whole envelope is finished.
 *
 * RED PLACEHOLDER: returns the whole remaining range `[L, S − 1]`.
 */
export function nextSlackSegmentAfterTerminal(envelopeLower: bigint, completed: SlackSegment): SlackSegment | null {
  if (completed.lower <= envelopeLower) return null;
  return { lower: envelopeLower, upper: completed.lower - BigInt(1) };
}

/**
 * The canonical stored text of a bound: decimal seconds without leading zeroes, a dot, exactly six
 * fractional digits, within `[0, SLACK_SEGMENT_MAX_TICKS]`. `null` outside that domain. This codec
 * is used for STORED and REQUEST bounds, not only for anything derived from a message, so it permits
 * zero: the historical envelope's lower bound and a margin clamped at zero are both `0.000000`.
 *
 * RED PLACEHOLDER: renders the bare tick count and refuses nothing.
 */
export function canonicalSlackBound(ticks: bigint): string | null {
  return String(ticks);
}

/**
 * The exact tick value of a PROVIDER MESSAGE timestamp spelling (`<seconds>.<1–6 fractional digits>`),
 * or `null`. It accepts exactly what the shared exact parser accepts — leading zeroes included, and
 * STRICTLY POSITIVE seconds only, up to the supported maximum — so it is not the parser for a stored
 * bound, which may be zero (see `canonicalSlackBound`). The original string is never rewritten by
 * this; it only yields the value to compare and to render canonically.
 *
 * RED PLACEHOLDER: parses nothing.
 */
export function slackTimestampTicks(ts: string): bigint | null {
  void ts;
  return null;
}
