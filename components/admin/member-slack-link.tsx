"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Hash, Check } from "lucide-react";
import { linkMemberSlack } from "@/app/t/[team]/admin/members/actions";

/**
 * Inline admin control to map a member to their Slack user id (the manual path when the Slack
 * connector lacks `users:read.email` to auto-reconcile). Shows the current mapping and an input to
 * set/change it. Calls the admin-gated `linkMemberSlack` action → writes `member_identities`.
 */
export function MemberSlackLink({
  teamSlug,
  memberId,
  slackUserId,
  slackHandle,
}: {
  teamSlug: string;
  memberId: string;
  slackUserId: string | null;
  slackHandle: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(slackUserId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await linkMemberSlack(teamSlug, memberId, value, slackHandle ?? undefined);
      if (!res.ok) {
        setError(res.error ?? "could not link");
        return;
      }
      setDone(true);
      setEditing(false);
      router.refresh();
    });
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        {slackUserId ? (
          <span className="flex items-center gap-1.5 text-xs text-ink-secondary">
            <Hash className="size-3.5" />
            <span className="font-mono">{slackHandle || slackUserId}</span>
            {done ? <Check className="size-3.5 text-emerald-600" /> : null}
          </span>
        ) : (
          <span className="text-xs text-ink-tertiary">—</span>
        )}
        <button
          onClick={() => setEditing(true)}
          className="rounded-md border border-border-default px-2 py-0.5 text-xs text-ink-secondary hover:text-ink"
        >
          {slackUserId ? "Change" : "Link"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          className="prism-input h-7 w-32 px-2 py-0.5 text-xs"
          placeholder="slack id (U0123…)"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
        <button
          onClick={submit}
          disabled={pending}
          className="rounded-md border border-violet/40 bg-violet/10 px-2 py-0.5 text-xs font-medium text-violet disabled:opacity-50"
        >
          {pending ? "Linking…" : "Save"}
        </button>
        <button
          onClick={() => setEditing(false)}
          className="rounded-md border border-border-default px-2 py-0.5 text-xs text-ink-tertiary"
        >
          Cancel
        </button>
      </div>
      {error ? <p className="text-xs text-red">{error}</p> : null}
    </div>
  );
}
