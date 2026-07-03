"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GitBranch, Plus, Trash2, RefreshCw, KeyRound } from "lucide-react";
import {
  addGithubRepo,
  removeGithubRepo,
  toggleIntegration,
  syncGithubNow,
  rotateSecret,
} from "@/app/t/[team]/admin/integrations/actions";
import type { IntegrationRow } from "@/components/admin/integrations-manager";

interface GithubReposPanelProps {
  teamSlug: string;
  /** The team's canonical github integration row, or null if none has been created yet. */
  integration: IntegrationRow | null;
  /** Repos already scanned (from `codebases`) — offered as one-click "link" suggestions. */
  scannedRepos: string[];
}

const reposOf = (i: IntegrationRow | null): string[] =>
  Array.isArray(i?.config.repos) ? (i!.config.repos as string[]) : [];

/**
 * Admin → Integrations · GitHub repositories. Always rendered (even with no integration row yet) so
 * GitHub is visible and manageable like the other connectors. Lists the linked repos, adds/removes
 * them (multiple), surfaces already-scanned repos as link suggestions, and exposes enable/disable,
 * a private-repo token, and "Sync now" once a row exists. Writes go through admin-gated server
 * actions; the single github row holds all repos in `config.repos`.
 */
export function GithubReposPanel({ teamSlug, integration, scannedRepos }: GithubReposPanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");

  const linked = reposOf(integration);
  const linkedLower = useMemo(() => new Set(linked.map((r) => r.toLowerCase())), [linked]);
  const suggestions = scannedRepos.filter((r) => !linkedLower.has(r.toLowerCase()));
  const enabled = integration?.status === "enabled";

  function act(fn: () => Promise<{ ok: boolean; error?: string }>, clearInput = false) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "something went wrong");
      else {
        if (clearInput) setInput("");
        router.refresh();
      }
    });
  }

  return (
    <div className="prism-card flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <GitBranch className="size-4 text-violet" /> GitHub repositories
        </p>
        <span className="text-xs text-ink-tertiary">
          {linked.length} linked{integration ? (enabled ? " · enabled" : " · disabled") : ""}
        </span>
        {integration ? (
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => act(() => syncGithubNow(teamSlug))}
              title="Import each linked repo's issues + files into the brain now"
              className="flex items-center gap-1.5 rounded-lg border border-violet/40 bg-violet/10 px-3 py-1 text-xs font-medium text-violet disabled:opacity-50"
            >
              <RefreshCw className={`size-3.5 ${pending ? "animate-spin" : ""}`} /> Sync now
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                act(() => toggleIntegration(teamSlug, integration.id, enabled ? "disabled" : "enabled"))
              }
              className={`rounded-lg border px-3 py-1 text-xs font-medium ${
                enabled ? "border-violet/40 bg-violet/10 text-violet" : "border-border-default text-ink-tertiary"
              }`}
            >
              {enabled ? "Enabled" : "Disabled"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                const s = window.prompt("GitHub token for private repos (stored encrypted):");
                if (s) act(() => rotateSecret(teamSlug, integration.id, s));
              }}
              title={integration.hasSecret ? "Replace GitHub token" : "Add a GitHub token (for private repos)"}
              className="rounded-lg border border-border-default p-1.5 text-ink-secondary hover:text-ink"
              aria-label="Set GitHub token"
            >
              <KeyRound className={`size-4 ${integration.hasSecret ? "text-emerald-700" : ""}`} />
            </button>
          </div>
        ) : null}
      </div>

      <p className="text-xs text-ink-secondary">
        Link one or more repos (public repos need no token). The brain imports each repo&apos;s{" "}
        <span className="text-ink">issues → tasks</span> and{" "}
        <span className="text-ink">files → deliverables</span>. Add a token above for private repos.
      </p>

      {/* Linked repos */}
      {linked.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-default px-3 py-4 text-center text-sm text-ink-tertiary">
          No repositories linked yet. Add one below.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {linked.map((repo) => (
            <li
              key={repo}
              className="flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2"
            >
              <GitBranch className="size-4 text-ink-tertiary" />
              <a
                href={`https://github.com/${repo}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-sm text-ink hover:text-violet hover:underline"
              >
                {repo}
              </a>
              <button
                type="button"
                disabled={pending}
                onClick={() => act(() => removeGithubRepo(teamSlug, repo))}
                className="ml-auto rounded-md border border-border-default p-1 text-ink-tertiary hover:text-red disabled:opacity-50"
                aria-label={`Unlink ${repo}`}
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Add a repo */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const repo = input.trim();
          if (repo) act(() => addGithubRepo(teamSlug, repo), true);
        }}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <input
          className="prism-input flex-1"
          placeholder="owner/repo (or a github.com URL)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="Repository to link"
        />
        <button type="submit" disabled={pending || !input.trim()} className="btn-prism justify-center">
          <Plus className="size-4" /> Link repo
        </button>
      </form>

      {/* Scanned-but-unlinked suggestions */}
      {suggestions.length > 0 ? (
        <div className="flex flex-col gap-1.5 border-t border-border-subtle pt-3">
          <p className="text-xs text-ink-secondary">
            Detected from codebase scans — link to also ingest their issues &amp; files:
          </p>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((repo) => (
              <button
                key={repo}
                type="button"
                disabled={pending}
                onClick={() => act(() => addGithubRepo(teamSlug, repo))}
                className="flex items-center gap-1.5 rounded-full border border-border-default px-3 py-1 text-xs text-ink-secondary hover:border-violet/40 hover:text-violet disabled:opacity-50"
              >
                <Plus className="size-3" /> <span className="font-mono">{repo}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {error ? <p className="text-sm text-red">{error}</p> : null}
    </div>
  );
}
