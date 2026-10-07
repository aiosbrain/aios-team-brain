import { TransactionExecutionError } from "@/lib/db/pg/tx";
import type { TransactionSession } from "@/lib/db/types";
import {
  SlackKnownRootValidationError,
  admitSlackKnownRootExecution,
  captureSlackKnownRootEntry,
  captureSlackKnownRootTeamId,
  runSlackKnownRootOperation,
  type SlackKnownRootEntry,
  type SlackKnownRootExecution,
  type SlackKnownRootLocatedEntry,
} from "./slack-known-root-page";
import { lockReadySlackNamespaceGate } from "./slack-namespace-gate";
import { lockSlackSelection } from "./slack-source-binding";
import { enqueueSlackThread } from "./slack-thread-state";
import { scopedSlackItemPath } from "./sources/slack-namespace";
import { slackChannelPathPrefix } from "./sources/slack-normalize";

/**
 * AIO-1170 AC-02 — INACTIVE preparation of completed-root reconciliation work
 * (`docs/design/slack-known-root-requeue-spec.md`, §5, §6 and §8).
 *
 * `prepareSlackKnownRootRequeue` recreates the missing pending row of ONE previously published,
 * provably canonical Slack root, from the team and one enumerated entry and nothing else. It checks
 * current source authority under the same locks, in the same order, as publication; proves the item
 * canonical and its root witnessed under the item's own lock; and then hands the exact scope and an
 * observation-derived due time to the existing enqueue helper — its only write. It issues no
 * provider request, opens no transaction, and writes no item, ledger row, identity, generation or
 * channel state. A stored proof is checked, never refreshed.
 *
 * The two PURE helpers that account for it — the failure classifier (§8.1) and the page tally
 * reducer (§8.2, §8.3) — are here as well. Neither performs I/O.
 *
 * Nothing in the application imports this module
 * (`test/guards/slack-known-root-requeue-not-wired.test.ts`, `test/guards/slack-source-not-wired.test.ts`).
 */

export const SLACK_KNOWN_ROOT_UNATTESTED_REASONS = [
  "not_slack",
  "invalid_metadata",
  "missing_channel_binding",
  "missing_namespace_pin",
  "item_missing",
  "canonical_mismatch",
  "missing_root_witness",
  "contradictory_ledger",
] as const;

export const SLACK_KNOWN_ROOT_REFUSED_REASONS = [
  "namespace_changed_or_unready",
  "source_not_current",
  "binding_changed",
  "channel_not_public",
  "scoped_path_conflict",
  "legacy_path_conflict",
] as const;

/** The safe reporting vocabulary for a preparation that THREW. Nothing else is reportable. */
export const SLACK_KNOWN_ROOT_FAILURE_CATEGORIES = [
  "lock_timeout",
  "statement_timeout",
  "deadline_exceeded",
  "serialization_failure",
  "deadlock",
  "database_failure",
  "dependency_failure",
  "commit_unknown",
] as const;

export type SlackKnownRootUnattestedReason = (typeof SLACK_KNOWN_ROOT_UNATTESTED_REASONS)[number];
export type SlackKnownRootRefusedReason = (typeof SLACK_KNOWN_ROOT_REFUSED_REASONS)[number];
export type SlackKnownRootFailureCategory = (typeof SLACK_KNOWN_ROOT_FAILURE_CATEGORIES)[number];

/** Provisional until the caller's transaction commits. Never `{ ok: false }`. */
export type SlackKnownRootPreparationResult =
  | { readonly outcome: "enqueued" }
  | { readonly outcome: "already_pending" }
  | { readonly outcome: "not_due" }
  | { readonly outcome: "unattested"; readonly reason: SlackKnownRootUnattestedReason }
  | { readonly outcome: "refused"; readonly reason: SlackKnownRootRefusedReason };

/**
 * Everything a caller supplies: the team and one complete enumerated entry. No workspace, channel,
 * integration, root, token, fingerprint or revision of its own.
 */
export interface SlackKnownRootRequeueInput {
  readonly teamId: string;
  readonly entry: SlackKnownRootEntry;
}

function invalidInput(): never {
  throw new SlackKnownRootValidationError();
}

/** Not a refusal and not a caller-contract failure: a stored or returned shape this slice cannot read. */
function unexpected(reason: string): never {
  throw new Error(`slack known-root: ${reason}`);
}

const refused = (reason: SlackKnownRootRefusedReason): SlackKnownRootPreparationResult => ({ outcome: "refused", reason });
const unattested = (reason: SlackKnownRootUnattestedReason): SlackKnownRootPreparationResult => ({ outcome: "unattested", reason });

const PROVIDER_ID = /^[A-Za-z0-9]+$/;
/** The internal publication project: the only project a canonical scoped Slack item lives in. */
const SLACK_PROJECT_SLUG = "slack";
const DUE_EPOCH_MS = /^-?(?:0|[1-9][0-9]*)$/;
/** The largest magnitude of epoch milliseconds a JavaScript Date can hold. */
const MAX_DATE_MS = 8_640_000_000_000_000;

// The binding row and the scoped channel row are LOCKED, exactly as publication locks them, so a
// revocation cannot commit behind these checks and the same-channel publisher is serialized.
const BINDING_SQL = `
  select state, config_revision, token_fingerprint, workspace_id, app_id, selected_channel_ids
    from slack_integration_bindings
   where team_id = $1::uuid and integration_id = $2::uuid
     for update`;

const CHANNEL_SQL = `
  select binding_integration_id::text as binding_integration_id,
         binding_config_revision,
         public_state,
         (public_checked_at is not null and isfinite(public_checked_at)) as public_checked
    from slack_sync_channels
   where team_id = $1::uuid and workspace_id = $2 and channel_id = $3
     for update`;

// A PLAIN read: no row lock and no skip. Locking the queue row here would make the claimer's
// `skip locked` pass over useful work, and the authority locks above already serialize this
// preparation with the publisher of the same channel.
const QUEUE_SQL = `
  select 1 as pending
    from slack_sync_threads
   where team_id = $1::uuid and workspace_id = $2 and channel_id = $3 and root_ts = $4
   limit 1`;

// The narrow scalar lock of the exact team/item row. Every stored value is projected through its
// type and its byte length: no body, no whole frontmatter object.
const ITEM_SQL = `
  select i.project_id::text as project_id,
         i.kind::text as kind,
         i.access::text as access,
         case when octet_length(i.path) <= 2048 then i.path end as path,
         case when jsonb_typeof(i.frontmatter->'source') = 'string' and octet_length(i.frontmatter->>'source') <= 256
              then i.frontmatter->>'source' end as source,
         case when jsonb_typeof(i.frontmatter->'workspace_id') = 'string' and octet_length(i.frontmatter->>'workspace_id') <= 256
              then i.frontmatter->>'workspace_id' end as workspace_id,
         case when jsonb_typeof(i.frontmatter->'channel_id') = 'string' and octet_length(i.frontmatter->>'channel_id') <= 256
              then i.frontmatter->>'channel_id' end as channel_id,
         case when jsonb_typeof(i.frontmatter->'ts') = 'string' and octet_length(i.frontmatter->>'ts') <= 128
              then i.frontmatter->>'ts' end as ts,
         case when jsonb_typeof(i.frontmatter->'thread_ts') = 'string' and octet_length(i.frontmatter->>'thread_ts') <= 128
              then i.frontmatter->>'thread_ts' end as thread_ts
    from items i
   where i.team_id = $1::uuid and i.id = $2::uuid
     for update`;

const SLACK_PROJECT_SQL = `
  select id::text as id
    from projects
   where team_id = $1::uuid and slug = $2`;

// The live root witness (§5.3): this exact root message, in this exact scope, bound to this item,
// not deleted, with a finite observation.
const WITNESS_PREDICATE = `
       w.team_id = $1::uuid and w.workspace_id = $2 and w.channel_id = $3
   and w.message_ts = $4 and w.root_ts = $4 and w.is_root = true
   and w.item_id = $5::uuid and w.deleted_at is null and isfinite(w.observed_at)`;

const WITNESS_SQL = `
  select 1 as witnessed
    from slack_messages w
   where ${WITNESS_PREDICATE}`;

// Both contradictory bindings, as EXISTENCE checks and over deleted rows too: neither predicate
// filters on deleted_at, because a deleted row still records which item a message was bound to.
// The second is on ROOT_TS, not on message_ts: a REPLY of this root that a second item owns is a
// contradiction, and a check of the root message alone would not see it.
const CONTRADICTION_SQL = `
  select exists (
           select 1 from slack_messages
            where team_id = $1::uuid and item_id = $5::uuid
              and (workspace_id <> $2 or channel_id <> $3 or root_ts <> $4)
         ) as item_bound_elsewhere,
         exists (
           select 1 from slack_messages
            where team_id = $1::uuid and workspace_id = $2 and channel_id = $3
              and root_ts = $4 and item_id <> $5::uuid
         ) as thread_bound_to_another_item`;

// The publication conflict predicates (§5.4): the scoped path owned by another project, and ANY
// extant item at the legacy path, whatever its project, access, kind or frontmatter.
const PATH_CONFLICT_SQL = `
  select exists (
           select 1 from items where team_id = $1::uuid and path = $2 and project_id <> $3::uuid
         ) as scoped_conflict,
         exists (
           select 1 from items where team_id = $1::uuid and path = $4
         ) as legacy_conflict`;

// The due decision, entirely in the database (§5.5): the exact instant is the witness's observation
// plus the revisit interval; it is compared with clock_timestamp(), never with the transaction's
// start or an application clock; and it is rounded UP to the millisecond in exact numeric
// arithmetic, after the interval was added. An observation past the year 9999 cannot be a real one
// and is not added to at all: whatever it would yield lies in the far future, so it is not due, and
// no out-of-range arithmetic or infinite value ever reaches the application.
const DUE_SQL = `
  select case when w.observed_at <= timestamptz '9999-12-31 00:00:00+00'
              then (w.observed_at + ($6::bigint * interval '1 millisecond')) <= clock_timestamp()
              else false end as is_due,
         case when w.observed_at <= timestamptz '9999-12-31 00:00:00+00'
              then ceil(extract(epoch from (w.observed_at + ($6::bigint * interval '1 millisecond')))::numeric * 1000)::bigint::text
              end as due_epoch_ms
    from slack_messages w
   where ${WITNESS_PREDICATE}`;

function capturedInput(input: unknown): { teamId: string; entry: SlackKnownRootEntry } {
  let teamId: string;
  let entry: SlackKnownRootEntry;
  try {
    const supplied = plainRecord(input);
    // The team and one enumerated entry: there is no third field to supply an authority through.
    if (supplied === null || !hasExactlyKeys(supplied, ["teamId", "entry"])) return invalidInput();
    teamId = captureSlackKnownRootTeamId(supplied.teamId);
    entry = captureSlackKnownRootEntry(supplied.entry);
  } catch {
    return invalidInput();
  }
  if (entry.teamId !== teamId) return invalidInput();
  return { teamId, entry };
}

/** A rounded due instant as a Date, validated as a safe, representable integer BEFORE it becomes one. */
function dueDate(value: unknown): Date {
  if (typeof value !== "string" || !DUE_EPOCH_MS.test(value)) return unexpected("a due instant is unreadable");
  const epochMs = Number(value);
  if (!Number.isSafeInteger(epochMs) || Math.abs(epochMs) > MAX_DATE_MS) return unexpected("a due instant is not representable");
  const due = new Date(epochMs);
  return Number.isNaN(due.getTime()) ? unexpected("a due instant is not representable") : due;
}

/**
 * Preparation of one LOCATED entry, on the slice's decorated session only. Every result it returns
 * is provisional until the caller's transaction commits, and anything unexpected is thrown so that
 * the caller's transaction rolls back: a failure never becomes a refusal.
 */
async function prepareLocated(
  decorated: TransactionSession,
  teamId: string,
  entry: SlackKnownRootLocatedEntry
): Promise<SlackKnownRootPreparationResult> {
  const { itemId, revisitAfterMs } = entry;
  const { workspaceId, channelId, rootTs, integrationId, bindingConfigRevision, namespaceRevision } = entry.locator;
  // Both paths come from the existing builders. Provider ids are never recovered from a path.
  const scopedPath = scopedSlackItemPath(workspaceId, channelId, rootTs);
  const legacyPath = `${slackChannelPathPrefix(channelId)}${rootTs}.md`;
  const scope = [teamId, workspaceId, channelId, rootTs];

  // ── §5.1 current source authority, in publication's lock order ──
  // 1. The namespace gate, at the revision ENUMERATION captured. A fresh revision is never
  //    substituted: if the gate was invalidated and made ready again in between, this refuses.
  const gate = await lockReadySlackNamespaceGate(decorated, {
    teamId, rawChannelId: channelId, workspaceId, expectedRevision: namespaceRevision,
  });
  if (gate.outcome !== "locked") return refused("namespace_changed_or_unready");

  // 2. The integration, through the selection lock, which resolves the effective token locally.
  //    Only the two stamps and the selection leave this block; the token does not.
  const selected = await lockSlackSelection(decorated, { teamId, integrationId });
  if (selected.outcome !== "current") return refused("source_not_current");
  const currentConfigRevision = selected.selection.configRevision;
  const currentTokenFingerprint = selected.selection.tokenFingerprint;
  if (!selected.selection.channelIds.includes(channelId) || currentConfigRevision !== bindingConfigRevision) {
    return refused("source_not_current");
  }

  // 3. The binding row.
  const bound = await decorated.executeSql<{
    state: unknown; config_revision: unknown; token_fingerprint: unknown;
    workspace_id: unknown; app_id: unknown; selected_channel_ids: unknown;
  }>(BINDING_SQL, [teamId, integrationId]);
  if (bound.rows.length !== 1) return refused("binding_changed");
  const binding = bound.rows[0];
  if (binding.state !== "verified" || typeof binding.app_id !== "string" || !PROVIDER_ID.test(binding.app_id) ||
      binding.workspace_id !== workspaceId || binding.config_revision !== bindingConfigRevision ||
      binding.token_fingerprint !== currentTokenFingerprint ||
      !Array.isArray(binding.selected_channel_ids) || !binding.selected_channel_ids.includes(channelId)) {
    return refused("binding_changed");
  }

  // 4. The exact scoped channel row: bound to the same integration at the same revision, and
  //    carrying a stored public proof. The proof is checked, not refreshed.
  const channels = await decorated.executeSql<{
    binding_integration_id: unknown; binding_config_revision: unknown; public_state: unknown; public_checked: unknown;
  }>(CHANNEL_SQL, [teamId, workspaceId, channelId]);
  if (channels.rows.length !== 1) return refused("binding_changed");
  const channel = channels.rows[0];
  if (typeof channel.binding_integration_id !== "string" || channel.binding_integration_id.toLowerCase() !== integrationId ||
      channel.binding_config_revision !== bindingConfigRevision) {
    return refused("binding_changed");
  }
  if (channel.public_state !== "public" || channel.public_checked !== true) return refused("channel_not_public");

  // ── §5.2 queue, then item ──
  // 5–6. Work that already exists is left exactly as it is. This says a row existed when it was
  //      read; it attests nothing about the item.
  const pending = await decorated.executeSql(QUEUE_SQL, scope);
  if (pending.rows.length > 0) return { outcome: "already_pending" };

  // 7–8. The item, locked, and validated on the row the lock returned.
  const items = await decorated.executeSql<{
    project_id: unknown; kind: unknown; access: unknown; path: unknown; source: unknown;
    workspace_id: unknown; channel_id: unknown; ts: unknown; thread_ts: unknown;
  }>(ITEM_SQL, [teamId, itemId]);
  if (items.rows.length === 0) return unattested("item_missing");
  if (items.rows.length !== 1) return unexpected("an item lock returned more than one row");
  const item = items.rows[0];
  const projects = await decorated.executeSql<{ id: unknown }>(SLACK_PROJECT_SQL, [teamId, SLACK_PROJECT_SLUG]);
  if (projects.rows.length > 1) return unexpected("a team has more than one project of one slug");
  const slackProjectId = projects.rows.length === 1 ? projects.rows[0].id : null;
  if (typeof slackProjectId !== "string" || item.project_id !== slackProjectId ||
      item.kind !== "transcript" || item.access !== "team" || item.path !== scopedPath ||
      item.source !== "slack" || item.workspace_id !== workspaceId || item.channel_id !== channelId ||
      item.ts !== rootTs || item.thread_ts !== rootTs) {
    return unattested("canonical_mismatch");
  }

  // ── §5.3 ledger facts, read only after the item lock ──
  const ledgerScope = [...scope, itemId];
  const witness = await decorated.executeSql(WITNESS_SQL, ledgerScope);
  if (witness.rows.length > 1) return unexpected("a root witness is not unique");
  if (witness.rows.length !== 1) return unattested("missing_root_witness");
  const contradictions = await decorated.executeSql<{ item_bound_elsewhere: unknown; thread_bound_to_another_item: unknown }>(
    CONTRADICTION_SQL, ledgerScope
  );
  if (contradictions.rows.length !== 1) return unexpected("a ledger check returned no verdict");
  const contradiction = contradictions.rows[0];
  if (contradiction.item_bound_elsewhere !== false || contradiction.thread_bound_to_another_item !== false) {
    // Only a clear `false` on BOTH is the absence of a contradiction.
    if (typeof contradiction.item_bound_elsewhere !== "boolean" || typeof contradiction.thread_bound_to_another_item !== "boolean") {
      return unexpected("a ledger check returned an unreadable verdict");
    }
    return unattested("contradictory_ledger");
  }

  // ── §5.4 exact path conflicts ──
  const conflicts = await decorated.executeSql<{ scoped_conflict: unknown; legacy_conflict: unknown }>(
    PATH_CONFLICT_SQL, [teamId, scopedPath, slackProjectId, legacyPath]
  );
  if (conflicts.rows.length !== 1) return unexpected("a path check returned no verdict");
  const conflict = conflicts.rows[0];
  if (typeof conflict.scoped_conflict !== "boolean" || typeof conflict.legacy_conflict !== "boolean") {
    return unexpected("a path check returned an unreadable verdict");
  }
  if (conflict.scoped_conflict) return refused("scoped_path_conflict");
  if (conflict.legacy_conflict) return refused("legacy_path_conflict");

  // ── §5.5 due time and insertion ──
  const dues = await decorated.executeSql<{ is_due: unknown; due_epoch_ms: unknown }>(DUE_SQL, [...ledgerScope, revisitAfterMs]);
  if (dues.rows.length > 1) return unexpected("a root witness is not unique");
  if (dues.rows.length !== 1) return unattested("missing_root_witness");
  const due = dues.rows[0];
  if (due.is_due === false) return { outcome: "not_due" };
  if (due.is_due !== true) return unexpected("a due decision is unreadable");
  // The historical due instant, never the moment of this invocation: unchanged witness facts
  // derive the same instant on every replay.
  const dueAt = dueDate(due.due_epoch_ms);

  // The existing enqueue helper is the only writer, and it preserves a conflicting pending row
  // untouched. A row somebody inserted after the plain read above is therefore still pending work.
  const enqueued = await enqueueSlackThread(decorated, { teamId, workspaceId, channelId, rootTs }, { dueAt });
  return { outcome: enqueued.inserted === true ? "enqueued" : "already_pending" };
}

/**
 * Recreate the missing pending row of one witnessed, canonical, previously published root.
 *
 * The caller supplies the team, one enumerated entry and the execution context, on its own
 * READ COMMITTED transaction, and nothing else. The input is validated in full and copied before
 * anything is awaited; the context is admitted before the session is used at all. An entry that
 * enumeration could not locate is `unattested` with that same reason, and the session is not
 * touched for it — there is nothing to look up, nothing to lock and nothing to restore.
 *
 * For a located entry every statement runs on the slice's decorated session. Each normal result —
 * a refusal, an unattested entry, `not_due`, `already_pending` on either path, or `enqueued` —
 * returns only after both session timeout settings were restored. A deadline, a SQL failure, a
 * dependency failure or a failed restoration is thrown, so the caller's transaction rolls back;
 * none of them is ever reported as a refusal or as completed work.
 */
export async function prepareSlackKnownRootRequeue(
  session: TransactionSession,
  input: SlackKnownRootRequeueInput,
  execution: SlackKnownRootExecution
): Promise<SlackKnownRootPreparationResult> {
  // Everything caller-controlled is validated and copied before the first await.
  const { teamId, entry } = capturedInput(input);
  admitSlackKnownRootExecution(execution);
  if ("unlocated" in entry) return unattested(entry.unlocated);
  return runSlackKnownRootOperation<SlackKnownRootPreparationResult>(session, execution, (decorated) => prepareLocated(decorated, teamId, entry));
}

/**
 * A PostgreSQL SQLSTATE: five characters whose two-character CLASS is one PostgreSQL defines —
 * every class that begins with a digit, and the four that do not (`F0`, `HV`, `P0`, `XX`).
 *
 * The length and alphabet alone are not enough. `EPIPE`, `EPERM`, `EBUSY` and `E2BIG` are five
 * upper-case characters too, and they are Node system error codes: a broken pipe is a dependency
 * failure, not a database one. No PostgreSQL class begins with `E`.
 */
const POSTGRES_SQLSTATE = /^(?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/;

/**
 * The value of one OWN DATA property, or undefined. An accessor is never invoked and a prototype is
 * never consulted, so a hostile getter cannot choose the answer or throw through this function, and
 * a proxy whose trap throws simply has no such property. The markers and the code this module reads
 * are all plain own data properties of the errors that carry them.
 */
function ownDataValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** Known class identity, and nothing read from the instance. A proxy that refuses the question is not one. */
function isTransactionExecutionError(value: object): boolean {
  try {
    return value instanceof TransactionExecutionError;
  } catch {
    return false;
  }
}

/**
 * The FINAL rejection of a complete transaction promise, as exactly one reportable category.
 *
 * Precedence, first match wins:
 *
 *  1. a true `unknownCommit` marker — whatever the callback returned and whatever code is attached,
 *     the one thing known is that the commit's outcome is not;
 *  2. this slice's deadline marker;
 *  3. SQLSTATE `55P03` — a lock wait timed out;
 *  4. SQLSTATE `57014` — a statement was cancelled;
 *  5. SQLSTATE `40001`;
 *  6. SQLSTATE `40P01`;
 *  7. any other PostgreSQL SQLSTATE, or the shared transaction-execution error type;
 *  8. anything else.
 *
 * It reads three own data properties (`unknownCommit`, the deadline marker, `code`) and one class
 * identity. It never reads a message, SQL text, a stack or a cause, and it never serializes,
 * retains, attaches or returns what it was given: the result is one string of the closed
 * vocabulary. It decides no retry, suppresses nothing and cannot throw.
 */
export function classifySlackKnownRootPreparationFailure(error: unknown): SlackKnownRootFailureCategory {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return "dependency_failure";

  if (ownDataValue(error, "unknownCommit") === true) return "commit_unknown";
  if (ownDataValue(error, "slackKnownRootDeadlineExceeded") === true) return "deadline_exceeded";

  const code = ownDataValue(error, "code");
  if (code === "55P03") return "lock_timeout";
  if (code === "57014") return "statement_timeout";
  if (code === "40001") return "serialization_failure";
  if (code === "40P01") return "deadlock";
  if (typeof code === "string" && POSTGRES_SQLSTATE.test(code)) return "database_failure";
  if (isTransactionExecutionError(error)) return "database_failure";
  return "dependency_failure";
}

/** One terminal receipt per page slot. A callback result still awaiting its commit is not one. */
export type SlackKnownRootReceipt =
  | { readonly entryIndex: number; readonly state: "not_attempted"; readonly attempts: 0 }
  | {
      readonly entryIndex: number;
      readonly state: "committed";
      readonly attempts: 1 | 2;
      readonly result: SlackKnownRootPreparationResult;
    }
  | {
      readonly entryIndex: number;
      readonly state: "failed";
      /** Callbacks that actually ran: 0 when transaction setup failed before any did. */
      readonly attempts: 0 | 1 | 2;
      readonly failure: SlackKnownRootFailureCategory;
    };

export interface SlackKnownRootPageTallyInput {
  /** The committed page's examined count, 0–100. Its entry order defines `entryIndex`. */
  readonly examined: number;
  readonly receipts: readonly SlackKnownRootReceipt[];
}

/**
 * Counters and closed category counts only: no receipt, item id, cursor or error.
 *
 * `examined = enqueued + already_pending + not_due + unattested + refused + preparation_failed + not_attempted`.
 */
export interface SlackKnownRootPageTally {
  readonly examined: number;
  readonly enqueued: number;
  readonly already_pending: number;
  readonly not_due: number;
  readonly unattested: number;
  readonly refused: number;
  readonly preparation_failed: number;
  readonly not_attempted: number;
  readonly unattestedCounts: Readonly<Record<SlackKnownRootUnattestedReason, number>>;
  readonly refusedCounts: Readonly<Record<SlackKnownRootRefusedReason, number>>;
  readonly failureCounts: Readonly<Record<SlackKnownRootFailureCategory, number>>;
}

function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  const counts = {} as Record<K, number>;
  for (const key of keys) counts[key] = 0;
  return counts;
}

/** The largest page a tally can describe: the enumeration's own page-size ceiling. */
const MAX_EXAMINED = 100;

function invalidTally(): never {
  throw new SlackKnownRootValidationError();
}

/** A plain object — never an array, a class instance or a primitive — or null. */
function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : null;
}

/** True when the record's own keys — string and symbol, enumerable or not — are exactly these. */
function hasExactlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(record);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function isOneOf<K extends string>(vocabulary: readonly K[], value: unknown): value is K {
  return typeof value === "string" && (vocabulary as readonly string[]).includes(value);
}

/**
 * One validated terminal receipt, reduced to the only facts a tally uses, together with a canonical
 * rendering of ALL its fields. Two receipts for one slot are the same receipt exactly when their
 * renderings are equal — the same state, the same attempt count, the same result or failure.
 */
interface TerminalReceipt {
  readonly entryIndex: number;
  readonly canonical: string;
  readonly parent: "enqueued" | "already_pending" | "not_due" | "unattested" | "refused" | "preparation_failed" | "not_attempted";
  readonly unattested: SlackKnownRootUnattestedReason | null;
  readonly refused: SlackKnownRootRefusedReason | null;
  readonly failure: SlackKnownRootFailureCategory | null;
}

/** A complete closed preparation result (§6): one of five outcomes, with a reason exactly where one belongs. */
function terminalResult(value: unknown): Pick<TerminalReceipt, "parent" | "unattested" | "refused"> & { readonly rendering: string } {
  const result = plainRecord(value);
  if (result === null) return invalidTally();
  const outcome = result.outcome;
  if (outcome === "enqueued" || outcome === "already_pending" || outcome === "not_due") {
    if (!hasExactlyKeys(result, ["outcome"])) return invalidTally();
    return { parent: outcome, unattested: null, refused: null, rendering: outcome };
  }
  if (outcome === "unattested") {
    const reason = result.reason;
    if (!hasExactlyKeys(result, ["outcome", "reason"]) || !isOneOf(SLACK_KNOWN_ROOT_UNATTESTED_REASONS, reason)) return invalidTally();
    return { parent: "unattested", unattested: reason, refused: null, rendering: `unattested/${reason}` };
  }
  if (outcome === "refused") {
    const reason = result.reason;
    if (!hasExactlyKeys(result, ["outcome", "reason"]) || !isOneOf(SLACK_KNOWN_ROOT_REFUSED_REASONS, reason)) return invalidTally();
    return { parent: "refused", unattested: null, refused: reason, rendering: `refused/${reason}` };
  }
  return invalidTally();
}

/**
 * One receipt of the closed grammar (§8.2), or the static error. Each field is read once. A callback
 * result that never reached a commit, a per-attempt record, a receipt carrying anything extra — an
 * item id, an error, SQL — and every value outside its vocabulary are all refused here.
 */
function terminalReceipt(value: unknown, examined: number): TerminalReceipt {
  const receipt = plainRecord(value);
  if (receipt === null) return invalidTally();
  const entryIndex = receipt.entryIndex;
  const state = receipt.state;
  const attempts = receipt.attempts;
  if (typeof entryIndex !== "number" || !Number.isSafeInteger(entryIndex) || entryIndex < 0 || entryIndex >= examined) return invalidTally();

  if (state === "not_attempted") {
    // No preparation invocation was started for this slot.
    if (!hasExactlyKeys(receipt, ["entryIndex", "state", "attempts"]) || attempts !== 0) return invalidTally();
    return { entryIndex, canonical: "not_attempted/0", parent: "not_attempted", unattested: null, refused: null, failure: null };
  }
  if (state === "committed") {
    // The complete transaction promise resolved: at least one callback ran, at most one retry.
    if (!hasExactlyKeys(receipt, ["entryIndex", "state", "attempts", "result"]) || (attempts !== 1 && attempts !== 2)) return invalidTally();
    const result = terminalResult(receipt.result);
    return {
      entryIndex, canonical: `committed/${attempts}/${result.rendering}`, parent: result.parent,
      unattested: result.unattested, refused: result.refused, failure: null,
    };
  }
  if (state === "failed") {
    // The promise finally rejected. Zero attempts is legal: setup can fail before any callback runs.
    const failure = receipt.failure;
    if (!hasExactlyKeys(receipt, ["entryIndex", "state", "attempts", "failure"]) || (attempts !== 0 && attempts !== 1 && attempts !== 2) ||
        !isOneOf(SLACK_KNOWN_ROOT_FAILURE_CATEGORIES, failure)) return invalidTally();
    return {
      entryIndex, canonical: `failed/${attempts}/${failure}`, parent: "preparation_failed",
      unattested: null, refused: null, failure,
    };
  }
  return invalidTally();
}

/**
 * The tally of ONE successfully committed enumeration page: one contribution per page slot, after
 * every started invocation has settled.
 *
 * The whole input is validated and reduced before anything is counted. Every index `0 … examined-1`
 * must be covered. An exact duplicate of a slot's final receipt is collapsed; two different receipts
 * for one slot are a contract error, and neither is chosen. A slot is counted once however many
 * attempts its transaction took, and an unknown commit is a failure of that slot — never the
 * insertion its callback reported.
 *
 * The result holds counters and closed category counts only, in objects of its own: no receipt,
 * item id, cursor or error is retained or returned, so nothing a caller does to its input afterwards
 * can change a tally. Every invalid shape throws the same static validation error.
 */
export function tallySlackKnownRootPage(input: SlackKnownRootPageTallyInput): SlackKnownRootPageTally {
  const slots = new Map<number, TerminalReceipt>();
  let examined: number;
  try {
    const page = plainRecord(input);
    if (page === null || !hasExactlyKeys(page, ["examined", "receipts"])) return invalidTally();
    const count = page.examined;
    const receipts = page.receipts;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > MAX_EXAMINED) return invalidTally();
    if (!Array.isArray(receipts)) return invalidTally();
    // Negative zero is zero: the count is reported as it is, so it is normalized here.
    examined = count === 0 ? 0 : count;

    // No bound is placed on how many receipts an array may hold. Exact duplicates of a final receipt
    // are legal and collapse, and the accepted contract states no limit on how often one may be
    // repeated; any cap would refuse an input it defines as valid. A bound on pathologically long
    // arrays is left to explicit adjudication rather than chosen here.
    const supplied: number = receipts.length;
    for (let position = 0; position < supplied; position++) {
      const receipt = terminalReceipt(receipts[position] as unknown, examined);
      const known = slots.get(receipt.entryIndex);
      if (known === undefined) slots.set(receipt.entryIndex, receipt);
      else if (known.canonical !== receipt.canonical) return invalidTally();
    }
    // Complete accounting: a slot nobody reported is not silently "not attempted".
    if (slots.size !== examined) return invalidTally();
  } catch {
    // Whatever went wrong while reading caller data — a throwing accessor included — is the same
    // static contract error, and nothing of the input travels with it.
    return invalidTally();
  }

  const parents = { enqueued: 0, already_pending: 0, not_due: 0, unattested: 0, refused: 0, preparation_failed: 0, not_attempted: 0 };
  const unattestedCounts = zeroCounts(SLACK_KNOWN_ROOT_UNATTESTED_REASONS);
  const refusedCounts = zeroCounts(SLACK_KNOWN_ROOT_REFUSED_REASONS);
  const failureCounts = zeroCounts(SLACK_KNOWN_ROOT_FAILURE_CATEGORIES);
  for (const receipt of slots.values()) {
    parents[receipt.parent] += 1;
    if (receipt.unattested !== null) unattestedCounts[receipt.unattested] += 1;
    if (receipt.refused !== null) refusedCounts[receipt.refused] += 1;
    if (receipt.failure !== null) failureCounts[receipt.failure] += 1;
  }

  return Object.freeze({
    examined,
    ...parents,
    unattestedCounts: Object.freeze(unattestedCounts),
    refusedCounts: Object.freeze(refusedCounts),
    failureCounts: Object.freeze(failureCounts),
  });
}
