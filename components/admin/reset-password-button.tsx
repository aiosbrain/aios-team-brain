"use client";

import { useState, useTransition } from "react";
import { KeyRound, Copy, Check } from "lucide-react";
import { resetMemberPassword } from "@/app/t/[team]/admin/members/actions";

/** Per-member "reset password" action — generates a new one and reveals it exactly once. */
export function ResetPasswordButton({ teamSlug, memberId }: { teamSlug: string; memberId: string }) {
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (issued) {
    return (
      <div className="flex items-center gap-2">
        <code className="overflow-x-auto rounded-lg bg-surface-overlay px-2 py-1 font-mono text-xs text-ink">
          {issued}
        </code>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(issued);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded-lg border border-border-default p-1.5 text-ink-secondary hover:text-ink"
          aria-label="Copy password"
        >
          {copied ? <Check className="size-3.5 text-violet" /> : <Copy className="size-3.5" />}
        </button>
        <button
          onClick={() => setIssued(null)}
          className="text-xs text-ink-tertiary underline"
        >
          done
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await resetMemberPassword(teamSlug, memberId);
            if (!res.ok) setError(res.error ?? "failed");
            else setIssued(res.password ?? null);
          })
        }
        className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-2.5 py-1 text-xs text-ink-secondary hover:border-violet/40 hover:text-ink disabled:opacity-50"
      >
        <KeyRound className="size-3.5" strokeWidth={1.75} />
        {pending ? "…" : "Reset password"}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
