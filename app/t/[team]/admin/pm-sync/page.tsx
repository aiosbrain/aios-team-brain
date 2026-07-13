import type { Metadata } from "next";
import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { classifyInboundRow, loadInboundRows } from "@/lib/pm-sync/inbound";
import { getProjectionHealth, listRecentProjectionRuns } from "@/lib/pm-sync/runs";
import { ProjectionHealthCard } from "@/components/admin/projection-health-card";
import { IngestRunsPanel } from "@/components/admin/ingest-runs-panel";
import { ProjectBoardButton } from "./project-board-button";
import { ReconcileButton } from "./reconcile-button";

export const metadata: Metadata = { title: "PM sync" };

export default async function PmSyncPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const db = await serverClient();
  const { data: team } = await db
    .from("teams")
    .select("id, primary_pm_provider")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null;

  const [{ data: unresolved }, { data: failedLinks }, inboundRows, projectionHealth, projectionRuns] = await Promise.all([
    db
      .from("work_events")
      .select("row_key, repo, merged_sha, pr_url, pr_title, error, created_at")
      .eq("team_id", team.id)
      .eq("status", "unresolved")
      .order("created_at", { ascending: false })
      .limit(50),
    db
      .from("task_pm_links")
      .select("row_key, provider, provider_external_id, provider_url, last_error, updated_at")
      .eq("team_id", team.id)
      .not("last_error", "is", null)
      .order("updated_at", { ascending: false })
      .limit(50),
    // Inbound divergence (brain-api v1.4): the enriched read the inbound engine itself uses —
    // links + task rows + the exact brain-status baseline — so the page deterministically
    // recomputes "conflict (both changed)" vs "pending apply" from persisted data alone.
    loadInboundRows(db, team.id),
    // AIO-357: last-run + staleness for the outbound projection engine itself, read via the
    // service-role client (ingest_runs has no per-team RLS-equivalent read helper besides this).
    getProjectionHealth(adminClient(), team.id),
    listRecentProjectionRuns(adminClient(), team.id, 20),
  ]);

  const divergences = inboundRows
    .map((row) => ({ row, state: classifyInboundRow(row) }))
    .filter((d) => d.state !== "in_sync")
    .map(({ row, state }) => ({
      row_key: row.link.row_key,
      provider: row.link.provider,
      provider_url: row.link.provider_url,
      last_projected_status: row.link.last_projected_status,
      provider_seen_status: row.link.provider_seen_status,
      state,
    }));

  return (
    <div className="flex flex-col gap-5">
      <ProjectionHealthCard health={projectionHealth} />

      <section className="prism-card p-4" data-section="recent-projection-runs">
        <h2 className="text-lg font-semibold text-ink">Recent projection runs</h2>
        <p className="mt-1 text-sm text-ink-secondary">
          Every reactive push-triggered projection, every manual <span className="font-medium text-ink">Project board now</span>,
          and every CLI <code>project</code> run, with its outcome — so a task edit that didn&apos;t reach the PM tool is diagnosable here.
        </p>
        <div className="mt-4">
          <IngestRunsPanel runs={projectionRuns} />
        </div>
      </section>

      <section className="prism-card p-4">
        <h2 className="text-lg font-semibold text-ink">Project board</h2>
        <p className="mt-1 text-sm text-ink-secondary">
          The brain is the source of truth. This projects every task into the primary PM tool
          (create/update/state, one-way, brain wins). Re-running is idempotent — unchanged rows are skipped.
        </p>
        <div className="mt-4">
          <ProjectBoardButton
            teamSlug={teamSlug}
            primaryProvider={(team as { primary_pm_provider: string | null }).primary_pm_provider}
          />
        </div>
      </section>

      <section className="prism-card p-4" data-section="inbound-divergence">
        <h2 className="text-lg font-semibold text-ink">Inbound divergence</h2>
        <p className="mt-1 text-sm text-ink-secondary">
          Tasks whose state in the PM tool has drifted from what the brain last projected.
          With inbound apply enabled, a <span className="font-medium text-ink">pending apply</span> row
          is written to the brain on the next sync (the brain hadn&apos;t changed); a{" "}
          <span className="font-medium text-ink">conflict</span> means both sides changed — it is
          surfaced here for a human and never auto-merged.
        </p>
        <div className="mt-4">
          <ReconcileButton
            teamSlug={teamSlug}
            primaryProvider={(team as { primary_pm_provider: string | null }).primary_pm_provider}
          />
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-ink-tertiary">
              <tr>
                <th className="py-2 pr-4 font-medium">Key</th>
                <th className="py-2 pr-4 font-medium">Provider</th>
                <th className="py-2 pr-4 font-medium">Brain projected</th>
                <th className="py-2 pr-4 font-medium">Seen in tool</th>
                <th className="py-2 pr-4 font-medium">Resolution</th>
              </tr>
            </thead>
            <tbody>
              {divergences.map((d) => (
                <tr key={`${d.provider}-${d.row_key}`} data-divergence={d.row_key} className="border-t border-border-subtle">
                  <td className="py-2 pr-4 font-mono text-xs">{d.row_key}</td>
                  <td className="py-2 pr-4">
                    {d.provider_url ? <a className="text-violet" href={d.provider_url}>{d.provider}</a> : d.provider}
                  </td>
                  <td className="py-2 pr-4 text-ink-secondary">{d.last_projected_status}</td>
                  <td className="py-2 pr-4 font-medium text-amber-700">{d.provider_seen_status}</td>
                  <td className="py-2 pr-4" data-resolution={d.state}>
                    {d.state === "conflict" ? (
                      <span className="font-medium text-red">conflict — both changed</span>
                    ) : (
                      <span className="text-ink-secondary">pending apply</span>
                    )}
                  </td>
                </tr>
              ))}
              {divergences.length === 0 ? (
                <tr><td colSpan={5} className="py-4 text-ink-tertiary">No divergence detected.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="prism-card p-4">
        <h2 className="text-lg font-semibold text-ink">Unresolved merge events</h2>
        <p className="mt-1 text-sm text-ink-secondary">
          Merged work that did not match a task row. Add or link the task key, then replay the event.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-ink-tertiary">
              <tr>
                <th className="py-2 pr-4 font-medium">Key</th>
                <th className="py-2 pr-4 font-medium">PR</th>
                <th className="py-2 pr-4 font-medium">Repo</th>
                <th className="py-2 pr-4 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {(unresolved ?? []).map((e) => (
                <tr key={`${e.repo}-${e.merged_sha}-${e.row_key}`} className="border-t border-border-subtle">
                  <td className="py-2 pr-4 font-mono text-xs">{e.row_key}</td>
                  <td className="py-2 pr-4">
                    {e.pr_url ? <a className="text-violet" href={e.pr_url}>{e.pr_title || e.pr_url}</a> : e.pr_title || "—"}
                  </td>
                  <td className="py-2 pr-4 text-ink-secondary">{e.repo}</td>
                  <td className="py-2 pr-4 text-ink-secondary">{e.error || "unresolved"}</td>
                </tr>
              ))}
              {(unresolved ?? []).length === 0 ? (
                <tr><td colSpan={4} className="py-4 text-ink-tertiary">No unresolved events.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="prism-card p-4">
        <h2 className="text-lg font-semibold text-ink">Provider sync failures</h2>
        <p className="mt-1 text-sm text-ink-secondary">
          Linked tasks whose latest Plane/Linear update failed. Secrets are never shown here.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-ink-tertiary">
              <tr>
                <th className="py-2 pr-4 font-medium">Key</th>
                <th className="py-2 pr-4 font-medium">Provider</th>
                <th className="py-2 pr-4 font-medium">External ID</th>
                <th className="py-2 pr-4 font-medium">Error</th>
              </tr>
            </thead>
            <tbody>
              {(failedLinks ?? []).map((l) => (
                <tr key={`${l.provider}-${l.row_key}`} className="border-t border-border-subtle">
                  <td className="py-2 pr-4 font-mono text-xs">{l.row_key}</td>
                  <td className="py-2 pr-4">{l.provider}</td>
                  <td className="py-2 pr-4">
                    {l.provider_url ? <a className="text-violet" href={l.provider_url}>{l.provider_external_id}</a> : l.provider_external_id}
                  </td>
                  <td className="py-2 pr-4 text-red">{l.last_error}</td>
                </tr>
              ))}
              {(failedLinks ?? []).length === 0 ? (
                <tr><td colSpan={4} className="py-4 text-ink-tertiary">No provider failures.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
