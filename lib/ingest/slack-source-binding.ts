import "server-only";
import { createHash } from "node:crypto";
import type { SqlQueryResult, TransactionSession } from "@/lib/db/types";
import { decryptSecret } from "@/lib/secrets/crypto";

/**
 * The single writer of `slack_integration_bindings` — "which Slack app and workspace does THIS
 * integration's effective token belong to, and is that answer still valid?" (AIO-1170).
 *
 * ⚠️ WHAT A VERIFIED BINDING IS, AND WHAT IT IS NOT. It is provider IDENTITY, proved by auth.test
 * and (when auth.test carried no `app_id`) by bots.info for exactly the `bot_id` auth.test returned.
 * It is not channel permission, not a publication gate, and not authorization to store anything: a
 * channel still needs its own public proof, and an item still needs the namespace gate.
 *
 * Five properties hold this module together:
 *
 *  1. IT NEVER OPENS A TRANSACTION. Every function takes the caller's `TransactionSession`, exactly
 *     like `slack-thread-state.ts` and `slack-method-budget.ts`, so a caller can compose a
 *     re-validation with its own writes atomically. What a caller must NOT do is hold that
 *     transaction open across an HTTP call — every provider request in this feature happens between
 *     transactions, never inside one.
 *  2. THE AUTHORITATIVE ROW IS READ HERE, UNDER A ROW LOCK. `getEnabledIntegrationsWithSecrets` is
 *     the right seam for picking a selection, but it deliberately returns no `updated_at`, so it
 *     cannot answer "is this still the same configuration?". `lockSlackSelection` reads
 *     status/type/config/secret/updated_at itself, `for update`, which is what serializes an
 *     acceptance against an ordinary integration edit.
 *  3. THE FINGERPRINT IS PRIVATE CACHE-VALIDITY METADATA. It exists because an ENV-token rotation
 *     leaves `integrations.updated_at` untouched and is otherwise undetectable. It is never a
 *     provider identity, a bucket key, a log line or an API field — no exported read returns it, and
 *     nothing is scoped or named by it.
 *  4. INVALIDATION COMES FIRST, ALWAYS. A changed revision or fingerprint drops every proved
 *     identity BEFORE any further source read, and re-bootstrap starts from auth.test. It does not
 *     touch channel frontiers: pages already read stay read (see `slack-channel-state.ts`), and it
 *     does not touch a method budget's durable block either — the provider bucket is still refusing
 *     whatever our config says.
 *  5. NOTHING IS SWALLOWED. A SQL failure rejects; a `stale` result can only mean the conditional
 *     update matched no row. Refusals are reported as `{ outcome: "stale" }` and NEVER as
 *     `{ ok: false }`, which `lib/db/pg/tx.ts` reads as a rollback signal.
 */

/** The env fallback `lib/ingest/run.ts` already supports, both spellings, in its order. */
export const SLACK_TOKEN_ENV_ALIASES = ["SLACK_BOT_TOKEN", "slack_bot_token"] as const;

export type SlackBootstrapState = "pending_auth" | "pending_app" | "verified" | "blocked";

/** The provider-id alphabet the Slack tables store, restated because this module has no path helper. */
const PROVIDER_ID = /^[A-Za-z0-9]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SlackSourceBindingError extends TypeError {
  constructor(message: string) {
    super(`slack source binding: ${message}`);
    this.name = "SlackSourceBindingError";
  }
}

/**
 * The effective selection: the integration row as it is RIGHT NOW, plus the token that row resolves
 * to and the two stamps a cached identity is only valid under.
 *
 * `token` is the one field whose contents are the hazard: it is never logged, never returned by an
 * exported read of stored state, and never part of a category or an error message.
 */
export interface SlackSelection {
  readonly teamId: string;
  readonly integrationId: string;
  readonly token: string;
  readonly tokenSource: "integration_secret" | "env";
  readonly tokenFingerprint: string;
  readonly configRevision: string;
  readonly channelIds: readonly string[];
  /** Config entries that are not usable Slack channel ids — reported, never silently dropped. */
  readonly rejectedChannelIds: readonly string[];
}

export type SlackSelectionRead =
  | { readonly outcome: "current"; readonly selection: SlackSelection }
  /** The row is gone, disabled, or not a Slack integration at all. No provider request may follow. */
  | { readonly outcome: "inactive"; readonly reason: "missing" | "disabled" | "wrong_type" }
  /** Neither a saved secret nor an env fallback: a blocked configuration, not a transient fault. */
  | { readonly outcome: "no_token" };

/** Identity + the two stamps every fenced write must still match. Carries no token. */
export interface SlackBindingRef {
  readonly teamId: string;
  readonly integrationId: string;
  readonly configRevision: string;
  readonly tokenFingerprint: string;
}

/** The stored binding as this module reports it — deliberately WITHOUT the token fingerprint. */
export interface SlackSourceBinding {
  readonly teamId: string;
  readonly integrationId: string;
  readonly state: SlackBootstrapState;
  readonly configRevision: string;
  readonly workspaceId: string | null;
  readonly appId: string | null;
  readonly botId: string | null;
  readonly workspaceUrl: string | null;
  readonly selectedChannelIds: readonly string[];
  readonly dueAt: string;
  readonly errorCode: string | null;
  readonly authCheckedAt: string | null;
  readonly appCheckedAt: string | null;
}

export type SlackBindingWrite =
  | { readonly outcome: "written"; readonly binding: SlackSourceBinding }
  /** The revision or the fingerprint moved while the request was in flight. Nothing was written. */
  | { readonly outcome: "stale" };

interface SelectionRow {
  status: string;
  type: string;
  config: unknown;
  secret_ciphertext: string | null;
  updated_at_utc: string;
}

interface BindingRow {
  team_id: string;
  integration_id: string;
  state: string;
  config_revision: string;
  workspace_id: string | null;
  app_id: string | null;
  bot_id: string | null;
  workspace_url: string | null;
  selected_channel_ids: string[] | null;
  due_at: Date | string;
  error_code: string | null;
  auth_checked_at: Date | string | null;
  app_checked_at: Date | string | null;
}

const BINDING_COLUMNS = `team_id, integration_id, state, config_revision, workspace_id, app_id, bot_id,
       workspace_url, selected_channel_ids, due_at, error_code, auth_checked_at, app_checked_at`;

/**
 * The fence every write shares: identity AND both cache-validity stamps. A write whose stamps no
 * longer match is a write about a configuration that no longer exists.
 */
const REF_PREDICATE = `team_id = $1 and integration_id = $2::uuid
     and config_revision = $3 and token_fingerprint = $4`;

// ── pure helpers ─────────────────────────────────────────────────────────────

/** SHA-256 of the effective token. See property 3 in the header for what this may and may not be. */
export function slackTokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function resolveEnvSlackToken(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string | null {
  for (const alias of SLACK_TOKEN_ENV_ALIASES) {
    const value = env[alias];
    // A blank variable is not a token: sending `Bearer ` is an unauthenticated request wearing a
    // credential's clothes, and the provider's refusal would read as a scope problem.
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/**
 * The channel selection, canonicalized: sorted, de-duplicated, and split from what it refuses.
 *
 * Sorted so that RE-ORDERING the same set is not a config change — an invalidation there would
 * re-run the whole bootstrap for nothing. Refusals are RETURNED rather than dropped: an id that
 * cannot be requested (or stored) must be visible as a rejected selection, because the alternative
 * is a channel that silently never syncs.
 */
export function canonicalSlackChannelIds(config: unknown): {
  selected: string[];
  rejected: string[];
} {
  const raw = (config as { channelIds?: unknown } | null)?.channelIds;
  if (!Array.isArray(raw)) return { selected: [], rejected: [] };
  const selected = new Set<string>();
  const rejected: string[] = [];
  for (const value of raw) {
    if (typeof value === "string" && PROVIDER_ID.test(value)) selected.add(value);
    else rejected.push(typeof value === "string" ? value : JSON.stringify(value));
  }
  return { selected: [...selected].sort(), rejected };
}

/**
 * The cache-validity stamp for the integration ROW: its `updated_at` (which moves on every write
 * through `lib/integrations/manage.ts`) plus the canonical selection it currently states.
 *
 * `updated_at` alone would be enough for the row, and the canonical selection alone would miss an
 * edit that changed something else; together they are the answer to "is this the configuration the
 * identity was proved under?" — the question `getEnabledIntegrationsWithSecrets` cannot answer,
 * because it does not return `updated_at` at all.
 */
export function slackConfigRevision(input: {
  updatedAt: string;
  status: string;
  type: string;
  channelIds: readonly string[];
}): string {
  const canonical = JSON.stringify([
    input.type,
    input.status,
    input.updatedAt,
    [...input.channelIds].sort(),
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ── the authoritative read ───────────────────────────────────────────────────

/**
 * Read the integration row THIS session will act on, under a short row lock, and resolve the
 * effective token exactly as `lib/ingest/run.ts` does: the saved secret first, the env fallback
 * second.
 *
 * `for update` is the point. It serializes this re-validation against an ordinary integration edit
 * (`manage.ts` writes take the same row lock), so a config change cannot land between the check and
 * the write that depends on it. The lock is released at COMMIT — and every caller's transaction here
 * is short and contains no network call, which is the other half of that contract.
 *
 * `updated_at` is rendered as UTC text in SQL rather than read as a `Date`: a `Date` round-trip
 * silently truncates microseconds, and `timestamptz::text` renders in the SESSION's time zone, which
 * would make the revision depend on who is asking.
 */
export async function lockSlackSelection(
  session: TransactionSession,
  input: { teamId: string; integrationId: string; envToken?: () => string | null }
): Promise<SlackSelectionRead> {
  assertUuid("teamId", input.teamId);
  assertUuid("integrationId", input.integrationId);

  const result = await session.executeSql<SelectionRow>(
    `select status, type, config, secret_ciphertext,
            to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at_utc
       from integrations
      where team_id = $1 and id = $2::uuid
        for update`,
    [input.teamId, input.integrationId]
  );
  const row = result.rows[0];
  if (!row) return { outcome: "inactive", reason: "missing" };
  if (row.type !== "slack") return { outcome: "inactive", reason: "wrong_type" };
  if (row.status !== "enabled") return { outcome: "inactive", reason: "disabled" };

  const saved = row.secret_ciphertext ? decryptSecret(row.secret_ciphertext) : null;
  const envToken = input.envToken ? input.envToken() : resolveEnvSlackToken();
  const token = saved ?? envToken;
  if (typeof token !== "string" || token.trim() === "") return { outcome: "no_token" };

  const { selected, rejected } = canonicalSlackChannelIds(row.config);
  return {
    outcome: "current",
    selection: {
      teamId: input.teamId,
      integrationId: input.integrationId,
      token,
      tokenSource: saved ? "integration_secret" : "env",
      tokenFingerprint: slackTokenFingerprint(token),
      configRevision: slackConfigRevision({
        updatedAt: row.updated_at_utc,
        status: row.status,
        type: row.type,
        channelIds: selected,
      }),
      channelIds: selected,
      rejectedChannelIds: rejected,
    },
  };
}

export function slackBindingRef(selection: SlackSelection): SlackBindingRef {
  return {
    teamId: selection.teamId,
    integrationId: selection.integrationId,
    configRevision: selection.configRevision,
    tokenFingerprint: selection.tokenFingerprint,
  };
}

// ── the writes ───────────────────────────────────────────────────────────────

/**
 * Ensure a binding row for the CURRENT selection, invalidating a stored identity whose revision or
 * fingerprint no longer matches.
 *
 * TWO STATEMENTS, NOT ONE UPSERT, for one reason: the caller needs to know whether an invalidation
 * HAPPENED, and a `RETURNING` clause is evaluated after the update, so it can only describe the
 * world the update just created. The conditional UPDATE reports it by matching, and it takes the row
 * lock, so a concurrent invocation for the same integration serializes behind it.
 *
 * The invalidation deliberately clears identity and error only. It does not touch channel frontiers
 * (already-read pages stay read) and it cannot touch a method budget's durable block, which belongs
 * to the provider's allowance rather than to our configuration.
 */
export async function bindSlackSelection(
  session: TransactionSession,
  selection: SlackSelection
): Promise<{ binding: SlackSourceBinding; invalidated: boolean }> {
  const invalidation = await session.executeSql(
    `update slack_integration_bindings
        set state = 'pending_auth',
            workspace_id = null,
            app_id = null,
            bot_id = null,
            workspace_url = null,
            error_code = null,
            auth_checked_at = null,
            app_checked_at = null,
            config_revision = $3,
            token_fingerprint = $4,
            due_at = clock_timestamp(),
            updated_at = clock_timestamp()
      where team_id = $1 and integration_id = $2::uuid
        and (config_revision <> $3 or token_fingerprint <> $4)`,
    [selection.teamId, selection.integrationId, selection.configRevision, selection.tokenFingerprint]
  );

  const ensured = await session.executeSql<BindingRow>(
    `insert into slack_integration_bindings
            (team_id, integration_id, config_revision, token_fingerprint, selected_channel_ids)
          values ($1, $2::uuid, $3, $4, $5::text[])
     on conflict (team_id, integration_id) do update
            set selected_channel_ids = excluded.selected_channel_ids,
                updated_at = clock_timestamp()
       returning ${BINDING_COLUMNS}`,
    [
      selection.teamId,
      selection.integrationId,
      selection.configRevision,
      selection.tokenFingerprint,
      selection.channelIds,
    ]
  );
  const row = single(ensured);
  if (!row) {
    throw new SlackSourceBindingError(
      "the binding row vanished between invalidation and ensure — refusing to report a state it does not have"
    );
  }
  return { binding: toBinding(row), invalidated: invalidation.rowCount > 0 };
}

/**
 * Persist what a successful auth.test established: the workspace, the bot it named, and the app when
 * auth.test carried one itself.
 *
 * The resulting state IS the resumption point. `pending_app` means "the workspace is proved, the
 * bots.info fallback is still owed" — so a bots.info the budget delayed is resumed on the next wake
 * WITHOUT re-running auth.test, which is the difference between finishing bootstrap under a
 * one-request-per-minute budget and never finishing it at all.
 */
export async function recordSlackWorkspaceIdentity(
  session: TransactionSession,
  ref: SlackBindingRef,
  identity: {
    workspaceId: string;
    botId: string | null;
    appId: string | null;
    workspaceUrl: string | null;
  }
): Promise<SlackBindingWrite> {
  assertProviderId("workspaceId", identity.workspaceId);
  if (identity.appId !== null) assertProviderId("appId", identity.appId);
  if (identity.botId !== null) assertProviderId("botId", identity.botId);
  // `pending_app` needs a bot to ask about; without an app id AND without a bot id there is no
  // fallback route at all, and the caller must block rather than store an unfinishable state.
  if (identity.appId === null && identity.botId === null) {
    throw new SlackSourceBindingError(
      "an auth.test with neither an app id nor a bot id cannot be bound — the caller must report it blocked"
    );
  }

  const result = await session.executeSql<BindingRow>(
    `update slack_integration_bindings
        set workspace_id = $5,
            bot_id = $6,
            app_id = $7,
            workspace_url = $8,
            state = case when $7::text is null then 'pending_app' else 'verified' end,
            error_code = null,
            auth_checked_at = clock_timestamp(),
            due_at = clock_timestamp(),
            updated_at = clock_timestamp()
      where ${REF_PREDICATE}
  returning ${BINDING_COLUMNS}`,
    [
      ref.teamId,
      ref.integrationId,
      ref.configRevision,
      ref.tokenFingerprint,
      identity.workspaceId,
      identity.botId,
      identity.appId,
      identity.workspaceUrl,
    ]
  );
  return written(result);
}

/**
 * Bind the app a validated bots.info reported. Only from `pending_app`: an app id may not be pinned
 * onto a binding that never asked for the fallback, and never onto one whose stamps have moved.
 */
export async function recordSlackAppIdentity(
  session: TransactionSession,
  ref: SlackBindingRef,
  identity: { appId: string }
): Promise<SlackBindingWrite> {
  assertProviderId("appId", identity.appId);
  const result = await session.executeSql<BindingRow>(
    `update slack_integration_bindings
        set app_id = $5,
            state = 'verified',
            error_code = null,
            app_checked_at = clock_timestamp(),
            due_at = clock_timestamp(),
            updated_at = clock_timestamp()
      where ${REF_PREDICATE}
        and state = 'pending_app'
  returning ${BINDING_COLUMNS}`,
    [ref.teamId, ref.integrationId, ref.configRevision, ref.tokenFingerprint, identity.appId]
  );
  return written(result);
}

/**
 * Record an ACTIONABLE refusal: a missing scope, a mismatched or deleted bot, a token that
 * establishes no workspace. It keeps whatever identity was already proved, because that is the
 * diagnosis, and it stores a sanitized CATEGORY — never provider text.
 *
 * There is deliberately NO retry time and no automatic recovery. A blocked binding needs an
 * operator; the fix (a new token, a corrected scope, a changed selection) moves the revision or the
 * fingerprint, and that invalidation is what returns it to `pending_auth`. Inventing a retry date
 * here would spend the budget forever on a request that cannot succeed.
 */
export async function blockSlackBinding(
  session: TransactionSession,
  ref: SlackBindingRef,
  input: { category: string }
): Promise<SlackBindingWrite> {
  const category = assertCategory(input.category);
  const result = await session.executeSql<BindingRow>(
    `update slack_integration_bindings
        set state = 'blocked',
            error_code = $5,
            updated_at = clock_timestamp()
      where ${REF_PREDICATE}
  returning ${BINDING_COLUMNS}`,
    [ref.teamId, ref.integrationId, ref.configRevision, ref.tokenFingerprint, category]
  );
  return written(result);
}

/**
 * Record a TRANSIENT delay: the category, and the deadline the provider or the budget actually
 * stated. `dueAt` is null when there is no such deadline — the DB clock is used, because the durable
 * method budget is the real gate and this column must not become a second, invented schedule.
 */
export async function delaySlackBinding(
  session: TransactionSession,
  ref: SlackBindingRef,
  input: { dueAt: Date | null; category: string }
): Promise<SlackBindingWrite> {
  const category = assertCategory(input.category);
  if (input.dueAt !== null && (!(input.dueAt instanceof Date) || Number.isNaN(input.dueAt.getTime()))) {
    throw new SlackSourceBindingError("dueAt must be a valid Date or null");
  }
  const result = await session.executeSql<BindingRow>(
    `update slack_integration_bindings
        set error_code = $5,
            due_at = coalesce($6::timestamptz, clock_timestamp()),
            updated_at = clock_timestamp()
      where ${REF_PREDICATE}
  returning ${BINDING_COLUMNS}`,
    [ref.teamId, ref.integrationId, ref.configRevision, ref.tokenFingerprint, category, input.dueAt]
  );
  return written(result);
}

export async function readSlackBinding(
  session: TransactionSession,
  input: { teamId: string; integrationId: string }
): Promise<SlackSourceBinding | null> {
  const result = await session.executeSql<BindingRow>(
    `select ${BINDING_COLUMNS} from slack_integration_bindings
      where team_id = $1 and integration_id = $2::uuid`,
    [input.teamId, input.integrationId]
  );
  const row = single(result);
  return row ? toBinding(row) : null;
}

// ── codecs ───────────────────────────────────────────────────────────────────

function written(result: SqlQueryResult<BindingRow>): SlackBindingWrite {
  const row = single(result);
  return row ? { outcome: "written", binding: toBinding(row) } : { outcome: "stale" };
}

function toBinding(row: BindingRow): SlackSourceBinding {
  if (row.state !== "pending_auth" && row.state !== "pending_app" && row.state !== "verified" && row.state !== "blocked") {
    throw new SlackSourceBindingError(`unknown stored state ${JSON.stringify(row.state)}`);
  }
  return {
    teamId: row.team_id,
    integrationId: row.integration_id,
    state: row.state,
    configRevision: row.config_revision,
    workspaceId: row.workspace_id,
    appId: row.app_id,
    botId: row.bot_id,
    workspaceUrl: row.workspace_url,
    selectedChannelIds: row.selected_channel_ids ?? [],
    dueAt: instant(row.due_at),
    errorCode: row.error_code,
    authCheckedAt: row.auth_checked_at === null ? null : instant(row.auth_checked_at),
    appCheckedAt: row.app_checked_at === null ? null : instant(row.app_checked_at),
  };
}

function single<T>(result: SqlQueryResult<T>): T | undefined {
  if (result.rows.length > 1) {
    throw new SlackSourceBindingError(`expected at most one row, got ${result.rows.length}`);
  }
  return result.rows[0];
}

function instant(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new SlackSourceBindingError(`unreadable timestamp from the database (${String(value)})`);
  }
  return date.toISOString();
}

function assertUuid(field: string, value: unknown): void {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new SlackSourceBindingError(`${field} must be a UUID (got ${JSON.stringify(value)})`);
  }
}

function assertProviderId(field: string, value: unknown): void {
  if (typeof value !== "string" || !PROVIDER_ID.test(value)) {
    throw new SlackSourceBindingError(
      `${field} must be a Slack provider id matching ${PROVIDER_ID.source} (got ${JSON.stringify(value)})`
    );
  }
}

/**
 * A sanitized failure CATEGORY. Like `slack-thread-state.assertErrorCode`, the message is STATIC and
 * never quotes what it refused: the rejected value is the exact string suspected of carrying a
 * provider message or a token, and quoting it would copy that into the throw, the log and the crash
 * report — the leak this rule exists to prevent, taking the scenic route.
 */
function assertCategory(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(value)) {
    throw new SlackSourceBindingError(
      "category must be a sanitized lower-case failure code matching ^[a-z][a-z0-9_]{0,39}$ — never " +
        "a provider message, a token or free text. The rejected value is deliberately omitted."
    );
  }
  return value;
}
