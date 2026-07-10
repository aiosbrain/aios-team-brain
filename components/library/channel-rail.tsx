"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import type { Freshness } from "@/lib/library/channels";

export interface RailChannel {
  key: string;
  source: string;
  name: string;
  count: number;
  ago: string;
  fresh: Freshness;
}

const DOT: Record<Freshness, string> = {
  fresh: "bg-emerald-500",
  recent: "bg-amber-500",
  stale: "bg-ink-tertiary/40",
};

const DOT_TITLE: Record<Freshness, string> = {
  fresh: "data in the last 24h",
  recent: "data in the last 7 days",
  stale: "no data in over a week",
};

/**
 * Left rail of the Data page: filterable channel list grouped by source, each row showing a
 * freshness dot + item count + last-received. Selecting a channel navigates (`?channel=`), so the
 * server re-renders the feed. Freshness/ago are precomputed server-side (passed in) to avoid
 * hydration drift — this component only filters.
 */
export function ChannelRail({
  basePath,
  channels,
  selectedKey,
}: {
  /** Route the channel links resolve against (e.g. `/t/acme/admin/data`). Selecting a channel
   *  appends `?channel=`, so the server re-renders the feed on that page. */
  basePath: string;
  channels: RailChannel[];
  selectedKey: string | null;
}) {
  const [filter, setFilter] = useState("");

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matched = q ? channels.filter((c) => c.key.toLowerCase().includes(q)) : channels;
    // Channels arrive sorted by recency; bucket by source preserving that order.
    const out: { source: string; channels: RailChannel[] }[] = [];
    const index = new Map<string, number>();
    for (const c of matched) {
      let i = index.get(c.source);
      if (i === undefined) {
        i = out.length;
        index.set(c.source, i);
        out.push({ source: c.source, channels: [] });
      }
      out[i].channels.push(c);
    }
    return out;
  }, [channels, filter]);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-tertiary" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter channels…"
          className="w-full rounded-lg border border-border-default bg-surface py-1.5 pl-8 pr-2 text-xs text-ink placeholder:text-ink-tertiary focus:border-violet/40 focus:outline-none"
        />
      </div>

      {groups.length === 0 ? (
        <p className="px-1 py-4 text-xs text-ink-tertiary">No channels match.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <div key={g.source} className="flex flex-col gap-1">
              <p className="px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary">
                {g.source}
              </p>
              {g.channels.map((c) => {
                const active = c.key === selectedKey;
                return (
                  <Link
                    key={c.key}
                    href={`${basePath}?channel=${encodeURIComponent(c.key)}`}
                    aria-current={active ? "true" : undefined}
                    className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors ${
                      active ? "bg-violet/10 text-violet" : "text-ink-secondary hover:bg-surface-raised"
                    }`}
                  >
                    <span className={`size-1.5 shrink-0 rounded-full ${DOT[c.fresh]}`} title={DOT_TITLE[c.fresh]} />
                    <span className="truncate font-medium">{c.name}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-ink-tertiary">{c.count}</span>
                    <span className="shrink-0 text-[10px] text-ink-tertiary">{c.ago}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
