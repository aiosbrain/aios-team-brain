import "server-only";
import type { SqlQueryResult, TransactionSession } from "@/lib/db/types";
import { parseSlackTimestamp } from "./sources/slack-message-evidence";
import { scopedSlackChannelPathPrefix } from "./sources/slack-namespace";

/**
 * The single writer of `slack_sync_channels` — one channel's public proof, its two history scans,
 * the ONE interval whose pages are certified read, and the lease that makes a bounded wake
 * resumable (AIO-1170).
 *
 * ⚠️ WHAT A CLAIM PROVES. Ownership of one channel's next history request, under one lane, at one
 * binding revision. It is not permission to publish, not proof the channel is still visible, and not
 * a promise that the page it fetches may be stored — every one of those is re-checked at acceptance,
 * while the row is locked.
 *
 * Five properties hold this module together:
 *
 *  1. IT NEVER OPENS A TRANSACTION. Every function takes the caller's `TransactionSession`, so the
 *     acceptance — enqueue the roots, advance the frontier — is ONE commit. A caller must not hold
 *     that transaction across the HTTP call; the orchestrator claims, commits, fetches, and only
 *     then opens the acceptance transaction.
 *  2. THE DATABASE IS THE CLOCK AND THE FENCE. Due-ness and lease expiry are `clock_timestamp()`
 *     inside the statement's own `WHERE`. Every write matches the full scope AND the owner token AND
 *     the lease generation AND an unexpired lease AND the claimed lane AND the lane's scan
 *     generation AND its cursor AND the binding revision. Zero rows means "you did not have the
 *     authority", returned as an explicit outcome.
 *  3. PROGRESS IS NOT CERTIFICATION. A partial page moves a cursor and nothing else. Only a
 *     genuinely terminal page replaces `completed_lower_ts`/`completed_upper_ts`, because absence
 *     inside a certified interval is later evidence of deletion, and absence inside partial progress
 *     is a hole we have simply not read yet.
 *  4. TIMESTAMPS ARE COMPARED AS INTEGERS AND STORED AS BYTES. The shared parser's (seconds,
 *     microseconds) pair decides which of two `ts` values is older; the STRING that gets stored is
 *     the provider's original. A float comparison would erase the difference between `…000100` and
 *     `…000101`, and a re-rendered string would mint an identity for a thread that does not exist.
 *  5. NOTHING IS SWALLOWED. A SQL failure rejects. A refusal is `{ outcome: "refused" }` and NEVER
 *     `{ ok: false }`, which `lib/db/pg/tx.ts` reads as a rollback signal — a caller returning one
 *     of those straight out of its transaction would silently undo its own committed work.
 *
 * THE TWO LANES are documented on the table in `postgres/schema.sql`; the rule that lives HERE is
 * what ends a scan. A newest scan with a lower bound ends when the provider says `has_more: false`.
 * A SEED scan — the first one, with no certified top to catch up from — is ONE page by definition,
 * and what it certifies is exactly the span that page returned; everything older is the historical
 * lane's work, which starts at that boundary rather than inheriting the seed's cursor.
 */

export type SlackScanLane = "newest" | "historical";
export type SlackChannelPublicState = "unknown" | "public" | "private" | "unverifiable";

/** Fully scoped identity of one channel's discovery state. `team_id` is a namespace above the ids. */
export interface SlackChannelScope {
  readonly teamId: string;
  readonly workspaceId: string;
  readonly channelId: string;
}

export interface SlackLaneState {
  readonly anchorTs: string | null;
  readonly lowerTs: string | null;
  readonly cursor: string | null;
  readonly scanGeneration: number;
}

export interface SlackChannelState {
  readonly scope: SlackChannelScope;
  readonly publicState: SlackChannelPublicState;
  readonly publicCheckedAt: string | null;
  readonly bindingIntegrationId: string | null;
  readonly bindingConfigRevision: string | null;
  readonly newest: SlackLaneState;
  readonly historical: SlackLaneState;
  readonly historicalOldestSeenTs: string | null;
  readonly historicalFloorReached: boolean;
  readonly completedLowerTs: string | null;
  readonly completedUpperTs: string | null;
  readonly claimedLane: SlackScanLane | null;
  readonly nextLane: SlackScanLane;
  readonly leaseOwner: string | null;
  readonly leaseGeneration: number;
  readonly leaseExpiresAt: string | null;
  readonly dueAt: string;
  readonly attempts: number;
  readonly lastErrorCode: string | null;
  readonly lastReadAt: string | null;
}

/**
 * What a successful claim hands back. A plain value, not a capability: the database re-checks every
 * field of it on every write, so holding one proves nothing.
 */
export interface SlackChannelClaim {
  readonly scope: SlackChannelScope;
  readonly lane: SlackScanLane;
  readonly leaseOwner: string;
  readonly leaseGeneration: number;
  readonly leaseExpiresAt: string;
  readonly bindingConfigRevision: string;
  /** The FROZEN upper bound of the scan this claim continues. */
  readonly anchorTs: string;
  /** The newest lane's overlap bound; null on a seed scan and on every historical scan. */
  readonly lowerTs: string | null;
  readonly cursor: string | null;
  readonly scanGeneration: number;
  readonly oldestSeenTs: string | null;
  readonly completedLowerTs: string | null;
  readonly completedUpperTs: string | null;
}

export type SlackChannelWrite =
  | { readonly outcome: "written"; readonly state: SlackChannelState }
  | { readonly outcome: "refused" };

/** How long a claim owns a channel. One wake is bounded well below this; a crash frees it. */
export const SLACK_CHANNEL_LEASE_MS = 120_000;

/**
 * How long a channel's public proof is reused before it is re-checked. Metadata is re-read to notice
 * a channel going private, NOT on every wake: a 15-second re-verification would spend the whole
 * `conversations.info` budget proving what we already know.
 */
export const SLACK_CHANNEL_METADATA_TTL_MS = 6 * 60 * 60 * 1000;

const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 900_000;
const MAX_CURSOR_LENGTH = 1_024;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVISION = /^[0-9a-f]{64}$/;

/**
 * The DB clock as an exact Slack timestamp string, for freezing a scan's upper bound.
 *
 * `statement_timestamp()`, not `clock_timestamp()`: the expression reads the clock twice (once for
 * the seconds, once for the microseconds) and `clock_timestamp()` is free to advance between them,
 * which could pair one second's integer part with the next second's fraction. Due-ness elsewhere
 * still uses `clock_timestamp()` — that is one read, and it must not be stale.
 */
const CLOCK_ANCHOR_TS = `(floor(extract(epoch from statement_timestamp()))::bigint::text
       || '.'
       || lpad(((extract(microseconds from statement_timestamp())::bigint) % 1000000)::text, 6, '0'))`;

const STATE_COLUMNS = `team_id, workspace_id, channel_id, binding_integration_id, binding_config_revision,
       public_state, public_checked_at, newest_anchor_ts, newest_lower_ts, newest_cursor,
       newest_scan_generation::text as newest_scan_generation, historical_anchor_ts, historical_cursor,
       historical_scan_generation::text as historical_scan_generation, historical_oldest_seen_ts,
       historical_floor_reached, completed_lower_ts, completed_upper_ts, claimed_lane, next_lane,
       lease_owner, lease_generation::text as lease_generation, lease_expires_at, due_at, attempts,
       last_error_code, last_read_at`;

interface StateRow {
  team_id: string;
  workspace_id: string;
  channel_id: string;
  binding_integration_id: string | null;
  binding_config_revision: string | null;
  public_state: string;
  public_checked_at: Date | string | null;
  newest_anchor_ts: string | null;
  newest_lower_ts: string | null;
  newest_cursor: string | null;
  newest_scan_generation: string;
  historical_anchor_ts: string | null;
  historical_cursor: string | null;
  historical_scan_generation: string;
  historical_oldest_seen_ts: string | null;
  historical_floor_reached: boolean;
  completed_lower_ts: string | null;
  completed_upper_ts: string | null;
  claimed_lane: string | null;
  next_lane: string;
  lease_owner: string | null;
  lease_generation: string;
  lease_expires_at: Date | string | null;
  due_at: Date | string;
  attempts: number | string;
  last_error_code: string | null;
  last_read_at: Date | string | null;
}

export class SlackChannelStateError extends TypeError {
  constructor(message: string) {
    super(`slack channel state: ${message}`);
    this.name = "SlackChannelStateError";
  }
}

const SCOPE_PREDICATE = `team_id = $1 and workspace_id = $2 and channel_id = $3`;

function scopeParams(scope: SlackChannelScope): [string, string, string] {
  return [scope.teamId, scope.workspaceId, scope.channelId];
}

/**
 * Scope validation, reusing the namespace helper for its VERDICT on the id alphabet and discarding
 * its lower-cased result: the row keeps the provider's bytes, exactly as `slack-thread-state` does.
 */
function assertScope(scope: SlackChannelScope): void {
  if (typeof scope?.teamId !== "string" || !UUID.test(scope.teamId)) {
    throw new SlackChannelStateError(`teamId must be a UUID (got ${JSON.stringify(scope?.teamId)})`);
  }
  scopedSlackChannelPathPrefix(scope.workspaceId, scope.channelId);
}

/** The older of two Slack instants, as its ORIGINAL string. Integer parts only — never a float. */
export function olderSlackTs(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const left = parseSlackTimestamp(a);
  const right = parseSlackTimestamp(b);
  if (!left || !right) {
    throw new SlackChannelStateError("cannot order a value that is not an exact Slack timestamp");
  }
  if (left.seconds !== right.seconds) return left.seconds < right.seconds ? a : b;
  return left.micros <= right.micros ? a : b;
}

// ── reads ────────────────────────────────────────────────────────────────────

/** Create the channel's state row if it is not there yet: unverified, unbound, immediately due. */
export async function ensureSlackChannel(
  session: TransactionSession,
  scope: SlackChannelScope
): Promise<{ inserted: boolean; state: SlackChannelState }> {
  assertScope(scope);
  const inserted = await session.executeSql<StateRow>(
    `insert into slack_sync_channels (team_id, workspace_id, channel_id)
          values ($1, $2, $3)
     on conflict (team_id, workspace_id, channel_id) do nothing
       returning ${STATE_COLUMNS}`,
    scopeParams(scope)
  );
  const fresh = single(inserted);
  if (fresh) return { inserted: true, state: toState(fresh) };

  const existing = await session.executeSql<StateRow>(
    `select ${STATE_COLUMNS} from slack_sync_channels where ${SCOPE_PREDICATE}`,
    scopeParams(scope)
  );
  const row = single(existing);
  if (!row) {
    // The insert conflicted, so a row existed; its disappearance inside this transaction is an
    // anomaly, not an empty result to paper over.
    throw new SlackChannelStateError(
      "ensure conflicted but the conflicting row is gone — refusing to report a state it does not have"
    );
  }
  return { inserted: false, state: toState(row) };
}

/**
 * This integration's selected channels, DUE FIRST. `(due_at, channel_id)` is a total order, so the
 * round-robin is deterministic: a channel that was just read has the newest `due_at` and goes last,
 * which is what keeps one busy channel from taking every request slot.
 */
export async function dueSlackChannels(
  session: TransactionSession,
  input: {
    teamId: string;
    workspaceId: string;
    channelIds: readonly string[];
    limit?: number;
  }
): Promise<SlackChannelState[]> {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new SlackChannelStateError(`limit must be a positive whole number (got ${JSON.stringify(limit)})`);
  }
  if (input.channelIds.length === 0) return [];
  const result = await session.executeSql<StateRow>(
    `select ${STATE_COLUMNS} from slack_sync_channels
      where team_id = $1 and workspace_id = $2 and channel_id = any($3::text[])
      order by due_at asc, channel_id asc
      limit $4`,
    [input.teamId, input.workspaceId, [...input.channelIds], limit]
  );
  return result.rows.map(toState);
}

// ── metadata ─────────────────────────────────────────────────────────────────

/**
 * Persist a DEFINITIVE public-status verdict, and bind the channel to the integration that proved it.
 *
 * Only a validated `conversations.info` response reaches here. A transient 429/timeout/5xx must NOT
 * call this at all: the last valid proof is the best information there is, and overwriting it with
 * "unknown" on a blip would close a channel that is perfectly fine — while writing "public" on no
 * evidence would open one that is not.
 */
export async function recordSlackChannelPublicState(
  session: TransactionSession,
  scope: SlackChannelScope,
  binding: { integrationId: string; configRevision: string },
  input: { publicState: Exclude<SlackChannelPublicState, "unknown">; errorCode?: string | null }
): Promise<SlackChannelWrite> {
  assertScope(scope);
  if (!UUID.test(binding.integrationId)) {
    throw new SlackChannelStateError("binding.integrationId must be a UUID");
  }
  if (!REVISION.test(binding.configRevision)) {
    throw new SlackChannelStateError("binding.configRevision must be a sha256 hex digest");
  }
  if (input.publicState !== "public" && input.publicState !== "private" && input.publicState !== "unverifiable") {
    throw new SlackChannelStateError(`unknown public state ${JSON.stringify(input.publicState)}`);
  }
  assertErrorCode(input.errorCode);

  const result = await session.executeSql<StateRow>(
    `update slack_sync_channels
        set public_state = $4,
            public_checked_at = clock_timestamp(),
            binding_integration_id = $5::uuid,
            binding_config_revision = $6,
            last_error_code = $7,
            due_at = clock_timestamp(),
            updated_at = clock_timestamp()
      where ${SCOPE_PREDICATE}
  returning ${STATE_COLUMNS}`,
    [
      ...scopeParams(scope),
      input.publicState,
      binding.integrationId,
      binding.configRevision,
      input.errorCode ?? null,
    ]
  );
  return written(result);
}

/**
 * Record a transient failure that happened OUTSIDE a claim (a delayed metadata read). It touches the
 * category and the not-before only — never the public proof, never a frontier.
 *
 * `dueAt` is null when nothing stated a real deadline; the DB clock is used then, because the durable
 * method budget is the actual gate and this column must not become a second, invented schedule.
 */
export async function delaySlackChannel(
  session: TransactionSession,
  scope: SlackChannelScope,
  input: { dueAt: Date | null; errorCode: string }
): Promise<SlackChannelWrite> {
  assertScope(scope);
  assertErrorCode(input.errorCode);
  if (input.dueAt !== null) assertInstant("dueAt", input.dueAt);
  const result = await session.executeSql<StateRow>(
    `update slack_sync_channels
        set due_at = coalesce($5::timestamptz, clock_timestamp()),
            last_error_code = $4,
            updated_at = clock_timestamp()
      where ${SCOPE_PREDICATE}
  returning ${STATE_COLUMNS}`,
    [...scopeParams(scope), input.errorCode, input.dueAt]
  );
  return written(result);
}

// ── the lease ────────────────────────────────────────────────────────────────

/**
 * Claim this channel's next history request: pick the lane, freeze the scan's anchor if it is
 * starting, and take the lease — all in ONE conditional statement.
 *
 * The lane rule, and why it is here rather than in a caller: the newest lane is always pending
 * (there is always more "now"), the historical lane is pending until it reaches the retention floor
 * AND has a boundary to start from, and `next_lane` is PERSISTED so an empty lane lends its slot
 * without losing its turn. A caller that recomputed the lane per invocation would hand every slot to
 * the same lane and starve the other forever, which is exactly the failure this column prevents.
 *
 * `null` means NOT CLAIMED: not due, not public, not bound to the CURRENT revision, or somebody's
 * lease is still live. It can never mean a failed statement — a SQL error rejects.
 */
export async function claimSlackChannelPage(
  session: TransactionSession,
  scope: SlackChannelScope,
  opts: { leaseMs?: number; bindingIntegrationId: string; bindingConfigRevision: string }
): Promise<SlackChannelClaim | null> {
  assertScope(scope);
  const leaseMs = opts.leaseMs ?? SLACK_CHANNEL_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
    throw new SlackChannelStateError(
      `leaseMs must be between ${MIN_LEASE_MS} and ${MAX_LEASE_MS} (got ${JSON.stringify(leaseMs)})`
    );
  }
  if (!UUID.test(opts.bindingIntegrationId)) {
    throw new SlackChannelStateError("bindingIntegrationId must be a UUID");
  }
  if (!REVISION.test(opts.bindingConfigRevision)) {
    throw new SlackChannelStateError("bindingConfigRevision must be a sha256 hex digest");
  }

  const result = await session.executeSql<StateRow & { lane: string }>(
    `with candidate as (
        select id,
               case
                 when next_lane = 'newest' then 'newest'
                 when not historical_floor_reached
                      and (historical_anchor_ts is not null or completed_lower_ts is not null)
                   then 'historical'
                 else 'newest'
               end as lane
          from slack_sync_channels
         where ${SCOPE_PREDICATE}
      )
      update slack_sync_channels c
         set claimed_lane = candidate.lane,
             lease_owner = gen_random_uuid()::text,
             lease_generation = c.lease_generation + 1,
             lease_expires_at = clock_timestamp() + ($6::double precision * interval '1 millisecond'),
             attempts = c.attempts + 1,
             -- Freeze the anchor ONLY when the lane's scan is starting; a resumed scan keeps the
             -- upper bound it was anchored at, or its pages would come from a moving window.
             newest_anchor_ts = case
               when candidate.lane = 'newest' then coalesce(c.newest_anchor_ts, ${CLOCK_ANCHOR_TS})
               else c.newest_anchor_ts end,
             newest_lower_ts = case
               when candidate.lane = 'newest' and c.newest_anchor_ts is null then c.completed_upper_ts
               else c.newest_lower_ts end,
             historical_anchor_ts = case
               when candidate.lane = 'historical'
                 then coalesce(c.historical_anchor_ts, c.completed_lower_ts)
               else c.historical_anchor_ts end,
             historical_oldest_seen_ts = case
               when candidate.lane = 'historical' and c.historical_anchor_ts is null then null
               else c.historical_oldest_seen_ts end,
             updated_at = clock_timestamp()
        from candidate
       where c.id = candidate.id
         and c.public_state = 'public'
         and c.binding_integration_id = $4::uuid
         and c.binding_config_revision = $5
         and c.due_at <= clock_timestamp()
         and (c.lease_owner is null or c.lease_expires_at <= clock_timestamp())
   returning candidate.lane, ${STATE_COLUMNS}`,
    [...scopeParams(scope), opts.bindingIntegrationId, opts.bindingConfigRevision, leaseMs]
  );

  const row = single(result);
  if (!row) return null;
  const state = toState(row);
  const lane = assertLane(row.lane);
  const laneState = lane === "newest" ? state.newest : state.historical;
  if (state.leaseOwner === null || state.leaseExpiresAt === null || laneState.anchorTs === null) {
    // Unreachable while the lease codec and the lane rule hold; asserted anyway, because the
    // alternative is handing back a claim nobody can fence.
    throw new SlackChannelStateError("claimed row came back without a lease or an anchor — refusing it");
  }
  return {
    scope: state.scope,
    lane,
    leaseOwner: state.leaseOwner,
    leaseGeneration: state.leaseGeneration,
    leaseExpiresAt: state.leaseExpiresAt,
    bindingConfigRevision: opts.bindingConfigRevision,
    anchorTs: laneState.anchorTs,
    lowerTs: laneState.lowerTs,
    cursor: laneState.cursor,
    scanGeneration: laneState.scanGeneration,
    oldestSeenTs: state.historicalOldestSeenTs,
    completedLowerTs: state.completedLowerTs,
    completedUpperTs: state.completedUpperTs,
  };
}

/**
 * Lock this claim's channel row and re-check the WHOLE fence, without writing anything.
 *
 * It exists so the acceptance can be ordered the way it must be: verify FIRST, then enqueue the
 * roots, then advance the frontier. A refusal discovered after the enqueues would have to un-write
 * them — and a refusal reported as a return value cannot, since the transaction would commit.
 * `for update` holds the row until this transaction ends, so no concurrent claim can slip in between
 * the check and the advance.
 */
export async function lockSlackChannelForAcceptance(
  session: TransactionSession,
  claim: SlackChannelClaim
): Promise<{ outcome: "locked" } | { outcome: "refused" }> {
  assertScope(claim.scope);
  const lane = assertLane(claim.lane);
  const result = await session.executeSql(
    `select id from slack_sync_channels
      where ${SCOPE_PREDICATE}
        and lease_owner = $4
        and lease_generation = $5::bigint
        and lease_expires_at > clock_timestamp()
        and claimed_lane = $6
        and binding_config_revision = $7
        and ${lane}_scan_generation = $8::bigint
        and ${lane}_cursor is not distinct from $9
        and ${lane}_anchor_ts is not distinct from $10
        for update`,
    [
      ...scopeParams(claim.scope),
      claim.leaseOwner,
      String(claim.leaseGeneration),
      lane,
      claim.bindingConfigRevision,
      String(claim.scanGeneration),
      claim.cursor,
      claim.anchorTs,
    ]
  );
  return result.rows.length === 1 ? { outcome: "locked" } : { outcome: "refused" };
}

/**
 * Apply one accepted page: the lane's progress, and — only for a terminal page — the certified
 * interval.
 *
 * The certification rules, which live here because the table's invariant does:
 *  • PARTIAL: store the continuation cursor, remember the oldest instant the historical scan has
 *    seen, and leave `completed_*` exactly as it was.
 *  • TERMINAL, newest lane: the certified top becomes this scan's frozen anchor. On a SEED scan
 *    (no lower bound) the certified bottom becomes the oldest instant the page returned — the span
 *    that page actually covered — or the anchor itself when the page was empty.
 *  • TERMINAL, historical lane: the retention floor is reached, and the certified bottom moves down
 *    to the oldest instant the scan saw. It never moves UP: `olderSlackTs` of the two.
 */
export async function acceptSlackChannelPage(
  session: TransactionSession,
  claim: SlackChannelClaim,
  page: { terminal: boolean; nextCursor: string | null; oldestTs: string | null }
): Promise<SlackChannelWrite> {
  assertScope(claim.scope);
  const lane = assertLane(claim.lane);
  if (!page.terminal) assertCursor(page.nextCursor, { required: true });
  if (page.oldestTs !== null && !parseSlackTimestamp(page.oldestTs)) {
    throw new SlackChannelStateError("oldestTs must be an exact Slack timestamp or null");
  }

  const seenTs = olderSlackTs(claim.oldestSeenTs, page.oldestTs);
  let completedLowerTs = claim.completedLowerTs;
  let completedUpperTs = claim.completedUpperTs;
  if (page.terminal) {
    if (lane === "newest") {
      completedUpperTs = claim.anchorTs;
      completedLowerTs = claim.completedLowerTs ?? page.oldestTs ?? claim.anchorTs;
    } else {
      completedLowerTs = olderSlackTs(claim.completedLowerTs, seenTs) ?? claim.anchorTs;
      completedUpperTs = claim.completedUpperTs ?? claim.anchorTs;
    }
  }

  const result = await session.executeSql<StateRow>(
    `update slack_sync_channels
        set ${lane}_cursor = $11,
            ${lane}_anchor_ts = $12,
            ${lane}_scan_generation = ${lane}_scan_generation + $13::int,
            ${lane === "newest" ? "newest_lower_ts" : "historical_oldest_seen_ts"} = $14,
            historical_floor_reached = historical_floor_reached or $15,
            completed_lower_ts = $16,
            completed_upper_ts = $17,
            -- The lane's turn is over whether or not its scan is: an empty lane lends its slot, it
            -- does not keep it.
            next_lane = case when claimed_lane = 'newest' then 'historical' else 'newest' end,
            claimed_lane = null,
            lease_owner = null,
            lease_expires_at = null,
            last_error_code = null,
            last_read_at = clock_timestamp(),
            due_at = clock_timestamp(),
            updated_at = clock_timestamp()
      where ${SCOPE_PREDICATE}
        and lease_owner = $4
        and lease_generation = $5::bigint
        and lease_expires_at > clock_timestamp()
        and claimed_lane = $6
        and binding_config_revision = $7
        and ${lane}_scan_generation = $8::bigint
        and ${lane}_cursor is not distinct from $9
        and ${lane}_anchor_ts is not distinct from $10
  returning ${STATE_COLUMNS}`,
    [
      ...scopeParams(claim.scope),
      claim.leaseOwner,
      String(claim.leaseGeneration),
      lane,
      claim.bindingConfigRevision,
      String(claim.scanGeneration),
      claim.cursor,
      claim.anchorTs,
      page.terminal ? null : page.nextCursor,
      page.terminal ? null : claim.anchorTs,
      page.terminal ? 1 : 0,
      lane === "newest" ? (page.terminal ? null : claim.lowerTs) : page.terminal ? null : seenTs,
      lane === "historical" && page.terminal,
      completedLowerTs,
      completedUpperTs,
    ]
  );
  return written(result);
}

/**
 * Restart the SAME anchored scan after the provider refused our cursor: drop the cursor, bump the
 * scan generation, keep the anchor.
 *
 * It is not a rollback. The certified interval is untouched, because a cursor the provider forgot
 * says nothing about the pages we already read; and the generation bump is what makes a late
 * acceptance from the abandoned attempt match no row.
 */
export async function restartSlackChannelScan(
  session: TransactionSession,
  claim: SlackChannelClaim,
  input: { errorCode: string }
): Promise<SlackChannelWrite> {
  assertScope(claim.scope);
  const lane = assertLane(claim.lane);
  assertErrorCode(input.errorCode);
  const result = await session.executeSql<StateRow>(
    `update slack_sync_channels
        set ${lane}_cursor = null,
            ${lane}_scan_generation = ${lane}_scan_generation + 1,
            ${lane === "newest" ? "newest_lower_ts" : "historical_oldest_seen_ts"} =
              ${lane === "newest" ? "newest_lower_ts" : "null"},
            next_lane = case when claimed_lane = 'newest' then 'historical' else 'newest' end,
            claimed_lane = null,
            lease_owner = null,
            lease_expires_at = null,
            last_error_code = $11,
            due_at = clock_timestamp(),
            updated_at = clock_timestamp()
      where ${SCOPE_PREDICATE}
        and lease_owner = $4
        and lease_generation = $5::bigint
        and lease_expires_at > clock_timestamp()
        and claimed_lane = $6
        and binding_config_revision = $7
        and ${lane}_scan_generation = $8::bigint
        and ${lane}_cursor is not distinct from $9
        and ${lane}_anchor_ts is not distinct from $10
  returning ${STATE_COLUMNS}`,
    [
      ...scopeParams(claim.scope),
      claim.leaseOwner,
      String(claim.leaseGeneration),
      lane,
      claim.bindingConfigRevision,
      String(claim.scanGeneration),
      claim.cursor,
      claim.anchorTs,
      input.errorCode,
    ]
  );
  return written(result);
}

/**
 * Hand the channel back for a later attempt with a sanitized category. Everything the scan had —
 * anchor, cursor, generation, certified interval — is left exactly as it is, so the retry RESUMES
 * the same anchored scan rather than restarting it at a new "now". The lane's turn still passes, so
 * a channel failing on one lane cannot starve the other.
 */
export async function releaseSlackChannelForRetry(
  session: TransactionSession,
  claim: SlackChannelClaim,
  input: { nextDueAt: Date | null; errorCode: string }
): Promise<SlackChannelWrite> {
  assertScope(claim.scope);
  const lane = assertLane(claim.lane);
  assertErrorCode(input.errorCode);
  if (input.nextDueAt !== null) assertInstant("nextDueAt", input.nextDueAt);
  const result = await session.executeSql<StateRow>(
    `update slack_sync_channels
        set next_lane = case when claimed_lane = 'newest' then 'historical' else 'newest' end,
            claimed_lane = null,
            lease_owner = null,
            lease_expires_at = null,
            due_at = coalesce($12::timestamptz, clock_timestamp()),
            last_error_code = $11,
            updated_at = clock_timestamp()
      where ${SCOPE_PREDICATE}
        and lease_owner = $4
        and lease_generation = $5::bigint
        and lease_expires_at > clock_timestamp()
        and claimed_lane = $6
        and binding_config_revision = $7
        and ${lane}_scan_generation = $8::bigint
        and ${lane}_cursor is not distinct from $9
        and ${lane}_anchor_ts is not distinct from $10
  returning ${STATE_COLUMNS}`,
    [
      ...scopeParams(claim.scope),
      claim.leaseOwner,
      String(claim.leaseGeneration),
      lane,
      claim.bindingConfigRevision,
      String(claim.scanGeneration),
      claim.cursor,
      claim.anchorTs,
      input.errorCode,
      input.nextDueAt,
    ]
  );
  return written(result);
}

// ── codecs ───────────────────────────────────────────────────────────────────

function written(result: SqlQueryResult<StateRow>): SlackChannelWrite {
  const row = single(result);
  return row ? { outcome: "written", state: toState(row) } : { outcome: "refused" };
}

function toState(row: StateRow): SlackChannelState {
  return {
    scope: { teamId: row.team_id, workspaceId: row.workspace_id, channelId: row.channel_id },
    publicState: assertPublicState(row.public_state),
    publicCheckedAt: row.public_checked_at === null ? null : instant(row.public_checked_at),
    bindingIntegrationId: row.binding_integration_id,
    bindingConfigRevision: row.binding_config_revision,
    newest: {
      anchorTs: row.newest_anchor_ts,
      lowerTs: row.newest_lower_ts,
      cursor: row.newest_cursor,
      scanGeneration: counter("newest_scan_generation", row.newest_scan_generation),
    },
    historical: {
      anchorTs: row.historical_anchor_ts,
      lowerTs: null, // the historical lane pages to the retention floor; it has no lower bound
      cursor: row.historical_cursor,
      scanGeneration: counter("historical_scan_generation", row.historical_scan_generation),
    },
    historicalOldestSeenTs: row.historical_oldest_seen_ts,
    historicalFloorReached: row.historical_floor_reached === true,
    completedLowerTs: row.completed_lower_ts,
    completedUpperTs: row.completed_upper_ts,
    claimedLane: row.claimed_lane === null ? null : assertLane(row.claimed_lane),
    nextLane: assertLane(row.next_lane),
    leaseOwner: row.lease_owner,
    leaseGeneration: counter("lease_generation", row.lease_generation),
    leaseExpiresAt: row.lease_expires_at === null ? null : instant(row.lease_expires_at),
    dueAt: instant(row.due_at),
    attempts: counter("attempts", row.attempts),
    lastErrorCode: row.last_error_code,
    lastReadAt: row.last_read_at === null ? null : instant(row.last_read_at),
  };
}

/**
 * A lane name is INTERPOLATED into column names above, so it is validated as a closed union here and
 * nowhere else. It never comes from a provider or a request — it comes from this module's own lane
 * rule or from a stored value this function is also the reader of — but the interpolation is the
 * reason the check is unconditional rather than a type-level assumption.
 */
function assertLane(value: unknown): SlackScanLane {
  if (value !== "newest" && value !== "historical") {
    throw new SlackChannelStateError(`unknown scan lane ${JSON.stringify(value)}`);
  }
  return value;
}

function assertPublicState(value: string): SlackChannelPublicState {
  if (value !== "unknown" && value !== "public" && value !== "private" && value !== "unverifiable") {
    throw new SlackChannelStateError(`unknown stored public state ${JSON.stringify(value)}`);
  }
  return value;
}

function assertCursor(value: string | null, opts: { required: boolean }): void {
  if (value === null) {
    if (opts.required) {
      throw new SlackChannelStateError("a non-terminal page must carry the cursor that continues it");
    }
    return;
  }
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_CURSOR_LENGTH) {
    throw new SlackChannelStateError(
      `a page cursor must be a non-blank string of at most ${MAX_CURSOR_LENGTH} characters`
    );
  }
}

/**
 * The one validator whose REJECTED VALUE IS ITSELF THE HAZARD — same rule, and same static message,
 * as `slack-thread-state.assertErrorCode`. Quoting the refused value would copy a suspected provider
 * message or token into the throw, the stack and every log that records it.
 */
function assertErrorCode(value: string | null | undefined): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "string" || !ERROR_CODE.test(value)) {
    throw new SlackChannelStateError(
      `errorCode must be null, omitted, or a sanitized lower-case failure CATEGORY matching ` +
        `${ERROR_CODE.source} — never a provider message, a token or free text. The rejected value ` +
        `is deliberately omitted from this message.`
    );
  }
}

function assertInstant(field: string, value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new SlackChannelStateError(`${field} must be a valid Date (got ${JSON.stringify(value)})`);
  }
}

function counter(field: string, value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SlackChannelStateError(`${field} is not representable as a safe integer (${value})`);
  }
  return parsed;
}

function instant(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new SlackChannelStateError(`unreadable timestamp from the database (${String(value)})`);
  }
  return date.toISOString();
}

function single<T>(result: SqlQueryResult<T>): T | undefined {
  if (result.rows.length > 1) {
    throw new SlackChannelStateError(`expected at most one row, got ${result.rows.length}`);
  }
  return result.rows[0];
}
