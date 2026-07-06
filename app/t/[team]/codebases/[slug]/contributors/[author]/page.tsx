import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { getContributorDetail, type ContributorRef } from "@/lib/metrics/codebases";
import { parseRange } from "@/lib/metrics/range";
import { RangeSelector } from "@/components/dashboard/range-selector";
import { CommitHeatmap } from "@/components/codebases/commit-heatmap";

export const metadata: Metadata = { title: "Contributor" };

function parseAuthor(author: string): ContributorRef | null {
  const decoded = decodeURIComponent(author);
  if (decoded.startsWith("m:")) return { memberId: decoded.slice(2) };
  if (decoded.startsWith("a:")) return { authorKey: decoded.slice(2) };
  return null;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="prism-card px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-ink-tertiary">{label}</p>
      <p className="mt-1 text-xl font-semibold text-ink">{value}</p>
    </div>
  );
}

export default async function ContributorPage({
  params,
  searchParams,
}: {
  params: Promise<{ team: string; slug: string; author: string }>;
  searchParams: Promise<{ range?: string }>;
}) {

  const { team: teamSlug, slug, author } = await params;
  const ref = parseAuthor(author);
  if (!ref) notFound();
  const range = parseRange((await searchParams).range);
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;
  const me = await currentMember(team.id);
  if (!me) return null;

  const c = await getContributorDetail(db, team.id, slug, ref, range, me.tier);
  if (!c) notFound();

  const aiPct = c.totals.commits ? Math.round((100 * c.totals.ai_commits) / c.totals.commits) : 0;
  const profileHandle = c.github_login ?? c.member_id;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div>
        <Link
          href={`/t/${teamSlug}/codebases/${slug}`}
          className="inline-flex items-center gap-1 text-xs text-ink-tertiary hover:text-ink-secondary"
        >
          <ArrowLeft className="size-3" /> {slug}
        </Link>
        <div className="mt-2 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            {c.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={c.avatar_url} alt="" className="size-12 rounded-full" />
            ) : (
              <span className="flex size-12 items-center justify-center rounded-full bg-surface-inset text-lg font-medium text-ink-tertiary">
                {c.name.slice(0, 1).toUpperCase()}
              </span>
            )}
            <div>
              <h1 className="font-display text-2xl font-semibold text-ink">{c.name}</h1>
              <div className="mt-0.5 flex items-center gap-3 text-xs text-ink-tertiary">
                {c.github_login ? (
                  <a
                    href={`https://github.com/${c.github_login}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-violet"
                  >
                    @{c.github_login}
                  </a>
                ) : null}
                {c.member_id && profileHandle ? (
                  <Link href={`/t/${teamSlug}/people/${profileHandle}`} className="hover:text-violet">
                    full profile →
                  </Link>
                ) : (
                  <span className="uppercase tracking-wider">unmapped author</span>
                )}
              </div>
            </div>
          </div>
          <RangeSelector value={range} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Commits" value={c.totals.commits} />
        <Stat label="AI-assisted" value={`${aiPct}%`} />
        <Stat label="Active days" value={c.totals.active_days} />
        <Stat label="Lines" value={`+${c.totals.additions} −${c.totals.deletions}`} />
      </div>

      <section className="prism-card flex flex-col gap-3 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          Commit activity in {slug}
        </h2>
        <CommitHeatmap days={c.days} />
      </section>
    </div>
  );
}
