"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";

export function LoginForm({ next }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "error">("idle");
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setState("sending");
    setError("");

    // Direct (passwordless) sign-in — recognized members are logged in
    // immediately; unknown emails are rejected (invite-only).
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, next }),
      });
      if (res.status === 403) {
        setState("error");
        setError("That email isn't recognized. Team Brain is invite-only — ask your admin to add you.");
        return;
      }
      if (!res.ok) throw new Error(`sign-in failed (${res.status})`);
      const data = (await res.json()) as { redirect?: string };
      window.location.href = data.redirect || next || "/";
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "could not sign in");
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label htmlFor="email" className="text-xs font-medium uppercase tracking-wider text-ink-tertiary">
        Work email
      </label>
      <input
        id="email"
        type="email"
        required
        autoComplete="email"
        placeholder="you@team.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="prism-input"
      />
      <button type="submit" disabled={state === "sending"} className="btn-prism justify-center">
        {state === "sending" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Send className="size-4" />
        )}
        Sign in
      </button>
      {state === "error" ? <p className="text-sm text-red">{error}</p> : null}
    </form>
  );
}
