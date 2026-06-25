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
  synced_at: string;
}

export interface Channel {
  key: string; // "slack/eng" — also the path prefix used to query the feed (`<key>/%`)
  source: string; // "slack"
  name: string; // "eng"
  count: number;
  lastSyncedAt: string;
}

/** `slack/eng/123.md` → { key: "slack/eng", source: "slack", name: "eng" }. */
export function parseChannel(path: string): { key: string; source: string; name: string } {
  const segs = path.split("/").filter(Boolean);
  if (segs.length >= 2) return { key: `${segs[0]}/${segs[1]}`, source: segs[0], name: segs[1] };
  const only = segs[0] ?? path;
  return { key: only, source: only, name: only };
}

/** Group rows into channels with item counts + most-recent arrival, sorted by recency (newest first). */
export function groupChannels(rows: ChannelRow[]): Channel[] {
  const byKey = new Map<string, Channel>();
  for (const row of rows) {
    const { key, source, name } = parseChannel(row.path);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { key, source, name, count: 1, lastSyncedAt: row.synced_at });
    } else {
      existing.count += 1;
      // ISO-8601 strings compare lexicographically in timestamp order.
      if (row.synced_at > existing.lastSyncedAt) existing.lastSyncedAt = row.synced_at;
    }
  }
  return [...byKey.values()].sort((a, b) => b.lastSyncedAt.localeCompare(a.lastSyncedAt));
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
