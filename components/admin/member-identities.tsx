"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Mail, Plus, X, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import { addMemberEmail, removeMemberEmail } from "@/app/t/[team]/admin/members/actions";
import { MemberGithubLink } from "@/components/admin/member-github-link";
import { ProviderIdentityLink } from "@/components/admin/provider-identity-link";

export interface ProviderLink {
  externalId: string;
  handle: string;
}

export interface MemberIdentityProps {
  teamSlug: string;
  memberId: string;
  rosterEmail: string;
  github: { login: string; avatarUrl: string | null } | null;
  emails: string[]; // alias emails (member_emails)
  slack: ProviderLink | null;
  linear: ProviderLink | null;
  plane: ProviderLink | null;
}

const PROVIDER_META = [
  { key: "slack", label: "Slack", placeholder: "U0123ABC" },
  { key: "linear", label: "Linear", placeholder: "user uuid" },
  { key: "plane", label: "Plane", placeholder: "member id" },
] as const;

/**
 * Per-member identity panel for Admin → Members: every platform we've linked this person to
 * (GitHub login, Slack/Linear/Plane user ids) + their email aliases — each editable. Surfaces gaps
 * (an unlinked provider is shown explicitly) so the "different email on a different platform" case
 * is visible and fixable: add the alternate email as an alias, or link the provider id directly.
 */
export function MemberIdentities(props: MemberIdentityProps) {
  const { teamSlug, memberId, rosterEmail, github, emails, slack, linear, plane } = props;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [newEmail, setNewEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const providers: Record<string, ProviderLink | null> = { slack, linear, plane };
  const linkedCount = [github, slack, linear, plane].filter(Boolean).length;
  const unlinked = PROVIDER_META.filter((p) => !providers[p.key]).map((p) => p.label);

  function addEmail() {
    const e = newEmail.trim();
    if (!e) return;
    setError(null);
    startTransition(async () => {
      const res = await addMemberEmail(teamSlug, memberId, e);
      if (!res.ok) return setError(res.error ?? "could not add email");
      setNewEmail("");
      router.refresh();
    });
  }
  function removeEmail(email: string) {
    setError(null);
    startTransition(async () => {
      const res = await removeMemberEmail(teamSlug, email);
      if (!res.ok) return setError(res.error ?? "could not remove email");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-ink-secondary hover:text-ink"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span>
          {linkedCount} linked{emails.length ? ` · ${emails.length} alias${emails.length > 1 ? "es" : ""}` : ""}
        </span>
        {unlinked.length ? (
          <span className="flex items-center gap-1 text-amber-600" title={`No ${unlinked.join(", ")} identity`}>
            <AlertTriangle className="size-3" /> {unlinked.join(", ")}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border-subtle p-2">
          {/* Emails */}
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1 text-xs font-medium text-ink-secondary">
              <Mail className="size-3" /> Emails
            </span>
            <div className="flex flex-wrap items-center gap-1">
              <span className="rounded-full bg-surface-overlay px-2 py-0.5 text-xs text-ink-secondary" title="roster email (primary)">
                {rosterEmail} <span className="text-ink-tertiary">· primary</span>
              </span>
              {emails.map((e) => (
                <span key={e} className="flex items-center gap-1 rounded-full border border-border-default px-2 py-0.5 text-xs text-ink-secondary">
                  {e}
                  <button onClick={() => removeEmail(e)} disabled={pending} className="text-ink-tertiary hover:text-red" aria-label={`Remove ${e}`}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              <span className="flex items-center gap-1">
                <input
                  className="prism-input h-6 w-40 px-1.5 py-0 text-xs"
                  placeholder="alt email on another platform…"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addEmail();
                  }}
                />
                <button onClick={addEmail} disabled={pending} className="rounded border border-violet/40 bg-violet/10 p-0.5 text-violet disabled:opacity-50" aria-label="Add email">
                  <Plus className="size-3.5" />
                </button>
              </span>
            </div>
            <p className="text-xs text-ink-tertiary">
              Add the email this person uses on another platform so its activity reconciles to them.
            </p>
          </div>

          {/* Platform links */}
          <div className="flex flex-col gap-1 border-t border-border-subtle pt-2">
            <div className="flex items-center gap-1.5">
              <span className="w-14 shrink-0 text-xs text-ink-tertiary">GitHub</span>
              <MemberGithubLink
                teamSlug={teamSlug}
                memberId={memberId}
                githubLogin={github?.login ?? null}
                avatarUrl={github?.avatarUrl ?? null}
              />
            </div>
            {PROVIDER_META.map((p) => (
              <ProviderIdentityLink
                key={p.key}
                teamSlug={teamSlug}
                memberId={memberId}
                provider={p.key}
                label={p.label}
                externalId={providers[p.key]?.externalId ?? null}
                handle={providers[p.key]?.handle ?? null}
                placeholder={p.placeholder}
              />
            ))}
          </div>
          {error ? <p className="text-xs text-red">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
