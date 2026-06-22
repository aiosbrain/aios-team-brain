"use client";

import { useState, useTransition } from "react";

import { projectBoardAction, type ProjectBoardResult } from "./actions";

function summarize(counts: Record<string, number> | undefined): { synced: number; skipped: number; other: number; total: number } {
  const c = counts ?? {};
  const synced = c.synced ?? 0;
  const skipped = c.skipped ?? 0;
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  return { synced, skipped, other: total - synced - skipped, total };
}

export function ProjectBoardButton({ teamSlug, primaryProvider }: { teamSlug: string; primaryProvider: string | null }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ProjectBoardResult | null>(null);

  function run() {
    setResult(null);
    startTransition(async () => {
      setResult(await projectBoardAction(teamSlug));
    });
  }

  const s = result?.ok ? summarize(result.counts) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={pending}
          className="rounded-md bg-violet px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
        >
          {pending ? "Projecting…" : "Project board now"}
        </button>
        <span className="text-sm text-ink-secondary">
          Primary PM tool: <span className="font-medium text-ink">{primaryProvider ?? "not set"}</span>
        </span>
        {pending ? (
          <span className="text-sm text-ink-tertiary">Projecting the full board — this can take up to ~90s.</span>
        ) : null}
      </div>

      {result && !pending ? (
        result.ok ? (
          <div className="rounded-md border border-emerald/40 bg-emerald/10 px-3 py-2 text-sm">
            <p className="font-medium text-emerald">✓ Projection complete — {result.provider}</p>
            <p className="mt-0.5 text-ink-secondary">
              {s!.total} task{s!.total === 1 ? "" : "s"}: <span className="font-medium text-ink">{s!.synced} updated</span>
              {" · "}
              {s!.skipped} already in sync
              {s!.other > 0 ? ` · ${s!.other} other` : ""}
            </p>
          </div>
        ) : (
          <div className="rounded-md border border-red/40 bg-red/10 px-3 py-2 text-sm">
            <p className="font-medium text-red">Projection failed</p>
            <p className="mt-0.5 text-ink-secondary">{result.error}</p>
          </div>
        )
      ) : null}
    </div>
  );
}
