import Link from "next/link";
import { Star, CircleDot } from "lucide-react";
import type { CodebaseSummary } from "@/lib/metrics/codebases";
import { timeAgo } from "@/components/format";
import { Sparkline } from "@/components/sparkline";
import { ScoreRing } from "./score-ring";

export function CodebaseCard({ teamSlug, cb }: { teamSlug: string; cb: CodebaseSummary }) {
  return (
    <Link
      href={`/t/${teamSlug}/codebases/${cb.slug}`}
      className="prism-card prism-card-hover flex flex-col gap-4 px-5 py-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-display text-lg text-ink">{cb.slug}</h2>
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
        {cb.readiness_level ? (
          <span
            title={`AEM agent-readiness${cb.readiness_pct == null ? "" : ` — ${cb.readiness_pct}% of checks`}`}
            className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] font-semibold text-ink-secondary"
          >
            {cb.readiness_level} ready
          </span>
        ) : null}
        <span className="ml-auto">
          <Sparkline data={cb.spark} width={72} height={22} className="text-violet" />
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
