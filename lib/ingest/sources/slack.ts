import "server-only";
import { INGEST_FETCH_TIMEOUT_MS } from "@/lib/http";

/**
 * Minimal Slack Web API client (raw fetch, no SDK) for the in-app ingestion
 * runner. Read-only methods only: conversations.history/replies/info and a
 * cached users.list for author display names. Bounded per run; pagination via
 * response_metadata.next_cursor.
 *
 * Scopes the bot token needs: channels:history + channels:read (public),
 * groups:history + groups:read (private), users:read (author names).
 */

const SLACK_API = "https://slack.com/api";

export interface SlackMessage {
  ts: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  subtype?: string;
}

export interface FetchedThread {
  root: SlackMessage;
  replies: SlackMessage[]; // excludes the root
}

export interface FetchedChannel {
  channelId: string;
  channelName: string;
  threads: FetchedThread[];
  /** user id → display name (best-effort) */
  users: Record<string, string>;
  /** True when the channel is PRIVATE (or a DM) and was therefore not read at all. The brain only
   *  ingests channels that are public within the workspace. */
  skippedPrivate?: boolean;
  /** True when Slack CONFIRMED the channel is private; false when we merely couldn't verify it was
   *  public. Only a confirmed-private channel may have its already-stored content purged. */
  privacyVerified?: boolean;
  /** Threads DROPPED this tick because their replies couldn't be fetched — see fetchSlackChannel.
   *  Surfaced so a systematic failure is visible in the run log instead of looking like a quiet sync. */
  skippedThreads: number;
  /** One sample cause for `skippedThreads`. Carries the real Slack code so an operator can tell
   *  "wait a tick" (`ratelimited`) from "frozen forever" (lost access / `thread_not_found`) — which
   *  is the entire triage question a skip raises. */
  skippedThreadsReason?: string;
  /** EVERY top-level message seen in this window's history — the "still EXISTS at the source" set
   *  the deletion diff reads. Deliberately wider than `threads` (which drops a thread whose replies
   *  wouldn't fetch) and wider than the render filter (a tombstoned or text-less root is still a
   *  thread): either narrower list would delete live data. */
  liveRootTs?: string[];
  /** Timestamp of the OLDEST message read this tick — the deletion diff's floor. Undefined when the
   *  channel returned no history at all, which must disable deletion entirely. */
  oldestTs?: string;
}

export class SlackError extends Error {}

/** Page cap for a single thread's replies — a backstop against a pathological thread, not a limit
 *  we expect to reach (200 replies per page). Hitting it throws, so the thread is skipped rather
 *  than stored truncated. */
const REPLIES_MAX_PAGES = 25;

/** What the runner does about a channel `fetchSlackChannel` refused to read. */
export interface PrivateChannelAction {
  /** Remove content already stored for this channel. */
  purge: boolean;
  /** The operator-facing line for the run log — it must say what happened AND what to do. */
  message: string;
}

/**
 * The private-channel policy, as a pure function so the branch that decides whether to DELETE data is
 * pinned by a test rather than buried in the runner's loop.
 *
 * The asymmetry is the whole point, and it is deliberate in both directions:
 *  • **Confirmed private** (Slack said `is_private`/`is_im`/`is_mpim`) → skip AND purge. Skipping
 *    alone only stops us adding more; content ingested before the channel went private, or before
 *    this check existed, would sit in a team-readable store — the exact thing being prevented.
 *  • **Unverifiable** (missing scope, `channel_not_found`, bot removed) → skip, NEVER purge. A
 *    transient permission failure on a PUBLIC channel would otherwise delete its whole history, and
 *    that is unrecoverable. The residue is stated in the message rather than hidden: previously
 *    ingested content is retained until we can actually establish the channel is private.
 */
export function privateChannelAction(channel: {
  channelId: string;
  privacyVerified?: boolean;
}): PrivateChannelAction {
  if (channel.privacyVerified) {
    return {
      purge: true,
      message:
        `${channel.channelId}: private channel — not ingested, and previously-ingested content removed ` +
        `(the brain only syncs channels that are public in the workspace; remove it from this integration)`,
    };
  }
  return {
    purge: false,
    message:
      `${channel.channelId}: could not verify this channel is public — skipped (the brain only syncs ` +
      `channels that are public in the workspace). Anything ingested earlier is RETAINED, since a ` +
      `permission failure is not proof of privacy. Check the bot's channels:read scope and membership.`,
  };
}

/**
 * True when a users.list failure means the TOKEN LACKS THE SCOPE — a stable, expected configuration
 * (the workspace simply never gets display names; `normalizeThread` renders raw ids consistently, so
 * bodies don't churn). Every OTHER failure is transient (network, rate limit, 5xx, timeout) and must
 * NOT be treated as "no users": rendering ids for one tick rewrites every thread body in the channel
 * → a new sha → a new version + re-embed + re-projection for the whole channel, which the next
 * successful tick churns straight back. Callers skip instead.
 */
function isMissingScopeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // ONLY genuine scope/permission conditions. Token-dead codes (`invalid_auth`, `account_inactive`,
  // `token_revoked`, …) are deliberately NOT here: nothing renders at all under a dead token, so
  // calling it a graceful degrade would be a lie — they rethrow and the integration is skipped with
  // one crisp error instead of a per-channel pile of downstream failures.
  return /missing_scope|not_allowed_token_type|no_permission/i.test(msg);
}

/**
 * True when a `conversations.info` failure means we CANNOT ESTABLISH the channel's visibility —
 * as opposed to a transient blip. A missing scope is one case; the other is a channel Slack won't
 * describe to this token at all: `channel_not_found` is what Slack returns for a private channel the
 * bot isn't in (it deliberately doesn't distinguish that from a bad id), and `not_in_channel` is the
 * membership variant. Left to the generic `throw`, those produced a bare per-tick error and the
 * channel's PRIVACY was never decided — the "kicked the bot, then made it private" case, where the
 * honest answer is "unverifiable, so treat as private."
 */
function isUnverifiableChannelError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return isMissingScopeError(err) || /channel_not_found|not_in_channel/i.test(msg);
}

export class SlackClient {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, params: Record<string, string>): Promise<T> {
    const url = `${SLACK_API}/${method}?${new URLSearchParams(params).toString()}`;
    // Timeout so a stalled Slack socket can't hang the ingest loop and wedge its running flag (M8).
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(INGEST_FETCH_TIMEOUT_MS),
    });
    const json = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!json.ok) {
      throw new SlackError(`slack ${method} failed: ${json.error ?? `HTTP ${res.status}`}`);
    }
    return json;
  }

  /**
   * A channel's display name AND whether it is PRIVATE. Privacy is load-bearing, not cosmetic: the
   * brain only ingests channels that are public within the workspace, so this decides whether the
   * channel is read at all (see `fetchSlackChannel`).
   *
   * Fails CLOSED. A missing scope (or a channel Slack won't describe to this token) means we cannot
   * verify the channel is public, and "unverified" must not be treated as "public" — a token without
   * `channels:read` would otherwise pull whatever it can reach, including private conversations. DMs
   * and group DMs (`is_im`/`is_mpim`) are private by definition and count the same.
   */
  async channelInfo(channelId: string): Promise<{ name: string; isPrivate: boolean; verified: boolean }> {
    try {
      const r = await this.call<{
        channel: { name?: string; is_private?: boolean; is_im?: boolean; is_mpim?: boolean };
      }>("conversations.info", { channel: channelId });
      const c = r.channel ?? {};
      return {
        name: c.name ?? channelId,
        isPrivate: Boolean(c.is_private || c.is_im || c.is_mpim),
        verified: true, // Slack told us directly
      };
    } catch (err) {
      // Paths are keyed on the immutable channel ID now, so a name flake no longer re-keys threads —
      // it only affects the DISPLAY name (`frontmatter.channel`, the thread title, the Data page). We
      // still skip on a transient failure rather than persist a wrong name: the frontmatter heal
      // rewrites `channel` on every unchanged re-push, so one bad tick would relabel the whole
      // channel's items (and the Data page picks the most recently synced name).
      if (!isUnverifiableChannelError(err)) throw err;
      // Can't read the channel's metadata → can't prove it's public → treat it as private and SKIP.
      // `verified: false` matters downstream: skipping on a guess is safe, but DELETING already-stored
      // content on a guess is not — an unverifiable public channel would lose its history.
      return { name: channelId, isPrivate: true, verified: false };
    }
  }

  /** Paginated history, newest→oldest, capped at `max` messages. */
  async history(channelId: string, max: number): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    let cursor: string | undefined;
    while (out.length < max) {
      const params: Record<string, string> = {
        channel: channelId,
        limit: String(Math.min(200, max - out.length)),
      };
      if (cursor) params.cursor = cursor;
      const r = await this.call<{
        messages: SlackMessage[];
        response_metadata?: { next_cursor?: string };
      }>("conversations.history", params);
      out.push(...(r.messages ?? []));
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return out;
  }

  /**
   * Thread replies (excludes the root message), PAGINATED to completion.
   *
   * Following the cursor is not an optimization — a thread's body is the whole conversation, so a
   * short page is a silent content regression: the stored item is rewritten missing its tail, and
   * (worse, now) the shrink it fakes looks exactly like someone deleting messages at the source.
   * That is the same failure #388 closed for a THROWN replies error, arriving through a successful
   * response. A page cap bounds a pathological thread rather than looping forever; hitting it throws,
   * so the caller skips the thread instead of storing a truncated body.
   */
  async replies(channelId: string, threadTs: string): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < REPLIES_MAX_PAGES; page++) {
      const params: Record<string, string> = { channel: channelId, ts: threadTs, limit: "200" };
      if (cursor) params.cursor = cursor;
      const r = await this.call<{
        messages: SlackMessage[];
        has_more?: boolean;
        response_metadata?: { next_cursor?: string };
      }>("conversations.replies", params);
      out.push(...(r.messages ?? []));
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) {
        // `has_more` with no cursor to follow means we CANNOT complete the thread. Throwing routes
        // it into the existing skip-the-thread path rather than storing what we happen to have.
        if (r.has_more) throw new SlackError(`slack conversations.replies incomplete: has_more with no cursor`);
        return out.filter((m) => m.ts !== threadTs);
      }
    }
    throw new SlackError(`slack conversations.replies exceeded ${REPLIES_MAX_PAGES} pages`);
  }

  /**
   * Does anything still exist at `ts` in this channel? The DELETION CONFIRMATION — the only thing
   * that authorizes removing stored content, so it is deliberately a separate method rather than a
   * flag on `replies()`.
   *
   * The distinction matters and is easy to get wrong: `replies()` strips the root (`m.ts !== threadTs`)
   * because callers want the replies *around* a root they already hold. Reusing it here would read a
   * LIVE STANDALONE message — which `conversations.replies` returns as exactly one message, the root —
   * as "nothing there", and confirm a deletion that never happened. That is the precise case the
   * confirmation exists to prevent, so this counts the RAW response.
   *
   * `thread_not_found` / `message_not_found` is Slack stating the content is gone → false. Every other
   * error propagates: not being able to ask is never evidence, and the caller must spare the thread.
   */
  async threadExists(channelId: string, ts: string): Promise<boolean> {
    try {
      const r = await this.call<{ messages?: SlackMessage[] }>("conversations.replies", {
        channel: channelId,
        ts,
        limit: "1",
      });
      return (r.messages ?? []).length > 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (/thread_not_found|message_not_found/i.test(msg)) return false;
      throw err;
    }
  }

  /**
   * All workspace users with display name + email (one paginated pass; best-effort). Email is
   * present only when the token has the `users:read.email` scope — otherwise undefined, and
   * automatic identity mapping degrades to manual admin mapping. Used to attribute Slack content
   * to the right person.
   */
  async usersDetailed(): Promise<{ id: string; displayName: string; email?: string }[]> {
    const out: { id: string; displayName: string; email?: string }[] = [];
    let cursor: string | undefined;
    try {
      do {
        const params: Record<string, string> = { limit: "200" };
        if (cursor) params.cursor = cursor;
        const r = await this.call<{
          members: { id: string; name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string; email?: string } }[];
          response_metadata?: { next_cursor?: string };
        }>("users.list", params);
        for (const u of r.members ?? []) {
          out.push({
            id: u.id,
            displayName: u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || u.id,
            email: u.profile?.email,
          });
        }
        cursor = r.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch (err) {
      // users:read[.email] not granted — caller degrades gracefully to ids (stable across ticks).
      // A TRANSIENT failure must surface so the caller can skip rather than rewrite every body.
      if (!isMissingScopeError(err)) throw err;
    }
    return out;
  }

  /** All workspace users → id→name map (one paginated pass; best-effort). */
  async usersMap(): Promise<Record<string, string>> {
    const map: Record<string, string> = {};
    let cursor: string | undefined;
    try {
      do {
        const params: Record<string, string> = { limit: "200" };
        if (cursor) params.cursor = cursor;
        const r = await this.call<{
          members: { id: string; name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } }[];
          response_metadata?: { next_cursor?: string };
        }>("users.list", params);
        for (const u of r.members ?? []) {
          map[u.id] =
            u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || u.id;
        }
        cursor = r.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch (err) {
      // users:read not granted — fall back to ids at normalize time (stable across ticks).
      if (!isMissingScopeError(err)) throw err; // transient → caller skips, never a churned rewrite
    }
    return map;
  }
}

/** Keep only real human/bot messages with text (drop joins, topic changes, etc.). */
function isContentMessage(m: SlackMessage): boolean {
  if (!m.text || !m.text.trim()) return false;
  // No subtype = a normal message. Allow bot_message; drop channel_join/leave/topic/etc.
  return !m.subtype || m.subtype === "bot_message" || m.subtype === "thread_broadcast";
}

/**
 * Fetch one channel into top-level threads (root message + its replies), capped
 * at `maxMessages` roots. Each thread becomes one brain item at normalize time.
 */
export async function fetchSlackChannel(
  client: SlackClient,
  channelId: string,
  opts: { maxMessages?: number; users?: Record<string, string> } = {}
): Promise<FetchedChannel> {
  const max = opts.maxMessages ?? 300;
  const [info, users] = await Promise.all([
    client.channelInfo(channelId),
    opts.users ? Promise.resolve(opts.users) : client.usersMap(),
  ]);
  const channelName = info.name;

  // PRIVATE CHANNELS ARE NEVER INGESTED. The brain is a shared team memory with exactly two tiers
  // (team / external) and no stricter one — so anything ingested from a private channel becomes
  // readable by the whole team, which is not what "private" means to the people in it. An admin
  // adding a channel id can't be relied on to have checked, and `conversations.info` tells us
  // directly, so we check rather than trust. Returns before ANY message is read: nothing private
  // enters the process, let alone the store.
  if (info.isPrivate) {
    return {
      channelId,
      channelName,
      threads: [],
      users,
      skippedThreads: 0,
      skippedPrivate: true,
      privacyVerified: info.verified,
    };
  }

  const history = await client.history(channelId, max);
  const isTopLevel = (m: SlackMessage) => !m.thread_ts || m.thread_ts === m.ts;
  // A top-level message that still EXISTS but has no renderable text: Slack leaves this behind when
  // a thread's root is deleted while its replies live on (a tombstone), or when the author edits the
  // text away. It must stay INGESTIBLE — the item's body is the served surface, so a thread that is
  // kept (correctly) but never re-rendered would go on quoting the deleted root forever, which is a
  // worse leak than the version history this feature is about. `reply_count > 0` bounds it to threads
  // that actually exist: a bare text-less message is not a conversation and must not become an item.
  // Slack's structural events (channel_join/topic/…) all carry text, so they are excluded already.
  //
  // Recognised by ANY of three signals, because none is guaranteed and requiring all of them drops
  // silently back to the frozen-body bug:
  //  • `subtype === "tombstone"` — Slack's own marker, and the one that matters most: a REAL tombstone
  //    carries `text: "This message was deleted."`, so a `!text` test alone never fires on the actual
  //    payload. Testing the text was an assumption about the wire format; this tests what Slack says.
  //  • no renderable text — a root edited down to a file/attachment with no caption.
  //  • `reply_count > 0` / `thread_ts === ts` — "this is a conversation, not a bare message". A
  //    standalone message carries no `thread_ts` at all (see `isTopLevel`), so the self-reference is
  //    an independent root signal for the case where Slack drops `reply_count`.
  // Structural events (channel_join/topic/…) carry text and a non-tombstone subtype, so they stay out.
  const isThreadRoot = (m: SlackMessage) => (m.reply_count ?? 0) > 0 || m.thread_ts === m.ts;
  const isRedactedRoot = (m: SlackMessage) =>
    (m.subtype === "tombstone" || !m.text?.trim()) && isThreadRoot(m);
  // Two DIFFERENT questions, and conflating them deletes live data:
  //  • `liveTopLevelTs` — "does this thread still EXIST at the source?" Every top-level message
  //    counts, with NO content filter. Slack leaves a tombstone in history when a thread root is
  //    deleted while its replies live on, and an author can edit a root down to a file with no text
  //    — both fail `isContentMessage`. Judging existence by the render filter would purge those
  //    threads, taking `item_versions` with them and destroying the credit of every replier whose
  //    messages are still in Slack.
  //  • `roots` — "is this thread INGESTIBLE this tick?" That one is content-filtered, as before.
  const liveTopLevelTs = history.filter(isTopLevel).map((m) => m.ts);
  const roots = history.filter((m) => isTopLevel(m) && (isContentMessage(m) || isRedactedRoot(m)));

  const threads: FetchedThread[] = [];
  let skippedThreads = 0;
  let skippedThreadsReason: string | undefined;
  for (const root of roots) {
    let replies: SlackMessage[] = [];
    // Admitting a root WITHOUT fetching its replies is worse than not admitting it at all: the
    // re-render would produce a placeholder-only body, overwrite the stored full conversation, and
    // `forgetSupersededBodies` would then blank the superseded body — erasing replies that are still
    // live in Slack from every stored surface. A redacted root is admitted precisely when
    // `reply_count` may be missing, so it must drive the fetch too.
    if ((root.reply_count ?? 0) > 0 || isRedactedRoot(root)) {
      try {
        replies = (await client.replies(channelId, root.ts)).filter(isContentMessage);
      } catch (err) {
        // SKIP the thread this tick — do NOT fall back to root-only. A thread's body is the whole
        // conversation, so ingesting it without its replies is a CONTENT REGRESSION: the stored item
        // is rewritten to a truncated body (a real version), retrieval serves the shortened thread,
        // and the next successful tick writes another version restoring it. Freshness costs nothing
        // here — the existing full item simply stands until the next tick.
        skippedThreads++;
        skippedThreadsReason ??= err instanceof Error ? err.message : String(err);
        continue;
      }
    }
    threads.push({ root, replies });
  }
  // The DELETION WINDOW. A thread stored under this channel but absent from `liveRootTs` is either
  // (a) deleted at the source or (b) simply older than the `maxMessages` window — and treating (b)
  // as (a) would delete the channel's entire history on every tick. `oldestTs` is what separates
  // them: only a stored thread NEWER than the oldest message we actually read can be judged.
  //
  // `liveRootTs` is EVERY top-level message in history, not `threads` and not even `roots` — a
  // thread whose replies failed to fetch is skipped from `threads` but is demonstrably still alive,
  // and a tombstoned/text-less root is still a thread that exists. Both narrower lists would delete
  // live data.
  const oldest = history.length > 0 ? history[history.length - 1].ts : undefined;
  return {
    channelId,
    channelName,
    threads,
    users,
    skippedThreads,
    skippedThreadsReason,
    liveRootTs: liveTopLevelTs,
    oldestTs: oldest,
  };
}
