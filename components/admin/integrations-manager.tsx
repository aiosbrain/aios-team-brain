"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plug, Plus, Trash2, KeyRound, RefreshCw } from "lucide-react";
import {
  saveIntegration,
  toggleIntegration,
  rotateSecret,
  removeIntegration,
  syncSlackNow,
  syncPlaneNow,
  syncLinearNow,
  syncGithubNow,
  setPrimaryPmProvider,
  type PrimaryPmProvider,
} from "@/app/t/[team]/admin/integrations/actions";

type IntegrationType =
  | "github"
  | "granola"
  | "slack"
  | "wise"
  | "linear"
  | "plane"
  | "openai"
  | "anthropic"
  | "google";

export interface IntegrationRow {
  id: string;
  type: IntegrationType;
  name: string;
  config: Record<string, unknown>;
  status: "enabled" | "disabled";
  hasSecret: boolean;
}

// Data-source connectors shown in the generic "Add an integration" form. Provider keys are NOT
// here — they get their own dedicated panel (PROVIDER_TYPES) so the page reads as a key panel.
const TYPES: IntegrationType[] = ["slack", "github", "granola", "linear", "plane", "wise"];

// LLM provider API keys — one set for the team, managed in the dedicated "AI provider keys" panel.
const PROVIDER_TYPES = ["anthropic", "openai", "google"] as const;
type ProviderType = (typeof PROVIDER_TYPES)[number];
const PROVIDER_META: Record<ProviderType, { label: string; note: string; placeholder: string }> = {
  anthropic: { label: "Anthropic", note: "Powers the AI query box (Claude).", placeholder: "sk-ant-…" },
  openai: { label: "OpenAI", note: "Embeddings & local/OpenAI-compatible LLMs.", placeholder: "sk-…" },
  google: { label: "Google", note: "Stored for Gemini — not wired into queries yet.", placeholder: "AIza…" },
};

// What the single "selection" field means per type (hint text + how config renders back).
// Keyed to the data-source TYPES only; provider keys use the dedicated panel, not this form.
const SELECTION_HINT: Partial<Record<IntegrationType, string>> = {
  slack: "channel IDs (comma-separated)",
  github: "repos owner/name (comma-separated)",
  granola: "match keywords (comma-separated)",
  linear: "teamId=..., projectId=..., doneStateName=Done",
  plane: "workspaceSlug=..., projectId=..., doneStateName=DONE, externalSource=aios-backlog",
  wise: "profile ID",
};

function summarizeConfig(type: IntegrationType, config: Record<string, unknown>): string {
  const arr = (k: string) => (Array.isArray(config[k]) ? (config[k] as string[]) : []);
  if (type === "slack") return `${arr("channelIds").length} channel(s)`;
  if (type === "github") return `${arr("repos").length} repo(s)`;
  if (type === "granola") return `${arr("matchKeywords").length} keyword(s)`;
  if (type === "linear") {
    return [
      config.teamId ? `team ${config.teamId}` : null,
      config.projectId ? `project ${config.projectId}` : null,
      config.doneStateName ? `done ${config.doneStateName}` : null,
    ].filter(Boolean).join(" · ") || "—";
  }
  if (type === "plane") {
    return [
      config.workspaceSlug ? `workspace ${config.workspaceSlug}` : null,
      config.projectId ? `project ${config.projectId}` : null,
      config.doneStateName ? `done ${config.doneStateName}` : null,
      config.externalSource ? `source ${config.externalSource}` : null,
    ].filter(Boolean).join(" · ") || "—";
  }
  return Object.values(config)[0] ? String(Object.values(config)[0]) : "—";
}

export function IntegrationsManager({
  teamSlug,
  integrations,
  primaryPmProvider,
}: {
  teamSlug: string;
  integrations: IntegrationRow[];
  primaryPmProvider: PrimaryPmProvider;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const SYNCABLE: Partial<Record<IntegrationType, (slug: string) => Promise<{ ok: boolean; error?: string; message?: string }>>> = {
    slack: syncSlackNow,
    plane: syncPlaneNow,
    linear: syncLinearNow,
    github: syncGithubNow,
  };
  const SYNC_TITLES: Partial<Record<IntegrationType, string>> = {
    slack: "Pull this team's Slack channels into the brain now",
    plane: "Import this Plane project's work-items into the brain now",
    linear: "Import this Linear team's issues into the brain now",
    github: "Import this GitHub repo's issues into the brain now",
  };

  function syncNow(type: IntegrationType) {
    const fn = SYNCABLE[type];
    if (!fn) return;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await fn(teamSlug);
      if (!res.ok) setError(res.error ?? "sync failed");
      else {
        setNotice(res.message ?? "Synced.");
        router.refresh();
      }
    });
  }
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

  // Provider keys render in their own panel; keep them out of the data-source list below.
  const sources = integrations.filter(
    (i) => !(PROVIDER_TYPES as readonly string[]).includes(i.type)
  );

  function setProviderKey(p: ProviderType, existing: IntegrationRow | undefined) {
    const key = window.prompt(`${PROVIDER_META[p].label} API key (${PROVIDER_META[p].placeholder}):`);
    if (!key) return;
    run(() =>
      existing
        ? rotateSecret(teamSlug, existing.id, key)
        : saveIntegration(teamSlug, { type: p, name: p, selection: "", secret: key })
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="prism-card flex flex-col gap-3 p-4">
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <KeyRound className="size-4 text-violet" /> AI provider keys
        </p>
        <p className="text-xs text-ink-secondary">
          One set of LLM provider keys for the team. Stored encrypted (AES-256-GCM); never shown
          again after saving. Unset providers fall back to the server&apos;s environment key.
        </p>
        <div className="flex flex-col gap-2">
          {PROVIDER_TYPES.map((p) => {
            const row = integrations.find((i) => i.type === p);
            const isSet = !!row?.hasSecret;
            return (
              <div
                key={p}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border-subtle px-3 py-2"
              >
                <span className="font-medium text-ink">{PROVIDER_META[p].label}</span>
                <span className="text-xs text-ink-tertiary">{PROVIDER_META[p].note}</span>
                <span className={`text-xs ${isSet ? "text-emerald-700" : "text-ink-tertiary"}`}>
                  {isSet ? "key set ✓" : "not set"}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => setProviderKey(p, row)}
                    className="rounded-lg border border-violet/40 bg-violet/10 px-3 py-1 text-xs font-medium text-violet disabled:opacity-50"
                  >
                    {isSet ? "Replace key" : "Set key"}
                  </button>
                  {row ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        if (window.confirm(`Remove ${PROVIDER_META[p].label} key?`)) {
                          run(() => removeIntegration(teamSlug, row.id));
                        }
                      }}
                      className="rounded-lg border border-border-default p-1.5 text-ink-secondary hover:text-red"
                      aria-label={`Remove ${PROVIDER_META[p].label} key`}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="prism-card flex flex-col gap-2 p-4">
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <Plug className="size-4 text-violet" /> Primary PM tool
        </p>
        <p className="text-xs text-ink-secondary">
          The single project-management tool the brain projects tasks into (epics, sub-issues,
          status). The brain stays the source of truth; the chosen board is a downstream projection.
        </p>
        <div className="flex flex-wrap gap-2">
          {(
            [
              { value: null, label: "None" },
              { value: "plane", label: "Plane" },
              { value: "linear", label: "Linear" },
            ] as { value: PrimaryPmProvider; label: string }[]
          ).map((opt) => {
            const active = primaryPmProvider === opt.value;
            return (
              <button
                key={opt.label}
                type="button"
                disabled={pending || active}
                onClick={() => run(() => setPrimaryPmProvider(teamSlug, opt.value))}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  active
                    ? "border-violet bg-violet/10 text-ink"
                    : "border-ink/15 text-ink-secondary hover:border-ink/30"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>
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

      {notice ? (
        <p className="rounded-lg border border-emerald/30 bg-emerald/5 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      ) : null}

      {sources.length === 0 ? (
        <p className="text-sm text-ink-tertiary">No source integrations yet. Add one above.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {sources.map((i) => (
            <div key={i.id} className="prism-card flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="rounded-full bg-violet/10 px-2 py-0.5 font-mono text-xs text-violet">{i.type}</span>
              <span className="font-medium text-ink">{i.name}</span>
              <span className="text-xs text-ink-tertiary">
                {summarizeConfig(i.type, i.config)}
                {i.hasSecret ? " · secret set" : " · no secret"}
              </span>
              <div className="ml-auto flex items-center gap-2">
                {SYNC_TITLES[i.type] ? (
                  <button
                    onClick={() => syncNow(i.type)}
                    disabled={pending}
                    className="flex items-center gap-1.5 rounded-lg border border-violet/40 bg-violet/10 px-3 py-1 text-xs font-medium text-violet disabled:opacity-50"
                    title={SYNC_TITLES[i.type]}
                  >
                    <RefreshCw className={`size-3.5 ${pending ? "animate-spin" : ""}`} /> Sync now
                  </button>
                ) : null}
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
