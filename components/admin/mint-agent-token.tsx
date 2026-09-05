"use client";

import { useState, useTransition } from "react";
import { Bot, Copy, Check } from "lucide-react";
import { mintAgentTokenAction, revokeAgentTokenAction } from "@/app/t/[team]/admin/agents/actions";
import {
  DEFAULT_TOKEN_LIFETIME_DAYS,
  MAX_TOKEN_LIFETIME_MS,
  MAX_PROJECT_SCOPE,
  canSubmitMint,
  expiryInstantFor,
  type ScopeChoice,
} from "@/lib/access/agent-token-policy";

type MemberOpt = { id: string; display_name: string; actor_handle: string };
type ProjectOpt = { id: string; name: string; slug: string };

/**
 * AGENTUI-1 mint form.
 *
 * The rules below are ALSO enforced in `lib/access/agent-token-policy`, which the server action
 * applies — this component makes the legal choices easy, it does not make them binding. That split
 * is deliberate: a server action is a public endpoint, so a constraint that lives only here binds
 * only people who use this page.
 *
 * SCOPE HAS NO DEFAULT. `null` (inherit) and a populated array are both legal, and they differ
 * enormously in blast radius, so the admin must SAY which. An untouched control yields no
 * submittable payload at all — never a silent `null` (which would inherit everything) and never a
 * silent `[]` (which mints a token that reads nothing).
 *
 * The secret is rendered in a `<code>`, never an `<input>`: an input invites password-manager and
 * autofill capture. It is held in state only until dismissed, and is never attached to an error —
 * the admin error boundary reports to Sentry.
 */

function defaultExpiryValue(): string {
  const d = new Date(Date.now() + DEFAULT_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function maxExpiryValue(): string {
  return new Date(Date.now() + MAX_TOKEN_LIFETIME_MS).toISOString().slice(0, 10);
}

function minExpiryValue(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

/** The show-once reveal. Split out so `MintAgentToken` stays under the complexity ceiling and so
 *  the secret's handling lives in one small, readable place. */
function MintedPanel({
  token,
  onDone,
}: {
  token: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  return (
    <div className="prism-card flex max-w-xl flex-col gap-3 border border-violet/40 p-4">
      <p className="text-sm font-medium text-ink">
        Token minted — copy it now. It is shown exactly once; only its hash is stored.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-lg bg-surface-overlay px-3 py-2 font-mono text-xs text-ink">
          {token}
        </code>
        <button
          onClick={() => {
            // A rejection (no permission / insecure context) must not become an unhandled rejection
            // with no feedback. The token stays on screen for manual copy either way.
            navigator.clipboard.writeText(token).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => setCopyError("Couldn't copy — select the token above and copy it manually.")
            );
          }}
          className="rounded-lg border border-border-default p-2 text-ink-secondary hover:text-ink"
          aria-label="Copy token"
        >
          {copied ? <Check className="size-4 text-violet" /> : <Copy className="size-4" />}
        </button>
      </div>
      {copyError && <p className="text-xs text-red-600">{copyError}</p>}
      <p className="text-xs text-ink-tertiary">
        Set it as <code>AIOS_API_KEY</code> for the agent. Reads only — <code>aios push</code> with
        this token returns 401.
      </p>
      <button onClick={onDone} className="self-start rounded-lg bg-violet px-4 py-2 text-sm font-medium text-white">
        Done — I copied it
      </button>
    </div>
  );
}

export function MintAgentToken({
  teamSlug,
  members,
  projects,
}: {
  teamSlug: string;
  members: MemberOpt[];
  projects: ProjectOpt[];
}) {
  const [open, setOpen] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [memberId, setMemberId] = useState("");
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState(defaultExpiryValue);
  const [scope, setScope] = useState<ScopeChoice>(null);
  // Date bounds read the clock. A lazy `useState` initializer still runs during the FIRST render —
  // so this is not "no clock read during render", it is "read once, then stable", which is what
  // keeps re-renders pure. Stated accurately because an earlier comment overclaimed it. A server/
  // client boundary crossing midnight UTC can therefore differ by a day; harmless, because the
  // ACTION re-checks and clamps both bounds, so a stale bound can never widen what is minted.
  const [expiryBounds] = useState(() => ({ min: minExpiryValue(), max: maxExpiryValue() }));

  // The rule itself lives in the policy module so it is unit-testable without a DOM harness, and so
  // the "untouched scope must not submit" hazard is pinned by an assertion rather than by this JSX.
  const scopeChosen = canSubmitMint({ memberId: memberId || "x", expiry: expiry || "x", scope });
  const canSubmit = canSubmitMint({ memberId, expiry, scope }) && !pending;

  if (minted) {
    return (
      <MintedPanel
        token={minted}
        onDone={() => {
          setMinted(null);
          setOpen(false);
          setScope(null);
          setMemberId("");
          setName("");
          setExpiry(defaultExpiryValue());
        }}
      />
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex shrink-0 items-center gap-2 rounded-lg bg-violet px-4 py-2 text-sm font-medium text-white"
      >
        <Bot className="size-4" /> Mint agent token
      </button>
    );
  }

  return (
    <div className="prism-card flex w-full max-w-xl flex-col gap-3 p-4">
      <label className="flex flex-col gap-1 text-xs text-ink-secondary">
        Acts as
        <select
          value={memberId}
          onChange={(e) => setMemberId(e.target.value)}
          className="rounded-lg border border-border-default bg-surface-card px-3 py-2 text-sm text-ink"
        >
          <option value="">Choose a member…</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name} ({m.actor_handle})
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-ink-secondary">
        Label
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. status-check agent"
          className="rounded-lg border border-border-default bg-surface-card px-3 py-2 text-sm text-ink"
        />
      </label>

      <fieldset className="flex flex-col gap-2 text-xs text-ink-secondary">
        <legend className="mb-1">Projects this token can read</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="scope"
            checked={scope?.kind === "inherit"}
            onChange={() => setScope({ kind: "inherit" })}
          />
          <span>Everything the member can see (inherits their access as it changes)</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="scope"
            checked={scope?.kind === "restrict"}
            onChange={() => setScope({ kind: "restrict", projectIds: [] })}
          />
          <span>Only the projects I choose</span>
        </label>
        {scope?.kind === "restrict" && (
          <div className="ml-6 flex max-h-40 flex-col gap-1 overflow-y-auto">
            {projects.length === 0 && (
              <span className="text-ink-tertiary">
                No projects available — choose the option above, or try again once projects load.
              </span>
            )}
            {projects.map((p) => (
              <label key={p.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={scope.projectIds.includes(p.id)}
                  disabled={!scope.projectIds.includes(p.id) && scope.projectIds.length >= MAX_PROJECT_SCOPE}
                  onChange={(e) =>
                    setScope({
                      kind: "restrict",
                      // Capped here too: the action refuses more than MAX_PROJECT_SCOPE, and the
                      // form must not be able to compose a request the action will reject.
                      projectIds: e.target.checked
                        ? [...scope.projectIds, p.id].slice(0, MAX_PROJECT_SCOPE)
                        : scope.projectIds.filter((id) => id !== p.id),
                    })
                  }
                />
                <span>{p.name || p.slug}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <label className="flex flex-col gap-1 text-xs text-ink-secondary">
        Expires (required, max {Math.round(MAX_TOKEN_LIFETIME_MS / 86_400_000)} days)
        <input
          type="date"
          value={expiry}
          min={expiryBounds.min}
          max={expiryBounds.max}
          onChange={(e) => setExpiry(e.target.value)}
          className="rounded-lg border border-border-default bg-surface-card px-3 py-2 text-sm text-ink"
        />
      </label>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          disabled={!canSubmit}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const res = await mintAgentTokenAction(teamSlug, {
                memberId,
                name,
                // End of the chosen day, CLAMPED to the cap — picking the max offered date used to
                // submit an instant ~12h past the exact 365-day limit, which the action then refused.
                expiresAt: expiryInstantFor(expiry, Date.now()),
                projectScope: scope?.kind === "restrict" ? scope.projectIds : null,
              });
              // Deliberately does NOT include res.token in any error path.
              if (!res.ok || !res.token) {
                setError(res.error || "mint failed");
                return;
              }
              setMinted(res.token);
            })
          }
          className="rounded-lg bg-violet px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {pending ? "Minting…" : "Mint token"}
        </button>
        <button
          onClick={() => { setOpen(false); setError(null); }}
          className="rounded-lg border border-border-default px-4 py-2 text-sm text-ink-secondary"
        >
          Cancel
        </button>
        {!scopeChosen && (
          <span className="text-xs text-ink-tertiary">Choose what this token can read to continue.</span>
        )}
      </div>
    </div>
  );
}

export function RevokeAgentTokenButton({
  teamSlug,
  tokenRowId,
}: {
  teamSlug: string;
  tokenRowId: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex items-center gap-2">
      {/* Surfaced, not swallowed: a revoke that silently fails leaves a live credential looking dead. */}
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await revokeAgentTokenAction(teamSlug, tokenRowId);
            if (!res.ok) setError(res.error || "revoke failed");
          })
        }
        className="text-xs text-ink-tertiary hover:text-red-600 disabled:opacity-40"
      >
        {pending ? "Revoking…" : "Revoke"}
      </button>
    </span>
  );
}
