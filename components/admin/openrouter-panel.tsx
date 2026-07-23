"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, ShieldCheck } from "lucide-react";
import { saveOpenrouter } from "@/app/t/[team]/admin/integrations/actions";
import { DEFAULT_OPENROUTER_MODEL } from "@/lib/query/llm-backend";

interface OpenrouterPanelProps {
  teamSlug: string;
  /** Whether an OpenRouter key is stored (never the key itself), and the chosen model slug. */
  connected: boolean;
  model: string | null;
}

/**
 * Admin → Integrations · OpenRouter. Makes OpenRouter — an OpenAI-compatible gateway to many models
 * (OpenAI, Anthropic, Google, Llama, …) — a first-class answering backend. This panel manages ONLY the
 * KEY (validated + stored encrypted); WHICH model answers/reasons is chosen in the "Answering & reasoning
 * models" picker above (a key-only save preserves that model — `saveOpenrouterSettings` leaves
 * `config.model` untouched when no model is passed). Once connected, the query LLM routes through
 * OpenRouter ahead of the Anthropic default (see selectLlmBackend).
 */
export function OpenrouterPanel({ teamSlug, connected, model }: OpenrouterPanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [key, setKey] = useState("");

  function save() {
    const k = key.trim();
    if (!k && !connected) {
      setError("enter an OpenRouter key to connect");
      return;
    }
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await saveOpenrouter(teamSlug, { key: k || undefined });
      if (!res.ok) setError(res.error ?? "could not save");
      else {
        setKey("");
        setNotice(res.label ? `Connected (${res.label}).` : "Saved.");
        router.refresh();
      }
    });
  }

  return (
    <div className="prism-card flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <Sparkles className="size-4 text-violet" /> OpenRouter (LLM gateway)
        </p>
        <span className={`text-xs ${connected ? "text-emerald-700" : "text-ink-tertiary"}`}>
          {connected ? `key set ✓ · model ${model ?? DEFAULT_OPENROUTER_MODEL}` : "not connected"}
        </span>
      </div>

      <p className="text-xs text-ink-secondary">
        Route the Team Brain&apos;s answers through{" "}
        <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="text-violet hover:underline">
          OpenRouter
        </a>{" "}
        — one key for many models (OpenAI, Anthropic, Google, Llama, …). When connected it takes
        precedence over the default Anthropic backend. Choose <em>which</em> model answers/reasons in the{" "}
        <span className="font-medium text-ink">Answering &amp; reasoning models</span> picker above.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className="prism-input flex-1"
          type="password"
          autoComplete="off"
          placeholder={connected ? "replace key — sk-or-… (leave blank to keep current)" : "sk-or-…"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          aria-label="OpenRouter API key"
        />
        <button type="button" onClick={save} disabled={pending} className="btn-prism justify-center">
          <ShieldCheck className="size-4" /> {connected ? "Save" : "Validate & connect"}
        </button>
      </div>

      {notice ? (
        <p className="rounded-lg border border-emerald/30 bg-emerald/5 px-3 py-2 text-sm text-emerald-700">{notice}</p>
      ) : null}
      {error ? <p className="text-sm text-red">{error}</p> : null}
    </div>
  );
}
