import type { Metadata } from "next";
import { serverClient } from "@/lib/supabase/server";
import { ProjectBoardButton } from "./project-board-button";

export const metadata: Metadata = { title: "PM sync" };

export default async function PmSyncPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const supabase = await serverClient();
  const { data: team } = await supabase
    .from("teams")
    .select("id, primary_pm_provider")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null;

  const [{ data: unresolved }, { data: failedLinks }] = await Promise.all([
    supabase
      .from("work_events")
      .select("row_key, repo, merged_sha, pr_url, pr_title, error, created_at")
      .eq("team_id", team.id)
      .eq("status", "unresolved")
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("task_pm_links")
      .select("row_key, provider, provider_external_id, provider_url, last_error, updated_at")
      .eq("team_id", team.id)
      .not("last_error", "is", null)
      .order("updated_at", { ascending: false })
      .limit(50),
  ]);

  return (
    <div className="flex flex-col gap-5">
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
                <th className="py-2 pr-4 font-medium">Error</th>
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
                  <td className="py-2 pr-4 text-red">{e.error || "unresolved"}</td>
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
