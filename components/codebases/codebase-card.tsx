import Link from "next/link";
import { Star, CircleDot } from "lucide-react";
import type { CodebaseSummary } from "@/lib/metrics/codebases";
import { timeAgo } from "@/components/format";
import { ScoreRing } from "./score-ring";

/** Inline sparkline (agentic score over the window), inherits color via currentColor. */
function Spark({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const w = 72;
  const h = 22;
  const step = w / (data.length - 1);
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible text-violet" aria-hidden>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" opacity={0.85} />
    </svg>
  );
}

export function CodebaseCard({ teamSlug, cb }: { teamSlug: string; cb: CodebaseSummary }) {
  return (
    <Link
      href={`/t/${teamSlug}/codebases/${cb.slug}`}
      className="prism-card prism-card-hover flex flex-col gap-4 px-5 py-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-display text-lg font-semibold text-ink">{cb.slug}</h2>
          <p className="truncate font-mono text-xs text-ink-tertiary">{cb.full_name || cb.slug}</p>
        </div>
        <ScoreRing value={cb.agentic_score} label="agentic" />
      </div>

      <div className="flex items-center gap-5 text-xs text-ink-secondary">
        <span>
          <span className="font-semibold text-ink">{cb.health_score}</span> health
        </span>
        <span>
          <span className="font-semibold text-ink">
            {cb.test_coverage_pct == null ? "—" : `${cb.test_coverage_pct}%`}
          </span>{" "}
          cov
        </span>
        <span className="ml-auto">
          <Spark data={cb.spark} />
        </span>
      </div>

      <div className="mt-auto flex items-center gap-4 text-[11px] text-ink-tertiary">
        {cb.primary_language ? <span>{cb.primary_language}</span> : null}
        <span className="inline-flex items-center gap-1">
          <Star className="size-3" /> {cb.stars}
        </span>
        <span className="inline-flex items-center gap-1">
          <CircleDot className="size-3" /> {cb.open_issues}
        </span>
        <span className="ml-auto">scanned {timeAgo(cb.last_scan_at)}</span>
      </div>
    </Link>
  );
}
