import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Star, GitFork, CircleDot } from "lucide-react";
import { isPostgresBackend } from "@/lib/db/backend";
import { serverClient } from "@/lib/supabase/server";
import { currentMember } from "@/lib/auth/guard";
import { getCodebaseDetail } from "@/lib/metrics/codebases";
import { parseRange } from "@/lib/metrics/range";
import { timeAgo } from "@/components/format";
import { RangeSelector } from "@/components/dashboard/range-selector";
import { AgenticBreakdownCard } from "@/components/codebases/agentic-breakdown";
import { ContributorTable } from "@/components/codebases/contributor-table";
import { IssuesList } from "@/components/codebases/issues-list";
import { AgenticTrend } from "@/components/charts/agentic-trend";

export const metadata: Metadata = { title: "Codebase" };

export default async function CodebaseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ team: string; slug: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  if (!isPostgresBackend()) notFound();

  const { team: teamSlug, slug } = await params;
  const range = parseRange((await searchParams).range);
  const supabase = await serverClient();

  const { data: team } = await supabase.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const me = await currentMember(team.id);
  if (!me) return null;

  const cb = await getCodebaseDetail(supabase, team.id, slug, range, me.tier);
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
            <h1 className="font-display text-2xl font-semibold text-ink">{cb.slug}</h1>
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

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        {cb.breakdown ? <AgenticBreakdownCard b={cb.breakdown} /> : null}
        <AgenticTrend data={cb.trend} />
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          Contributors
        </h2>
        <ContributorTable rows={cb.contributors} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          Issues &amp; PRs
        </h2>
        <IssuesList issues={cb.issues} />
      </section>
    </div>
  );
}
