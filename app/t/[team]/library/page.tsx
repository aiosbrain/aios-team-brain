import type { Metadata } from "next";
import Link from "next/link";
import { Database } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { visibleItems } from "@/lib/auth/visibility";
import { KindBadge } from "@/components/kind-badge";
import { TierBadge } from "@/components/tier-badge";
import { EmptyState } from "@/components/empty-state";
import { timeAgo } from "@/components/format";
import { ChannelRail } from "@/components/library/channel-rail";
import { groupChannels, freshnessNow, previewLine, type ChannelRow } from "@/lib/library/channels";

export const metadata: Metadata = { title: "Data" };

// Occasional-use verification view: scan a bounded recent window for the channel list, and a single
// channel's feed on demand. Both are generous for dogfooding; counts beyond the cap show as "N+".
const CHANNEL_SCAN_CAP = 6000;
const PAGE_SIZE = 50;
const MAX_FEED = 500;

type FeedItem = {
  id: string;
  path: string;
  kind: string;
  access: string;
  actor: string;
  synced_at: string;
  body: string | null;
};

export default async function DataPage({
  params,
  searchParams,
}: {
  params: Promise<{ team: string }>;
  searchParams: Promise<{ channel?: string; limit?: string }>;
}) {
  const { team: teamSlug } = await params;
  const { channel: channelParam, limit: limitParam } = await searchParams;
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const me = await currentMember(team.id);
  const tier = me?.tier ?? "external";

  // 1) Channel list — group a bounded recent window of visible items by path prefix.
  let chQuery = db
    .from("items")
    .select("path, synced_at")
    .eq("team_id", team.id)
    .order("synced_at", { ascending: false })
    .limit(CHANNEL_SCAN_CAP);
  chQuery = visibleItems(chQuery, tier); // external viewers never see team/admin content
  const { data: chRows } = await chQuery;
  const channels = groupChannels((chRows ?? []) as ChannelRow[]);

  const selected =
    channelParam && channels.some((c) => c.key === channelParam) ? channelParam : channels[0]?.key ?? null;
  const limit = Math.min(MAX_FEED, Math.max(PAGE_SIZE, Number(limitParam) || PAGE_SIZE));

  // 2) Selected channel feed — newest first, one extra row to detect "load more".
  let items: FeedItem[] = [];
  let hasMore = false;
  if (selected) {
    let feedQuery = db
      .from("items")
      .select("id, path, kind, access, actor, synced_at, body")
      .eq("team_id", team.id)
      .like("path", `${selected}/%`)
      .order("synced_at", { ascending: false })
      .limit(limit + 1);
    feedQuery = visibleItems(feedQuery, tier);
    const { data: feed } = await feedQuery;
    // Exact prefix guard: LIKE treats `_` as a wildcard, so confirm the path segment boundary in JS.
    const rows = ((feed ?? []) as FeedItem[]).filter((it) => it.path.startsWith(`${selected}/`));
    hasMore = rows.length > limit;
    items = rows.slice(0, limit);
  }

  const railChannels = channels.map((c) => ({
    key: c.key,
    source: c.source,
    name: c.name,
    count: c.count,
    ago: timeAgo(c.lastSyncedAt),
    fresh: freshnessNow(c.lastSyncedAt),
  }));
  const selectedChannel = channels.find((c) => c.key === selected) ?? null;
  const totalItems = channels.reduce((sum, c) => sum + c.count, 0);
  const cappedNote = (chRows ?? []).length >= CHANNEL_SCAN_CAP ? "+" : "";

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold text-ink">Data</h1>
        <p className="text-xs text-ink-tertiary">
          {channels.length} channel{channels.length === 1 ? "" : "s"} · {totalItems}
          {cappedNote} items
        </p>
      </div>

      {channels.length === 0 ? (
        <EmptyState
          icon={Database}
          title="No data yet"
          action="Connect a source in Admin → Integrations (Slack, Linear, GitHub, Plane) or run aios push from a repo. Ingested data shows up here, grouped by channel."
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-[220px_1fr]">
          <aside className="md:sticky md:top-4 md:self-start">
            <ChannelRail teamSlug={teamSlug} channels={railChannels} selectedKey={selected} />
          </aside>

          <section className="flex min-w-0 flex-col gap-3">
            {selectedChannel && (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border-subtle pb-2">
                <h2 className="font-mono text-sm font-medium text-ink">{selectedChannel.key}</h2>
                <span className="text-xs text-ink-tertiary">
                  {selectedChannel.count}
                  {cappedNote} items · last received {timeAgo(selectedChannel.lastSyncedAt)}
                </span>
              </div>
            )}

            {items.length === 0 ? (
              <p className="px-1 py-6 text-sm text-ink-tertiary">No items in this channel.</p>
            ) : (
              <ol className="flex flex-col divide-y divide-border-subtle">
                {items.map((it) => {
                  const file = it.path.split("/").slice(2).join("/") || it.path;
                  const preview = previewLine(it.body);
                  return (
                    <li key={it.id}>
                      <Link
                        href={`/t/${teamSlug}/library/${it.id}`}
                        className="flex items-start gap-3 px-1 py-2.5 transition-colors hover:bg-surface-raised"
                      >
                        <span className="mt-0.5 flex shrink-0 items-center gap-1.5">
                          <KindBadge kind={it.kind} />
                          <TierBadge tier={it.access} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-ink">{preview || file}</span>
                          <span className="block truncate font-mono text-[11px] text-ink-tertiary">
                            {file}
                            {it.actor ? ` · @${it.actor}` : ""}
                          </span>
                        </span>
                        <span className="mt-0.5 shrink-0 text-[11px] text-ink-tertiary">{timeAgo(it.synced_at)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ol>
            )}

            {hasMore && selected && (
              <Link
                href={`/t/${teamSlug}/library?channel=${encodeURIComponent(selected)}&limit=${limit + PAGE_SIZE}`}
                className="self-center rounded-lg border border-border-default px-4 py-1.5 text-xs font-medium text-ink-secondary transition-colors hover:border-violet/30"
              >
                Load more
              </Link>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
