import type { MemberCostRow } from "@/lib/metrics/members";

function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function initial(r: MemberCostRow): string {
  return (r.member_name || "?").slice(0, 1).toUpperCase();
}

/** Brain spend per member (query_log). Reuses the codebases contributor-table visual language. */
export function MemberCostTable({ rows }: { rows: MemberCostRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-ink-tertiary">No brain usage in this window.</p>;
  }
  return (
    <div className="prism-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-ink-tertiary">
            <th className="px-4 py-3 font-medium">Member</th>
            <th className="px-4 py-3 font-medium">Queries</th>
            <th className="px-4 py-3 font-medium">Tokens</th>
            <th className="px-4 py-3 font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.member_id ?? "unattributed"}
              className="border-b border-border-subtle last:border-0"
            >
              <td className="px-4 py-3">
                <span className="flex items-center gap-2">
                  {r.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.avatar_url} alt="" className="size-6 rounded-full" />
                  ) : (
                    <span className="flex size-6 items-center justify-center rounded-full bg-surface-inset text-[10px] font-medium text-ink-tertiary">
                      {initial(r)}
                    </span>
                  )}
                  <span className="font-medium text-ink">{r.member_name}</span>
                  {!r.member_id ? (
                    <span className="text-[10px] uppercase tracking-wider text-ink-tertiary">
                      unattributed
                    </span>
                  ) : null}
                </span>
              </td>
              <td className="px-4 py-3 text-ink-secondary">{fmtNum(r.queries)}</td>
              <td className="px-4 py-3 text-ink-secondary">
                {fmtNum(r.total_tokens)}
                <span className="ml-1 text-xs text-ink-tertiary">
                  ({fmtNum(r.input_tokens)} in / {fmtNum(r.output_tokens)} out)
                </span>
              </td>
              <td className="px-4 py-3 font-medium text-emerald">{fmtUsd(r.cost_usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
