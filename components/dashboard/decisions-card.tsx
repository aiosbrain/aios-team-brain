import Link from "next/link";
import { Gavel } from "lucide-react";
import { fmtDate, truncate, stripMarkdown } from "@/components/format";
import type { DecisionRow } from "./types";

const TIER_LABEL: Record<number, string> = { 1: "1-way", 2: "2-way", 3: "minor" };

export function DecisionsCard({
  teamSlug,
  decisions,
}: {
  teamSlug: string;
  decisions: DecisionRow[];
}) {
  return (
    <section className="prism-card px-5 py-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
        <Gavel className="size-3.5 text-amber" /> Recent decisions
      </h2>
      {decisions.length === 0 ? (
        <p className="text-sm text-ink-tertiary">
          No decisions logged yet —{" "}
          <Link
            href={`/t/${teamSlug}/decisions`}
            className="text-violet underline underline-offset-2"
          >
            see the log
          </Link>
          .
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {decisions.map((d) => {
            // Link to the source it was recorded in (decision-log doc / meeting); fall back to the log.
            const href = d.source_item_id
              ? `/t/${teamSlug}/library/${d.source_item_id}`
              : `/t/${teamSlug}/decisions`;
            return (
              <li key={d.id} className="flex items-start justify-between gap-2">
                <Link
                  href={href}
                  className={`text-sm transition-colors hover:text-violet ${
                    d.still_valid ? "text-ink-secondary" : "text-ink-tertiary line-through"
                  }`}
                >
                  {truncate(stripMarkdown(d.title), 64)}
                </Link>
                <span className="shrink-0 text-[11px] text-ink-tertiary">
                  {d.tier ? TIER_LABEL[d.tier] ?? `T${d.tier}` : ""} · {fmtDate(d.decided_at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
