/**
 * AIO-1170 AM-F2 + AC-02 deep history — the PURE timestamp-segment arithmetic for a channel
 * history lane (accepted consolidated contract
 * `aio1170-am-f2-deep-history-consolidated-accepted-spec-migration-v1-20261023.md`, §4–§7, §11).
 *
 * Timestamps here are exact integer MICROSECOND ticks (`bigint`): seconds × 1,000,000 + micros.
 * Never `Number`, floats, `Date` or string order. Every bound, width, midpoint and doubling stays a
 * `bigint` throughout, so the arithmetic is exact across the whole supported domain
 * `[0, 253402300799.999999]`. The channel-state writer stays authoritative for every durable
 * transition; these helpers only compute bounds.
 *
 * Nothing imports this module yet; nothing is wired or activated.
 *
 * (`BigInt(...)` is used rather than bigint literal syntax, which this project's production
 * TypeScript target does not permit.)
 */

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const MICROS_PER_SECOND = BigInt(1000000);
/** The largest supported whole second, 9999-12-31T23:59:59Z — the shared exact parser's own bound. */
const MAX_EPOCH_SECONDS = BigInt("253402300799");

/** The largest supported instant, `253402300799.999999`, in microsecond ticks. */
export const SLACK_SEGMENT_MAX_TICKS = BigInt("253402300799999999");

/** One inclusive request interval `[lower, upper]`, in microsecond ticks. */
export interface SlackSegment {
  readonly lower: bigint;
  readonly upper: bigint;
}

/**
 * The upper half of a non-singleton segment after a capacity, unrepresentable-cursor or actual
 * `invalid_cursor` refusal: `M = floor((S+U)/2)`, next `[M+1, U]`. A message at `M` stays in the
 * older remainder; one at `M+1` belongs to the upper half. `U` never moves. `null` for a singleton
 * (`S >= U`), which cannot be divided.
 *
 * Bounds are nonnegative ticks, so `bigint` division (which truncates) is exactly `floor`.
 */
export function splitSlackSegment(segment: SlackSegment): SlackSegment | null {
  if (segment.lower >= segment.upper) return null;
  const midpoint = (segment.lower + segment.upper) / TWO;
  return { lower: midpoint + ONE, upper: segment.upper };
}

/**
 * The next segment after a GENUINELY TERMINAL response finished `[S, U]` inside an envelope whose
 * lower bound is `envelopeLower` (L): `W = U − S + 1`, next `[max(L, S − 2W), S − 1]` — adjacent,
 * older, and up to twice the width that just fitted. `null` when `S <= L`: the whole envelope is
 * finished, and only then may the lane's certification rules apply.
 */
export function nextSlackSegmentAfterTerminal(envelopeLower: bigint, completed: SlackSegment): SlackSegment | null {
  if (completed.lower <= envelopeLower) return null;
  const width = completed.upper - completed.lower + ONE;
  const doubled = completed.lower - TWO * width;
  return {
    lower: doubled < envelopeLower ? envelopeLower : doubled,
    upper: completed.lower - ONE,
  };
}

/**
 * The canonical stored text of a bound: decimal seconds without leading zeroes, a dot, exactly six
 * fractional digits, within `[0, SLACK_SEGMENT_MAX_TICKS]`. `null` outside that domain. This codec
 * is used for STORED and REQUEST bounds, not only for anything derived from a message, so it permits
 * zero: the historical envelope's lower bound and a margin clamped at zero are both `0.000000`.
 */
export function canonicalSlackBound(ticks: bigint): string | null {
  if (ticks < ZERO || ticks > SLACK_SEGMENT_MAX_TICKS) return null;
  const seconds = ticks / MICROS_PER_SECOND;
  const micros = ticks % MICROS_PER_SECOND;
  return `${seconds.toString()}.${micros.toString().padStart(6, "0")}`;
}

/** A Slack `ts`: decimal seconds, a dot, one to six fractional digits — the shared exact parser's grammar. */
const PROVIDER_TS = /^(\d+)\.(\d{1,6})$/;

/**
 * The exact tick value of a PROVIDER MESSAGE timestamp spelling (`<seconds>.<1–6 fractional digits>`),
 * or `null`. It accepts exactly what the shared exact parser accepts — leading zeroes included, and
 * STRICTLY POSITIVE seconds only, up to the supported maximum — so it is not the parser for a stored
 * bound, which may be zero (see `canonicalSlackBound`). The original string is never rewritten by
 * this; it only yields the value to compare and to render canonically. A short fraction is padded on
 * the right: `.1` is 100,000 microseconds.
 */
export function slackTimestampTicks(ts: string): bigint | null {
  const match = PROVIDER_TS.exec(ts);
  if (!match) return null;
  const seconds = BigInt(match[1]);
  if (seconds <= ZERO || seconds > MAX_EPOCH_SECONDS) return null;
  const micros = BigInt(match[2].padEnd(6, "0"));
  return seconds * MICROS_PER_SECOND + micros;
}
