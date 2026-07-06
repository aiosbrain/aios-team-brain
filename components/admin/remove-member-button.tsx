"use client";

import { useState, useTransition } from "react";
import { UserMinus } from "lucide-react";
import { removeMember } from "@/app/t/[team]/admin/members/actions";

/** Per-member "remove from team" action — soft-disables, with a one-click confirm step. */
export function RemoveMemberButton({
  teamSlug,
  memberId,
}: {
  teamSlug: string;
  memberId: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-ink-secondary">Remove?</span>
        <button
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const res = await removeMember(teamSlug, memberId);
              if (!res.ok) {
                setError(res.error ?? "failed");
                setConfirming(false);
              }
              // On success the row's status flips to "disabled" via revalidation — no local state to reset.
            })
          }
          className="text-xs font-medium text-red-600 underline underline-offset-2"
        >
          {pending ? "…" : "confirm"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="text-xs text-ink-tertiary underline"
        >
          cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => setConfirming(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-2.5 py-1 text-xs text-ink-secondary hover:border-red-400/40 hover:text-red-600"
      >
        <UserMinus className="size-3.5" strokeWidth={1.75} />
        Remove
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
