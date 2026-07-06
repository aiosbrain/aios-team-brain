"use client";

import { useState, useTransition } from "react";
import { KeyRound } from "lucide-react";
import { changeMyPassword } from "@/app/actions/account";

export function ChangePasswordForm() {
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="prism-card flex max-w-sm flex-col gap-3 p-4"
      action={(formData) => {
        setError(null);
        setSuccess(false);
        const currentPassword = String(formData.get("currentPassword") ?? "");
        const newPassword = String(formData.get("newPassword") ?? "");
        const confirmPassword = String(formData.get("confirmPassword") ?? "");
        if (newPassword !== confirmPassword) {
          setError("new password and confirmation don't match");
          return;
        }
        startTransition(async () => {
          const res = await changeMyPassword(currentPassword, newPassword);
          if (!res.ok) setError(res.error ?? "could not change password");
          else setSuccess(true);
        });
      }}
    >
      <label htmlFor="currentPassword" className="text-xs font-medium uppercase tracking-wider text-ink-tertiary">
        Current password
      </label>
      <input
        id="currentPassword"
        name="currentPassword"
        type="password"
        required
        autoComplete="current-password"
        className="rounded-lg border border-border-default bg-surface-base px-3 py-2 text-sm text-ink outline-none focus:border-violet"
      />
      <label htmlFor="newPassword" className="text-xs font-medium uppercase tracking-wider text-ink-tertiary">
        New password
      </label>
      <input
        id="newPassword"
        name="newPassword"
        type="password"
        required
        autoComplete="new-password"
        minLength={10}
        className="rounded-lg border border-border-default bg-surface-base px-3 py-2 text-sm text-ink outline-none focus:border-violet"
      />
      <label htmlFor="confirmPassword" className="text-xs font-medium uppercase tracking-wider text-ink-tertiary">
        Confirm new password
      </label>
      <input
        id="confirmPassword"
        name="confirmPassword"
        type="password"
        required
        autoComplete="new-password"
        minLength={10}
        className="rounded-lg border border-border-default bg-surface-base px-3 py-2 text-sm text-ink outline-none focus:border-violet"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      {success && <p className="text-sm text-emerald-600">Password changed.</p>}
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-violet px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        <KeyRound className="size-4" strokeWidth={1.75} />
        {pending ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}
