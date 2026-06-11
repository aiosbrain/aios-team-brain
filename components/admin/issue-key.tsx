"use client";

import { useState, useTransition } from "react";
import { KeyRound, Copy, Check } from "lucide-react";
import { issueApiKey, revokeApiKey } from "@/app/t/[team]/admin/actions";

type MemberOpt = { id: string; display_name: string; actor_handle: string };

export function IssueKey({ teamSlug, members }: { teamSlug: string; members: MemberOpt[] }) {
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
          onClick={() => { setIssued(null); setOpen(false); }}
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
        Issue key
      </button>
    );
  }

  return (
    <form
      className="prism-card flex flex-col gap-3 p-4"
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const res = await issueApiKey(
            teamSlug,
            String(formData.get("memberId") ?? ""),
            String(formData.get("name") ?? "")
          );
          if (!res.ok || !res.key) setError(res.error ?? "failed");
          else setIssued(res.key);
        });
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <select name="memberId" required
          className="rounded-lg border border-border-default bg-surface-base px-3 py-2 text-sm text-ink outline-none focus:border-violet">
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name} ({m.actor_handle})
            </option>
          ))}
        </select>
        <input name="name" placeholder="key name (e.g. alex-laptop)"
          className="rounded-lg border border-border-default bg-surface-base px-3 py-2 text-sm text-ink outline-none focus:border-violet" />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={pending}
          className="rounded-lg bg-violet px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {pending ? "Issuing…" : "Issue"}
        </button>
        <button type="button" onClick={() => setOpen(false)}
          className="rounded-lg border border-border-default px-4 py-2 text-sm text-ink-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

export function RevokeKeyButton({ teamSlug, apiKeyId }: { teamSlug: string; apiKeyId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await revokeApiKey(teamSlug, apiKeyId);
        })
      }
      className="rounded-lg border border-border-default px-3 py-1 text-xs text-ink-secondary hover:border-red-300 hover:text-red-600 disabled:opacity-50"
    >
      {pending ? "…" : "Revoke"}
    </button>
  );
}
