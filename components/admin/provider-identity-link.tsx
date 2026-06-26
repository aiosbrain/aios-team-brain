"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Hash, Check, X } from "lucide-react";
import { linkMemberIdentity, unlinkMemberIdentity } from "@/app/t/[team]/admin/members/actions";

/**
 * Inline admin control to map a member to ONE provider's user id (slack/linear/plane) — the manual
 * path / correction when auto-reconcile missed (e.g. a different email on that platform). Shows the
 * current link with set/change/unlink. Writes `member_identities` via the generic admin actions.
 */
export function ProviderIdentityLink({
  teamSlug,
  memberId,
  provider,
  label,
  externalId,
  handle,
  placeholder,
}: {
  teamSlug: string;
  memberId: string;
  provider: "slack" | "linear" | "plane";
  label: string;
  externalId: string | null;
  handle: string | null;
  placeholder: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(externalId ?? "");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await linkMemberIdentity(teamSlug, memberId, provider, value, handle ?? undefined);
      if (!res.ok) return setError(res.error ?? "could not link");
      setEditing(false);
      router.refresh();
    });
  }
  function unlink() {
    if (!externalId) return;
    setError(null);
    startTransition(async () => {
      const res = await unlinkMemberIdentity(teamSlug, provider, externalId);
      if (!res.ok) return setError(res.error ?? "could not unlink");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <span className="w-14 shrink-0 text-xs text-ink-tertiary">{label}</span>
        {editing ? (
          <>
            <input
              autoFocus
              className="prism-input h-6 w-28 px-1.5 py-0 text-xs"
              placeholder={placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") setEditing(false);
              }}
            />
            <button onClick={submit} disabled={pending} className="rounded border border-violet/40 bg-violet/10 px-1.5 py-0 text-xs font-medium text-violet disabled:opacity-50">
              {pending ? "…" : "Save"}
            </button>
            <button onClick={() => setEditing(false)} className="rounded border border-border-default px-1.5 py-0 text-xs text-ink-tertiary">
              Cancel
            </button>
          </>
        ) : externalId ? (
          <>
            <span className="flex items-center gap-1 text-xs text-ink-secondary">
              <Hash className="size-3" />
              <span className="font-mono">{handle || externalId}</span>
              <Check className="size-3 text-emerald-600" />
            </span>
            <button onClick={() => setEditing(true)} className="rounded border border-border-default px-1.5 py-0 text-xs text-ink-secondary hover:text-ink">
              Change
            </button>
            <button onClick={unlink} disabled={pending} className="rounded border border-border-default p-0.5 text-ink-tertiary hover:text-red disabled:opacity-50" aria-label={`Unlink ${label}`}>
              <X className="size-3" />
            </button>
          </>
        ) : (
          <>
            <span className="text-xs text-ink-tertiary">not linked</span>
            <button onClick={() => setEditing(true)} className="rounded border border-violet/40 bg-violet/10 px-1.5 py-0 text-xs font-medium text-violet">
              Link
            </button>
          </>
        )}
      </div>
      {error ? <p className="pl-14 text-xs text-red">{error}</p> : null}
    </div>
  );
}
