import "server-only";
import type { DbClient, TransactionSession } from "@/lib/db/types";
import { runContextTransaction } from "@/lib/projects/context/transaction";
import type { SlackBudgetedMethod, SlackMethodScope } from "@/lib/ingest/slack-method-budget";
import {
  slackReservedRequest,
  type SlackPage,
  type SlackRequestResult,
} from "@/lib/ingest/sources/slack-page-request";
import { parseSlackTimestamp } from "@/lib/ingest/sources/slack-message-evidence";
import { enqueueSlackThread } from "@/lib/ingest/slack-thread-state";
import {
  acceptSlackChannelPage,
  claimSlackChannelPage,
  delaySlackChannel,
  dueSlackChannels,
  ensureSlackChannel,
  lockSlackChannelForAcceptance,
  olderSlackTs,
  recordSlackChannelPublicState,
  releaseSlackChannelForRetry,
  restartSlackChannelScan,
  SLACK_CHANNEL_METADATA_TTL_MS,
  type SlackChannelClaim,
  type SlackChannelState,
} from "@/lib/ingest/slack-channel-state";
import {
  bindSlackSelection,
  blockSlackBinding,
  delaySlackBinding,
  lockSlackSelection,
  recordSlackAppIdentity,
  recordSlackWorkspaceIdentity,
  slackBindingRef,
  type SlackBindingRef,
  type SlackSelection,
  type SlackSourceBinding,
} from "@/lib/ingest/slack-source-binding";

/**
 * ONE bounded pass of internal Slack SOURCE DISCOVERY for one integration (AIO-1170):
 *
 *   current integration row + effective token
 *     → resumable app-identity bootstrap (auth.test, then bots.info when auth.test carried no app)
 *     → one channel's public proof
 *     → ONE budgeted history page
 *     → its roots and its frontier, in one commit.
 *
 * ⚠️ NOTHING CALLS THIS YET, and that is enforced by `test/guards/slack-source-not-wired.test.ts`.
 * It performs real provider requests with a real token, while the slice around it is deliberately
 * incomplete: no item is published, no namespace is migrated, no identity is credited, no capacity
 * gate has been certified. Wiring it into `run.ts`, the scheduler, manual sync or an admin action is
 * the deliberate act that activation requires.
 *
 * Six properties hold this entrypoint together:
 *
 *  1. IT RESOLVES ITS OWN AUTHORITY. The caller passes a team and an integration id — never a
 *     workspace, an app, a token or a "this channel is public" flag. Every one of those is read from
 *     the persisted integration row, or proved by a provider response, inside this pass. A caller
 *     that could assert them would be the authorization hole this whole packet exists to close.
 *  2. NO DB TRANSACTION CROSSES THE NETWORK. Each provider request sits BETWEEN two short
 *     transactions: one that reserves/claims and commits, one that re-validates and writes. The
 *     integration row lock is held only inside those, never across a round trip.
 *  3. THE WORLD IS RE-CHECKED AFTER EVERY REQUEST. The response that comes back is applied only if
 *     the config revision, the effective-token fingerprint and (for a page) the channel's whole lease
 *     fence still hold. Otherwise it is dropped: no roots, no cursor, no proof.
 *  4. THE ROOTS AND THE FRONTIER ARE ONE COMMIT, in that order, behind a row lock taken first. A
 *     refusal is therefore detected BEFORE anything is enqueued, and any SQL failure rolls back both.
 *  5. DISCOVERY IS STRUCTURAL. Every top-level message becomes pending work — tombstoned, text-less,
 *     bot-authored, reply-less. Eligibility is a publication question, and applying it here would
 *     silently delete work while certifying the interval it was found in.
 *  6. A REQUEST IS NEVER REFUNDED, AND NEVER FABRICATED. The durable method budget is the only gate
 *     on provider load; this module reads its verdicts and never clears a durable block, never
 *     invents a retry time, and never retries inside a wake.
 */

/** The default per-invocation request ceiling: auth.test, bots.info, conversations.info, one page. */
export const SLACK_DISCOVERY_MAX_REQUESTS = 4;

export interface SlackSourceDiscoveryInput {
  readonly db: DbClient;
  readonly teamId: string;
  readonly integrationId: string;
}

export interface SlackSourceDiscoveryOptions {
  /** Injectable transport, per the existing connector convention. */
  readonly fetchImpl?: typeof fetch;
  /**
   * The env-token fallback, as a RUNTIME resolver: an env rotation leaves `integrations.updated_at`
   * untouched, so the effective token is resolved (and fingerprinted) on every invocation.
   */
  readonly envToken?: () => string | null;
  readonly maxRequests?: number;
  readonly leaseMs?: number;
}

export type SlackDiscoveryStage = "selection" | "auth" | "app" | "metadata" | "history";

export type SlackDiscoveryStepResult =
  | "ok"
  | "deferred"
  | "delayed"
  | "blocked"
  | "refused"
  | "inactive"
  | "skipped";

export interface SlackDiscoveryStep {
  readonly stage: SlackDiscoveryStage;
  readonly method?: SlackBudgetedMethod;
  readonly result: SlackDiscoveryStepResult;
  /** A sanitized category — never provider text, a token or a header. */
  readonly category?: string;
  /** A STATIC operator-facing sentence. Written here, never assembled from a provider response. */
  readonly detail?: string;
  readonly channelId?: string;
  /** Only ever a deadline something actually persisted; never one this module invented. */
  readonly nextPermittedAt?: string;
}

/** The binding as a caller may see it — deliberately WITHOUT the effective-token fingerprint. */
export interface SlackBindingSummary {
  readonly state: SlackSourceBinding["state"];
  readonly workspaceId: string | null;
  readonly appId: string | null;
  readonly botId: string | null;
  readonly workspaceUrl: string | null;
  readonly selectedChannelIds: readonly string[];
  readonly errorCode: string | null;
}

export interface SlackSourceDiscoveryResult {
  readonly outcome: "progressed" | "blocked" | "deferred" | "inactive" | "idle";
  readonly steps: readonly SlackDiscoveryStep[];
  readonly binding: SlackBindingSummary | null;
}

// ── pure: what a history page is allowed to certify ──────────────────────────

export type SlackHistoryPageValidation =
  | {
      readonly ok: true;
      readonly roots: readonly string[];
      readonly oldestTs: string | null;
      readonly hasMore: boolean;
      readonly nextCursor: string | null;
    }
  | {
      readonly ok: false;
      readonly category: "malformed_page" | "malformed_timestamp" | "pagination_incomplete" | "cursor_repeated";
    };

/**
 * Read one `conversations.history` page, or refuse the WHOLE of it.
 *
 * Refusing wholesale is the point. A page whose paging cannot be continued, or that contains one
 * message we cannot place in time, is not "mostly fine": enqueueing its readable half while
 * certifying the interval it came from is precisely how a real thread disappears inside a range we
 * later claim to have read completely.
 *
 * Root-ness is `!thread_ts || thread_ts === ts` — the same rule as `fetchSlackChannel`'s
 * `isTopLevel`, deliberately unchanged, and with NO content filter after it.
 */
export function validateSlackHistoryPage(
  page: SlackPage,
  opts: { sentCursor: string | null }
): SlackHistoryPageValidation {
  // ABSENT is not `[]`. The transport preserves that difference exactly so that a response which
  // never mentioned messages cannot be read here as an empty range we may certify.
  if (!Array.isArray(page.messages)) return { ok: false, category: "malformed_page" };
  if (page.hasMore && page.nextCursor === null) return { ok: false, category: "pagination_incomplete" };
  if (page.nextCursor !== null && page.nextCursor === opts.sentCursor) {
    return { ok: false, category: "cursor_repeated" };
  }

  const roots: string[] = [];
  let oldestTs: string | null = null;
  for (const message of page.messages) {
    const ts = (message as { ts?: unknown } | null)?.ts;
    if (typeof ts !== "string" || !parseSlackTimestamp(ts)) {
      return { ok: false, category: "malformed_timestamp" };
    }
    const threadTs = (message as { thread_ts?: unknown }).thread_ts;
    if (threadTs !== undefined && (typeof threadTs !== "string" || !parseSlackTimestamp(threadTs))) {
      return { ok: false, category: "malformed_timestamp" };
    }
    oldestTs = olderSlackTs(oldestTs, ts);
    if (threadTs === undefined || threadTs === ts) roots.push(ts);
  }
  return { ok: true, roots, oldestTs, hasMore: page.hasMore, nextCursor: page.nextCursor };
}

// ── pure: what a transport outcome means to a source ─────────────────────────

export type SlackCallDisposition =
  | { readonly kind: "ok"; readonly body: Record<string, unknown>; readonly page: SlackPage }
  /** The local budget refused. Its deadline is a persisted fact, so it is carried. */
  | { readonly kind: "deferred"; readonly category: string; readonly nextPermittedAt: string }
  /** Worth trying again later; a stated deadline is carried only when one exists. */
  | { readonly kind: "transient"; readonly category: string; readonly nextPermittedAt?: string }
  /** Needs an operator: the credential, its scopes, or a durable provider block. */
  | { readonly kind: "blocked"; readonly category: string }
  /** The provider answered and said no about THIS request. What that means is the caller's call. */
  | { readonly kind: "refused"; readonly category: string };

/** Provider codes that are a passing fault rather than a stated refusal. */
const TRANSIENT_PROVIDER_ERRORS = new Set([
  "ratelimited",
  "internal_error",
  "service_unavailable",
  "fatal_error",
  "request_timeout",
]);

/**
 * Every transport outcome, mapped to what a source may do about it. Exhaustive by construction: the
 * switch has no default, so a new outcome added to `SlackRequestResult` fails the type-check here
 * rather than falling into a silent "treat as transient".
 *
 * ⚠️ `blocked` STAYS BLOCKED. It is the request layer's durable marker on a shared provider bucket —
 * no deadline, no near-term retry, and never cleared by a token or config change on our side, since
 * the same provider allowance is still refusing. This module therefore neither re-marks it (the
 * transport already committed it) nor gives it a retry time on the way out.
 */
export function classifySlackCall(result: SlackRequestResult): SlackCallDisposition {
  switch (result.outcome) {
    case "ok":
      return { kind: "ok", body: result.body, page: result.page };
    case "deferred":
      return { kind: "deferred", category: "budget_deferred", nextPermittedAt: result.nextPermittedAt };
    case "rate_limited":
      return { kind: "transient", category: result.category, nextPermittedAt: result.nextPermittedAt };
    case "blocked":
      return { kind: "blocked", category: result.category };
    case "auth_error":
      return { kind: "blocked", category: result.category };
    case "transport_error":
      return { kind: "transient", category: result.category };
    case "provider_error":
      return TRANSIENT_PROVIDER_ERRORS.has(result.category)
        ? { kind: "transient", category: result.category }
        : { kind: "refused", category: result.category };
  }
}

// ── the pass ─────────────────────────────────────────────────────────────────

interface Pass {
  readonly input: SlackSourceDiscoveryInput;
  readonly options: SlackSourceDiscoveryOptions;
  readonly steps: SlackDiscoveryStep[];
  remaining: number;
}

/**
 * Run one bounded discovery pass.
 *
 * The selection gate is `lockSlackSelection`, not `getEnabledIntegrationsWithSecrets`: the latter is
 * the right seam for LISTING a team's connectors, but it returns no `updated_at` (so it cannot say
 * whether the configuration still matches a cached identity) and it decrypts every connector secret
 * the team has, when this pass needs exactly one. The locked read answers both questions with one
 * statement and one decryption, and the lock is what serializes this pass against an integration edit.
 */
export async function discoverSlackSource(
  input: SlackSourceDiscoveryInput,
  options: SlackSourceDiscoveryOptions = {}
): Promise<SlackSourceDiscoveryResult> {
  const pass: Pass = {
    input,
    options,
    steps: [],
    remaining: options.maxRequests ?? SLACK_DISCOVERY_MAX_REQUESTS,
  };

  // The FIRST short transaction: read the authoritative row under its lock, resolve the effective
  // token, and invalidate any cached identity whose configuration or token has moved. Everything
  // after this line acts on a selection that was current as of a committed read.
  const opened = await runContextTransaction(input.db, async (session) => {
    const read = await lockSlackSelection(session, {
      teamId: input.teamId,
      integrationId: input.integrationId,
      envToken: options.envToken,
    });
    if (read.outcome === "inactive") return { outcome: "inactive" as const, reason: read.reason };
    if (read.outcome === "no_token") return { outcome: "no_token" as const };
    const bound = await bindSlackSelection(session, read.selection);
    return { outcome: "current" as const, selection: read.selection, binding: bound.binding };
  });

  if (opened.outcome === "inactive") {
    step(pass, {
      stage: "selection",
      result: "inactive",
      category: `integration_${opened.reason}`,
      detail: "This integration is not an enabled Slack connector; no provider request was made.",
    });
    return finish(pass, null);
  }
  if (opened.outcome === "no_token") {
    step(pass, {
      stage: "selection",
      result: "blocked",
      category: "no_token",
      detail: "No bot token: paste one in the dashboard or set SLACK_BOT_TOKEN.",
    });
    return finish(pass, null);
  }

  const selection = opened.selection;
  const ref = slackBindingRef(selection);
  let binding = opened.binding;
  if (selection.rejectedChannelIds.length > 0) {
    step(pass, {
      stage: "selection",
      result: "skipped",
      category: "unusable_channel_id",
      detail: "Some selected entries are not Slack channel ids and were not synced.",
    });
  }

  binding = await bootstrap(pass, selection, ref, binding);
  // The ONE gate on every channel read: a bound app and a bound workspace, both proved in this pass
  // or in an earlier one under these exact stamps. There is no other way past this line.
  if (binding.state !== "verified" || binding.workspaceId === null || binding.appId === null) {
    return finish(pass, binding);
  }
  const bound: SlackVerifiedIdentity = { workspaceId: binding.workspaceId, appId: binding.appId };

  await proveChannel(pass, selection, ref, bound);
  await readOnePage(pass, selection, ref, bound);
  return finish(pass, binding);
}

/** The workspace + app a verified-scope request is metered under. Carried explicitly, never global. */
interface SlackVerifiedIdentity {
  readonly workspaceId: string;
  readonly appId: string;
}

// ── bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap(
  pass: Pass,
  selection: SlackSelection,
  ref: SlackBindingRef,
  current: SlackSourceBinding
): Promise<SlackSourceBinding> {
  let binding = current;

  if (binding.state === "blocked") {
    step(pass, {
      stage: binding.workspaceId === null ? "auth" : "app",
      result: "blocked",
      category: binding.errorCode ?? "blocked",
      detail:
        "App identity is blocked for this integration. It is re-attempted when the token or the " +
        "channel selection changes; nothing is retried on a timer.",
    });
    return binding;
  }

  if (binding.state === "pending_auth") {
    const scope: SlackMethodScope = {
      kind: "provisional",
      teamId: selection.teamId,
      integrationId: selection.integrationId,
    };
    const call = await request(pass, "auth", selection, scope, "auth.test", {});
    if (!call) return binding;
    if (call.kind !== "ok") {
      await reportBindingFailure(pass, "auth", "auth.test", ref, call, selection);
      return binding;
    }
    const identity = readAuthTest(call.body);
    if (!identity.ok) {
      const refused = await write(pass, selection, ref, (session, r) =>
        blockSlackBinding(session, r, { category: identity.category })
      );
      if (refused.outcome === "written") binding = refused.binding;
      step(pass, {
        stage: "auth",
        method: "auth.test",
        result: "blocked",
        category: identity.category,
        detail: identity.detail,
      });
      return binding;
    }
    const written = await write(pass, selection, ref, (session, r) =>
      recordSlackWorkspaceIdentity(session, r, identity.value)
    );
    if (written.outcome !== "written") {
      step(pass, { stage: "auth", method: "auth.test", result: "refused", category: "binding_changed" });
      return binding;
    }
    binding = written.binding;
    step(pass, { stage: "auth", method: "auth.test", result: "ok" });
  }

  const workspaceId = binding.workspaceId;
  const botId = binding.botId;
  if (binding.state === "pending_app" && workspaceId !== null && botId !== null) {
    // ⚠️ THE BOOTSTRAP BUCKET, NOT THE VERIFIED ONE. One `bots.info` allowance per workspace, shared
    // across every integration and app in it — the budget refuses this method under any other scope.
    const scope: SlackMethodScope = {
      kind: "workspace_bootstrap",
      teamId: selection.teamId,
      workspaceId,
    };
    // EXACTLY the bot auth.test named, never a value derived from the token.
    const call = await request(pass, "app", selection, scope, "bots.info", { bot: botId });
    if (!call) return binding;
    if (call.kind !== "ok") {
      await reportBindingFailure(pass, "app", "bots.info", ref, call, selection);
      return binding;
    }
    const app = readBotsInfo(call.body, botId);
    if (!app.ok) {
      const refused = await write(pass, selection, ref, (session, r) =>
        blockSlackBinding(session, r, { category: app.category })
      );
      if (refused.outcome === "written") binding = refused.binding;
      step(pass, { stage: "app", method: "bots.info", result: "blocked", category: app.category, detail: app.detail });
      return binding;
    }
    const written = await write(pass, selection, ref, (session, r) =>
      recordSlackAppIdentity(session, r, { appId: app.appId })
    );
    if (written.outcome !== "written") {
      step(pass, { stage: "app", method: "bots.info", result: "refused", category: "binding_changed" });
      return binding;
    }
    binding = written.binding;
    step(pass, { stage: "app", method: "bots.info", result: "ok" });
  }

  return binding;
}

type AuthIdentity =
  | {
      ok: true;
      value: { workspaceId: string; botId: string | null; appId: string | null; workspaceUrl: string | null };
    }
  | { ok: false; category: string; detail: string };

/**
 * What a successful auth.test established — and nothing it did not.
 *
 * `team_id` is the workspace and is REQUIRED: without it there is no scope to key anything on.
 * `app_id` is optional and authoritative when present. `bot_id` is the exact value bots.info will be
 * asked about; with neither an app nor a bot there is no route to an app identity at all, which is a
 * blocked configuration (a user token, typically) rather than something to retry. No id is ever
 * derived from the token's bytes or its prefix.
 */
function readAuthTest(body: Record<string, unknown>): AuthIdentity {
  const workspaceId = providerId(body.team_id);
  if (workspaceId === null) {
    return {
      ok: false,
      category: "missing_workspace_id",
      detail: "auth.test returned no usable workspace id; the token cannot be bound to a workspace.",
    };
  }
  const appId = body.app_id === undefined || body.app_id === null ? null : providerId(body.app_id);
  if (body.app_id !== undefined && body.app_id !== null && appId === null) {
    return { ok: false, category: "invalid_app_id", detail: "auth.test returned an unusable app id." };
  }
  const botId = body.bot_id === undefined || body.bot_id === null ? null : providerId(body.bot_id);
  if (appId === null && botId === null) {
    return {
      ok: false,
      category: "missing_bot_identity",
      detail:
        "auth.test returned neither an app id nor a bot id. Slack ingestion expects a BOT token; a " +
        "user token has no app identity to bind.",
    };
  }
  return { ok: true, value: { workspaceId, botId, appId, workspaceUrl: httpsUrl(body.url) } };
}

type AppIdentity = { ok: true; appId: string } | { ok: false; category: string; detail: string };

/** bots.info, validated against the bot auth.test named. Every mismatch is fail-closed. */
function readBotsInfo(body: Record<string, unknown>, expectedBotId: string): AppIdentity {
  const bot = body.bot;
  if (!bot || typeof bot !== "object") {
    return { ok: false, category: "malformed_bot", detail: "bots.info returned no bot object." };
  }
  const record = bot as Record<string, unknown>;
  if (providerId(record.id) !== expectedBotId) {
    return {
      ok: false,
      category: "bot_mismatch",
      detail: "bots.info described a different bot than auth.test named; nothing was bound.",
    };
  }
  if (record.deleted === true) {
    return { ok: false, category: "bot_deleted", detail: "The bot this token belongs to is deleted." };
  }
  const appId = providerId(record.app_id);
  if (appId === null) {
    return {
      ok: false,
      category: "missing_app_id",
      detail: "bots.info returned no usable app id, so no app identity could be bound.",
    };
  }
  return { ok: true, appId };
}

// ── channel metadata ─────────────────────────────────────────────────────────

/** Prove at most ONE due channel public per pass; the shared `conversations.info` budget is 1/min. */
async function proveChannel(
  pass: Pass,
  selection: SlackSelection,
  ref: SlackBindingRef,
  bound: SlackVerifiedIdentity
): Promise<void> {
  const states = await runContextTransaction(pass.input.db, async (session) => {
    for (const channelId of selection.channelIds) {
      await ensureSlackChannel(session, {
        teamId: selection.teamId,
        workspaceId: bound.workspaceId,
        channelId,
      });
    }
    return dueSlackChannels(session, {
      teamId: selection.teamId,
      workspaceId: bound.workspaceId,
      channelIds: selection.channelIds,
    });
  });

  const now = Date.now();
  const target = states.find((state) => needsPublicProof(state, ref, now));
  if (!target) return;

  const scope = verifiedScope(selection, bound);
  const channelId = target.scope.channelId;
  const call = await request(pass, "metadata", selection, scope, "conversations.info", {
    channel: channelId,
  });
  if (!call) return;

  if (call.kind === "transient" || call.kind === "deferred") {
    // ⚠️ A BLIP IS NOT EVIDENCE. The last valid proof is the best information there is, so nothing
    // about the public state is written — only the category and the deadline something stated.
    await runContextTransaction(pass.input.db, (session) =>
      delaySlackChannel(session, target.scope, {
        dueAt: deadline(call),
        errorCode: sanitize(call.category),
      })
    );
    step(pass, {
      stage: "metadata",
      method: "conversations.info",
      result: call.kind === "deferred" ? "deferred" : "delayed",
      category: call.category,
      channelId,
      ...(deadlineIso(call) ? { nextPermittedAt: deadlineIso(call) as string } : {}),
    });
    return;
  }

  const verdict = call.kind === "ok" ? readChannelInfo(call.body, channelId) : refusedChannel(call.category);
  const written = await runContextTransaction(pass.input.db, async (session) => {
    const read = await lockSlackSelection(session, {
      teamId: selection.teamId,
      integrationId: selection.integrationId,
      envToken: pass.options.envToken,
    });
    if (read.outcome !== "current" || !sameSelection(read.selection, ref)) return { outcome: "refused" as const };
    return recordSlackChannelPublicState(
      session,
      target.scope,
      { integrationId: selection.integrationId, configRevision: ref.configRevision },
      { publicState: verdict.state, errorCode: verdict.state === "public" ? null : verdict.category }
    );
  });
  if (written.outcome !== "written") {
    step(pass, { stage: "metadata", method: "conversations.info", result: "refused", category: "binding_changed", channelId });
    return;
  }
  step(pass, {
    stage: "metadata",
    method: "conversations.info",
    result: verdict.state === "public" ? "ok" : "blocked",
    ...(verdict.state === "public" ? {} : { category: verdict.category, detail: verdict.detail }),
    channelId,
  });
}

/**
 * A proof is re-checked when there is none, when it was made under a configuration or token that no
 * longer applies, or when it is older than the metadata TTL. It is NOT re-checked every wake: a
 * 15-second re-verification would spend the whole `conversations.info` allowance re-proving what we
 * already know, and that allowance is shared with interactive channel validation.
 */
function needsPublicProof(state: SlackChannelState, ref: SlackBindingRef, now: number): boolean {
  if (state.publicState === "unknown") return true;
  if (state.bindingIntegrationId !== ref.integrationId) return true;
  if (state.bindingConfigRevision !== ref.configRevision) return true;
  if (state.publicCheckedAt === null) return true;
  return Date.parse(state.publicCheckedAt) <= now - SLACK_CHANNEL_METADATA_TTL_MS;
}

interface ChannelVerdict {
  state: "public" | "private" | "unverifiable";
  category: string;
  detail: string;
}

/**
 * The public verdict, from a validated `conversations.info` response only.
 *
 * The brain ingests channels that are PUBLIC in the workspace, so anything else is a definitive
 * refusal rather than a retry: a private channel, a DM/group DM, a response describing a different
 * channel, or a response we cannot read. None of them purges anything here — this slice only stops
 * reading further.
 */
function readChannelInfo(body: Record<string, unknown>, channelId: string): ChannelVerdict {
  const channel = body.channel;
  if (!channel || typeof channel !== "object") {
    return { state: "unverifiable", category: "malformed_channel", detail: "conversations.info returned no channel." };
  }
  const record = channel as Record<string, unknown>;
  if (record.id !== channelId) {
    return {
      state: "unverifiable",
      category: "channel_identity_mismatch",
      detail: "conversations.info described a different channel than the one asked about.",
    };
  }
  if (record.is_private === true || record.is_im === true || record.is_mpim === true) {
    return {
      state: "private",
      category: "channel_private",
      detail:
        "This channel is private or a DM. The brain only syncs channels that are public in the " +
        "workspace; remove it from this integration.",
    };
  }
  if (record.is_channel !== true || record.is_private !== false) {
    return {
      state: "unverifiable",
      category: "channel_unverifiable",
      detail: "conversations.info did not establish that this channel is public in the workspace.",
    };
  }
  return { state: "public", category: "channel_public", detail: "" };
}

/** A stated provider refusal about the channel — reachability or permission, not a bad credential. */
function refusedChannel(category: string): ChannelVerdict {
  return {
    state: "unverifiable",
    category: sanitize(category),
    detail:
      "Slack would not describe this channel to this token, so it cannot be established as public. " +
      "Check the bot's channels:read scope and its membership.",
  };
}

// ── one history page ─────────────────────────────────────────────────────────

async function readOnePage(
  pass: Pass,
  selection: SlackSelection,
  ref: SlackBindingRef,
  bound: SlackVerifiedIdentity
): Promise<void> {
  // Re-read AFTER the metadata step: the channel it just proved public is not public in a snapshot
  // taken before it ran, and that channel is usually the one this page belongs to.
  const states = await runContextTransaction(pass.input.db, (session) =>
    dueSlackChannels(session, {
      teamId: selection.teamId,
      workspaceId: bound.workspaceId,
      channelIds: selection.channelIds,
    })
  );

  for (const state of states) {
    if (state.publicState !== "public") continue;
    if (state.bindingConfigRevision !== ref.configRevision) continue;
    if (state.bindingIntegrationId !== ref.integrationId) continue;

    const claim = await runContextTransaction(pass.input.db, async (session) => {
      const read = await lockSlackSelection(session, {
        teamId: selection.teamId,
        integrationId: selection.integrationId,
        envToken: pass.options.envToken,
      });
      if (read.outcome !== "current" || !sameSelection(read.selection, ref)) return null;
      return claimSlackChannelPage(session, state.scope, {
        bindingIntegrationId: selection.integrationId,
        bindingConfigRevision: ref.configRevision,
        ...(pass.options.leaseMs === undefined ? {} : { leaseMs: pass.options.leaseMs }),
      });
    });
    // Not due, or somebody else's live claim: try the next channel, in `(due_at, channel_id)` order.
    if (!claim) continue;

    await fetchAndAccept(pass, selection, ref, bound, claim);
    return;
  }
}

async function fetchAndAccept(
  pass: Pass,
  selection: SlackSelection,
  ref: SlackBindingRef,
  bound: SlackVerifiedIdentity,
  claim: SlackChannelClaim
): Promise<void> {
  const channelId = claim.scope.channelId;
  const params: Record<string, string> = {
    channel: channelId,
    latest: claim.anchorTs,
    // INCLUSIVE, so a catch-up scan re-reads the message on its lower boundary. The duplicate root
    // is deduplicated by the exact-key thread enqueue; trimming the seam is what loses a thread.
    inclusive: "true",
    ...(claim.lowerTs === null ? {} : { oldest: claim.lowerTs }),
    ...(claim.cursor === null ? {} : { cursor: claim.cursor }),
  };
  const scope = verifiedScope(selection, bound);
  const call = await request(pass, "history", selection, scope, "conversations.history", params, claim);
  if (!call) return;

  if (call.kind !== "ok") {
    // `invalid_cursor` is the one refusal with its own repair: the SAME anchored scan restarts with
    // a fresh generation and no cursor, and the certified interval is untouched — a cursor the
    // provider forgot says nothing about the pages already read.
    const restart = call.kind === "refused" && call.category === "invalid_cursor";
    await runContextTransaction(pass.input.db, (session) =>
      restart
        ? restartSlackChannelScan(session, claim, { errorCode: sanitize(call.category) })
        : releaseSlackChannelForRetry(session, claim, {
            nextDueAt: deadline(call),
            errorCode: sanitize(call.category),
          })
    );
    step(pass, {
      stage: "history",
      method: "conversations.history",
      result: call.kind === "deferred" ? "deferred" : call.kind === "blocked" ? "blocked" : "delayed",
      category: call.category,
      channelId,
      ...(deadlineIso(call) ? { nextPermittedAt: deadlineIso(call) as string } : {}),
    });
    return;
  }

  const page = validateSlackHistoryPage(call.page, { sentCursor: claim.cursor });
  if (!page.ok) {
    await runContextTransaction(pass.input.db, (session) =>
      releaseSlackChannelForRetry(session, claim, { nextDueAt: null, errorCode: page.category })
    );
    step(pass, {
      stage: "history",
      method: "conversations.history",
      result: "delayed",
      category: page.category,
      channelId,
      detail: "The page could not be read in full, so nothing from it was enqueued or certified.",
    });
    return;
  }

  // A SEED scan is one page by definition: it has no certified top to catch up from, so what it
  // certifies is the span this page covered and everything older belongs to the historical lane.
  const terminal = !page.hasMore || (claim.lane === "newest" && claim.lowerTs === null);

  const accepted = await runContextTransaction(pass.input.db, async (session) => {
    // LOCK ORDER: the integration row first, then the channel row — the same order everywhere, so
    // two passes can never take them in opposite orders and deadlock.
    const read = await lockSlackSelection(session, {
      teamId: selection.teamId,
      integrationId: selection.integrationId,
      envToken: pass.options.envToken,
    });
    if (read.outcome !== "current" || !sameSelection(read.selection, ref)) {
      return { outcome: "stale" as const };
    }
    const locked = await lockSlackChannelForAcceptance(session, claim);
    if (locked.outcome === "refused") return { outcome: "refused" as const };

    // Verified FIRST, then enqueued, then advanced — and all three in this one commit. A refusal
    // discovered after the enqueues could not un-write them, because returning a refusal COMMITS.
    for (const rootTs of page.roots) {
      await enqueueSlackThread(session, { ...claim.scope, rootTs });
    }
    const advanced = await acceptSlackChannelPage(session, claim, {
      terminal,
      nextCursor: page.nextCursor,
      oldestTs: page.oldestTs,
    });
    if (advanced.outcome !== "written") {
      // Unreachable while the row lock above is held. THROWN rather than returned: a returned
      // refusal would commit the roots this transaction just enqueued for a frontier that never moved.
      throw new Error("slack source discovery: the frontier refused a write made under its own row lock");
    }
    return { outcome: "accepted" as const };
  });

  if (accepted.outcome === "accepted") {
    step(pass, { stage: "history", method: "conversations.history", result: "ok", channelId });
    return;
  }
  if (accepted.outcome === "stale") {
    // The fence still matches (only the BINDING moved), so the lease is handed back immediately
    // rather than left to expire — with nothing enqueued and nothing advanced.
    await runContextTransaction(pass.input.db, (session) =>
      releaseSlackChannelForRetry(session, claim, { nextDueAt: null, errorCode: "binding_changed" })
    );
  }
  step(pass, {
    stage: "history",
    method: "conversations.history",
    result: "refused",
    category: accepted.outcome === "stale" ? "binding_changed" : "stale_channel_lease",
    channelId,
    detail: "The world changed while the page was in flight; no root was queued and no cursor moved.",
  });
}

// ── plumbing ─────────────────────────────────────────────────────────────────

/**
 * One reserved provider request, or `null` when this pass has spent its request allowance.
 *
 * The per-invocation ceiling is a WAKE budget, not a rate limit: a wake runs under an HTTP deadline,
 * and the durable per-method budget — which is the cross-process one — remains the only thing that
 * decides whether the provider may be called at all.
 */
async function request(
  pass: Pass,
  stage: SlackDiscoveryStage,
  selection: SlackSelection,
  scope: SlackMethodScope,
  method: SlackBudgetedMethod,
  params: Record<string, string>,
  claim?: SlackChannelClaim
): Promise<SlackCallDisposition | null> {
  if (pass.remaining <= 0) {
    step(pass, {
      stage,
      method,
      result: "skipped",
      category: "invocation_budget",
      detail: "This wake reached its request ceiling; the work stays due for the next one.",
    });
    if (claim) {
      await runContextTransaction(pass.input.db, (session) =>
        releaseSlackChannelForRetry(session, claim, { nextDueAt: null, errorCode: "invocation_budget" })
      );
    }
    return null;
  }
  pass.remaining -= 1;
  const result = await slackReservedRequest(
    { db: pass.input.db, scope, token: selection.token },
    method,
    params,
    pass.options.fetchImpl === undefined ? {} : { fetchImpl: pass.options.fetchImpl }
  );
  return classifySlackCall(result);
}

/** Record a bootstrap failure against the binding, under the same fence as any other write. */
async function reportBindingFailure(
  pass: Pass,
  stage: "auth" | "app",
  method: SlackBudgetedMethod,
  ref: SlackBindingRef,
  call: SlackCallDisposition,
  selection: SlackSelection
): Promise<void> {
  const category = sanitize(call.category);
  const blocked = call.kind === "blocked" || call.kind === "refused";
  await write(pass, selection, ref, (session, r) =>
    blocked
      ? blockSlackBinding(session, r, { category })
      : delaySlackBinding(session, r, { dueAt: deadline(call), category })
  );
  step(pass, {
    stage,
    method,
    result: blocked ? "blocked" : call.kind === "deferred" ? "deferred" : "delayed",
    category: call.category,
    ...(call.category === "missing_scope"
      ? {
          detail:
            "The token is missing the users:read scope, which bots.info needs to complete " +
            "app-identity bootstrap. Add it and re-save the integration.",
        }
      : {}),
    ...(deadlineIso(call) ? { nextPermittedAt: deadlineIso(call) as string } : {}),
  });
}

/** A binding write behind a fresh, locked re-read of the integration row. */
function write<T>(
  pass: Pass,
  selection: SlackSelection,
  ref: SlackBindingRef,
  operation: (session: TransactionSession, ref: SlackBindingRef) => Promise<T>
): Promise<T | { outcome: "stale" }> {
  return runContextTransaction(pass.input.db, async (session) => {
    const read = await lockSlackSelection(session, {
      teamId: selection.teamId,
      integrationId: selection.integrationId,
      envToken: pass.options.envToken,
    });
    if (read.outcome !== "current" || !sameSelection(read.selection, ref)) {
      return { outcome: "stale" as const };
    }
    return operation(session, ref);
  });
}

function sameSelection(selection: SlackSelection, ref: SlackBindingRef): boolean {
  return (
    selection.configRevision === ref.configRevision && selection.tokenFingerprint === ref.tokenFingerprint
  );
}

/**
 * The bucket every channel read is metered under: (team, workspace, app). It is built ONLY from an
 * identity this pass has already verified — the argument is the proof, so there is no path that
 * reaches a verified scope without one.
 */
function verifiedScope(selection: SlackSelection, bound: SlackVerifiedIdentity): SlackMethodScope {
  return {
    kind: "verified",
    teamId: selection.teamId,
    workspaceId: bound.workspaceId,
    appId: bound.appId,
  };
}

function deadline(call: SlackCallDisposition): Date | null {
  const iso = deadlineIso(call);
  return iso === null ? null : new Date(iso);
}

function deadlineIso(call: SlackCallDisposition): string | null {
  if (call.kind === "deferred") return call.nextPermittedAt;
  if (call.kind === "transient" && call.nextPermittedAt !== undefined) return call.nextPermittedAt;
  return null;
}

/** A category is a SANITIZED code; an unrecognised shape becomes a generic one rather than a leak. */
function sanitize(category: string): string {
  return /^[a-z][a-z0-9_]{0,39}$/.test(category) ? category : "provider_error";
}

function providerId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9]+$/.test(value) ? value : null;
}

/** auth.test's `url`, kept only when it is a real HTTPS workspace URL. */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function step(pass: Pass, entry: SlackDiscoveryStep): void {
  pass.steps.push(entry);
}

function finish(pass: Pass, binding: SlackSourceBinding | null): SlackSourceDiscoveryResult {
  const has = (result: SlackDiscoveryStepResult) => pass.steps.some((s) => s.result === result);
  const outcome: SlackSourceDiscoveryResult["outcome"] = has("inactive")
    ? "inactive"
    : // A blocked configuration outranks progress made before it was discovered: a pass that bound a
      // workspace and then found no app has not made the source usable, and reporting "progressed"
      // would hide the one thing an operator has to act on.
      has("blocked")
      ? "blocked"
      : has("ok")
        ? "progressed"
        : has("deferred") || has("delayed") || has("refused") || has("skipped")
          ? "deferred"
          : "idle";
  return {
    outcome,
    steps: pass.steps,
    binding:
      binding === null
        ? null
        : {
            state: binding.state,
            workspaceId: binding.workspaceId,
            appId: binding.appId,
            botId: binding.botId,
            workspaceUrl: binding.workspaceUrl,
            selectedChannelIds: binding.selectedChannelIds,
            errorCode: binding.errorCode,
          },
  };
}
