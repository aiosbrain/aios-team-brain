"use client";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { recordFindingDecision } from "@/app/t/[team]/codebases/[slug]/actions";
import type { FindingDecisionOwner } from "@/lib/metrics/codebases";

type DecisionStatus = "accepted" | "risk_accepted" | "false_positive";

function defaultExpiryDate(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 30);
  return date.toISOString().slice(0, 10);
}

export function FindingDecisionControl({
  teamSlug,
  codebaseSlug,
  findingId,
  owners,
  currentMemberId,
  existingOwnerId,
}: {
  teamSlug: string;
  codebaseSlug: string;
  findingId: string;
  owners: FindingDecisionOwner[];
  currentMemberId: string;
  existingOwnerId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<DecisionStatus>("risk_accepted");
  const [ownerMemberId, setOwnerMemberId] = useState(
    existingOwnerId ??
      (owners.some((owner) => owner.id === currentMemberId)
        ? currentMemberId
        : (owners[0]?.id ?? "")),
  );
  const [reason, setReason] = useState("");
  const [expiresOn, setExpiresOn] = useState(defaultExpiryDate);
  const [message, setMessage] = useState<{
    tone: "error" | "success";
    text: string;
  } | null>(null);
  const minimumExpiry = useMemo(
    () => new Date().toISOString().slice(0, 10),
    [],
  );
  const prefix = `finding-decision-${findingId}`;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const expiresAt = new Date(`${expiresOn}T23:59:59.000Z`).toISOString();
    startTransition(async () => {
      const result = await recordFindingDecision(teamSlug, codebaseSlug, {
        findingId,
        ownerMemberId,
        status,
        reason,
        expiresAt,
      });
      if (!result.ok) {
        setMessage({
          tone: "error",
          text: result.error ?? "could not record decision",
        });
        return;
      }
      setReason("");
      setMessage({
        tone: "success",
        text: "Decision recorded in finding history.",
      });
      router.refresh();
    });
  }

  return (
    <details className="group/decision border-t border-border-subtle pt-3">
      <summary className="cursor-pointer list-none text-xs font-medium text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50">
        Record operator decision
      </summary>
      <form
        onSubmit={submit}
        className="mt-3 grid gap-3 rounded-md bg-surface-overlay p-3 sm:grid-cols-2"
      >
        <label className="grid gap-1 text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">
          Decision
          <select
            id={`${prefix}-status`}
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as DecisionStatus)
            }
            disabled={pending}
            className="min-h-9 rounded-md border border-border-subtle bg-surface px-2 text-sm normal-case tracking-normal text-ink outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
          >
            <option value="accepted">Accepted</option>
            <option value="risk_accepted">Risk accepted</option>
            <option value="false_positive">False positive</option>
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">
          Owner
          <select
            id={`${prefix}-owner`}
            value={ownerMemberId}
            onChange={(event) => setOwnerMemberId(event.target.value)}
            disabled={pending || owners.length === 0}
            required
            className="min-h-9 rounded-md border border-border-subtle bg-surface px-2 text-sm normal-case tracking-normal text-ink outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
          >
            {owners.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.display_name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">
          Expires on
          <input
            id={`${prefix}-expiry`}
            type="date"
            min={minimumExpiry}
            value={expiresOn}
            onChange={(event) => setExpiresOn(event.target.value)}
            disabled={pending}
            required
            className="min-h-9 rounded-md border border-border-subtle bg-surface px-2 text-sm normal-case tracking-normal text-ink outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
          />
        </label>
        <label className="grid gap-1 text-[11px] font-medium uppercase tracking-wide text-ink-tertiary sm:col-span-2">
          Reason
          <textarea
            id={`${prefix}-reason`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={pending}
            minLength={10}
            maxLength={500}
            required
            rows={3}
            placeholder="Why is this decision appropriate, and what should the next operator know?"
            className="rounded-md border border-border-subtle bg-surface px-2 py-2 text-sm normal-case tracking-normal text-ink outline-none placeholder:text-ink-tertiary focus-visible:ring-2 focus-visible:ring-amber-500/50"
          />
        </label>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <button
            type="submit"
            disabled={pending || !ownerMemberId}
            className="min-h-9 rounded-md bg-ink px-3 text-xs font-medium text-surface-base disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Recording…" : "Record decision"}
          </button>
          <span className="text-[11px] text-ink-tertiary">
            Reason, owner, expiry, and actor are audited.
          </span>
        </div>
        {message ? (
          <p
            role="status"
            className={`text-xs sm:col-span-2 ${message.tone === "error" ? "text-red-600 dark:text-red-300" : "text-emerald-700 dark:text-emerald-300"}`}
          >
            {message.text}
          </p>
        ) : null}
      </form>
    </details>
  );
}
