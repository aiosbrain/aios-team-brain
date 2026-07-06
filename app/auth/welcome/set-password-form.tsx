"use client";

import { useState, useTransition } from "react";
import { setInitialPassword } from "./actions";

/**
 * Optional password set for a member who just signed in via magic link. Skippable — they can
 * always request a fresh magic link at /login if they never set one.
 */
export function SetPasswordForm() {
  const [expanded, setExpanded] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  if (done) {
    return (
      <p className="mt-4 text-center text-sm text-ink-secondary">
        Password set. You can now sign in with your email + password too.
      </p>
    );
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mt-4 w-full text-center text-xs text-ink-tertiary underline"
      >
        Set a password (optional — you can keep using emailed sign-in links instead)
      </button>
    );
  }

  return (
    <form
      className="mt-4 flex flex-col gap-2"
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const res = await setInitialPassword(String(formData.get("password") ?? ""));
          if (!res.ok) setError(res.error ?? "failed");
          else setDone(true);
        });
      }}
    >
      <input
        name="password"
        type="password"
        required
        placeholder="new password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="rounded-lg border border-border-default bg-surface-base px-3 py-2 text-sm text-ink outline-none focus:border-violet"
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-border-default px-3 py-2 text-sm text-ink-secondary hover:text-ink disabled:opacity-50"
      >
        {pending ? "Setting…" : "Set password"}
      </button>
    </form>
  );
}
