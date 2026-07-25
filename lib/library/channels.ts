/**
 * Pure helpers for the "Data" page (channel inspector). A *channel* is the source stream an item
 * arrived on, derived from the first two segments of its `path` (`slack/eng`, `linear/aio`,
 * `github/acme-app`, `plane/eng`). Grouping by path prefix gives per-Slack-channel granularity
 * (all Slack shares one brain project, so project-grouping would lump channels together).
 *
 * No DB access here — the page fetches `items` (through the `visibleItems` tier choke-point) and
 * feeds rows in. Kept pure so the grouping/freshness/preview rules are unit-tested.
 */

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
  key: string; // "slack/eng" — also the path prefix used to query the feed (`<key>/%`)
  source: string; // "slack"
  name: string; // "eng"
  count: number;
  lastSyncedAt: string;
}

/** `slack/eng/123.md` → { key: "slack/eng", source: "slack", name: "eng" }. `key` stays the PATH
 *  prefix (it's also the feed query `<key>/%`); only the display `name` may be overridden by a label. */
export function parseChannel(path: string): { key: string; source: string; name: string } {
  const segs = path.split("/").filter(Boolean);
  if (segs.length >= 2) return { key: `${segs[0]}/${segs[1]}`, source: segs[0], name: segs[1] };
  const only = segs[0] ?? path;
  return { key: only, source: only, name: only };
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
    const label = row.label?.trim() || "";
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
