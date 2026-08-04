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
  estimateGithubImportAction,
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

/** repo (lowercase) → chosen history days, from config.repoHistory (AIO-798). */
const historyOf = (i: IntegrationRow | null): Map<string, number> => {
  const raw = i?.config.repoHistory;
  const out = new Map<string, number>();
  if (Array.isArray(raw)) {
    for (const e of raw as { repo?: string; days?: number }[]) {
      if (e && typeof e.repo === "string" && typeof e.days === "number") out.set(e.repo.toLowerCase(), e.days);
    }
  }
  return out;
};

/** The history-window choices offered at link time. 14 first — the default the feature was asked for. */
const WINDOW_CHOICES = [
  { days: 14, label: "2 weeks" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 0, label: "No history" },
] as const;

type EstimateState =
  | { repo: string; busy: true }
  | {
      repo: string;
      busy: false;
      unreachable?: boolean;
      estimate?: Awaited<ReturnType<typeof estimateGithubImportAction>>["estimate"];
      priceUsd?: number | null;
      previouslyImportedTasks?: number;
    };

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
  // Two-step link flow (AIO-798): pick repo → see the priced estimate → choose a window → confirm.
  const [est, setEst] = useState<EstimateState | null>(null);
  const [windowDays, setWindowDays] = useState<number>(14);

  const linked = reposOf(integration);
  const historyByRepo = useMemo(() => historyOf(integration), [integration]);
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

  /** Step 1 of linking: nothing is imported — ~3 GitHub metadata calls produce the priced estimate. */
  function beginEstimate(repo: string, days = windowDays) {
    setError(null);
    setEst({ repo, busy: true });
    startTransition(async () => {
      const res = await estimateGithubImportAction(teamSlug, repo, days);
      if (!res.ok) {
        setEst(null);
        setError(res.error ?? "estimate failed");
        return;
      }
      setEst({
        repo,
        busy: false,
        unreachable: res.unreachable,
        estimate: res.estimate,
        priceUsd: res.priceUsd,
        previouslyImportedTasks: res.previouslyImportedTasks,
      });
    });
  }

  /** Step 2: the admin saw the number and chose the window — link, anchored. The unreachable path
   *  links WITHOUT a window (pre-window behaviour): no chips were shown there, so an invisible
   *  window from leftover state would be a choice the admin never made (review finding). */
  function confirmLink(withWindow = true) {
    if (!est) return;
    const repo = est.repo;
    setEst(null);
    act(() => (withWindow ? addGithubRepo(teamSlug, repo, windowDays) : addGithubRepo(teamSlug, repo)), true);
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

      <p className="rounded-lg border border-border-subtle bg-white/[0.02] px-3 py-2 text-xs text-ink-tertiary">
        <span className="font-semibold text-ink-secondary">Note:</span> syncing a repo imports its
        issues + files (knowledge base) and auto-populates the{" "}
        <span className="text-ink-secondary">Codebases</span> dashboard&apos;s commit-volume and
        per-person contribution graphs from the GitHub API.{" "}
        <span className="text-ink-secondary">Agent-readiness &amp; test coverage</span> still need a
        full <span className="font-mono text-ink-secondary">aios-ingest scan</span> (it reads the
        code checkout) — run it in CI on merge (
        <span className="font-mono text-ink-secondary">scan-on-merge.yml</span>) or once locally.
      </p>

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
              const days = historyByRepo.get(repo.toLowerCase());
              // The most expensive default (full history) must not be the invisible one.
              const windowLabel =
                days === undefined
                  ? "full history (linked before windows)"
                  : days === 0
                    ? "no history"
                    : `${days}d history`;
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
                  <span className="rounded-full bg-surface-overlay px-2 py-0.5 text-xs text-ink-tertiary">
                    {windowLabel}
                  </span>
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
          if (repo) beginEstimate(repo);
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
          <Plus className="size-4" /> Estimate &amp; link
        </button>
      </form>

      {/* Step 1 result: the priced estimate + window choice. Nothing has been imported yet. */}
      {est ? (
        <div className="flex flex-col gap-2 rounded-lg border border-violet/30 bg-violet/5 px-3 py-3">
          <p className="text-xs font-medium text-ink">
            <span className="font-mono">{est.repo}</span> — import estimate
          </p>
          {est.busy ? (
            <p className="text-sm text-ink-secondary">Sizing the repo (metadata only — nothing is imported yet)…</p>
          ) : est.unreachable ? (
            <>
              <p className="text-sm text-ink-secondary">
                <span className={`mr-2 rounded-full px-2 py-0.5 text-xs font-medium ${ACCESS_BADGE.no_access.cls}`}>
                  No access
                </span>
                This repo can&apos;t be read with the current token, so the cost is unknown until access
                works. You can still link it — it will import once a token with access is connected.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => confirmLink(false)}
                  className="btn-prism justify-center"
                >
                  Link anyway
                </button>
                <button
                  type="button"
                  onClick={() => setEst(null)}
                  className="rounded-lg border border-border-default px-3 py-1 text-xs text-ink-secondary"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : est.estimate ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
                <span className="mr-1 font-medium text-ink">History window:</span>
                {WINDOW_CHOICES.map((c) => (
                  <button
                    key={c.days}
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setWindowDays(c.days);
                      beginEstimate(est.repo, c.days);
                    }}
                    className={`rounded-full border px-2.5 py-0.5 ${
                      windowDays === c.days
                        ? "border-violet/50 bg-violet/10 text-violet"
                        : "border-border-default hover:text-ink"
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <ul className="text-sm text-ink-secondary">
                <li>
                  <span className="text-ink">{est.estimate.files}</span> markdown docs →{" "}
                  <span className="text-ink">
                    {est.estimate.atLeast ? "at least " : ""}
                    {est.estimate.fileEpisodes}
                  </span>{" "}
                  graph episodes (imported as they are now — the window applies to issues &amp; commits)
                </li>
                <li>
                  {est.estimate.issueCount === null ? (
                    <>issues in window: unknown</>
                  ) : (
                    <>
                      <span className="text-ink">{est.estimate.issueCount}</span> issues in window → ~
                      <span className="text-ink">{est.estimate.issueEpisodes}</span> episodes
                    </>
                  )}
                </li>
                <li>
                  {est.estimate.commitCount === null ? (
                    <>commits in window: unknown</>
                  ) : (
                    <>
                      <span className="text-ink">{est.estimate.commitCount}</span> commits → contributor
                      graphs · no extraction cost
                    </>
                  )}
                </li>
              </ul>
              <p className="text-sm font-medium text-ink">
                {est.priceUsd !== null && est.priceUsd !== undefined ? (
                  <>
                    Initial import ≈ {est.estimate.atLeast ? "at least " : ""}
                    {est.estimate.episodes} episodes ≈ ${est.priceUsd.toFixed(2)} at your current
                    extraction model
                  </>
                ) : (
                  <>
                    Initial import ≈ {est.estimate.atLeast ? "at least " : ""}
                    {est.estimate.episodes} episodes — no local price history yet; the Costs page will
                    show the real spend as it lands
                  </>
                )}
              </p>
              {est.previouslyImportedTasks ? (
                <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  This repo was imported before ({est.previouslyImportedTasks} tasks exist). Linking with
                  a narrower window will <strong>remove previously imported tasks</strong> outside it on
                  the first sync.
                </p>
              ) : null}
              <div className="flex gap-2">
                <button type="button" disabled={pending} onClick={() => confirmLink()} className="btn-prism justify-center">
                  <Plus className="size-4" /> Link with{" "}
                  {WINDOW_CHOICES.find((c) => c.days === windowDays)?.label.toLowerCase() ?? "window"}
                </button>
                <button
                  type="button"
                  onClick={() => setEst(null)}
                  className="rounded-lg border border-border-default px-3 py-1 text-xs text-ink-secondary"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

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
                onClick={() => beginEstimate(repo)}
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
