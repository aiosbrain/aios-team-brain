import Link from "next/link";
import { KindBadge } from "@/components/kind-badge";
import { timeAgo } from "@/components/format";
import type { ActivityItem } from "./types";

export function ActivityFeed({ teamSlug, items }: { teamSlug: string; items: ActivityItem[] }) {
  return (
    <section className="prism-card px-5 py-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
        Recent activity
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-ink-tertiary">Nothing synced in this window.</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-3 py-2.5">
              <KindBadge kind={it.kind} />
              <Link
                href={`/t/${teamSlug}/library/${it.id}`}
                className="min-w-0 flex-1 truncate font-mono text-xs text-ink hover:text-violet"
                title={it.path}
              >
                {it.path}
              </Link>
              <span className="hidden shrink-0 text-xs text-ink-tertiary sm:inline">
                {it.actor || "—"} · {it.projects?.slug ?? "—"}
              </span>
              <span className="shrink-0 text-xs text-ink-tertiary">{timeAgo(it.synced_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
