import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Star, GitFork, CircleDot, ChevronRight } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { getCodebaseDetail } from "@/lib/metrics/codebases";
import { parseRange } from "@/lib/metrics/range";
import { timeAgo } from "@/components/format";
import { RangeSelector } from "@/components/dashboard/range-selector";
import { AgenticScoreCard, AgentReadinessCard } from "@/components/codebases/agentic-breakdown";
import { ContributorTable } from "@/components/codebases/contributor-table";
import { IssuesList } from "@/components/codebases/issues-list";
import { AgenticTrend } from "@/components/charts/agentic-trend";
import { ContributionsTrend } from "@/components/charts/contributions-trend";

export const metadata: Metadata = { title: "Codebase" };

export default async function CodebaseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ team: string; slug: string }>;
  searchParams: Promise<{ range?: string }>;
}) {

  const { team: teamSlug, slug } = await params;
  const range = parseRange((await searchParams).range);
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const me = await currentMember(team.id);
  if (!me) return null;

  const cb = await getCodebaseDetail(db, team.id, slug, range, me.tier);
  if (!cb) notFound();

  const langs = Object.entries(cb.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div>
        <Link
          href={`/t/${teamSlug}/codebases`}
          className="inline-flex items-center gap-1 text-xs text-ink-tertiary hover:text-ink-secondary"
        >
          <ArrowLeft className="size-3" /> Codebases
        </Link>
        <div className="mt-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display text-2xl text-ink">{cb.slug}</h1>
            {cb.full_name ? (
              <a
                href={`https://github.com/${cb.full_name}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-xs text-ink-tertiary hover:text-violet"
              >
                {cb.full_name}
              </a>
            ) : null}
            {cb.description ? (
              <p className="mt-1 max-w-2xl text-sm text-ink-secondary">{cb.description}</p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-ink-tertiary">
              {langs.map((l) => (
                <span key={l} className="rounded-full border border-border-subtle px-2 py-0.5">
                  {l}
                </span>
              ))}
              <span className="inline-flex items-center gap-1">
                <Star className="size-3" /> {cb.stars}
              </span>
              <span className="inline-flex items-center gap-1">
                <GitFork className="size-3" /> {cb.forks}
              </span>
              <span className="inline-flex items-center gap-1">
                <CircleDot className="size-3" /> {cb.open_issues} open
              </span>
              <span>scanned {timeAgo(cb.last_scan_at)}</span>
            </div>
          </div>
          <RangeSelector value={range} />
        </div>
      </div>

      {cb.stale ? (
        <div className="rounded-lg border border-amber-400/25 bg-amber-400/10 px-4 py-2.5 text-xs text-amber-600 dark:text-amber-300">
          No recent scan — the scores below are from the last scan{" "}
          {cb.last_scan_at ? timeAgo(cb.last_scan_at) : ""}. Contribution and commit-volume charts
          only cover the selected range, so they may be empty until this repo is re-scanned.
        </div>
      ) : null}

      {/* Trend spans the full page width; the score + readiness bar cards sit side-by-side below it. */}
      <AgenticTrend data={cb.trend} />

      {cb.breakdown ? (
        cb.breakdown.readiness_level ? (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <AgenticScoreCard b={cb.breakdown} />
            <AgentReadinessCard b={cb.breakdown} />
          </div>
        ) : (
          <AgenticScoreCard b={cb.breakdown} />
        )
      ) : null}

      <ContributionsTrend data={cb.commitVolume} />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          Contributors
        </h2>
        <ContributorTable rows={cb.contributors} teamSlug={teamSlug} codebaseSlug={cb.slug} />
      </section>

      {/* Issues & PRs collapsed by default (native <details> — no client JS). */}
      <details className="group flex flex-col gap-3">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold uppercase tracking-wider text-ink-tertiary hover:text-ink-secondary">
          <ChevronRight className="size-4 shrink-0 transition-transform group-open:rotate-90" />
          Issues &amp; PRs
          <span className="font-normal normal-case text-ink-tertiary/70">({cb.issues.length})</span>
        </summary>
        <div className="mt-3">
          <IssuesList issues={cb.issues} />
        </div>
      </details>
    </div>
  );
}
