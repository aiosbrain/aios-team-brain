import "server-only";
import type { SqlQueryResult, TransactionSession } from "@/lib/db/types";
import { lockSlackSelection } from "./slack-source-binding";
import { scopedSlackChannelPathPrefix } from "./sources/slack-namespace";

/**
 * The single writer of `slack_channel_migration_gates` — the durable per-(team, RAW channel)
 * NAMESPACE gate for the Slack timeline (AIO-1170).
 *
 * ⚠️ WHAT THIS GATE DECIDES, AND WHAT IT DOES NOT. It answers one question: have this raw channel's
 * pre-existing legacy rows been resolved to verified workspace provenance and migrated, so that
 * items may be published under `slack/<workspace>/<channel>/<root-ts>.md`? It is NOT source
 * authorization: it says nothing about channel permission, provider scope, whether a body is
 * complete, or whether any particular item may be published. A thread claim from the pending-work
 * slice (`slack-thread-state.ts`) proves ownership of a QUEUE ROW and cannot satisfy this gate
 * either; the two are independent, and the later publisher needs both plus its own checks.
 *
 * The only readiness producer here handles a genuinely NEW channel: it proves current binding,
 * selection, public status and an empty legacy scan in one caller transaction. Historical paths
 * still require an attended provenance repair, which is not built. No caller supplies a verified
 * flag, workspace, repair id or list of supposedly migrated rows.
 * A ready row does not stop the old Slack writer after commit. Attended activation must disable
 * and drain those workers before invoking this helper or enabling scoped publication.
 *
 * Four properties hold this module together:
 *
 *  1. IT NEVER OPENS A TRANSACTION. Every function takes the caller's `TransactionSession` and runs
 *     on that one bound connection, so the later publisher can compose the gate check, the path
 *     locks and the item write into ONE atomic transaction. A gate consulted on a different
 *     connection would be a gate that can be invalidated between the check and the write.
 *  2. ABSENCE IS BLOCKED, AND A FAILED READ IS NEITHER. A missing row refuses (and is never
 *     inserted as a side effect of a read); a SQL failure REJECTS. "No gate", "not ready" and "the
 *     database is broken" must never be the same value, because two of them mean do-not-publish and
 *     the third means do-not-know.
 *  3. READINESS IS ALL OF ITS EVIDENCE OR NONE. The revision it was proved at, the resolved
 *     workspace set and the completed repair identity are stored together and refused apart — by a
 *     DB constraint, and again by the codec here. Neither of those proves provenance; they only
 *     make a HALF-proved readiness unstorable and unreportable.
 *  4. INVALIDATION IS ONE SERIALIZED STEP. Bumping the revision and clearing every proof field
 *     happen in a single statement on the locked row, so a competing reader can never be handed
 *     pre-invalidation readiness.
 *
 * A refusal is reported as `{ outcome: "refused" }` and NEVER as `{ ok: false }`: the transaction
 * engine treats an `ok:false` return from a transaction callback as a rollback signal
 * (`returnedFailure` in `lib/db/pg/tx.ts`), so a caller returning one of these results straight out
 * of its transaction would silently undo its own committed work.
 *
 * This row is the per-raw-channel MIGRATION state, not a stand-in for channel sync state. The
 * producer reads the current public proof but does not write provider metadata or history cursors.
 */

/** A gate's identity. `team_id` is a namespace above the raw Slack channel id. */
export interface SlackNamespaceGateScope {
  readonly teamId: string;
  readonly rawChannelId: string;
}

export type SlackNamespaceGateStatus = "blocked" | "ready";

/** The stored row, as this module reports it. Reporting `ready` is a READ, never a capability. */
export interface SlackNamespaceGateState {
  readonly scope: SlackNamespaceGateScope;
  readonly state: SlackNamespaceGateStatus;
  readonly revision: number;
  readonly readyRevision: number | null;
  readonly resolvedWorkspaceIds: readonly string[];
  readonly completedRepairId: string | null;
  readonly blockedReason: string | null;
}

const readyLockBrand: unique symbol = Symbol("aio1170-slack-namespace-ready");

/**
 * Proof that a `ready` gate was observed UNDER ROW LOCK, at the expected revision, listing this
 * workspace — held on the caller's own transaction, which is the only scope in which it means
 * anything. Its constructor is module-private (the brand symbol is not exported), so it cannot be
 * forged and cannot be produced from a `verified: true`.
 *
 * NAMESPACE-READY ONLY. It is not "allowed to publish": the later publisher must still acquire its
 * old/new path identity locks AFTER this one, re-check the thread fence, and apply the provider /
 * selected-channel / visibility checks this module knows nothing about.
 */
export interface SlackNamespaceReadyLock {
  readonly [readyLockBrand]: true;
  readonly session: TransactionSession;
  readonly scope: SlackNamespaceGateScope;
  readonly workspaceId: string;
  readonly revision: number;
}

export type SlackNamespaceReadyLockResult =
  | { readonly outcome: "locked"; readonly lock: SlackNamespaceReadyLock }
  | { readonly outcome: "refused" };

/** A sanitized blocking CATEGORY: lower-case, underscore-separated, short. Never a message/token. */
const BLOCKED_REASON = /^[a-z][a-z0-9_]{0,39}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A workspace segment that is valid BY CONSTRUCTION, used only to ask the namespace helper about
 * the other half of the pair. `scopedSlackChannelPathPrefix` validates a (workspace, channel) pair
 * and there is no exported single-segment validator; borrowing its verdict is how the id alphabet
 * stays defined in one place instead of being restated here.
 */
const SYNTAX_PROBE_WORKSPACE = "T0";

const GATE_COLUMNS = `team_id, raw_channel_id, state, revision::text as revision,
       ready_revision::text as ready_revision, resolved_workspace_ids, completed_repair_id,
       blocked_reason`;

interface GateRow {
  team_id: string;
  raw_channel_id: string;
  state: string;
  revision: string;
  ready_revision: string | null;
  resolved_workspace_ids: unknown;
  completed_repair_id: string | null;
  blocked_reason: string | null;
}

interface ChannelProofRow {
  workspace_id: string;
  binding_integration_id: string | null;
  binding_config_revision: string | null;
  public_state: string;
  public_checked_at: Date | null;
}

interface BindingProofRow {
  id: string;
  state: string;
  config_revision: string;
  token_fingerprint: string;
  workspace_id: string | null;
  app_id: string | null;
  selected_channel_ids: string[];
}

class SlackNamespaceGateError extends TypeError {
  constructor(message: string) {
    super(`slack namespace gate: ${message}`);
    this.name = "SlackNamespaceGateError";
  }
}

/**
 * Verdict only — the returned prefix is discarded, and its lower-cased form is emphatically not
 * what is stored: the row keeps the provider's bytes, exactly as `slack_sync_threads` does. The SQL
 * check constraints are the storage-level restatement of the same rule, because app validation is
 * not a guarantee about what is in the table.
 */
function assertIdPair(workspaceId: string, channelId: string): void {
  scopedSlackChannelPathPrefix(workspaceId, channelId);
}

function assertScope(scope: SlackNamespaceGateScope): void {
  if (typeof scope?.teamId !== "string" || !UUID.test(scope.teamId)) {
    throw new SlackNamespaceGateError(
      `teamId must be a UUID (got ${JSON.stringify(scope?.teamId)})`
    );
  }
  assertIdPair(SYNTAX_PROBE_WORKSPACE, scope.rawChannelId);
}

/**
 * The one validator here whose REJECTED VALUE IS ITSELF THE HAZARD. Everything this rule stops — a
 * provider message, a token, a signed URL — is a thing that must not reach `blocked_reason`, and a
 * message quoting what it refused would copy that value into the throw, the stack and every log
 * that records it. So the message is STATIC and no `cause` is attached: nothing on the thrown error
 * carries the input. The caller already holds the value; what it needs from us is the rule.
 */
function assertReason(reason: string): void {
  if (typeof reason !== "string" || !BLOCKED_REASON.test(reason)) {
    throw new SlackNamespaceGateError(
      `reason must be a sanitized lower-case blocking CATEGORY matching ${BLOCKED_REASON.source} — ` +
        `never a provider message, a token or free text. The rejected value is deliberately omitted ` +
        `from this message: it is the exact string suspected of carrying one.`
    );
  }
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SlackNamespaceGateError(
      `expectedRevision must be a non-negative whole number (got ${JSON.stringify(value)})`
    );
  }
}

/** bigint arrives as text so nothing is silently rounded; a value past 2^53 is reported, not lost. */
function counter(field: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SlackNamespaceGateError(`${field} is not representable as a safe integer (${value})`);
  }
  return parsed;
}

function readWorkspaces(row: GateRow): readonly string[] {
  const value = row.resolved_workspace_ids;
  if (!Array.isArray(value)) {
    throw new SlackNamespaceGateError("resolved_workspace_ids did not read back as an array");
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new SlackNamespaceGateError("resolved_workspace_ids holds a non-string entry");
    }
    // Provider ids, checked against the same alphabet on the way OUT: a stored value that could not
    // have been minted is a corrupt gate, not a workspace to hand to a publisher.
    assertIdPair(entry, row.raw_channel_id);
  }
  return Object.freeze([...(value as string[])]);
}

/**
 * The stored row → the reported state, refusing any shape whose readiness is partial. The DB
 * constraint states the same rule; this is the second reading of it, so a row written before (or
 * outside) that constraint is an ERROR here rather than a quiet `ready`. Neither reading proves
 * provider provenance — they only make a half-proved readiness unstorable and unreportable.
 */
function toGate(row: GateRow): SlackNamespaceGateState {
  if (row.state !== "blocked" && row.state !== "ready") {
    throw new SlackNamespaceGateError(`unknown stored state ${JSON.stringify(row.state)}`);
  }
  const revision = counter("revision", row.revision);
  const readyRevision = row.ready_revision === null ? null : counter("ready_revision", row.ready_revision);
  const resolvedWorkspaceIds = readWorkspaces(row);
  const completedRepairId = row.completed_repair_id;

  if (row.state === "ready") {
    const complete =
      readyRevision !== null &&
      readyRevision === revision &&
      resolvedWorkspaceIds.length > 0 &&
      completedRepairId !== null &&
      row.blocked_reason === null;
    if (!complete) {
      throw new SlackNamespaceGateError(
        "stored gate claims ready without complete, current readiness evidence — refusing to report it"
      );
    }
  } else if (readyRevision !== null || resolvedWorkspaceIds.length > 0 || completedRepairId !== null) {
    throw new SlackNamespaceGateError(
      "stored gate is blocked but carries readiness evidence — refusing to report it"
    );
  }

  return {
    scope: { teamId: row.team_id, rawChannelId: row.raw_channel_id },
    state: row.state,
    revision,
    readyRevision,
    resolvedWorkspaceIds,
    completedRepairId,
    blockedReason: row.blocked_reason,
  };
}

/**
 * Make sure a gate EXISTS for this raw channel, blocked, and report its current state.
 *
 * `ON CONFLICT DO NOTHING`, never an upsert: this is the "we have noticed this channel" step, and a
 * second caller noticing the same channel must not reset a revision, drop a blocking reason, or
 * touch readiness somebody else established. It is also not an invalidation — it cannot revoke — so
 * calling it on a `ready` gate reports that readiness and changes nothing.
 *
 * The returned state is a READ. It carries no capability: publication must still take the lock
 * below, which re-checks the row under `for update`.
 */
export async function ensureBlockedSlackNamespaceGate(
  session: TransactionSession,
  scope: SlackNamespaceGateScope
): Promise<SlackNamespaceGateState> {
  assertScope(scope);

  const inserted = await session.executeSql<GateRow>(
    `insert into slack_channel_migration_gates (team_id, raw_channel_id)
          values ($1, $2)
     on conflict (team_id, raw_channel_id) do nothing
       returning ${GATE_COLUMNS}`,
    [scope.teamId, scope.rawChannelId]
  );
  const fresh = single(inserted);
  if (fresh) return toGate(fresh);

  const existing = await session.executeSql<GateRow>(
    `select ${GATE_COLUMNS} from slack_channel_migration_gates
      where team_id = $1 and raw_channel_id = $2`,
    [scope.teamId, scope.rawChannelId]
  );
  const row = single(existing);
  if (!row) {
    // The insert conflicted, so a row existed; its disappearance inside this transaction is an
    // anomaly (a concurrent team cascade, or an isolation level above the engine's READ COMMITTED
    // so this statement cannot see the committed conflicting row), not an empty result to paper
    // over — and reporting a gate whose state we did not read is the failure that must fail closed.
    throw new SlackNamespaceGateError(
      "ensure conflicted but the conflicting row is gone — refusing to report a state it does not have"
    );
  }
  return toGate(row);
}

/**
 * Inactive producer for an empty, new channel. Lock order: gate -> integration -> channel TABLE
 * SHARE -> binding -> channel row -> items TABLE SHARE. Discovery takes integration before channel
 * writes when both occur in one transaction, so the table lock must follow the integration lock.
 */
export async function prepareNewSlackChannelNamespace(
  session: TransactionSession,
  scope: SlackNamespaceGateScope
): Promise<{ readonly outcome: "ready"; readonly gate: SlackNamespaceGateState } | { readonly outcome: "blocked" }> {
  assertScope(scope);
  await ensureBlockedSlackNamespaceGate(session, scope);
  const gateResult = await session.executeSql<GateRow>(
    `select ${GATE_COLUMNS} from slack_channel_migration_gates
      where team_id = $1 and raw_channel_id = $2 for update`,
    [scope.teamId, scope.rawChannelId]
  );
  const gateRow = single(gateResult);
  if (!gateRow) throw new SlackNamespaceGateError("gate disappeared after ensure");
  const gate = toGate(gateRow);
  if (gate.state !== "blocked") return { outcome: "blocked" };

  // This is only a locator for the integration lock, never the decisive candidate-set check.
  // Discovery can insert a second workspace row until the table SHARE lock below is held.
  const located = await session.executeSql<ChannelProofRow>(
    `select workspace_id, binding_integration_id, binding_config_revision,
            public_state, public_checked_at
       from slack_sync_channels where team_id = $1 and channel_id = $2`,
    [scope.teamId, scope.rawChannelId]
  );
  if (located.rows.length !== 1) return { outcome: "blocked" };
  const locator = located.rows[0];
  if (!locator.binding_integration_id) return { outcome: "blocked" };

  const current = await lockSlackSelection(session, {
    teamId: scope.teamId,
    integrationId: locator.binding_integration_id,
  });
  if (current.outcome !== "current") return { outcome: "blocked" };
  const selection = current.selection;
  if (!selection.channelIds.includes(scope.rawChannelId)) return { outcome: "blocked" };

  // A row lock on the located channel cannot exclude a different workspace key. SHARE excludes
  // discovery's INSERT/UPDATE RowExclusive lock until this transaction commits. Rescan AFTER it
  // is held, so an insertion that won the race is visible and a later one must wait.
  await session.executeSql("lock table slack_sync_channels in share mode");
  const candidates = await session.executeSql<ChannelProofRow>(
    `select workspace_id, binding_integration_id, binding_config_revision,
            public_state, public_checked_at
       from slack_sync_channels where team_id = $1 and channel_id = $2`,
    [scope.teamId, scope.rawChannelId]
  );
  if (candidates.rows.length !== 1) return { outcome: "blocked" };
  const candidate = candidates.rows[0];
  if (
    candidate.workspace_id !== locator.workspace_id ||
    candidate.binding_integration_id !== selection.integrationId
  ) return { outcome: "blocked" };

  const bindingResult = await session.executeSql<BindingProofRow>(
    `select id, state, config_revision, token_fingerprint, workspace_id, app_id,
            selected_channel_ids
       from slack_integration_bindings
      where team_id = $1 and integration_id = $2 for update`,
    [scope.teamId, selection.integrationId]
  );
  const binding = single(bindingResult);
  if (
    !binding || binding.state !== "verified" || !binding.app_id ||
    binding.workspace_id !== candidate.workspace_id ||
    binding.config_revision !== selection.configRevision ||
    binding.token_fingerprint !== selection.tokenFingerprint ||
    !binding.selected_channel_ids.includes(scope.rawChannelId)
  ) return { outcome: "blocked" };

  const channelResult = await session.executeSql<ChannelProofRow>(
    `select workspace_id, binding_integration_id, binding_config_revision,
            public_state, public_checked_at
       from slack_sync_channels
      where team_id = $1 and workspace_id = $2 and channel_id = $3 for update`,
    [scope.teamId, binding.workspace_id, scope.rawChannelId]
  );
  const channel = single(channelResult);
  if (
    !channel || channel.public_state !== "public" || !channel.public_checked_at ||
    channel.binding_integration_id !== selection.integrationId ||
    channel.binding_config_revision !== selection.configRevision
  ) return { outcome: "blocked" };

  // Legacy writers do not take this gate. SHARE protects ONLY this transaction's scan; the
  // attended rollout must drain old workers before invoking this helper or enabling publication.
  // Any legacy path in the team can hide this channel behind a display-name slug, so block.
  await session.executeSql("lock table items in share mode");
  const legacy = await session.executeSql<{ id: string }>(
    `select id from items
      where team_id = $1
        and (
          ((path like 'slack/%' or frontmatter->>'source' = 'slack')
            and path !~ '^slack/[A-Za-z0-9]+/[A-Za-z0-9]+/[0-9]+[.][0-9]{6}[.]md$')
          or (path ~ '^slack/[A-Za-z0-9]+/[A-Za-z0-9]+/[0-9]+[.][0-9]{6}[.]md$'
              and lower(split_part(path, '/', 3)) = lower($2))
        )
      limit 1`,
    [scope.teamId, scope.rawChannelId]
  );
  if (legacy.rows.length !== 0) return { outcome: "blocked" };

  const proof = await session.executeSql<{ id: string }>(
    `insert into slack_namespace_readiness_proofs
       (team_id, raw_channel_id, gate_revision, workspace_id, integration_id,
        binding_id, config_revision, public_checked_at, legacy_rows_found)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 0) returning id`,
    [scope.teamId, scope.rawChannelId, gate.revision, binding.workspace_id,
      selection.integrationId, binding.id, selection.configRevision, channel.public_checked_at]
  );
  const proofId = single(proof)?.id;
  if (!proofId) throw new SlackNamespaceGateError("completed proof insert returned no identity");
  const written = await session.executeSql<GateRow>(
    `update slack_channel_migration_gates
        set state = 'ready', ready_revision = revision, resolved_workspace_ids = array[$3]::text[],
            completed_repair_id = $4::uuid, blocked_reason = null, updated_at = clock_timestamp()
      where team_id = $1 and raw_channel_id = $2 and state = 'blocked' and revision = $5
      returning ${GATE_COLUMNS}`,
    [scope.teamId, scope.rawChannelId, binding.workspace_id, proofId, gate.revision]
  );
  const ready = single(written);
  if (!ready) throw new SlackNamespaceGateError("locked gate changed before readiness write");
  return { outcome: "ready", gate: toGate(ready) };
}

/**
 * Invalidate this channel's namespace readiness: bump the revision, clear every proof field, record
 * a sanitized reason — creating the gate blocked if it does not exist yet.
 *
 * ONE statement, so the bump and the clearing cannot be observed apart, and the `do update` arm
 * takes the row lock, so concurrent invalidations serialize into distinct revisions instead of one
 * losing the other's. The revision only ever moves FORWARD, which is what lets a publisher pin its
 * work to the value it saw.
 *
 * This invalidates NAMESPACE readiness only. It does not purge items, caches or source state; when
 * an integration/workspace change requires that broader invalidation, the change handler composes
 * it into the same transaction as this call.
 */
export async function invalidateSlackNamespaceGate(
  session: TransactionSession,
  scope: SlackNamespaceGateScope,
  reason: string
): Promise<SlackNamespaceGateState> {
  assertScope(scope);
  assertReason(reason);

  const result = await session.executeSql<GateRow>(
    `insert into slack_channel_migration_gates (team_id, raw_channel_id, state, blocked_reason)
          values ($1, $2, 'blocked', $3)
     on conflict (team_id, raw_channel_id) do update
            set state = 'blocked',
                revision = slack_channel_migration_gates.revision + 1,
                ready_revision = null,
                resolved_workspace_ids = '{}',
                completed_repair_id = null,
                blocked_reason = excluded.blocked_reason,
                updated_at = clock_timestamp()
      returning ${GATE_COLUMNS}`,
    [scope.teamId, scope.rawChannelId, reason]
  );
  const row = single(result);
  if (!row) {
    throw new SlackNamespaceGateError(
      "invalidate returned no row — refusing to report a revision it did not persist"
    );
  }
  return toGate(row);
}

/**
 * Lock this channel's gate and hand back a namespace-ready capability, or refuse.
 *
 * The row is read `for update` and every condition is re-checked on the row that lock RETURNED —
 * current state, readiness at the current revision, the caller's expected revision, and this
 * workspace's membership of the resolved set. A pre-lock read would be a check against a value
 * somebody else is already changing.
 *
 * Workspace membership is BYTE-EXACT: a case-different spelling refuses rather than being folded,
 * because folding would accept an identity the stored provenance does not name.
 *
 * A refusal deliberately carries no reason. Missing, blocked, outrun by an invalidation and "not
 * this workspace" have exactly the same consequence — this caller must not publish on the scoped
 * namespace — and a classified refusal is the thing a later caller branches on by mistake. It never
 * inserts: a read must not create the row whose absence it is reporting.
 */
export async function lockReadySlackNamespaceGate(
  session: TransactionSession,
  request: {
    teamId: string;
    rawChannelId: string;
    workspaceId: string;
    expectedRevision: number;
  }
): Promise<SlackNamespaceReadyLockResult> {
  const scope: SlackNamespaceGateScope = {
    teamId: request.teamId,
    rawChannelId: request.rawChannelId,
  };
  assertScope(scope);
  assertIdPair(request.workspaceId, scope.rawChannelId);
  assertRevision(request.expectedRevision);

  const result = await session.executeSql<GateRow>(
    `select ${GATE_COLUMNS} from slack_channel_migration_gates
      where team_id = $1 and raw_channel_id = $2
        for update`,
    [scope.teamId, scope.rawChannelId]
  );
  const row = single(result);
  if (!row) return { outcome: "refused" };

  const gate = toGate(row);
  if (gate.state !== "ready") return { outcome: "refused" };
  // The codec above already refuses a stale `ready_revision`; restated because this is the
  // condition the capability's revision is taken from, and it must not depend on a distant check.
  if (gate.readyRevision !== gate.revision) return { outcome: "refused" };
  if (gate.revision !== request.expectedRevision) return { outcome: "refused" };
  if (!gate.resolvedWorkspaceIds.includes(request.workspaceId)) return { outcome: "refused" };

  return {
    outcome: "locked",
    lock: {
      [readyLockBrand]: true,
      session,
      scope: gate.scope,
      workspaceId: request.workspaceId,
      revision: gate.revision,
    },
  };
}

/** One row or none. More than one would mean the primary key is not doing its job. */
function single<T>(result: SqlQueryResult<T>): T | undefined {
  if (result.rows.length > 1) {
    throw new SlackNamespaceGateError(`expected at most one row, got ${result.rows.length}`);
  }
  return result.rows[0];
}
