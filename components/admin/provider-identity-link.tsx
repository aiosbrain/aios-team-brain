"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Hash, Check, X } from "lucide-react";
import { linkMemberIdentity, unlinkMemberIdentity } from "@/app/t/[team]/admin/members/actions";
import {
  identityLinkRequest,
  identityUnlinkRequest,
  standingRemapOffer,
  type IdentityRemapOffer,
} from "@/components/admin/provider-identity-link-payload";

/**
 * Inline admin control to map a member to ONE provider's user id (slack/linear/plane) — the manual
 * path / correction when auto-reconcile missed (e.g. a different email on that platform). Shows the
 * current link with set/change/unlink. Writes `member_identities` via the generic admin actions.
 *
 * `externalId` + `revision` are what this row DISPLAYS. They are sent as the observation of that
 * identity only; the id typed into the box is a separate request, and the action observes it
 * itself. An id another member holds comes back as a remap offer, confirmed here explicitly — except
 * from a blank Google row, which the action refuses outright. What is sent, and which offer still
 * stands, is decided in `provider-identity-link-payload` (pure, and tested there).
 */
export function ProviderIdentityLink({
  teamSlug,
  memberId,
  provider,
  label,
  externalId,
  handle,
  email,
  revision,
  placeholder,
}: {
  teamSlug: string;
  memberId: string;
  provider: "slack" | "linear" | "plane" | "gdrive";
  label: string;
  externalId: string | null;
  handle: string | null;
  email: string | null;
  revision: number;
  placeholder: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(externalId ?? "");
  const [error, setError] = useState<string | null>(null);
  // A remap the action reported and has not made: the requested id, who holds it, and the revision
  // it was shown at. Only an explicit confirmation sends that revision back.
  const [remap, setRemap] = useState<IdentityRemapOffer | null>(null);
  // Shown, and confirmable, only while the box still holds the id the offer named.
  const offer = standingRemapOffer(remap, value);

  function submit(confirmRemap = false) {
    setError(null);
    const request = identityLinkRequest({ provider, externalId, revision }, value, remap, confirmRemap);
    startTransition(async () => {
      const res = await linkMemberIdentity(teamSlug, memberId, request.provider, request.externalId, handle ?? undefined, request.observed);
      if (res.remap) return setRemap(res.remap);
      setRemap(null);
      if (!res.ok) return setError(res.error ?? "could not link");
      setEditing(false);
      router.refresh();
    });
  }
  function cancel() {
    setRemap(null);
    setEditing(false);
  }
  function unlink() {
    // The displayed id, bound to THIS row's member and the revision it displays.
    const request = identityUnlinkRequest({ provider, externalId, revision }, memberId);
    if (!request) return;
    setError(null);
    startTransition(async () => {
      const res = await unlinkMemberIdentity(teamSlug, request.provider, request.externalId, request.observed);
      if (!res.ok) return setError(res.error ?? "could not unlink");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <span className="w-14 shrink-0 text-xs text-ink-tertiary">{label}</span>
        {editing ? (
          <>
            <input
              autoFocus
              className="prism-input h-6 w-28 px-1.5 py-0 text-xs"
              placeholder={placeholder}
              value={value}
              onChange={(e) => {
                // An offer is for the exact id it named; a different id is a different request.
                const requested = e.target.value;
                setRemap((standing) => standingRemapOffer(standing, requested));
                setValue(requested);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") cancel();
              }}
            />
            <button onClick={() => submit()} disabled={pending} className="rounded border border-violet/40 bg-violet/10 px-1.5 py-0 text-xs font-medium text-violet disabled:opacity-50">
              {pending ? "…" : "Save"}
            </button>
            <button onClick={cancel} className="rounded border border-border-default px-1.5 py-0 text-xs text-ink-tertiary">
              Cancel
            </button>
          </>
        ) : externalId ? (
          <>
            <span className="flex items-center gap-1 text-xs text-ink-secondary">
              <Hash className="size-3" />
              <span className="font-mono">{handle || externalId}</span>
              <Check className="size-3 text-emerald-600" />
            </span>
            {provider === "gdrive" && email ? (
              <span className="text-xs text-ink-tertiary" title="Verified Google account email">{email}</span>
            ) : null}
            <button onClick={() => setEditing(true)} className="rounded border border-border-default px-1.5 py-0 text-xs text-ink-secondary hover:text-ink">
              Change
            </button>
            <button onClick={unlink} disabled={pending} className="rounded border border-border-default p-0.5 text-ink-tertiary hover:text-red disabled:opacity-50" aria-label={`Unlink ${label}`}>
              <X className="size-3" />
            </button>
          </>
        ) : (
          <>
            <span className="text-xs text-ink-tertiary">not linked</span>
            <button onClick={() => setEditing(true)} className="rounded border border-violet/40 bg-violet/10 px-1.5 py-0 text-xs font-medium text-violet">
              Link
            </button>
          </>
        )}
      </div>
      {editing && offer ? (
        <div className="flex items-center gap-1.5 pl-14 text-xs text-amber-600">
          <span>
            <span className="font-mono">{offer.externalId}</span> is linked to {offer.linkedTo}. Remap it to this member?
          </span>
          <button onClick={() => submit(true)} disabled={pending} className="rounded border border-border-default px-1.5 py-0 text-xs text-ink-secondary hover:text-ink disabled:opacity-50">
            {pending ? "…" : "Remap"}
          </button>
        </div>
      ) : null}
      {error ? <p className="pl-14 text-xs text-red">{error}</p> : null}
    </div>
  );
}
