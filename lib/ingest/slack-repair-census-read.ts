import "server-only";

import { withTransaction } from "@/lib/db/pg/tx";
import type { SqlExecutor } from "@/lib/db/types";
import type { SlackAccountMapping } from "@/lib/identity/resolve";
import {
  SLACK_REPAIR_CENSUS_LIMITS,
  classifySlackRepairAuthor,
  classifySlackRepairItem,
  classifySlackRepairRelationship,
  countSlackRepairEntries,
  decideSlackRepairScope,
  decodeSlackRepairGate,
  encodeSlackRepairCursor,
  orderSlackRepairObservations,
  validateSlackRepairCensusRequest,
  type SlackRepairAuthorStatus,
  type SlackRepairCensusEntry,
  type SlackRepairCensusRequest,
  type SlackRepairCensusResult,
  type SlackRepairCensusScope,
  type SlackRepairGateRow,
  type SlackRepairLedgerSourceFacts,
  type SlackRepairRelationshipResult,
  type SlackRepairSourceObservation,
  type SlackRepairWorkspaceObservation,
  type ValidatedSlackRepairCensusRequest,
} from "./slack-repair-census";

/**
 * READER for the Slack repair census (AIO-1170): one bounded, dry-run diagnostic page of STORED
 * Slack facts for an explicit `{teamId, integrationId, channelId}`.
 *
 * INACTIVE AND UNAUTHORIZED BY DESIGN. Nothing in the application calls this, and it is not
 * re-exported from an index (`test/guards/slack-source-not-wired.test.ts`). It is an internal
 * administrative data reader, NOT an authorization boundary: a future entry point must authorize
 * administrative access to the requested team before invoking it.
 *
 * What one invocation is:
 *
 *  • ONE `REPEATABLE READ, READ ONLY` transaction that this module opens itself, with a
 *    transaction-local 5s statement timeout. Every read below goes through the executor bound to
 *    that connection, so a page is internally consistent and physically cannot write. Callers
 *    cannot supply an executor, a pool, a transaction or an isolation mode.
 *  • ALL OR NOTHING. A SQL error, a statement timeout or a corrupt stored gate rejects the whole
 *    invocation. There is no partial page and no "zero results" fallback.
 *  • STORED FACTS ONLY. No provider request, no secret read (the token fingerprint and the secret
 *    blob are never selected), no queue claim, no budget reservation, no cache access, no gate
 *    preparation. A missing channel state or gate is reported as absent, never created.
 *
 * Cross-page traversal is observational and may span database states: `nextCursor: null` means the
 * scan was exhausted at the last page's snapshot, not that a historical census is complete, and the
 * cursor is not a repair checkpoint. An ordinary unbootstrapped database has no verified binding and
 * every request on it is refused as `scope_unavailable`; this slice cannot prepare one.
 */

export interface SlackRepairCensusReadOptions {
  /**
   * TEST-ONLY seam. Awaited exactly once, after the first scope SELECT has established the snapshot
   * and before the refusal decision and every later read — so it also runs for a request that is then
   * refused. It does not run for input rejected before the transaction or when that first SELECT
   * fails. It receives only the transaction-bound query function; whatever it throws rejects the
   * invocation. That function is revoked when the invocation ends — a copy kept by the hook rejects
   * instead of reaching the pooled connection again. No application caller passes options.
   */
  afterFirstRead?: (query: SqlExecutor) => Promise<void>;
}

/** PostgreSQL-side UTC text with six fractional digits: JavaScript dates lose the microseconds. */
const UTC_MICROSECONDS = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/**
 * The ECMAScript `String.prototype.trim` whitespace set. PostgreSQL's one-argument `btrim` removes
 * only U+0020, so a candidate read that trimmed with it would MISS a stored spelling variant the
 * account lookup treats as collision evidence.
 */
const JS_TRIM_WHITESPACE =
  "\u0009\u000A\u000B\u000C\u000D                  　﻿";

/** The existing account lookup's id-part syntax. */
const SLACK_ID_PART = /^[A-Z0-9]+$/;

/** Rows per internal keyset read of the peer inventory. Output is bounded separately, by the peer cap. */
const PEER_BATCH = 500;

// The join decides whether a scope row exists at all; the outer row exists either way, so this single
// first SELECT also fixes the observation time and the snapshot. Only the `channelIds` projection of
// the config is read.
const SCOPE_SQL = `
  select to_char(transaction_timestamp() at time zone 'UTC', ${UTC_MICROSECONDS}) as observed_at,
         s.integration_type, s.integration_status, s.updated_at_utc, s.config_channel_ids,
         s.binding_state, s.binding_workspace_id, s.binding_config_revision
    from (select 1) as snapshot
    left join lateral (
      select i.type as integration_type,
             i.status as integration_status,
             to_char(i.updated_at at time zone 'UTC', ${UTC_MICROSECONDS}) as updated_at_utc,
             i.config->'channelIds' as config_channel_ids,
             b.state as binding_state,
             b.workspace_id as binding_workspace_id,
             b.config_revision as binding_config_revision
        from integrations i
        join slack_integration_bindings b
          on b.team_id = i.team_id and b.integration_id = i.id
       where i.team_id = $1 and i.id = $2
    ) s on true`;

const CHANNEL_STATE_SQL = `
  select public_state,
         to_char(public_checked_at at time zone 'UTC', ${UTC_MICROSECONDS}) as public_checked_at,
         newest_anchor_ts, historical_anchor_ts, completed_lower_ts, completed_upper_ts,
         historical_floor_reached, newest_catchup_upper_ts
    from slack_sync_channels
   where team_id = $1 and workspace_id = $2 and channel_id = $3`;

// One more than the cap, so overflow is proved rather than assumed. Byte order, to match the report's.
const OTHER_WORKSPACE_STATE_SQL = `
  select id::text as id, workspace_id
    from slack_sync_channels
   where team_id = $1 and channel_id = $2 and workspace_id <> $3
   order by workspace_id collate "C", id
   limit $4`;

// Case-only variants of the requested ids anywhere in this team's channel state: a workspace or a
// channel id that is equal when case-folded and different in bytes. A dedicated aggregate, so the cap
// on the observation array above cannot hide a contradiction. The fold uses the "C" collation (the
// table's own CHECK keeps these ids ASCII), so it does not depend on the database locale. This read
// only DETECTS a variant; every source-key read in this module stays byte-exact.
const STORED_ID_VARIANT_SQL = `
  select coalesce(bool_or(lower(workspace_id collate "C") = lower($2::text collate "C")
                          and workspace_id <> $2::text), false) as workspace_variant,
         coalesce(bool_or(lower(channel_id collate "C") = lower($3::text collate "C")
                          and channel_id <> $3::text), false) as channel_variant
    from slack_sync_channels
   where team_id = $1`;

const GATE_SQL = `
  select state, revision::text as revision, ready_revision::text as ready_revision,
         resolved_workspace_ids, completed_repair_id::text as completed_repair_id, blocked_reason
    from slack_channel_migration_gates
   where team_id = $1 and raw_channel_id = $2`;

const THREAD_COUNTS_SQL = `
  select (count(*) filter (where status = 'queued'))::text as queued,
         (count(*) filter (where status = 'running'))::text as running,
         (count(*) filter (where last_error_code is not null))::text as with_error
    from slack_sync_threads
   where team_id = $1 and workspace_id = $2 and channel_id = $3`;

// The scan domain is the team's stored Slack inventory — source-marked items or Slack-prefixed paths —
// because an old three-segment path may carry a channel-name slug that today's channel id cannot
// exclude. Frontmatter is read as a narrow projection: `channel_id` and `participants` only.
const SCAN_SQL = `
  select i.id::text as id, i.project_id::text as project_id, i.path,
         i.member_id::text as member_id, i.member_id_locked,
         (jsonb_typeof(i.frontmatter) = 'object' and jsonb_exists(i.frontmatter, 'channel_id')) as has_channel_id,
         i.frontmatter->'channel_id' as channel_id,
         (jsonb_typeof(i.frontmatter) = 'object' and jsonb_exists(i.frontmatter, 'participants')) as has_participants,
         i.frontmatter->'participants' as participants
    from items i
   where i.team_id = $1
     and (i.frontmatter->>'source' = 'slack' or i.path like 'slack/%')
     and ($2::uuid is null or i.id > $2::uuid)
   order by i.id
   limit $3`;

// Restricted to the scanned items: there is never a channel-wide ledger scan. Rows are grouped by
// their EXACT stored source so an inconsistent source is reported apart instead of being counted in.
const LEDGER_SQL = `
  select item_id::text as item_id, workspace_id, channel_id,
         count(*)::text as total_messages,
         (count(*) filter (where eligible and deleted_at is null))::text as eligible_nondeleted_messages,
         (count(*) filter (where not eligible))::text as excluded_messages,
         (count(*) filter (where deleted_at is not null))::text as deleted_messages,
         (count(distinct (occurred_at at time zone 'UTC')::date)
            filter (where eligible and deleted_at is null))::text as eligible_nondeleted_utc_days
    from slack_messages
   where team_id = $1 and item_id = any($2::uuid[])
   group by item_id, workspace_id, channel_id`;

const LEDGER_AUTHORS_SQL = `
  select distinct item_id::text as item_id, author_external_id
    from slack_messages
   where team_id = $1 and item_id = any($2::uuid[])
     and workspace_id = $3 and channel_id = $4
     and eligible and deleted_at is null and author_external_id is not null`;

// Live mapping candidates per qualified account, spelling variants INCLUDED: the lookup needs them to
// report a conflict instead of a clean match. The trim uses the JS whitespace set and the fold uses
// the "C" collation, so neither depends on the database locale; a provider or id that still holds a
// non-ASCII character after trimming cannot be decided here and is handed to the lookup as a
// candidate rather than dropped. One row past the cap proves the read was truncated.
const MAPPING_CANDIDATES_SQL = `
  select a.account_id, c.provider, c.external_id, c.member_id
    from unnest($2::text[]) as a(account_id)
   cross join lateral (
     select mi.provider, mi.external_id, mi.member_id::text as member_id
       from member_identities mi
      where mi.team_id = $1
        and (lower(btrim(mi.provider, $3::text) collate "C") = 'slack'
             or octet_length(btrim(mi.provider, $3::text)) <> char_length(btrim(mi.provider, $3::text)))
        and (upper(btrim(mi.external_id, $3::text) collate "C") = a.account_id
             or octet_length(btrim(mi.external_id, $3::text)) <> char_length(btrim(mi.external_id, $3::text)))
      order by mi.id
      limit $4
   ) c`;

// The roster predicate credit projection uses: a HUMAN row that is not a connector. A standing agent
// and an offroster actor are members, and neither is a person whose messages are personal credit.
const HUMAN_MEMBERS_SQL = `
  select id::text as id
    from members
   where team_id = $1 and id = any($2::uuid[]) and kind = 'human' and not is_connector`;

// Byte-exact root and exact scope: the queue has no item key, so this is the only association allowed.
const THREAD_ROOTS_SQL = `
  select root_ts, status, (last_error_code is not null) as error_observed
    from slack_sync_threads
   where team_id = $1 and workspace_id = $2 and channel_id = $3 and root_ts = any($4::text[])`;

// The path uniqueness key is (team, project, path): a target is occupied only within a project.
const TARGET_OCCUPANTS_SQL = `
  select id::text as id, project_id::text as project_id, path
    from items
   where team_id = $1 and path = any($2::text[]) and project_id = any($3::uuid[])`;

// The peer inventory for the page's roots, read across the WHOLE team snapshot and independent of the
// main cursor: a peer on an earlier or later page must still be found.
const PEERS_SQL = `
  select i.id::text as id, i.project_id::text as project_id, i.path,
         (jsonb_typeof(i.frontmatter) = 'object' and jsonb_exists(i.frontmatter, 'channel_id')) as has_channel_id,
         i.frontmatter->'channel_id' as channel_id
    from items i
   where i.team_id = $1
     and i.path like 'slack/%'
     and substring(i.path from '/([^/]+)[.]md$') = any($2::text[])
     and ($3::uuid is null or i.id > $3::uuid)
   order by i.id
   limit $4`;

const PEER_LEDGER_SOURCES_SQL = `
  select distinct item_id::text as item_id, workspace_id, channel_id
    from slack_messages
   where team_id = $1 and item_id = any($2::uuid[])`;

interface ScopeReadRow {
  observed_at: string;
  integration_type: string | null;
  integration_status: string | null;
  updated_at_utc: string | null;
  config_channel_ids: unknown;
  binding_state: string | null;
  binding_workspace_id: string | null;
  binding_config_revision: string | null;
}

interface ChannelStateRow {
  public_state: string;
  public_checked_at: string | null;
  newest_anchor_ts: string | null;
  historical_anchor_ts: string | null;
  completed_lower_ts: string | null;
  completed_upper_ts: string | null;
  historical_floor_reached: boolean;
  newest_catchup_upper_ts: string | null;
}

interface ScanRow {
  id: string;
  project_id: string;
  path: string;
  member_id: string | null;
  member_id_locked: boolean;
  has_channel_id: boolean;
  channel_id: unknown;
  has_participants: boolean;
  participants: unknown;
}

interface PeerRow {
  id: string;
  project_id: string;
  path: string;
  has_channel_id: boolean;
  channel_id: unknown;
}

interface LedgerRow {
  item_id: string;
  workspace_id: string;
  channel_id: string;
  total_messages: string;
  eligible_nondeleted_messages: string;
  excluded_messages: string;
  deleted_messages: string;
  eligible_nondeleted_utc_days: string;
}

interface MappingCandidateRow {
  account_id: string;
  provider: string;
  external_id: string;
  member_id: string;
}

/** A page entry that needs its peers looked up across the full inventory. */
interface PeerSeeker {
  id: string;
  projectId: string;
  /** Only a legacy entry with a hypothetical target has one that candidates can converge on. */
  wantsConverging: boolean;
  converging: string[];
  otherProject: string[];
}

/** The narrow frontmatter projection, rebuilt so presence (a key holding null) survives the read. */
function projectedFrontmatter(row: {
  has_channel_id: boolean;
  channel_id: unknown;
  has_participants?: boolean;
  participants?: unknown;
}): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {};
  if (row.has_channel_id) frontmatter.channel_id = row.channel_id;
  if (row.has_participants) frontmatter.participants = row.participants;
  return frontmatter;
}

/**
 * The distinct author evidence retained participants carry: whatever is stored under a PRESENT
 * `author_id` key, string or not. A number or a null there is not an account id, but it is author
 * evidence somebody stored, and dropping it here would hide it from the diagnostics — the classifier
 * reports it as invalid input. A participant with no `author_id` key carries no author evidence.
 * These values are counted by status only: never resolved, never echoed.
 */
function participantAuthorEvidence(participants: unknown): unknown[] {
  if (!Array.isArray(participants)) return [];
  const evidence = new Map<string, unknown>();
  for (const participant of participants as unknown[]) {
    if (typeof participant !== "object" || participant === null || Array.isArray(participant)) continue;
    if (!Object.prototype.hasOwnProperty.call(participant, "author_id")) continue;
    const authorId = (participant as { author_id?: unknown }).author_id;
    // Distinct by stored value. The prefix keeps the string "7" apart from the number 7.
    const key = typeof authorId === "string" ? `string:${authorId}` : `json:${JSON.stringify(authorId)}`;
    evidence.set(key, authorId);
  }
  return [...evidence.values()];
}

function pushGrouped<K, V>(groups: Map<K, V[]>, key: K, value: V): void {
  const group = groups.get(key);
  if (group) group.push(value);
  else groups.set(key, [value]);
}

/** Raised by the test seam's executor when it is used after its invocation has ended. */
class SlackRepairCensusHookRevokedError extends Error {
  constructor() {
    super("slack repair census: the test hook executor is revoked once its invocation ends");
    this.name = "SlackRepairCensusHookRevokedError";
  }
}

export async function readSlackRepairCensusPage(
  request: SlackRepairCensusRequest,
  options: SlackRepairCensusReadOptions = {}
): Promise<SlackRepairCensusResult> {
  // Everything that can be refused without a database is refused before one is opened.
  const captured = validateSlackRepairCensusRequest(request);
  const afterFirstRead = options?.afterFirstRead;

  return withTransaction(async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    // Transaction-local, set before the first SELECT. A timeout rejects with SQLSTATE 57014.
    await client.query(`SET LOCAL statement_timeout = ${SLACK_REPAIR_CENSUS_LIMITS.statementTimeoutMs}`);
    const query: SqlExecutor = async <T>(sql: string, params: unknown[] = []) => {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    };
    // The seam's executor is a closure over a POOLED connection. Left live, a copy captured by the hook
    // could run a statement after this transaction ended — on a connection that is no longer
    // read-only, or that another caller now holds. So the hook never receives `query` itself: it gets
    // this revocable wrapper, revoked before this callback returns on every outcome, and therefore
    // before the commit or rollback and the release.
    let hookActive = true;
    const hookQuery: SqlExecutor = async <T>(sql: string, params: unknown[] = []) => {
      if (!hookActive) throw new SlackRepairCensusHookRevokedError();
      return query<T>(sql, params);
    };
    try {
      return await readPageInSnapshot(query, hookQuery, captured, afterFirstRead);
    } finally {
      hookActive = false;
    }
  });
}

async function readPageInSnapshot(
  query: SqlExecutor,
  hookQuery: SqlExecutor,
  captured: ValidatedSlackRepairCensusRequest,
  afterFirstRead: SlackRepairCensusReadOptions["afterFirstRead"]
): Promise<SlackRepairCensusResult> {
  const { scope, pageSize, cursor } = captured;

  const scopeRead = await query<ScopeReadRow>(SCOPE_SQL, [scope.teamId, scope.integrationId]);
  // The snapshot now exists. The seam runs before any decision, including a refusal.
  if (afterFirstRead) await afterFirstRead(hookQuery);

  const stored = scopeRead.rows[0];
  if (!stored) throw new Error("slack repair census: the scope read returned no row");
  const decision = decideSlackRepairScope({
    scope,
    row:
      stored.integration_type === null
        ? null
        : {
            integrationType: stored.integration_type,
            integrationStatus: stored.integration_status ?? "",
            updatedAtUtcMicroseconds: stored.updated_at_utc ?? "",
            configChannelIds: stored.config_channel_ids,
            bindingState: stored.binding_state ?? "",
            bindingWorkspaceId: stored.binding_workspace_id,
            bindingConfigRevision: stored.binding_config_revision ?? "",
          },
    cursor,
  });
  if (decision.outcome === "refused") return { outcome: "refused", mode: "dry_run", reason: decision.reason };

  // The STORED binding workspace. Whether that binding is still current is not established here.
  const workspace = decision.bindingWorkspaceId;
  const sourceKey = [scope.teamId, workspace, scope.channelId];

  const source = await readSourceObservation(query, sourceKey);
  const otherStates = await query<{ id: string; workspace_id: string }>(OTHER_WORKSPACE_STATE_SQL, [
    scope.teamId,
    scope.channelId,
    workspace,
    SLACK_REPAIR_CENSUS_LIMITS.observationCap + 1,
  ]);
  const variantRead = await query<{ workspace_variant: boolean; channel_variant: boolean }>(
    STORED_ID_VARIANT_SQL,
    sourceKey
  );
  // Either kind contradicts a match: a path segment is compared lower-cased, so with a variant on
  // record it no longer names one stored source. It is evidence against a match, never an alias.
  const storedIdVariantObserved =
    variantRead.rows[0]?.workspace_variant === true || variantRead.rows[0]?.channel_variant === true;
  const gateRead = await query<SlackRepairGateRow>(GATE_SQL, [scope.teamId, scope.channelId]);
  const namespaceGate = decodeSlackRepairGate(gateRead.rows[0] ?? null);

  // One row past the page establishes continuation only; it is never classified.
  const scan = await query<ScanRow>(SCAN_SQL, [scope.teamId, cursor?.lastItemId ?? null, pageSize + 1]);
  const rows = scan.rows.slice(0, pageSize);
  const hasMore = scan.rows.length > pageSize;
  const itemIds = rows.map((row) => row.id);

  const ledgerByItem = new Map<string, SlackRepairLedgerSourceFacts[]>();
  if (itemIds.length > 0) {
    const ledgerRead = await query<LedgerRow>(LEDGER_SQL, [scope.teamId, itemIds]);
    for (const row of ledgerRead.rows) {
      pushGrouped(ledgerByItem, row.item_id, {
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        totalMessages: row.total_messages,
        eligibleNondeletedMessages: row.eligible_nondeleted_messages,
        excludedMessages: row.excluded_messages,
        deletedMessages: row.deleted_messages,
        eligibleNondeletedUtcDays: row.eligible_nondeleted_utc_days,
      });
    }
  }
  const hasRequestedLedger = (itemId: string): boolean =>
    (ledgerByItem.get(itemId) ?? []).some(
      (ledger) => ledger.workspaceId === workspace && ledger.channelId === scope.channelId
    );

  // First pass: the relationship alone, which decides what else each row needs read.
  const relations = new Map<string, SlackRepairRelationshipResult>();
  for (const row of rows) {
    relations.set(
      row.id,
      classifySlackRepairRelationship({
        scope,
        bindingWorkspaceId: workspace,
        path: row.path,
        frontmatter: projectedFrontmatter(row),
        ledgerSources: ledgerByItem.get(row.id) ?? [],
        storedIdVariantObserved,
      })
    );
  }
  const entryRows = rows.filter((row) => relations.get(row.id)?.bucket === "entry");

  const authorStatuses = await readAuthorStatuses(query, scope, workspace, entryRows, hasRequestedLedger);
  const queueByRoot = await readQueueByRoot(query, sourceKey, rows, relations);
  const occupantByTarget = await readTargetOccupants(query, scope, rows, relations);
  const seekers = await readPeers(query, scope, workspace, rows, relations, storedIdVariantObserved);

  // Second pass: every scanned row lands in exactly one bucket.
  const entries: SlackRepairCensusEntry[] = [];
  const scannedObservations: SlackRepairWorkspaceObservation[] = [];
  let unrelatedItems = 0;
  let otherWorkspaceItems = 0;
  let gateNoncanonicalItems = 0;
  for (const row of rows) {
    const relation = relations.get(row.id);
    const target = relation?.hypotheticalTarget ?? null;
    const occupant = target ? occupantByTarget.get(targetKey(row.project_id, target.path)) : undefined;
    const rootTs = relation && relation.path.kind !== "malformed" ? relation.path.rootTs : null;
    const seeker = seekers.get(row.id);
    const classified = classifySlackRepairItem({
      scope,
      bindingWorkspaceId: workspace,
      item: {
        id: row.id,
        projectId: row.project_id,
        path: row.path,
        frontmatter: projectedFrontmatter(row),
        memberId: row.member_id,
        memberIdLocked: row.member_id_locked === true,
      },
      ledgerSources: ledgerByItem.get(row.id) ?? [],
      authorStatuses: authorStatuses.get(row.id) ?? [],
      targetPathItems: occupant ? [{ itemId: occupant, projectId: row.project_id }] : [],
      otherProjectSameThreadItemIds: seeker?.otherProject ?? [],
      sameProjectConvergingItemIds: seeker?.converging ?? [],
      queue:
        relation?.relationship === "scoped_channel_match" && rootTs !== null
          ? (queueByRoot.get(rootTs) ?? null)
          : null,
      storedIdVariantObserved,
    });
    if (classified.gateNoncanonical) gateNoncanonicalItems += 1;
    if (classified.bucket === "entry") entries.push(classified.entry);
    else if (classified.bucket === "other_workspace") {
      // Counted even when the observation array below is capped.
      otherWorkspaceItems += 1;
      scannedObservations.push(classified.observation);
    } else unrelatedItems += 1;
  }

  const observations = orderSlackRepairObservations([
    ...otherStates.rows.map(
      (row): SlackRepairWorkspaceObservation => ({
        kind: "channel_state",
        workspaceId: row.workspace_id,
        sourceId: row.id,
      })
    ),
    ...scannedObservations,
  ]);

  const lastScanned = rows[rows.length - 1];
  return {
    outcome: "page",
    mode: "dry_run",
    scope,
    consistency: "page_snapshot",
    historicalCensusComplete: false,
    applyReady: false,
    observedAt: stored.observed_at,
    scopeFingerprint: decision.scopeFingerprint,
    integrationStatus: decision.integrationStatus,
    gateNoncanonicalItems,
    otherWorkspaceObservations: observations.observations,
    otherWorkspaceObservationsTruncated: observations.truncated,
    scannedItems: rows.length,
    unrelatedItems,
    otherWorkspaceItems,
    otherWorkspaceObservationSources: "channel_state_and_scanned_paths_only",
    bindingCurrency: "not_established",
    entries,
    source,
    namespaceGate,
    counts: countSlackRepairEntries(entries),
    // The cursor advances over EVERY scanned row, unrelated ones included.
    nextCursor:
      hasMore && lastScanned
        ? encodeSlackRepairCursor({
            scope,
            scopeFingerprint: decision.scopeFingerprint,
            lastItemId: lastScanned.id,
          })
        : null,
    traversalExhaustedAtThisSnapshot: !hasMore,
  };
}

function targetKey(projectId: string, path: string): string {
  return `${projectId}\u0000${path}`;
}

/** Recorded channel progress and channel-level queue counts, for the exact stored source. */
async function readSourceObservation(query: SqlExecutor, sourceKey: unknown[]): Promise<SlackRepairSourceObservation> {
  const stateRead = await query<ChannelStateRow>(CHANNEL_STATE_SQL, sourceKey);
  const threadRead = await query<{ queued: string; running: string; with_error: string }>(
    THREAD_COUNTS_SQL,
    sourceKey
  );
  const state = stateRead.rows[0];
  const threads = threadRead.rows[0];
  if (!threads) throw new Error("slack repair census: the thread count read returned no row");
  return {
    // A missing state row is absence. It is not synthesized and not inserted.
    channelState: state ? "present" : "absent",
    publicState: state?.public_state ?? null,
    publicCheckedAt: state?.public_checked_at ?? null,
    newestAnchorTs: state?.newest_anchor_ts ?? null,
    historicalAnchorTs: state?.historical_anchor_ts ?? null,
    recordedCoverage: {
      completedLowerTs: state?.completed_lower_ts ?? null,
      completedUpperTs: state?.completed_upper_ts ?? null,
      historicalFloorReached: state ? state.historical_floor_reached === true : null,
      newestCatchupUpperTs: state?.newest_catchup_upper_ts ?? null,
    },
    threads: { queued: threads.queued, running: threads.running, withError: threads.with_error },
    providerAvailableRange: { status: "unknown_not_read" },
  };
}

/**
 * One status per distinct observed author account, per entry.
 *
 * An entry with a ledger for the requested source is diagnosed from that ledger's eligible,
 * non-deleted authors, with the verified workspace taken from the ledger rows themselves. Only an
 * entry WITHOUT one falls back to counting its retained participant ids — and those are never
 * resolved, whatever is mapped.
 */
async function readAuthorStatuses(
  query: SqlExecutor,
  scope: SlackRepairCensusScope,
  workspace: string,
  entryRows: readonly ScanRow[],
  hasRequestedLedger: (itemId: string) => boolean
): Promise<Map<string, SlackRepairAuthorStatus[]>> {
  const statuses = new Map<string, SlackRepairAuthorStatus[]>();
  const ledgerItemIds = entryRows.filter((row) => hasRequestedLedger(row.id)).map((row) => row.id);

  const authorsByItem = new Map<string, string[]>();
  if (ledgerItemIds.length > 0) {
    const authorRead = await query<{ item_id: string; author_external_id: string }>(LEDGER_AUTHORS_SQL, [
      scope.teamId,
      ledgerItemIds,
      workspace,
      scope.channelId,
    ]);
    for (const row of authorRead.rows) pushGrouped(authorsByItem, row.item_id, row.author_external_id);
  }

  const authors = [...new Set([...authorsByItem.values()].flat())];
  const accountOf = (author: string): string | null =>
    SLACK_ID_PART.test(workspace) && SLACK_ID_PART.test(author) ? `${workspace}:${author}` : null;
  const accounts = [...new Set(authors.map(accountOf).filter((account): account is string => account !== null))];

  const cap = SLACK_REPAIR_CENSUS_LIMITS.mappingCandidateCap;
  const candidatesByAccount = new Map<string, MappingCandidateRow[]>();
  if (accounts.length > 0) {
    const candidateRead = await query<MappingCandidateRow>(MAPPING_CANDIDATES_SQL, [
      scope.teamId,
      accounts,
      JS_TRIM_WHITESPACE,
      cap + 1,
    ]);
    for (const row of candidateRead.rows) pushGrouped(candidatesByAccount, row.account_id, row);
  }

  const memberIds = [...new Set([...candidatesByAccount.values()].flat().map((row) => row.member_id))];
  const humanMemberIds = new Set<string>();
  if (memberIds.length > 0) {
    const memberRead = await query<{ id: string }>(HUMAN_MEMBERS_SQL, [scope.teamId, memberIds]);
    for (const row of memberRead.rows) humanMemberIds.add(row.id);
  }

  const statusByAuthor = new Map<string, SlackRepairAuthorStatus>();
  for (const author of authors) {
    const account = accountOf(author);
    const candidates = account === null ? [] : (candidatesByAccount.get(account) ?? []);
    // Past the cap the candidate set is not known to be complete, so it is not offered for resolution.
    const overflow = candidates.length > cap;
    const mappings: SlackAccountMapping[] = overflow
      ? []
      : candidates.map(
          (row): SlackAccountMapping => ({
            teamId: scope.teamId,
            provider: row.provider,
            externalId: row.external_id,
            memberId: row.member_id,
            state: "live",
          })
        );
    statusByAuthor.set(
      author,
      classifySlackRepairAuthor({
        teamId: scope.teamId,
        externalId: author,
        origin: "source_ledger",
        verifiedItemWorkspaceId: workspace,
        mappings,
        mappingCandidatesOverflow: overflow,
        humanMemberIds,
      })
    );
  }

  for (const row of entryRows) {
    if (hasRequestedLedger(row.id)) {
      statuses.set(
        row.id,
        (authorsByItem.get(row.id) ?? []).map((author) => statusByAuthor.get(author) ?? "invalid_input")
      );
      continue;
    }
    if (!row.has_participants) continue;
    statuses.set(
      row.id,
      participantAuthorEvidence(row.participants).map((externalId) =>
        classifySlackRepairAuthor({
          teamId: scope.teamId,
          externalId,
          origin: "participant_metadata",
          mappings: [],
          mappingCandidatesOverflow: false,
          humanMemberIds: [],
        })
      )
    );
  }
  return statuses;
}

/** Queue rows for scoped matches only, by exact scope and byte-exact root. */
async function readQueueByRoot(
  query: SqlExecutor,
  sourceKey: unknown[],
  rows: readonly ScanRow[],
  relations: ReadonlyMap<string, SlackRepairRelationshipResult>
): Promise<Map<string, { status: string; errorObserved: boolean }>> {
  const roots = new Set<string>();
  for (const row of rows) {
    const relation = relations.get(row.id);
    if (relation?.relationship === "scoped_channel_match" && relation.path.kind === "scoped") {
      roots.add(relation.path.rootTs);
    }
  }
  const queueByRoot = new Map<string, { status: string; errorObserved: boolean }>();
  if (roots.size === 0) return queueByRoot;
  const queueRead = await query<{ root_ts: string; status: string; error_observed: boolean }>(THREAD_ROOTS_SQL, [
    ...sourceKey,
    [...roots],
  ]);
  for (const row of queueRead.rows) {
    queueByRoot.set(row.root_ts, { status: row.status, errorObserved: row.error_observed === true });
  }
  return queueByRoot;
}

/** Same-project occupants of each hypothetical target path. Uniqueness makes this 0 or 1 per entry. */
async function readTargetOccupants(
  query: SqlExecutor,
  scope: SlackRepairCensusScope,
  rows: readonly ScanRow[],
  relations: ReadonlyMap<string, SlackRepairRelationshipResult>
): Promise<Map<string, string>> {
  const paths = new Set<string>();
  const projects = new Set<string>();
  for (const row of rows) {
    const target = relations.get(row.id)?.hypotheticalTarget;
    if (!target) continue;
    paths.add(target.path);
    projects.add(row.project_id);
  }
  const occupantByTarget = new Map<string, string>();
  if (paths.size === 0) return occupantByTarget;
  const occupantRead = await query<{ id: string; project_id: string; path: string }>(TARGET_OCCUPANTS_SQL, [
    scope.teamId,
    [...paths],
    [...projects],
  ]);
  for (const row of occupantRead.rows) occupantByTarget.set(targetKey(row.project_id, row.path), row.id);
  return occupantByTarget;
}

/**
 * Peers for every page entry that has a thread identity to share: other legacy candidates in the
 * same project bound for the same hypothetical target, and same-thread items in other projects.
 *
 * The inventory is read in ascending id order across the whole team snapshot, every row is QUALIFIED
 * with the same classifier (and its own ledger sources, so a conflicting peer is not counted) before
 * it is kept, and the read continues until every seeker holds one id past the cap or the inventory
 * is exhausted. The limit is never applied before qualification, so no peer is silently missed. This
 * names hypothetical convergence; it picks no winner and deduplicates nothing.
 */
async function readPeers(
  query: SqlExecutor,
  scope: SlackRepairCensusScope,
  workspace: string,
  rows: readonly ScanRow[],
  relations: ReadonlyMap<string, SlackRepairRelationshipResult>,
  storedIdVariantObserved: boolean
): Promise<Map<string, PeerSeeker>> {
  const seekers = new Map<string, PeerSeeker>();
  const seekersByRoot = new Map<string, PeerSeeker[]>();
  for (const row of rows) {
    const relation = relations.get(row.id);
    if (!relation || relation.path.kind === "malformed") continue;
    // A legacy entry with a hypothetical target seeks peers whether it is still a candidate or a
    // contradiction made it conflicting: the diagnostics belong to the item's basis, not its verdict.
    const hasLegacyTarget = relation.path.kind === "legacy" && relation.hypotheticalTarget !== null;
    if (!hasLegacyTarget && relation.relationship !== "scoped_channel_match") continue;
    const seeker: PeerSeeker = {
      id: row.id,
      projectId: row.project_id,
      wantsConverging: hasLegacyTarget,
      converging: [],
      otherProject: [],
    };
    seekers.set(row.id, seeker);
    pushGrouped(seekersByRoot, relation.path.rootTs, seeker);
  }
  if (seekers.size === 0) return seekers;

  // One past the cap is enough to prove overflow; ids arrive ascending, so those kept are the lowest.
  const limit = SLACK_REPAIR_CENSUS_LIMITS.peerIdCap + 1;
  const unsatisfied = (seeker: PeerSeeker): boolean =>
    (seeker.wantsConverging && seeker.converging.length < limit) || seeker.otherProject.length < limit;

  const roots = [...seekersByRoot.keys()];
  let after: string | null = null;
  while ([...seekers.values()].some(unsatisfied)) {
    const batch: { rows: PeerRow[] } = await query<PeerRow>(PEERS_SQL, [scope.teamId, roots, after, PEER_BATCH]);
    if (batch.rows.length === 0) break;

    const sourcesByItem = new Map<string, { workspaceId: string; channelId: string }[]>();
    const sourceRead = await query<{ item_id: string; workspace_id: string; channel_id: string }>(
      PEER_LEDGER_SOURCES_SQL,
      [scope.teamId, batch.rows.map((row) => row.id)]
    );
    for (const row of sourceRead.rows) {
      pushGrouped(sourcesByItem, row.item_id, { workspaceId: row.workspace_id, channelId: row.channel_id });
    }

    for (const row of batch.rows) {
      const relation = classifySlackRepairRelationship({
        scope,
        bindingWorkspaceId: workspace,
        path: row.path,
        frontmatter: projectedFrontmatter(row),
        ledgerSources: sourcesByItem.get(row.id) ?? [],
        storedIdVariantObserved,
      });
      if (relation.path.kind === "malformed") continue;
      const legacyCandidate = relation.relationship === "channel_candidate" && relation.path.kind === "legacy";
      // A scoped path in a definitely different workspace is not a compatible same-thread item.
      if (!legacyCandidate && relation.relationship !== "scoped_channel_match") continue;
      for (const seeker of seekersByRoot.get(relation.path.rootTs) ?? []) {
        if (seeker.id === row.id) continue;
        if (row.project_id === seeker.projectId) {
          if (legacyCandidate && seeker.wantsConverging && seeker.converging.length < limit) {
            seeker.converging.push(row.id);
          }
        } else if (seeker.otherProject.length < limit) {
          seeker.otherProject.push(row.id);
        }
      }
    }

    const last = batch.rows[batch.rows.length - 1];
    if (!last || batch.rows.length < PEER_BATCH) break;
    after = last.id;
  }
  return seekers;
}
