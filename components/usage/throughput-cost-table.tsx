import type { ThroughputCostRow } from "@/lib/metrics/members";
import { MemberAvatar } from "@/components/people/member-avatar";

function fmtUsd(n: number | null): string {
  if (n == null) return "—";
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

/**
 * Throughput vs. brain cost (W1.2.3): code_contributions (AI commits) × query_log spend →
 * "$ per AI commit" per contributor. Spend is brain-only (external-provider spend is Wave 2).
 */
export function ThroughputCostTable({ rows }: { rows: ThroughputCostRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-tertiary">
        No attributed code contributions in this window.
      </p>
    );
  }
  return (
    <div className="prism-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-ink-tertiary">
            <th className="px-4 py-3 font-medium">Contributor</th>
            <th className="px-4 py-3 font-medium">AI commits</th>
            <th className="px-4 py-3 font-medium">Commits</th>
            <th className="px-4 py-3 font-medium">Brain cost</th>
            <th className="px-4 py-3 font-medium">$ / AI commit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.member_id} className="border-b border-border-subtle last:border-0">
              <td className="px-4 py-3">
                <span className="flex items-center gap-2">
                  <MemberAvatar
                    person={{ displayName: r.member_name, avatarUrl: r.avatar_url, avatarDataUrl: r.avatar_data_url }}
                    size={24}
                  />
                  <span className="font-medium text-ink">{r.member_name}</span>
                </span>
              </td>
              <td className="px-4 py-3 text-ink-secondary">{r.ai_commits}</td>
              <td className="px-4 py-3 text-ink-secondary">{r.commits}</td>
              <td className="px-4 py-3 text-emerald">{fmtUsd(r.cost_usd)}</td>
              <td className="px-4 py-3 font-medium text-ink">{fmtUsd(r.cost_per_ai_commit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
