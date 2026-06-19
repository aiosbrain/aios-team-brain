import "server-only";

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
}

export class SlackError extends Error {}

export class SlackClient {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, params: Record<string, string>): Promise<T> {
    const url = `${SLACK_API}/${method}?${new URLSearchParams(params).toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    const json = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!json.ok) {
      throw new SlackError(`slack ${method} failed: ${json.error ?? `HTTP ${res.status}`}`);
    }
    return json;
  }

  async channelName(channelId: string): Promise<string> {
    try {
      const r = await this.call<{ channel: { name?: string } }>("conversations.info", {
        channel: channelId,
      });
      return r.channel.name ?? channelId;
    } catch {
      return channelId; // private channel without scope, or renamed — fall back to id
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

  /** Thread replies (excludes the root message). */
  async replies(channelId: string, threadTs: string): Promise<SlackMessage[]> {
    const r = await this.call<{ messages: SlackMessage[] }>("conversations.replies", {
      channel: channelId,
      ts: threadTs,
    });
    return (r.messages ?? []).filter((m) => m.ts !== threadTs);
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
    } catch {
      // users:read not granted — fall back to ids at normalize time.
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
  const [channelName, users] = await Promise.all([
    client.channelName(channelId),
    opts.users ? Promise.resolve(opts.users) : client.usersMap(),
  ]);

  const history = await client.history(channelId, max);
  // Top-level messages only (a reply has thread_ts !== ts). Roots keep their thread.
  const roots = history.filter((m) => isContentMessage(m) && (!m.thread_ts || m.thread_ts === m.ts));

  const threads: FetchedThread[] = [];
  for (const root of roots) {
    let replies: SlackMessage[] = [];
    if (root.reply_count && root.reply_count > 0) {
      try {
        replies = (await client.replies(channelId, root.ts)).filter(isContentMessage);
      } catch {
        replies = [];
      }
    }
    threads.push({ root, replies });
  }
  return { channelId, channelName, threads, users };
}
