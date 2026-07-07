"use client";

import { useState, useTransition } from "react";
import { UserPlus, Copy, Check, Dices } from "lucide-react";
import { inviteMember, type InviteMemberResult } from "@/app/t/[team]/admin/actions";

type Issued = Extract<InviteMemberResult, { ok: true }>;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-2 rounded-lg border border-border-default px-3 py-2 text-sm text-ink-secondary hover:text-ink"
    >
      {copied ? <Check className="size-4 text-violet" /> : <Copy className="size-4" />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function InviteMember({ teamSlug }: { teamSlug: string }) {
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setIssued(null);
    setOpen(false);
    setManual(false);
    setPassword("");
  }

  if (issued?.mode === "magic-link") {
    return (
      <div className="prism-card flex flex-col gap-3 border border-violet/40 p-4">
        <p className="text-sm font-medium text-ink">
          {issued.emailDelivered
            ? `Invite email sent to ${issued.email} with a one-time sign-in link (valid 7 days).`
            : `Member created for ${issued.email}, but we couldn't confirm the invite email was delivered. Check your mail provider settings, or ask them to request a sign-in link at the login page.`}
        </p>
        <button
          onClick={reset}
          className="self-start rounded-lg bg-violet px-4 py-2 text-sm font-medium text-white"
        >
          Done
        </button>
      </div>
    );
  }

  if (issued?.mode === "manual") {
    const intro =
      issued.reason === "admin-choice"
        ? `Share this message with ${issued.email} directly (Slack, DM, etc). It's shown exactly once; only the password's hash is stored.`
        : `Email delivery isn't configured for this deployment — share this message with ${issued.email} directly (Slack, DM, etc). It's shown exactly once; only the password's hash is stored.`;
    return (
      <div className="prism-card flex flex-col gap-3 border border-violet/40 p-4">
        <p className="text-sm font-medium text-ink">{intro}</p>
        <pre className="whitespace-pre-wrap rounded-lg bg-surface-overlay px-3 py-2 font-mono text-xs text-ink">
          {issued.inviteMessage}
        </pre>
        <div className="flex gap-2">
          <CopyButton text={issued.inviteMessage} label="Copy message" />
          <CopyButton text={issued.password} label="Copy password only" />
        </div>
        <button
          onClick={reset}
          className="self-start rounded-lg bg-violet px-4 py-2 text-sm font-medium text-white"
        >
          Done — I shared it
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-violet px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
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
            manualInvite: manual,
            password: manual ? password || undefined : undefined,
          });
          if (!res.ok) setError(res.error);
          else setIssued(res);
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

      <button
        type="button"
        onClick={() => setManual((m) => !m)}
        className="self-start text-xs text-ink-tertiary underline"
      >
        {manual ? "Use a magic sign-in link instead" : "Set a password manually instead"}
      </button>

      {manual && (
        <div className="flex items-center gap-2">
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
      )}

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
        {manual
          ? "The member signs in with this email + password. Share the password with them out-of-band (Slack, in person) — it's never emailed."
          : "The member gets a one-click sign-in link by email. If this deployment has no mail provider configured, you'll get a ready-to-share invite instead."}
      </p>
    </form>
  );
}
