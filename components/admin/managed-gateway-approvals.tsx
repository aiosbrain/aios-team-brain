"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ShieldCheck, X } from "lucide-react";
import { decideManagedGatewayApproval } from "@/app/t/[team]/admin/approvals/actions";

export type ManagedGatewayApprovalRow = {
  approvalId: string;
  executionId: string;
  memberId: string;
  memberName: string;
  tool: string;
  resource: string;
  requestHashPrefix: string;
  createdAt: string;
  expiresAt: string;
  status: string;
};

function age(createdAt: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function ManagedGatewayApprovals({
  teamSlug,
  approvals,
}: {
  teamSlug: string;
  approvals: ManagedGatewayApprovalRow[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function decide(row: ManagedGatewayApprovalRow, decision: "approve" | "deny") {
    const verb = decision === "approve" ? "Approve" : "Deny";
    if (!window.confirm(`${verb} ${row.tool} for ${row.memberName}?`)) return;
    setError(null);
    setActiveId(row.approvalId);
    startTransition(async () => {
      const result = await decideManagedGatewayApproval(
        teamSlug,
        row.approvalId,
        decision,
        crypto.randomUUID(),
      );
      if (!result.ok) setError(result.error ?? "Could not decide approval.");
      else router.refresh();
      setActiveId(null);
    });
  }

  return (
    <section aria-labelledby="managed-gateway-heading" className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-5 text-violet" aria-hidden="true" />
        <div>
          <h2 id="managed-gateway-heading" className="text-base font-semibold text-ink">
            Managed gateway approvals
          </h2>
          <p className="text-sm text-ink-secondary">
            Read-only GitHub requests paused for an administrator. The queue shows only
            the member, allowlisted repository, request fingerprint prefix, and expiry.
          </p>
        </div>
      </div>

      {approvals.length === 0 ? (
        <div className="prism-card px-4 py-5 text-sm text-ink-tertiary">
          No managed gateway requests are waiting.
        </div>
      ) : (
        <div className="grid gap-3">
          {approvals.map((row) => {
            const pending = isPending && activeId === row.approvalId;
            return (
              <article key={row.approvalId} className="prism-card flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{row.memberName}</p>
                    <p className="mt-1 break-all font-mono text-xs text-ink-secondary">
                      {row.tool} · {row.resource}
                    </p>
                  </div>
                  <span className="rounded-full bg-amber/10 px-2 py-0.5 text-xs font-medium text-amber-700">
                    Pending
                  </span>
                </div>
                <dl className="grid gap-2 text-xs text-ink-tertiary sm:grid-cols-3">
                  <div>
                    <dt className="font-medium text-ink-secondary">Request</dt>
                    <dd className="font-mono">{row.requestHashPrefix}…</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-ink-secondary">Age</dt>
                    <dd
                      suppressHydrationWarning
                      title={new Date(row.createdAt).toLocaleString()}
                    >
                      {age(row.createdAt)}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium text-ink-secondary">Expires</dt>
                    <dd>{new Date(row.expiresAt).toLocaleString()}</dd>
                  </div>
                </dl>
                <div className="flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => decide(row, "deny")}
                    disabled={isPending}
                    className="flex items-center gap-1 rounded-lg border border-red/40 bg-red/10 px-3 py-1.5 text-xs font-medium text-red outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-red/40 disabled:opacity-50"
                  >
                    <X className="size-3.5" aria-hidden="true" />
                    {pending ? "Working…" : "Deny"}
                  </button>
                  <button
                    type="button"
                    onClick={() => decide(row, "approve")}
                    disabled={isPending}
                    className="flex items-center gap-1 rounded-lg border border-emerald/40 bg-emerald/10 px-3 py-1.5 text-xs font-medium text-emerald-700 outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-emerald/40 disabled:opacity-50"
                  >
                    <Check className="size-3.5" aria-hidden="true" />
                    {pending ? "Working…" : "Approve"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {error ? (
        <p role="alert" className="text-sm text-red">
          {error}
        </p>
      ) : null}
    </section>
  );
}
