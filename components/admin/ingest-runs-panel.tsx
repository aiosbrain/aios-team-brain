import { relativeAge } from "@/lib/ingest/runs-format";
import type { IngestRunRow } from "@/lib/ingest/runs";

/**
 * Admin → Integrations "Recent ingestion runs" panel. Read-only view of the `ingest_runs` log so
 * import/scan failures are diagnosable (this is the surface that turns a silent breakage into a
 * visible one). Server component: the page passes rows it already gated on (admin-only).
 */
export function IngestRunsPanel({ runs }: { runs: IngestRunRow[] }) {
  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-border-subtle bg-surface-inset px-3 py-2 text-sm text-ink-secondary">
        No ingestion runs recorded yet. Scheduler ticks, manual <code>/sync</code> runs, and codebase
        scans will appear here with their outcome and any errors.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border-subtle">
      <table className="w-full text-sm">
        <thead className="bg-surface-raised text-left text-xs uppercase tracking-wide text-ink-tertiary">
          <tr>
            <th className="px-3 py-2 font-medium">Source</th>
            <th className="px-3 py-2 font-medium">Trigger</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Changes</th>
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Details</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const when = new Date(r.finished_at).getTime();
            const changes = `+${r.created} ~${r.updated}${r.unchanged ? ` =${r.unchanged}` : ""}`;
            return (
              <tr key={r.id} className="border-t border-border-subtle align-top">
                <td className="px-3 py-2 font-medium text-ink">{r.source}</td>
                <td className="px-3 py-2 text-ink-secondary">{r.trigger}</td>
                <td className="px-3 py-2">
                  {r.ok ? (
                    <span className="rounded-full bg-emerald/10 px-2 py-0.5 text-xs font-medium text-emerald">
                      ok
                    </span>
                  ) : (
                    <span className="rounded-full bg-red/10 px-2 py-0.5 text-xs font-medium text-red">
                      failed{r.error_count ? ` (${r.error_count})` : ""}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 tabular-nums text-ink-secondary">{changes}</td>
                <td className="px-3 py-2 whitespace-nowrap text-ink-secondary" title={r.finished_at}>
                  {relativeAge(when)}
                </td>
                <td className="px-3 py-2 text-ink-tertiary">
                  {r.errors.length > 0 ? (
                    <span className="text-red" title={r.errors.join("\n")}>
                      {r.errors[0].slice(0, 120)}
                      {r.errors[0].length > 120 ? "…" : ""}
                    </span>
                  ) : (
                    <RunMeta meta={r.meta} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Render the small set of meta keys we record, compactly. */
function RunMeta({ meta }: { meta: Record<string, unknown> }) {
  const parts = Object.entries(meta)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${String(v)}`);
  return <span>{parts.join(" · ") || "—"}</span>;
}
