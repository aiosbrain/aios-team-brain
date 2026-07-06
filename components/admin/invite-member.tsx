"use client";

import { useState, useTransition } from "react";
import { UserPlus, Copy, Check, Dices } from "lucide-react";
import { inviteMember } from "@/app/t/[team]/admin/actions";

export function InviteMember({ teamSlug }: { teamSlug: string }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  if (issued) {
    return (
      <div className="prism-card flex flex-col gap-3 border border-violet/40 p-4">
        <p className="text-sm font-medium text-ink">
          Member created — copy their password now and share it out-of-band. It is shown exactly
          once; only its hash is stored.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-lg bg-surface-overlay px-3 py-2 font-mono text-xs text-ink">
            {issued}
          </code>
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(issued);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="rounded-lg border border-border-default p-2 text-ink-secondary hover:text-ink"
            aria-label="Copy password"
          >
            {copied ? <Check className="size-4 text-violet" /> : <Copy className="size-4" />}
          </button>
        </div>
        <button
          onClick={() => { setIssued(null); setOpen(false); setPassword(""); }}
          className="self-start rounded-lg bg-violet px-4 py-2 text-sm font-medium text-white"
        >
          Done — I copied it
        </button>
      </div>
    );
  }

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
            password: password || undefined,
          });
          if (!res.ok) setError(res.error ?? "failed");
          else setIssued(res.password ?? null);
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
        <div className="col-span-2 flex items-center gap-2">
          <input
            name="password"
            type="text"
            placeholder="initial password (blank = generate a strong one)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="flex-1 rounded-lg border border-border-default bg-surface-base px-3 py-2 font-mono text-sm text-ink outline-none focus:border-violet"
          />
          <button
            type="button"
            onClick={() => setPassword(crypto.randomUUID().replace(/-/g, "").slice(0, 16))}
            className="rounded-lg border border-border-default p-2 text-ink-secondary hover:text-ink"
            aria-label="Generate a password"
            title="Generate a password"
          >
            <Dices className="size-4" />
          </button>
        </div>
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
        Invite-only: the member signs in with this email + password. Share the password with them
        out-of-band (Slack, in person) — it&apos;s never emailed.
      </p>
    </form>
  );
}
