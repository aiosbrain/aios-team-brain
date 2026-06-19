"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plug, Plus, Trash2, KeyRound } from "lucide-react";
import {
  saveIntegration,
  toggleIntegration,
  rotateSecret,
  removeIntegration,
} from "@/app/t/[team]/admin/integrations/actions";

type IntegrationType = "github" | "granola" | "slack" | "wise" | "linear" | "plane";

export interface IntegrationRow {
  id: string;
  type: IntegrationType;
  name: string;
  config: Record<string, unknown>;
  status: "enabled" | "disabled";
  hasSecret: boolean;
}

const TYPES: IntegrationType[] = ["slack", "github", "granola", "linear", "plane", "wise"];

// What the single "selection" field means per type (hint text + how config renders back).
const SELECTION_HINT: Record<IntegrationType, string> = {
  slack: "channel IDs (comma-separated)",
  github: "repos owner/name (comma-separated)",
  granola: "match keywords (comma-separated)",
  linear: "project ID",
  plane: "project ID",
  wise: "profile ID",
};

function summarizeConfig(type: IntegrationType, config: Record<string, unknown>): string {
  const arr = (k: string) => (Array.isArray(config[k]) ? (config[k] as string[]) : []);
  if (type === "slack") return `${arr("channelIds").length} channel(s)`;
  if (type === "github") return `${arr("repos").length} repo(s)`;
  if (type === "granola") return `${arr("matchKeywords").length} keyword(s)`;
  return Object.values(config)[0] ? String(Object.values(config)[0]) : "—";
}

export function IntegrationsManager({
  teamSlug,
  integrations,
}: {
  teamSlug: string;
  integrations: IntegrationRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ type: IntegrationType; name: string; selection: string; secret: string }>({
    type: "slack",
    name: "",
    selection: "",
    secret: "",
  });

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "something went wrong");
      else router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const res = await saveIntegration(teamSlug, form);
            if (res.ok) setForm({ type: form.type, name: "", selection: "", secret: "" });
            return res;
          });
        }}
        className="prism-card flex flex-col gap-3 p-4"
      >
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <Plus className="size-4 text-violet" /> Add an integration
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <select
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value as IntegrationType })}
            className="prism-input"
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <input
            className="prism-input"
            placeholder="name (e.g. eng-slack)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </div>
        <input
          className="prism-input"
          placeholder={SELECTION_HINT[form.type]}
          value={form.selection}
          onChange={(e) => setForm({ ...form, selection: e.target.value })}
        />
        <input
          className="prism-input"
          type="password"
          autoComplete="off"
          placeholder="secret token (e.g. xoxb-… for Slack) — stored encrypted, never shown again"
          value={form.secret}
          onChange={(e) => setForm({ ...form, secret: e.target.value })}
        />
        <button type="submit" disabled={pending} className="btn-prism justify-center">
          <Plug className="size-4" /> Save integration
        </button>
        {error ? <p className="text-sm text-red">{error}</p> : null}
      </form>

      {integrations.length === 0 ? (
        <p className="text-sm text-ink-tertiary">No integrations yet. Add one above.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {integrations.map((i) => (
            <div key={i.id} className="prism-card flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="rounded-full bg-violet/10 px-2 py-0.5 font-mono text-xs text-violet">{i.type}</span>
              <span className="font-medium text-ink">{i.name}</span>
              <span className="text-xs text-ink-tertiary">
                {summarizeConfig(i.type, i.config)}
                {i.hasSecret ? " · secret set" : " · no secret"}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => run(() => toggleIntegration(teamSlug, i.id, i.status === "enabled" ? "disabled" : "enabled"))}
                  disabled={pending}
                  className={`rounded-lg border px-3 py-1 text-xs font-medium ${
                    i.status === "enabled"
                      ? "border-violet/40 bg-violet/10 text-violet"
                      : "border-border-default text-ink-tertiary"
                  }`}
                >
                  {i.status === "enabled" ? "Enabled" : "Disabled"}
                </button>
                <button
                  onClick={() => {
                    const s = window.prompt(`New secret for ${i.name}:`);
                    if (s) run(() => rotateSecret(teamSlug, i.id, s));
                  }}
                  disabled={pending}
                  className="rounded-lg border border-border-default p-1.5 text-ink-secondary hover:text-ink"
                  aria-label="Rotate secret"
                >
                  <KeyRound className="size-4" />
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(`Delete integration "${i.name}"?`)) run(() => removeIntegration(teamSlug, i.id));
                  }}
                  disabled={pending}
                  className="rounded-lg border border-border-default p-1.5 text-ink-secondary hover:text-red"
                  aria-label="Delete integration"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
