"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GitBranch, Plus, Trash2, RefreshCw, KeyRound, ShieldCheck } from "lucide-react";
import {
  addGithubRepo,
  removeGithubRepo,
  toggleIntegration,
  syncGithubNow,
  connectGithubToken,
  checkGithubAccess,
} from "@/app/t/[team]/admin/integrations/actions";
import type { RepoAccess, RepoAccessState } from "@/lib/integrations/github-validate";
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

const ACCESS_BADGE: Record<RepoAccessState, { label: string; cls: string }> = {
  public: { label: "Public", cls: "bg-surface-overlay text-ink-tertiary" },
  private: { label: "Private · reachable", cls: "bg-emerald/10 text-emerald-700" },
  no_access: { label: "No access", cls: "bg-red/10 text-red" },
  error: { label: "Unknown", cls: "bg-amber/10 text-amber-700" },
};

/**
 * Admin → Integrations · GitHub repositories. Always rendered (even with no integration row yet) so
 * GitHub is visible/manageable like the other connectors. Lists linked repos, adds/removes them,
 * surfaces scanned repos as suggestions, and drives the PRIVATE-REPO flow: connect a validated PAT
 * ("Connected as @login"), then "Check access" shows per-repo public / private-reachable / no-access
 * BEFORE a sync. Writes go through admin-gated server actions; the token is stored encrypted.
 */
export function GithubReposPanel({ teamSlug, integration, scannedRepos }: GithubReposPanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [showConnect, setShowConnect] = useState(false);
  const [token, setToken] = useState("");
  const [connectMsg, setConnectMsg] = useState<string | null>(null);
  const [access, setAccess] = useState<RepoAccess[] | null>(null);

  const linked = reposOf(integration);
  const linkedLower = useMemo(() => new Set(linked.map((r) => r.toLowerCase())), [linked]);
  const suggestions = scannedRepos.filter((r) => !linkedLower.has(r.toLowerCase()));
  const enabled = integration?.status === "enabled";
  const hasToken = !!integration?.hasSecret;
  const accessByRepo = useMemo(
    () => new Map((access ?? []).map((a) => [a.repo.toLowerCase(), a])),
    [access]
  );

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

  function connect() {
    const t = token.trim();
    if (!t) return;
    setError(null);
    setConnectMsg(null);
    startTransition(async () => {
      const res = await connectGithubToken(teamSlug, t);
      if (!res.ok) setError(res.error ?? "could not connect");
      else {
        setToken("");
        setShowConnect(false);
        setConnectMsg(res.login ? `Connected as @${res.login}` : "Token connected");
        router.refresh();
      }
    });
  }

  function checkAccess() {
    setError(null);
    startTransition(async () => {
      const res = await checkGithubAccess(teamSlug);
      if (!res.ok) setError(res.error ?? "access check failed");
      else setAccess(res.access ?? []);
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
          {hasToken ? " · token set ✓" : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => setShowConnect((v) => !v)}
            title={hasToken ? "Replace the GitHub token" : "Connect a token to sync private repos"}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-medium disabled:opacity-50 ${
              hasToken ? "border-emerald/40 bg-emerald/5 text-emerald-700" : "border-border-default text-ink-secondary hover:text-ink"
            }`}
          >
            <KeyRound className="size-3.5" /> {hasToken ? "Token connected" : "Connect token"}
          </button>
          {integration ? (
            <>
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
            </>
          ) : null}
        </div>
      </div>

      <p className="text-xs text-ink-secondary">
        Link one or more repos. The brain imports each repo&apos;s{" "}
        <span className="text-ink">issues → tasks</span> and{" "}
        <span className="text-ink">files → deliverables</span>. Public repos need no token;{" "}
        <span className="text-ink">private repos need a token</span> (connect one above).
      </p>

      {/* Connect-token flow (private repos) */}
      {showConnect ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-overlay/40 px-3 py-3">
          <p className="text-xs font-medium text-ink">Connect a GitHub token (for private repos)</p>
          <p className="text-xs text-ink-secondary">
            Create a{" "}
            <a
              href="https://github.com/settings/tokens?type=beta"
              target="_blank"
              rel="noreferrer"
              className="text-violet hover:underline"
            >
              fine-grained token
            </a>{" "}
            with <span className="font-mono text-ink">Contents: Read-only</span> +{" "}
            <span className="font-mono text-ink">Issues: Read-only</span> on the repos you&apos;re linking
            (or a classic token with the <span className="font-mono text-ink">repo</span> scope). It&apos;s
            validated here and stored encrypted — never shown again.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="prism-input flex-1"
              type="password"
              autoComplete="off"
              placeholder="github_pat_… or ghp_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              aria-label="GitHub token"
            />
            <button
              type="button"
              onClick={connect}
              disabled={pending || !token.trim()}
              className="btn-prism justify-center"
            >
              <ShieldCheck className="size-4" /> Validate &amp; connect
            </button>
          </div>
        </div>
      ) : null}

      {connectMsg ? (
        <p className="rounded-lg border border-emerald/30 bg-emerald/5 px-3 py-2 text-sm text-emerald-700">
          {connectMsg}
        </p>
      ) : null}

      {/* Linked repos */}
      {linked.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-default px-3 py-4 text-center text-sm text-ink-tertiary">
          No repositories linked yet. Add one below.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink-secondary">Linked</span>
            <button
              type="button"
              disabled={pending}
              onClick={checkAccess}
              title="Probe each repo's access with the current token"
              className="flex items-center gap-1.5 rounded-lg border border-border-default px-2.5 py-1 text-xs text-ink-secondary hover:text-ink disabled:opacity-50"
            >
              <ShieldCheck className="size-3.5" /> Check access
            </button>
          </div>
          <ul className="flex flex-col gap-1.5">
            {linked.map((repo) => {
              const a = accessByRepo.get(repo.toLowerCase());
              const badge = a ? ACCESS_BADGE[a.state] : null;
              return (
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
                  {badge ? (
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>
                      {badge.label}
                    </span>
                  ) : null}
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
              );
            })}
          </ul>
        </>
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
