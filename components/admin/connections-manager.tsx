"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plug, Plus, Trash2, KeyRound } from "lucide-react";
import {
  addConnection,
  setConnectionEnabled,
  rotateConnectionSecret,
  removeConnection,
} from "@/app/t/[team]/admin/integrations/actions";

export interface ConnectionRow {
  id: string;
  source: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  hasSecret: boolean;
}

const SOURCES = ["slack", "github", "notion", "gdrive", "confluence", "linear", "web"];

export function ConnectionsManager({
  teamSlug,
  connections,
}: {
  teamSlug: string;
  connections: ConnectionRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ source: "slack", name: "", channels: "", secret: "" });

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
      {/* Add form */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const res = await addConnection(teamSlug, form);
            if (res.ok) setForm({ source: "slack", name: "", channels: "", secret: "" });
            return res;
          });
        }}
        className="prism-card flex flex-col gap-3 p-4"
      >
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <Plus className="size-4 text-violet" /> Add a connection
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <select
            value={form.source}
            onChange={(e) => setForm({ ...form, source: e.target.value })}
            className="prism-input"
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>{s}</option>
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
          placeholder="channel IDs / paths (comma-separated, optional)"
          value={form.channels}
          onChange={(e) => setForm({ ...form, channels: e.target.value })}
        />
        <input
          className="prism-input"
          type="password"
          autoComplete="off"
          placeholder="secret token (e.g. xoxb-… for Slack) — stored encrypted"
          value={form.secret}
          onChange={(e) => setForm({ ...form, secret: e.target.value })}
        />
        <button type="submit" disabled={pending} className="btn-prism justify-center">
          <Plug className="size-4" /> Save connection
        </button>
        {error ? <p className="text-sm text-red">{error}</p> : null}
      </form>

      {/* List */}
      {connections.length === 0 ? (
        <p className="text-sm text-ink-tertiary">No connections yet. Add one above.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {connections.map((c) => (
            <div key={c.id} className="prism-card flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="rounded-full bg-violet/10 px-2 py-0.5 font-mono text-xs text-violet">
                {c.source}
              </span>
              <span className="font-medium text-ink">{c.name}</span>
              <span className="text-xs text-ink-tertiary">
                {Array.isArray(c.config.channel_ids)
                  ? `${(c.config.channel_ids as string[]).length} channel(s)`
                  : ""}
                {c.hasSecret ? " · secret set" : " · no secret"}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => run(() => setConnectionEnabled(teamSlug, c.id, !c.enabled))}
                  disabled={pending}
                  className={`rounded-lg border px-3 py-1 text-xs font-medium ${
                    c.enabled
                      ? "border-violet/40 bg-violet/10 text-violet"
                      : "border-border-default text-ink-tertiary"
                  }`}
                >
                  {c.enabled ? "Enabled" : "Disabled"}
                </button>
                <button
                  onClick={() => {
                    const s = window.prompt(`New secret for ${c.name}:`);
                    if (s) run(() => rotateConnectionSecret(teamSlug, c.id, s));
                  }}
                  disabled={pending}
                  className="rounded-lg border border-border-default p-1.5 text-ink-secondary hover:text-ink"
                  aria-label="Rotate secret"
                >
                  <KeyRound className="size-4" />
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(`Delete connection "${c.name}"?`))
                      run(() => removeConnection(teamSlug, c.id));
                  }}
                  disabled={pending}
                  className="rounded-lg border border-border-default p-1.5 text-ink-secondary hover:text-red"
                  aria-label="Delete connection"
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
