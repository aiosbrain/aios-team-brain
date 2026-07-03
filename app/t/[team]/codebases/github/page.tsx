import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, GitBranch } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { canSeeCodebases } from "@/lib/codebases/visibility";
import { getCodebaseFreshness, type CodebaseFreshness } from "@/lib/metrics/codebases";
import { fetchRepoHeadSha } from "@/lib/codebases/github";

export const metadata: Metadata = { title: "Codebases · GitHub" };

type Freshness = "fresh" | "stale" | "unknown";

interface RepoRow extends CodebaseFreshness {
  liveSha: string | null;
  freshness: Freshness;
}

/** Resolve each codebase's live branch HEAD (best-effort) and classify freshness. */
async function withLiveHead(rows: CodebaseFreshness[], token: string | undefined): Promise<RepoRow[]> {
  return Promise.all(
    rows.map(async (cb): Promise<RepoRow> => {
      if (!token || !cb.full_name) return { ...cb, liveSha: null, freshness: "unknown" };
      try {
        const liveSha = await fetchRepoHeadSha(cb.full_name, token, cb.default_branch || "main");
        const freshness: Freshness =
          cb.last_scanned_sha == null ? "stale" : liveSha === cb.last_scanned_sha ? "fresh" : "stale";
        return { ...cb, liveSha, freshness };
      } catch {
        // Degrade to unknown on any GitHub error (bad token, private repo, rate limit) — never throw.
        return { ...cb, liveSha: null, freshness: "unknown" };
      }
    })
  );
}

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "—");

function FreshnessBadge({ f }: { f: Freshness }) {
  const styles: Record<Freshness, string> = {
    fresh: "bg-emerald/10 text-emerald-700",
    stale: "bg-amber/10 text-amber-700",
    unknown: "bg-surface-overlay text-ink-tertiary",
  };
  const label: Record<Freshness, string> = { fresh: "Up to date", stale: "Scan stale", unknown: "Unknown" };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[f]}`}>{label[f]}</span>;
}

export default async function CodebasesGithubPage({ params }: { params: Promise<{ team: string }> }) {

  const { team: teamSlug } = await params;
  const supabase = await serverClient();
  const { data: team } = await supabase.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const me = await currentMember(team.id);
  if (!me) return null;

  const base = `/t/${teamSlug}`;

  if (!canSeeCodebases(me.tier)) {
    return (
      <div className="mx-auto max-w-3xl">
        <p className="prism-card px-4 py-6 text-sm text-ink-secondary">
          Codebase scanning is visible to team members only.
        </p>
      </div>
    );
  }

  // Read helper enforces the team-tier gate; live HEAD compare is best-effort and never blocks.
  const freshness = await getCodebaseFreshness(supabase, team.id, me.tier);
  const rows = await withLiveHead(freshness, process.env.GITHUB_TOKEN);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link href={`${base}/codebases`} className="flex w-fit items-center gap-1 text-xs text-ink-tertiary hover:text-ink">
          <ArrowLeft className="size-3.5" /> Codebases
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-ink">
          <GitBranch className="size-6" /> GitHub scans
        </h1>
        <p className="text-sm text-ink-secondary">
          Which repos are scanned, how fresh each scan is, and how to re-scan. Scans run from the
          ingestion sidecar — there is no server-triggered scan. Pick repos and link members in{" "}
          <Link href={`${base}/admin/integrations`} className="text-violet hover:underline">
            Admin → Integrations
          </Link>{" "}
          and{" "}
          <Link href={`${base}/admin/members`} className="text-violet hover:underline">
            Admin → Members
          </Link>
          .
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="prism-card flex flex-col items-center gap-2 px-6 py-10 text-center">
          <GitBranch className="size-7 text-ink-tertiary" strokeWidth={1.5} />
          <p className="text-sm text-ink-secondary">
            No codebases scanned yet. Run the manual scan command below against a checked-out repo.
          </p>
        </div>
      ) : (
        <div className="prism-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left text-xs uppercase tracking-wide text-ink-tertiary">
                <th className="px-4 py-3">Repo</th>
                <th className="px-4 py-3">Last scan</th>
                <th className="px-4 py-3">Scanned SHA</th>
                <th className="px-4 py-3">{process.env.GITHUB_TOKEN ? `Live HEAD` : "Status"}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((cb) => (
                <tr key={cb.id} className="border-b border-border-subtle last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium text-ink">{cb.full_name || cb.slug}</div>
                    <div className="font-mono text-xs text-ink-tertiary">{cb.default_branch || "main"}</div>
                  </td>
                  <td className="px-4 py-3 text-ink-secondary">
                    {cb.last_scan_at ? new Date(cb.last_scan_at).toLocaleString() : "never"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-secondary">{short(cb.last_scanned_sha)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <FreshnessBadge f={cb.freshness} />
                      {cb.liveSha ? <span className="font-mono text-xs text-ink-tertiary">{short(cb.liveSha)}</span> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="prism-card flex flex-col gap-2 px-4 py-4">
        <p className="text-sm font-medium text-ink">Manual scan</p>
        <p className="text-xs text-ink-secondary">
          From a local checkout of the repo, run the ingestion sidecar scanner. The GitHub token is
          read from <code className="font-mono">GITHUB_TOKEN</code> in your environment — never pass
          it as a flag.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-surface-overlay px-3 py-2 text-xs text-ink">
          <code>{`GITHUB_TOKEN=… aios-ingest scan \\
  --path ./<local-checkout> \\
  --slug <codebase-slug> \\
  --full-name <owner/repo>`}</code>
        </pre>
        <p className="text-xs text-ink-tertiary">
          Re-running with the same commit is idempotent (the brain dedups by head SHA); a new commit
          adds one trend point and refreshes the badge above.
        </p>
      </div>
    </div>
  );
}
