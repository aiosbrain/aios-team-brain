"use client";

import { useState } from "react";
import { Loader2, LogIn } from "lucide-react";

export function LoginForm({ next }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "error">("idle");
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent) {
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
        {state === "sending" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <LogIn className="size-4" />
        )}
        Sign in
      </button>
      {state === "error" ? <p className="text-sm text-red">{error}</p> : null}
    </form>
  );
}
