import type { ContributorRow } from "@/lib/metrics/codebases";

function pct(ai: number, total: number): number {
  return total === 0 ? 0 : Math.round((100 * ai) / total);
}

export function ContributorTable({ rows }: { rows: ContributorRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-ink-tertiary">No contributions in this window.</p>;
  }
  return (
    <div className="prism-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-ink-tertiary">
            <th className="px-4 py-3 font-medium">Contributor</th>
            <th className="px-4 py-3 font-medium">Commits</th>
            <th className="px-4 py-3 font-medium">AI-assisted</th>
            <th className="px-4 py-3 font-medium">+/−</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const ai = pct(r.ai_commits, r.commits);
            return (
              <tr key={r.author_key} className="border-b border-border-subtle last:border-0">
                <td className="px-4 py-3">
                  <span className="font-medium text-ink">
                    {r.member_name ?? r.author_name ?? r.author_key}
                  </span>
                  {!r.member_id ? (
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-ink-tertiary">
                      unmapped
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-ink-secondary">{r.commits}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-inset">
                      <div className="h-full rounded-full bg-violet" style={{ width: `${ai}%` }} />
                    </div>
                    <span className="text-xs text-ink-tertiary">{ai}%</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-xs">
                  <span className="text-emerald">+{r.additions}</span>{" "}
                  <span className="text-red">−{r.deletions}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
