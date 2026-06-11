"use client";

import { useState } from "react";
import { Loader2, MailCheck, Send } from "lucide-react";
import { browserClient } from "@/lib/supabase/client";

export function LoginForm({ next }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setState("sending");
    setError("");
    const supabase = browserClient();
    const redirect = `${window.location.origin}/auth/confirm${
      next ? `?next=${encodeURIComponent(next)}` : ""
    }`;
    const { error: err } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirect, shouldCreateUser: false },
    });
    if (err) {
      setState("error");
      setError(err.message);
    } else {
      setState("sent");
    }
  }

  if (state === "sent") {
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <MailCheck className="size-8 text-violet" strokeWidth={1.5} />
        <p className="text-sm text-ink-secondary">
          Magic link sent to <span className="font-medium text-ink">{email}</span>.
          <br />
          Check your inbox and click the link to sign in.
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
        Send magic link
      </button>
      {state === "error" ? <p className="text-sm text-red">{error}</p> : null}
    </form>
  );
}
