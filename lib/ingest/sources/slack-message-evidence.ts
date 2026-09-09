import { createHash } from "node:crypto";
import type { SlackMessage } from "./slack";

/**
 * PURE projection: raw Slack messages → per-message contribution evidence (AIO-1170).
 *
 * Nothing calls this yet. It is the source-message half of the `slack_messages` ledger the design
 * doc specifies, isolated so its invariants can be pinned before any writer or reader depends on
 * them. It answers exactly three questions about one observed message and nothing else:
 *
 *   1. WHICH message is it — `(workspace, channel, message_ts)` with the Slack strings kept
 *      byte-exact. Identity is never derived from a parsed number.
 *   2. WHEN did it happen — one UTC instant at Slack's full microsecond precision, plus the UTC day
 *      it belongs to. The existing normalizer converts with `parseFloat(ts) * 1000`, which collapses
 *      two messages a microsecond apart onto one millisecond; the evidence grain is
 *      `(thread, member, UTC day)`, so that loss cannot be carried into the ledger.
 *   3. DOES it earn a person's work credit — with a reason when it does not, so an operator can tell
 *      "a bot posted it" from "we could not classify the author yet".
 *
 * Deliberately NOT here: any notion of the current time other than the `now` the caller passes, any
 * member/identity resolution (the ledger stores the SOURCE identity and resolves mappings at read
 * time), any rendered display text, and any I/O.
 */

/** The Slack scope a batch of messages was read from. Both parts are part of every message id. */
export interface SlackEvidenceScope {
  /** Slack workspace/team id (`T…`), exactly as the provider reported it. */
  workspaceId: string;
  /** Slack channel id (`C…`), exactly as the provider reported it. */
  channelId: string;
}

/**
 * What the workspace user directory says about one author. Only the BOT flags change a verdict:
 * `deleted` (deactivated) and the guest flags are carried because the design requires deactivated
 * people and guests to remain creditable source identities — recording them here makes that a
 * property this module is pinned to rather than one it merely happens to have.
 */
export interface SlackEvidenceUser {
  displayName?: string;
  isBot?: boolean;
  isAppUser?: boolean;
  deleted?: boolean;
  isRestricted?: boolean;
  isUltraRestricted?: boolean;
}

export interface ProjectSlackEvidenceOptions {
  scope: SlackEvidenceScope;
  /**
   * The request's fixed UTC instant. REQUIRED and never defaulted: a module-level `Date.now()` would
   * make the projection impure, make its future-timestamp rule untestable, and — worst — invite the
   * ingest clock to stand in for a message time that failed to parse.
   */
  now: Date;
  /**
   * Workspace user directory. `undefined` means the directory could not be READ (e.g. a `users.list`
   * scope failure), which leaves every author unclassified — never "all human".
   */
  users?: Record<string, SlackEvidenceUser>;
}

/** Eligible = credit this person. Excluded = a durable property of the message. Unresolved = we
 *  cannot decide YET, and re-reading may change the answer; it must not become credit by default. */
export type SlackEvidenceStatus = "eligible" | "excluded" | "unresolved";

export type SlackEvidenceReason =
  | "invalid_timestamp"
  | "no_author"
  | "bot_message"
  | "tombstone"
  | "unsupported_subtype"
  | "no_text"
  | "bot_identity"
  | "author_unclassified"
  | "future_timestamp";

export interface SlackMessageEvidence {
  /** `<workspace>:<channel>:<message_ts>` — the ledger's unique key. */
  messageId: string;
  workspaceId: string;
  channelId: string;
  /** The Slack `ts` string verbatim. */
  messageTs: string;
  /** The thread root's `ts` verbatim (`messageTs` for a root). */
  rootTs: string;
  isRoot: boolean;
  /** Raw Slack user id, exact case. `null` when the message has no author. */
  authorExternalId: string | null;
  /** `<workspace>:<user>` — the qualified account identity the resolver matches on. */
  qualifiedAuthorId: string | null;
  /** ISO-8601 UTC with microseconds (`2024-06-20T16:13:20.000100Z`), or `null` if `ts` won't parse. */
  occurredAt: string | null;
  /** `YYYY-MM-DD` in UTC — the contribution day. `null` alongside a null `occurredAt`. */
  contributionDay: string | null;
  status: SlackEvidenceStatus;
  reason: SlackEvidenceReason | null;
  subtype: string | null;
  /** sha256 over the RAW source fields that carry evidence — see `sourceHash`. */
  sourceHash: string;
}

export interface SlackEvidenceProjection {
  /** One row per distinct message id, ordered by instant then id. Unparseable instants sort last. */
  messages: SlackMessageEvidence[];
  /** Observations folded into an existing row (overlapping pages, thread broadcasts). */
  duplicateCount: number;
  /** …of which disagreed on `sourceHash` — an edit straddling two pages. Counted, not hidden. */
  conflictingDuplicateCount: number;
  /** Observations with no `ts` at all: they cannot be identified, so they cannot become rows. */
  unidentifiableCount: number;
}

/** Slack `ts` is `<epoch-seconds>.<microseconds>`; anything else has no defensible instant. */
const TS_PATTERN = /^(\d+)\.(\d{1,6})$/;
/** Upper bound = 9999-12-31T23:59:59Z. Past it, `Date` reasoning stops being meaningful. */
const MAX_EPOCH_SECONDS = 253402300799;
/** Slack ids are opaque, but they must not contain the id delimiter or whitespace. */
const SCOPE_PATTERN = /^[^\s:]+$/;

/** Subtypes that are still a person's own message. Everything else is structural or a file post. */
const CREDITABLE_SUBTYPES = new Set(["thread_broadcast"]);

/** An exact Slack instant, kept as its integer parts so later packets can persist microseconds. */
export interface ParsedInstant {
  seconds: number;
  micros: number;
  iso: string;
  day: string;
}

/**
 * Exact `ts` → UTC instant, with NO floating-point arithmetic on the fractional part: the seconds and
 * the microseconds are parsed as separate integers and the microseconds are re-attached as text. A
 * single `parseFloat` here is what erases the difference between `…000100` and `…000101`.
 */
export function parseSlackTimestamp(ts: string): ParsedInstant | null {
  const m = TS_PATTERN.exec(ts);
  if (!m) return null;
  const seconds = Number(m[1]);
  // A zero/absurd epoch is not a real Slack message time; treating it as 1970 would silently plant
  // evidence on a day nobody worked.
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > MAX_EPOCH_SECONDS) return null;
  const micros = Number(m[2].padEnd(6, "0"));
  const base = new Date(seconds * 1000).toISOString(); // always ends `.000Z` — seconds are integral
  const iso = `${base.slice(0, -5)}.${String(micros).padStart(6, "0")}Z`;
  return { seconds, micros, iso, day: iso.slice(0, 10) };
}

/**
 * The EVIDENCE hash: raw source fields whose change means "this message's evidence changed".
 *
 * In, because each one can flip eligibility, credit or placement: the raw text, the subtype, the
 * bot marker, the author, the message's own ts and the root it hangs under.
 *
 * Out, deliberately:
 *  • display names — cosmetic, and workspace-wide renames would otherwise mark every message in the
 *    channel as semantically changed;
 *  • `reply_count` — it moves on the ROOT every time somebody else replies, which is a change to the
 *    thread, not to the root author's message.
 */
function sourceHash(m: SlackMessage, rootTs: string): string {
  const material = [
    "slack-message-evidence/v1",
    m.ts,
    rootTs,
    m.user ?? "",
    m.subtype ?? "",
    m.bot_id ?? "",
    m.text ?? "",
  ];
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

/**
 * The eligibility verdict, in a FIXED precedence order so a message that trips several rules always
 * reports the same reason. Message-level facts (does it parse, who sent it, is it a bot post, is it
 * structural) are decided before directory-level ones, because they hold regardless of what we
 * managed to read about the workspace.
 */
function classify(
  m: SlackMessage,
  instant: ParsedInstant | null,
  opts: ProjectSlackEvidenceOptions
): { status: SlackEvidenceStatus; reason: SlackEvidenceReason | null } {
  if (!instant) return { status: "excluded", reason: "invalid_timestamp" };
  if (!m.user) return { status: "excluded", reason: "no_author" };
  // A `bot_message` carries a user id often enough that trusting the id alone credits a person for
  // an app's post; `bot_id` is the same statement on a message Slack left un-subtyped.
  if (m.subtype === "bot_message" || m.bot_id) return { status: "excluded", reason: "bot_message" };
  // A deleted root still EXISTS (and its replies are still live work) — it just is not evidence itself.
  if (m.subtype === "tombstone") return { status: "excluded", reason: "tombstone" };
  if (m.subtype && !CREDITABLE_SUBTYPES.has(m.subtype)) {
    return { status: "excluded", reason: "unsupported_subtype" };
  }
  if (!m.text || !m.text.trim()) return { status: "excluded", reason: "no_text" };

  const user = opts.users?.[m.user];
  if (user?.isBot || user?.isAppUser) return { status: "excluded", reason: "bot_identity" };
  // No directory, or an author absent from it. Guests and deactivated people ARE creditable, so the
  // fallback cannot be "human"; it is "not decided", which credits nobody and can be re-read later.
  if (!user) return { status: "unresolved", reason: "author_unclassified" };

  // Clock skew, not a contribution. The instant is kept exactly as the source stated it — it is
  // never clamped to `now` — and the verdict is re-evaluable once the clock passes it.
  if (isAfter(instant, opts.now)) return { status: "unresolved", reason: "future_timestamp" };

  return { status: "eligible", reason: null };
}

function isAfter(instant: ParsedInstant, now: Date): boolean {
  const nowMs = now.getTime();
  const nowSeconds = Math.floor(nowMs / 1000);
  const nowMicros = (nowMs - nowSeconds * 1000) * 1000;
  if (instant.seconds !== nowSeconds) return instant.seconds > nowSeconds;
  return instant.micros > nowMicros;
}

function assertScope(scope: SlackEvidenceScope): void {
  for (const [field, value] of [
    ["workspaceId", scope?.workspaceId],
    ["channelId", scope?.channelId],
  ] as const) {
    if (typeof value !== "string" || !SCOPE_PATTERN.test(value)) {
      throw new TypeError(
        `slack evidence: ${field} must be a non-empty Slack id with no whitespace or ':' (got ${JSON.stringify(value)})`
      );
    }
  }
}

/**
 * Project observed Slack messages onto contribution evidence.
 *
 * Duplicates are expected, not exceptional: a `thread_broadcast` is returned by both
 * `conversations.history` and `conversations.replies`, and overlapping pages re-deliver messages by
 * design. The FIRST observation of an id wins so a batch's result never depends on page order; a
 * duplicate that disagrees is counted rather than dropped silently, because a disagreement means an
 * edit landed mid-scan and the ledger's change detection needs to know.
 */
export function projectSlackMessageEvidence(
  messages: readonly SlackMessage[],
  opts: ProjectSlackEvidenceOptions
): SlackEvidenceProjection {
  assertScope(opts?.scope);
  if (!(opts.now instanceof Date) || !Number.isFinite(opts.now.getTime())) {
    throw new TypeError("slack evidence: `now` must be a valid Date — the projection has no ambient clock");
  }
  const { workspaceId, channelId } = opts.scope;

  const byId = new Map<string, { row: SlackMessageEvidence; instant: ParsedInstant | null }>();
  let duplicateCount = 0;
  let conflictingDuplicateCount = 0;
  let unidentifiableCount = 0;

  for (const m of messages) {
    // No `ts` → no identity. Such an observation cannot be a ledger row at all (as opposed to a
    // present-but-unparseable `ts`, which is a real, identifiable message we simply cannot place).
    if (typeof m?.ts !== "string" || !m.ts.trim()) {
      unidentifiableCount++;
      continue;
    }
    const messageId = `${workspaceId}:${channelId}:${m.ts}`;
    const rootTs = m.thread_ts ? m.thread_ts : m.ts;
    const hash = sourceHash(m, rootTs);

    const seen = byId.get(messageId);
    if (seen) {
      duplicateCount++;
      if (seen.row.sourceHash !== hash) conflictingDuplicateCount++;
      continue;
    }

    const instant = parseSlackTimestamp(m.ts);
    const { status, reason } = classify(m, instant, opts);
    byId.set(messageId, {
      instant,
      row: {
        messageId,
        workspaceId,
        channelId,
        messageTs: m.ts,
        rootTs,
        isRoot: rootTs === m.ts,
        authorExternalId: m.user ?? null,
        qualifiedAuthorId: m.user ? `${workspaceId}:${m.user}` : null,
        occurredAt: instant?.iso ?? null,
        contributionDay: instant?.day ?? null,
        status,
        reason,
        subtype: m.subtype ?? null,
        sourceHash: hash,
      },
    });
  }

  const ordered = [...byId.values()].sort((a, b) => {
    if (!a.instant || !b.instant) {
      if (a.instant) return -1; // unplaceable rows sort last, deterministically among themselves
      if (b.instant) return 1;
      return a.row.messageId < b.row.messageId ? -1 : a.row.messageId > b.row.messageId ? 1 : 0;
    }
    if (a.instant.seconds !== b.instant.seconds) return a.instant.seconds - b.instant.seconds;
    if (a.instant.micros !== b.instant.micros) return a.instant.micros - b.instant.micros;
    return a.row.messageId < b.row.messageId ? -1 : a.row.messageId > b.row.messageId ? 1 : 0;
  });

  return {
    messages: ordered.map((e) => e.row),
    duplicateCount,
    conflictingDuplicateCount,
    unidentifiableCount,
  };
}
