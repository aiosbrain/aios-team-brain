"use client";

import { useState, useTransition } from "react";

import { reconcileDivergenceAction, type ReconcileResultDto } from "./actions";

/**
 * "Check for divergence" — triggers the inbound reconcile pass (brain-api v1.2 Phase 5). Reads the
 * primary PM tool's current state and surfaces drift on the table below. Surface-only: it never
 * writes back to the brain or the board. The page revalidates so the divergence list refreshes.
 */
export function ReconcileButton({ teamSlug, primaryProvider }: { teamSlug: string; primaryProvider: string | null }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ReconcileResultDto | null>(null);

  function run() {
    setResult(null);
    startTransition(async () => {
      setResult(await reconcileDivergenceAction(teamSlug));
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={pending || !primaryProvider}
          className="rounded-md border border-violet/50 px-3 py-1.5 text-sm font-medium text-violet disabled:opacity-60"
        >
          {pending ? "Checking…" : "Check for divergence"}
        </button>
        {!primaryProvider ? (
          <span className="text-sm text-ink-tertiary">Set a primary PM tool first.</span>
        ) : null}
      </div>

      {result && !pending ? (
        result.ok ? (
          <div className="rounded-md border border-emerald/40 bg-emerald/10 px-3 py-2 text-sm">
            <p className="font-medium text-emerald">✓ Checked {result.provider}</p>
            <p className="mt-0.5 text-ink-secondary">
              {(result.divergences ?? []).length} diverged · {result.seenUpdated ?? 0} state{result.seenUpdated === 1 ? "" : "s"} updated
            </p>
          </div>
        ) : (
          <div className="rounded-md border border-red/40 bg-red/10 px-3 py-2 text-sm">
            <p className="font-medium text-red">Reconcile failed</p>
            <p className="mt-0.5 text-ink-secondary">{result.error}</p>
          </div>
        )
      ) : null}
    </div>
  );
}
