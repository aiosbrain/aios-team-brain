"use client";

import { useState, useTransition } from "react";
import { KeyRound, Copy, Check } from "lucide-react";
import { issueMyApiKey, revokeMyApiKey } from "@/app/t/[team]/people/[handle]/actions";
import { timeAgo } from "@/components/format";

export interface MyKeyRow {
  id: string;
  key_id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/**
 * Self-serve API key management, shown only on your own profile (never a teammate's — see
 * the self-only gate in actions.ts). Closes the invite/key gap: instead of an admin
 * generating a secret and relaying it over Slack/1Password, you generate your own here once
 * you've signed in via your invite email.
 */
export function MyApiKeys({ teamSlug, keys }: { teamSlug: string; keys: MyKeyRow[] }) {
  return (
    <section className="prism-card flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          My API keys
        </h2>
        <IssueMyKey teamSlug={teamSlug} />
      </div>
      <p className="text-xs text-ink-tertiary">
        Used by the <code>aios</code> CLI to sync this workspace. Secrets are hashed at rest and
        shown exactly once at issue time.
      </p>
      {keys.length ? (
        <div className="overflow-x-auto rounded-lg border border-border-subtle">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left text-xs uppercase tracking-wide text-ink-tertiary">
                <th className="px-4 py-2">Key</th>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Last used</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-b border-border-subtle last:border-0">
                  <td className="px-4 py-2 font-mono text-xs text-ink-secondary">aios_{k.key_id}_…</td>
                  <td className="px-4 py-2 text-ink">{k.name}</td>
                  <td className="px-4 py-2 text-ink-tertiary">
                    {k.last_used_at ? timeAgo(k.last_used_at) : "never"}
                  </td>
                  <td className="px-4 py-2">
                    {k.revoked_at ? (
                      <span className="text-xs text-red-600">revoked</span>
                    ) : (
                      <span className="text-xs text-emerald-600">active</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {!k.revoked_at && <RevokeMyKeyButton teamSlug={teamSlug} apiKeyId={k.id} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border-subtle px-4 py-6 text-center text-sm text-ink-tertiary">
          No keys yet — generate one to run <code>aios push</code> from your workspace.
        </p>
      )}
    </section>
  );
}

function IssueMyKey({ teamSlug }: { teamSlug: string }) {
  const [open, setOpen] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (issued) {
    return (
      <div className="prism-card flex flex-col gap-3 border border-violet/40 p-4">
        <p className="text-sm font-medium text-ink">
          Key issued — copy it now. It is shown exactly once; only its hash is stored.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-lg bg-surface-overlay px-3 py-2 font-mono text-xs text-ink">
            {issued}
          </code>
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(issued);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="rounded-lg border border-border-default p-2 text-ink-secondary hover:text-ink"
            aria-label="Copy key"
          >
            {copied ? <Check className="size-4 text-violet" /> : <Copy className="size-4" />}
          </button>
        </div>
        <button
          onClick={() => {
            setIssued(null);
            setOpen(false);
          }}
          className="self-start rounded-lg bg-violet px-4 py-2 text-sm font-medium text-white"
        >
          Done — I copied it
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg bg-violet px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
      >
        <KeyRound className="size-4" strokeWidth={1.75} />
        Generate key
      </button>
    );
  }

  return (
    <form
      className="flex items-center gap-2"
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const res = await issueMyApiKey(teamSlug, String(formData.get("name") ?? ""));
          if (!res.ok || !res.key) setError(res.error ?? "failed");
          else setIssued(res.key);
        });
      }}
    >
      <input
        name="name"
        placeholder="key name (e.g. my-laptop)"
        required
        className="rounded-lg border border-border-default bg-surface-base px-3 py-2 text-sm text-ink outline-none focus:border-violet"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-violet px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? "Issuing…" : "Generate"}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="rounded-lg border border-border-default px-4 py-2 text-sm text-ink-secondary"
      >
        Cancel
      </button>
    </form>
  );
}

function RevokeMyKeyButton({ teamSlug, apiKeyId }: { teamSlug: string; apiKeyId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await revokeMyApiKey(teamSlug, apiKeyId);
        })
      }
      className="rounded-lg border border-border-default px-3 py-1 text-xs text-ink-secondary hover:border-red-300 hover:text-red-600 disabled:opacity-50"
    >
      {pending ? "…" : "Revoke"}
    </button>
  );
}
