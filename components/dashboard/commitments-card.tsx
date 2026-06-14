import { AlertTriangle } from "lucide-react";
import { truncate } from "@/components/format";
import type { CommitmentRow } from "./types";

const BADGE: Record<string, string> = {
  open: "bg-blue/8 text-blue border-blue/25",
  at_risk: "bg-amber/10 text-amber-700 border-amber/30",
  overdue: "bg-red/8 text-red border-red/25",
  broken: "bg-red/15 text-red border-red/40",
};

export function CommitmentsCard({ commitments }: { commitments: CommitmentRow[] }) {
  return (
    <section className="prism-card px-5 py-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
        <AlertTriangle className="size-3.5 text-amber" /> Commitments at risk
      </h2>
      {commitments.length === 0 ? (
        <p className="text-sm text-ink-tertiary">No open or at-risk commitments.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {commitments.map((c) => {
            const status = String(c.attrs?.status ?? "open");
            const badge = BADGE[status] ?? BADGE.open;
            return (
              <li key={c.id} className="flex items-start justify-between gap-2">
                <span className="text-sm text-ink-secondary">
                  {truncate(c.name || String(c.attrs?.description ?? c.entity_id), 70)}
                </span>
                <span
                  className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge}`}
                >
                  {status.replace("_", " ")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
