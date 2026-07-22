"use client";

import { useState } from "react";
import { Loader2, LogIn, Mail } from "lucide-react";

/**
 * Password is the DEFAULT sign-in mode — always available, no email infrastructure needed
 * (audit M1/M2b). When `magicLinkAvailable` (a domain + mail delivery are actually configured —
 * resolved server-side in app/login/page.tsx), a secondary "use a magic link instead" option is
 * offered, posting to POST /api/auth/request-magic-link; the session is only set once the emailed
 * link is clicked (GET /auth/confirm), never by this form directly.
 */
export function LoginForm({ next, magicLinkAvailable }: { next?: string; magicLinkAvailable: boolean }) {
  const [mode, setMode] = useState<"password" | "magic-link">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  async function onSubmitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) return;
    setState("sending");
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, next }),
      });
      if (res.status === 401) {
        setState("error");
        setError("Incorrect email or password.");
        return;
      }
      if (res.status === 429) {
        setState("error");
        setError("Too many attempts — try again in a minute.");
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

  async function onSubmitMagicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setState("sending");
    setError("");

    // Magic-link sign-in: request a one-time link, then wait for the click on
    // /auth/confirm to actually set the session — this form never sets it directly.
    try {
      const res = await fetch("/api/auth/request-magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, next }),
      });
      if (res.status === 429) {
        setState("error");
        setError("Too many attempts — try again in a minute.");
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
          If <span className="text-ink">{email}</span> belongs to a member, we&apos;ve sent a single-use
          sign-in link that expires in 15 minutes. Double-check the address if it doesn&apos;t arrive.
        </p>
      </div>
    );
  }

  if (mode === "magic-link") {
    return (
      <form onSubmit={onSubmitMagicLink} className="flex flex-col gap-3">
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
          {state === "sending" ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
          Send sign-in link
        </button>
        {state === "error" ? <p className="text-sm text-red">{error}</p> : null}
        <button
          type="button"
          onClick={() => { setMode("password"); setState("idle"); setError(""); }}
          className="text-xs text-ink-tertiary underline"
        >
          Sign in with a password instead
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={onSubmitPassword} className="flex flex-col gap-3">
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
      <label htmlFor="password" className="text-xs font-medium uppercase tracking-wider text-ink-tertiary">
        Password
      </label>
      <input
        id="password"
        type="password"
        required
        autoComplete="current-password"
        placeholder="••••••••••"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="prism-input"
      />
      <button type="submit" disabled={state === "sending"} className="btn-prism justify-center">
        {state === "sending" ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
        Sign in
      </button>
      {state === "error" ? <p className="text-sm text-red">{error}</p> : null}
      {magicLinkAvailable ? (
        <button
          type="button"
          onClick={() => { setMode("magic-link"); setState("idle"); setError(""); }}
          className="text-xs text-ink-tertiary underline"
        >
          Or sign in with a magic link instead
        </button>
      ) : null}
    </form>
  );
}
