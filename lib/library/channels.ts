/**
 * Pure helpers for the "Data" page (channel inspector). A *channel* is the source stream an item
 * arrived on, derived from its `path` (`slack/<workspace>/<channel>` for scoped Slack,
 * `slack/<channel>` for legacy Slack, and the first two segments for other sources).
 *
 * No DB access here — the page fetches `items` (through the `visibleItems` tier choke-point) and
 * feeds rows in. Kept pure so the grouping/freshness/preview rules are unit-tested.
 */

import { parseSlackItemPath, scopedSlackItemPath } from "@/lib/ingest/sources/slack-namespace";

// Two adjacent slashes cannot be produced by the non-Slack first-two-segment key parser,
// which drops empty segments. This keeps malformed Slack rows distinct from arbitrary paths.
const UNRECOGNIZED_SLACK_PREFIX = "unrecognized-slack://";

export interface ChannelRow {
  path: string;
  // The pg adapter returns timestamptz as a Date, not an ISO string (the #134 gotcha) — accept
  // both so the caller can pass rows straight through. Normalized to an ISO string internally.
  synced_at: string | Date;
  /**
   * Human display name for the channel, when the source knows one the PATH doesn't carry. Slack keys
   * its paths on the immutable channel ID (a rename must not re-key every thread into duplicate
   * items), so `slack/c0b8v119g4d` has no readable segment — the real `#all-vibrana` comes from the
   * item's `frontmatter.channel`. Sources whose segment is already readable (linear/github/plane)
   * pass nothing and keep deriving the name from the path.
   */
  label?: string | null;
}

export interface Channel {
  key: string; // path prefix (or a distinct key for an unrecognized Slack item)
  source: string; // "slack"
  name: string; // "eng"
  count: number;
  lastSyncedAt: string;
}

/** Only the shared exact parser may assign a Slack channel identity. Invalid Slack paths remain
 * individually inspectable, without guessing a workspace or merging them into a valid channel. */
export function parseChannel(path: string): { key: string; source: string; name: string } {
  const slack = parseSlackItemPath(path);
  if (slack?.kind === "scoped" &&
      scopedSlackItemPath(slack.workspaceSegment, slack.channelSegment, slack.rootTs) === path) {
    return {
      key: `slack/${slack.workspaceSegment}/${slack.channelSegment}`,
      source: "slack",
      name: slack.channelSegment,
    };
  }
  if (slack?.kind === "legacy") {
    return { key: `slack/${slack.channelSegment}`, source: "slack", name: slack.channelSegment };
  }
  const segs = path.split("/").filter(Boolean);
  if (segs[0] === "slack" || path.startsWith("slack/")) {
    return { key: `${UNRECOGNIZED_SLACK_PREFIX}${path}`, source: "unknown", name: path };
  }
  if (segs.length >= 2) return { key: `${segs[0]}/${segs[1]}`, source: segs[0], name: segs[1] };
  const only = segs[0] ?? path;
  return { key: only, source: only, name: only };
}

/** The unknown-path key is deliberately outside the valid Slack key space. */
export function channelExactPath(key: string): string {
  return key.startsWith(UNRECOGNIZED_SLACK_PREFIX) ? key.slice(UNRECOGNIZED_SLACK_PREFIX.length) : key;
}

/** PostgreSQL LIKE treats `%`, `_` and `\\` specially. Escape the literal channel prefix before
 * adding its one trailing wildcard; the feed also checks parsed keys after each bounded batch. */
export function channelFeedPattern(key: string): string {
  return `${key.replace(/[\\%_]/g, (char) => `\\${char}`)}/%`;
}

/** The final feed boundary: legacy and scoped Slack prefixes can overlap in SQL, but never here. */
export function belongsToChannel(path: string, key: string): boolean {
  return parseChannel(path).key === key;
}

/** Keep only the filename relative to the selected channel, including the scoped Slack segment. */
export function channelFeedFilename(path: string, key: string): string {
  const prefix = `${key}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Normalize a timestamptz value (Date from the pg adapter, or an ISO string) to an ISO string. */
function isoOf(v: string | Date): string {
  return typeof v === "string" ? v : v.toISOString();
}

/** Group rows into channels with item counts + most-recent arrival, sorted by recency (newest first). */
export function groupChannels(rows: ChannelRow[]): Channel[] {
  const byKey = new Map<string, Channel>();
  // Tracks WHEN each channel's current display label was observed, so the most recently synced name
  // wins. Input order is not assumed (a caller may pass rows in any order), and after a rename the
  // older rows still carry the old name — picking by recency is what makes the new name show.
  const labelAt = new Map<string, number>();
  for (const row of rows) {
    const { key, source, name } = parseChannel(row.path);
    const label = source === "unknown" ? "" : row.label?.trim() || "";
    const syncedAt = isoOf(row.synced_at);
    const ms = Date.parse(syncedAt);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { key, source, name: label || name, count: 1, lastSyncedAt: syncedAt });
      if (label) labelAt.set(key, ms);
    } else {
      existing.count += 1;
      if (label && ms >= (labelAt.get(key) ?? -Infinity)) {
        existing.name = label;
        labelAt.set(key, ms);
      }
      // Compare by epoch ms — mixed "Z"/offset ISO forms don't sort lexicographically.
      if (ms > Date.parse(existing.lastSyncedAt)) existing.lastSyncedAt = syncedAt;
    }
  }
  return [...byKey.values()].sort((a, b) => Date.parse(b.lastSyncedAt) - Date.parse(a.lastSyncedAt));
}

export type Freshness = "fresh" | "recent" | "stale";

const DAY_MS = 24 * 60 * 60 * 1000;

/** fresh = data in the last 24h · recent = last 7d · stale = older (the "gone quiet" signal). */
export function freshness(lastSyncedAt: string, now: number): Freshness {
  const age = now - new Date(lastSyncedAt).getTime();
  if (age < DAY_MS) return "fresh";
  if (age < 7 * DAY_MS) return "recent";
  return "stale";
}

/** `freshness` against the current clock — wraps the time-read so callers stay render-pure. */
export function freshnessNow(lastSyncedAt: string): Freshness {
  return freshness(lastSyncedAt, Date.now());
}

/** First meaningful line of an item body, markdown-heading-stripped, for a one-line feed preview. */
export function previewLine(body: string | null | undefined, max = 100): string {
  const text = String(body ?? "");
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^#+\s*/, "").trim();
    if (line) return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
  }
  return "";
}
