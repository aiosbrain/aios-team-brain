import { GitPullRequest, CircleDot } from "lucide-react";
import type { IssueRow } from "@/lib/metrics/codebases";
import { timeAgo } from "@/components/format";

export function IssuesList({ issues }: { issues: IssueRow[] }) {
  const open = issues.filter((i) => i.state === "open");
  const closed = issues.filter((i) => i.state !== "open");

  if (issues.length === 0) {
    return <p className="text-sm text-ink-tertiary">No issues synced for this repo.</p>;
  }

  return (
    <div className="prism-card divide-y divide-border-subtle">
      {[...open, ...closed].slice(0, 30).map((i) => (
        <a
          key={i.number}
          href={i.url || "#"}
          target="_blank"
          rel="noreferrer"
          className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-card-hover"
        >
          {i.is_pull_request ? (
            <GitPullRequest className="mt-0.5 size-4 shrink-0 text-blue" />
          ) : (
            <CircleDot className={`mt-0.5 size-4 shrink-0 ${i.state === "open" ? "text-emerald" : "text-ink-tertiary"}`} />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-ink">
              <span className="text-ink-tertiary">#{i.number}</span> {i.title}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-tertiary">
              {i.author_login ? <span>{i.author_login}</span> : null}
              <span>· {timeAgo(i.opened_at)}</span>
              {i.labels.slice(0, 4).map((l) => (
                <span key={l} className="rounded-full border border-border-subtle px-1.5 py-0.5">
                  {l}
                </span>
              ))}
            </div>
          </div>
        </a>
      ))}
    </div>
  );
}
