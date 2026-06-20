"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GitBranch, Check } from "lucide-react";
import { linkMemberGithub } from "@/app/t/[team]/admin/members/actions";

/**
 * Inline admin control to link a member to a GitHub login (W1.3). Shows the current
 * `github_login` (with avatar) when set, and an input to set/change it. Calls the
 * admin-gated `linkMemberGithub` server action, which reuses `linkGithub` to backfill
 * the member's git-author aliases. The GitHub token lives only on the server.
 */
export function MemberGithubLink({
  teamSlug,
  memberId,
  githubLogin,
  avatarUrl,
}: {
  teamSlug: string;
  memberId: string;
  githubLogin: string | null;
  avatarUrl: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(githubLogin ?? "");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await linkMemberGithub(teamSlug, memberId, value);
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
        {githubLogin ? (
          <span className="flex items-center gap-1.5 text-xs text-ink-secondary">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatarUrl} alt="" className="size-4 rounded-full" />
            ) : (
              <GitBranch className="size-3.5" />
            )}
            <span className="font-mono">{githubLogin}</span>
            {done ? <Check className="size-3.5 text-emerald-600" /> : null}
          </span>
        ) : (
          <span className="text-xs text-ink-tertiary">—</span>
        )}
        <button
          onClick={() => setEditing(true)}
          className="rounded-md border border-border-default px-2 py-0.5 text-xs text-ink-secondary hover:text-ink"
        >
          {githubLogin ? "Change" : "Link"}
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
          placeholder="github login"
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
