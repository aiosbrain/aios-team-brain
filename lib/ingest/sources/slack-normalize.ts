import { createHash } from "node:crypto";
import type { ItemPayload } from "@/lib/api/schemas";
import type { FetchedThread, SlackMessage } from "./slack";

/**
 * Pure: a Slack thread (root + replies) → the brain's ItemPayload.
 *   kind  = transcript
 *   path  = slack/<channel>/<root-ts>.md   (one item per top-level message/thread)
 *   body  = rendered markdown transcript (author · time · text, replies appended)
 * Re-ingesting an unchanged thread is a no-op (sha256 dedup at the writer); a new
 * reply changes the body → sha → a new version.
 */

export interface NormalizeOpts {
  channelId: string;
  channelName: string;
  users: Record<string, string>;
  project?: string; // brain project slug (default "slack")
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function safeSegment(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "channel";
}

function tsToIso(ts: string): string {
  const ms = Math.round(parseFloat(ts) * 1000);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

/** Resolve <@U123> mentions and <url|label> links to human-readable text. */
function renderText(text: string, users: Record<string, string>): string {
  return text
    .replace(/<@([A-Z0-9]+)(\|[^>]+)?>/g, (_m, id: string) => `@${users[id] ?? id}`)
    .replace(/<(https?:[^>|]+)\|([^>]+)>/g, (_m, url: string, label: string) => `${label} (${url})`)
    .replace(/<(https?:[^>]+)>/g, (_m, url: string) => url);
}

function renderMessage(m: SlackMessage, opts: NormalizeOpts): string {
  const author = (m.user && opts.users[m.user]) || m.user || "unknown";
  const when = tsToIso(m.ts);
  return `**${author}**${when ? ` · ${when}` : ""}\n\n${renderText(m.text ?? "", opts.users)}`;
}

export function normalizeThread(thread: FetchedThread, opts: NormalizeOpts): ItemPayload {
  const { root, replies } = thread;
  const channelSeg = safeSegment(opts.channelName || opts.channelId);

  const parts = [renderMessage(root, opts)];
  for (const r of replies) parts.push(renderMessage(r, opts));
  const body = `# #${opts.channelName} — Slack thread\n\n${parts.join("\n\n---\n\n")}\n`;

  const author = (root.user && opts.users[root.user]) || root.user || "";

  return {
    project: opts.project ?? "slack",
    path: `slack/${channelSeg}/${root.ts}.md`,
    kind: "transcript",
    content_sha256: sha256(body),
    actor: author,
    access: "team",
    frontmatter: {
      source: "slack",
      channel: opts.channelName,
      channel_id: opts.channelId,
      ts: root.ts,
      thread_ts: root.thread_ts ?? root.ts,
      author,
      author_id: root.user ?? "",
      source_ts: tsToIso(root.ts),
      reply_count: replies.length,
    },
    body,
  };
}
