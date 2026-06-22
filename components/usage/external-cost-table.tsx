import type { ExternalMemberCosts } from "@/lib/metrics/external-costs";

function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function initial(name: string): string {
  return (name || "?").slice(0, 1).toUpperCase();
}

/** External AI provider spend per member (usage_costs). */
export function ExternalCostTable({ rows }: { rows: ExternalMemberCosts[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-tertiary">
        No external AI spend recorded in this window. Run{" "}
        <code className="text-xs">aios analyze --push</code> from your workstation.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {rows.map((r) => (
        <div key={r.member_id ?? "unattributed"} className="prism-card overflow-x-auto">
          <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
            {r.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={r.avatar_url} alt="" className="size-6 rounded-full" />
            ) : (
              <span className="flex size-6 items-center justify-center rounded-full bg-surface-inset text-[10px] font-medium text-ink-tertiary">
                {initial(r.member_name)}
              </span>
            )}
            <span className="font-medium text-ink">{r.member_name}</span>
            <span className="ml-auto font-medium text-emerald">{fmtUsd(r.cost_usd)}</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-ink-tertiary">
                <th className="px-4 py-2 font-medium">Provider</th>
                <th className="px-4 py-2 font-medium">Source</th>
                <th className="px-4 py-2 font-medium">Project</th>
                <th className="px-4 py-2 font-medium">Events</th>
                <th className="px-4 py-2 font-medium">Tokens</th>
                <th className="px-4 py-2 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {r.providers.map((p) => (
                <tr
                  key={`${p.provider}-${p.source}-${p.project}`}
                  className="border-b border-border-subtle last:border-0"
                >
                  <td className="px-4 py-2 capitalize text-ink">{p.provider}</td>
                  <td className="px-4 py-2 text-ink-secondary">{p.source}</td>
                  <td className="px-4 py-2 text-ink-secondary">{p.project || "—"}</td>
                  <td className="px-4 py-2 text-ink-secondary">{fmtNum(p.events)}</td>
                  <td className="px-4 py-2 text-ink-secondary">{fmtNum(p.total_tokens)}</td>
                  <td className="px-4 py-2 font-medium text-emerald">{fmtUsd(p.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
