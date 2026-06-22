"use client";

import { useState, useTransition } from "react";

import { projectBoardAction, type ProjectBoardResult } from "./actions";

export function ProjectBoardButton({ teamSlug, primaryProvider }: { teamSlug: string; primaryProvider: string | null }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ProjectBoardResult | null>(null);

  function run() {
    setResult(null);
    startTransition(async () => {
      setResult(await projectBoardAction(teamSlug));
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
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
      </div>
      {result ? (
        result.ok ? (
          <p className="text-sm text-ink-secondary">
            Projected to <span className="font-medium text-ink">{result.provider}</span>:{" "}
            {Object.entries(result.counts ?? {})
              .map(([k, v]) => `${v} ${k}`)
              .join(" · ") || "no rows"}
          </p>
        ) : (
          <p className="text-sm text-red">{result.error}</p>
        )
      ) : null}
    </div>
  );
}
