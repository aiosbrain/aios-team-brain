import type { Metadata } from "next";
import Link from "next/link";
import { GitBranch } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { getCodebaseSummaries } from "@/lib/metrics/codebases";
import { parseRange } from "@/lib/metrics/range";
import { EmptyState } from "@/components/empty-state";
import { KpiBand } from "@/components/dashboard/kpi-band";
import { RangeSelector } from "@/components/dashboard/range-selector";
import { CodebaseCard } from "@/components/codebases/codebase-card";

export const metadata: Metadata = { title: "Codebases" };

export default async function CodebasesPage({
  params,
  searchParams,
}: {
  params: Promise<{ team: string }>;
  searchParams: Promise<{ range?: string }>;
}) {

  const { team: teamSlug } = await params;
  const range = parseRange((await searchParams).range);
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const me = await currentMember(team.id);
  if (!me) return null;

  // Read helper enforces the team-tier gate (external → empty).
  const { codebases, kpis } = await getCodebaseSummaries(db, team.id, range, me.tier);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Codebases</h1>
          <p className="text-sm text-ink-secondary">
            Health, coverage, and AI-transformation across the team&apos;s repos.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/t/${teamSlug}/codebases/github`}
            className="flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-sm text-ink-secondary hover:text-ink"
          >
            <GitBranch className="size-4" /> GitHub scans
          </Link>
          <RangeSelector value={range} />
        </div>
      </div>

      {codebases.length === 0 ? (
        <EmptyState
          icon={GitBranch}
          title="No codebases scanned yet"
          action="Codebases appear after the first scan. Run the ingestion sidecar scanner (`aios-ingest scan`) against a repo, or POST a scan to /api/v1/codebases with a team-tier key."
        />
      ) : (
        <>
          <KpiBand kpis={kpis} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {codebases.map((cb) => (
              <CodebaseCard key={cb.id} teamSlug={teamSlug} cb={cb} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
