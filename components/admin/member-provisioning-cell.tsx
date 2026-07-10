"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, RefreshCw } from "lucide-react";
import { retryProvisioning } from "@/app/t/[team]/admin/members/actions";
import type { ProvisioningResult, ProvisioningTool } from "@/lib/provisioning/types";

const TOOL_LABEL: Record<ProvisioningTool, string> = {
  linear: "Linear",
  slack: "Slack",
  github: "GitHub",
};

/**
 * Compact per-tool provisioning status for one member row. Deliberately quiet: only `failed` tools
 * surface (a red badge + a retry that re-runs `runProvisioning` for that one tool) — the states an
 * admin acts on. `sent`/`link_provided`/`skipped` are omitted to keep the dense members table clean.
 */
export function MemberProvisioningCell({
  teamSlug,
  memberId,
  rows,
}: {
  teamSlug: string;
  memberId: string;
  rows: ProvisioningResult[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const failed = rows.filter((r) => r.status === "failed");
  if (failed.length === 0) return <span className="text-xs text-ink-tertiary">—</span>;

  function retry(tool: ProvisioningTool) {
    setError(null);
    startTransition(async () => {
      const res = await retryProvisioning(teamSlug, memberId, tool);
      if (!res.ok) {
        setError(res.error ?? "retry failed");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-1">
      {failed.map((r) => (
        <button
          key={r.tool}
          type="button"
          disabled={pending}
          onClick={() => retry(r.tool)}
          title={`${r.detail} — click to retry`}
          className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs text-red-600 hover:bg-red-500/20 disabled:opacity-50"
        >
          <AlertCircle className="size-3" />
          {TOOL_LABEL[r.tool]}
          <RefreshCw className="size-3" />
        </button>
      ))}
      {error ? <span className="text-[11px] text-red-600">{error}</span> : null}
    </div>
  );
}
