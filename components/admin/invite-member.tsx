"use client";

import { useState, useTransition } from "react";
import { UserPlus } from "lucide-react";
import { inviteMember } from "@/app/t/[team]/admin/actions";

export function InviteMember({ teamSlug }: { teamSlug: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg bg-violet px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
      >
        <UserPlus className="size-4" strokeWidth={1.75} />
        Invite member
      </button>
    );
  }

  return (
    <form
      className="prism-card flex flex-col gap-3 p-4"
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const res = await inviteMember(teamSlug, {
            email: String(formData.get("email") ?? ""),
            displayName: String(formData.get("displayName") ?? ""),
            actorHandle: String(formData.get("actorHandle") ?? ""),
            role: (String(formData.get("role")) as "admin" | "lead" | "member") || "member",
          });
          if (!res.ok) setError(res.error ?? "failed");
          else setOpen(false);
        });
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <input name="email" type="email" required placeholder="email"
          className="rounded-lg border border-border-default bg-surface-base px-3 py-2 text-sm text-ink outline-none focus:border-violet" />
        <input name="displayName" required placeholder="display name"
          className="rounded-lg border border-border-default bg-surface-base px-3 py-2 text-sm text-ink outline-none focus:border-violet" />
        <input name="actorHandle" required placeholder="actor handle (e.g. alex — matches aios pushes)"
          className="rounded-lg border border-border-default bg-surface-base px-3 py-2 text-sm text-ink outline-none focus:border-violet" />
        <select name="role" defaultValue="member"
          className="rounded-lg border border-border-default bg-surface-base px-3 py-2 text-sm text-ink outline-none focus:border-violet">
          <option value="member">member</option>
          <option value="lead">lead</option>
          <option value="admin">admin</option>
        </select>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={pending}
          className="rounded-lg bg-violet px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {pending ? "Inviting…" : "Invite"}
        </button>
        <button type="button" onClick={() => setOpen(false)}
          className="rounded-lg border border-border-default px-4 py-2 text-sm text-ink-secondary">
          Cancel
        </button>
      </div>
      <p className="text-xs text-ink-tertiary">
        Invite-only: the member signs in with this email via magic link and is linked automatically
        on first login.
      </p>
    </form>
  );
}
