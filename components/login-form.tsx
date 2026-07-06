"use client";

import { useState } from "react";
import { Loader2, Send, Mail } from "lucide-react";

export function LoginForm({ next }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setState("sending");
    setError("");

    // Magic-link sign-in: request a one-time link, then wait for the click on
    // /auth/confirm to actually set the session — no direct-by-email login anymore.
    try {
      const res = await fetch("/api/auth/request-magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, next }),
      });
      if (res.status === 403) {
        setState("error");
        setError("That email isn't recognized. Team Brain is invite-only — ask your admin to add you.");
        return;
      }
      if (!res.ok) throw new Error(`request failed (${res.status})`);
      setState("sent");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "could not send link");
    }
  }

  if (state === "sent") {
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-center">
        <Mail className="size-8 text-violet" strokeWidth={1.5} />
        <p className="text-sm font-medium text-ink">Check your email</p>
        <p className="text-sm text-ink-secondary">
          We sent a sign-in link to <span className="text-ink">{email}</span>. It&apos;s single-use and
          expires in 15 minutes.
        </p>
      </div>
    );
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
        Send sign-in link
      </button>
      {state === "error" ? <p className="text-sm text-red">{error}</p> : null}
    </form>
  );
}
