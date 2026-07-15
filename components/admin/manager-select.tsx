"use client";

import { useState, useTransition } from "react";
import { setMemberManager } from "@/app/t/[team]/admin/members/actions";

/**
 * Inline "reports to" editor for the Admin → Members table (admins only). The org-chart source
 * synced into the company graph (`GET /api/v1/company-graph`, `lib/query/retrieve.ts`'s chat
 * context) — without this, `manager_member_id` would only be settable via CLI/psql. Optimistic:
 * reverts with an error if the server rejects it (self, cross-team, disabled, or connector).
 */
export function ManagerSelect({
  teamSlug,
  memberId,
  managerMemberId,
  candidates,
}: {
  teamSlug: string;
  memberId: string;
  managerMemberId: string | null;
  candidates: { id: string; displayName: string }[];
}) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<string>(managerMemberId ?? "");
  const [error, setError] = useState<string | null>(null);

  function change(next: string) {
    if (next === value) return;
    const prev = value;
    setValue(next); // optimistic: reflect the new manager instantly
    setError(null);
    startTransition(async () => {
      const res = await setMemberManager(teamSlug, memberId, next || null);
      // No router.refresh(): this select is the only surface showing the assignment on the page
      // (the company-graph is rebuilt server-side on read, not from a page re-render).
      if (!res.ok) {
        setValue(prev); // revert on server rejection (self / cross-team / disabled / connector)
        setError(res.error ?? "could not set manager");
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <select
        value={value}
        disabled={pending}
        onChange={(e) => change(e.target.value)}
        aria-label="Reports to"
        className="rounded-lg border border-border-default bg-transparent px-2 py-0.5 text-xs text-ink-secondary outline-none disabled:opacity-50"
      >
        <option value="">— none —</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.displayName}
          </option>
        ))}
      </select>
      {error ? <span className="text-[11px] text-red-600">{error}</span> : null}
    </div>
  );
}
