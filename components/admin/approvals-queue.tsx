"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X, Clock } from "lucide-react";
import { decideApproval } from "@/app/t/[team]/admin/approvals/actions";

export interface ApprovalRow {
  id: string;
  requested_by_actor: string;
  action: string;
  resource: string;
  context: Record<string, unknown>;
  created_at: string;
}

export interface DecidedRow {
  id: string;
  requested_by_actor: string;
  action: string;
  resource: string;
  status: string;
  decided_at: string | null;
  decision_note: string;
}

export function ApprovalsQueue({ teamSlug, pending, recent }: { teamSlug: string; pending: ApprovalRow[]; recent: DecidedRow[] }) {
  const router = useRouter();
  const [pendingTx, startTransition] = useTransition();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function decide(id: string, decision: "approved" | "denied") {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await decideApproval(teamSlug, id, decision, notes[id]);
      if (!res.ok) return setError(res.error ?? "could not decide");
      setNotice(res.message ?? "Done.");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-2 text-sm font-medium text-ink"><Clock className="size-4 text-amber-600" /> Pending ({pending.length})</p>
        {pending.length === 0 ? (
          <p className="text-sm text-ink-tertiary">Nothing waiting for approval.</p>
        ) : (
          pending.map((a) => (
            <div key={a.id} className="prism-card flex flex-col gap-2 p-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="rounded-full bg-amber/10 px-2 py-0.5 font-mono text-xs text-amber-700">{a.action}</span>
                <span className="font-mono text-xs text-ink-secondary">{a.resource}</span>
                <span className="text-xs text-ink-tertiary">requested by <span className="font-mono">{a.requested_by_actor || "—"}</span> · {new Date(a.created_at).toLocaleString()}</span>
              </div>
              {a.context && Object.keys(a.context).length ? (
                <pre className="max-h-32 overflow-auto rounded-lg bg-surface-overlay p-2 text-xs text-ink-secondary">{JSON.stringify(a.context, null, 2)}</pre>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="prism-input h-8 flex-1 px-2 py-0 text-xs"
                  placeholder="note (optional)"
                  value={notes[a.id] ?? ""}
                  onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })}
                />
                <button onClick={() => decide(a.id, "approved")} disabled={pendingTx} className="flex items-center gap-1 rounded-lg border border-emerald/40 bg-emerald/10 px-3 py-1 text-xs font-medium text-emerald-700 disabled:opacity-50"><Check className="size-3.5" /> Approve</button>
                <button onClick={() => decide(a.id, "denied")} disabled={pendingTx} className="flex items-center gap-1 rounded-lg border border-red/40 bg-red/10 px-3 py-1 text-xs font-medium text-red disabled:opacity-50"><X className="size-3.5" /> Deny</button>
              </div>
            </div>
          ))
        )}
        {error ? <p className="text-sm text-red">{error}</p> : null}
        {notice ? <p className="text-sm text-emerald-700">{notice}</p> : null}
      </div>

      {recent.length ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-ink-secondary">Recently decided</p>
          <div className="prism-card divide-y divide-border-subtle">
            {recent.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs">
                <span className={`rounded-full px-2 py-0.5 ${a.status === "approved" ? "bg-emerald/10 text-emerald-700" : "bg-red/10 text-red"}`}>{a.status}</span>
                <span className="font-mono text-ink">{a.action}</span>
                <span className="font-mono text-ink-tertiary">{a.resource}</span>
                <span className="text-ink-tertiary">{a.decided_at ? new Date(a.decided_at).toLocaleString() : ""}</span>
                {a.decision_note ? <span className="text-ink-tertiary">— {a.decision_note}</span> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
