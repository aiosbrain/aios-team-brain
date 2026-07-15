"use client";

import { useState, useTransition } from "react";
import { setMemberRole } from "@/app/t/[team]/admin/members/actions";

type Role = "admin" | "lead" | "member";

const BADGE_CLS: Record<Role, string> = {
  admin: "bg-violet/10 text-violet",
  lead: "bg-surface-overlay text-ink-secondary",
  member: "bg-surface-overlay text-ink-secondary",
};

/**
 * Inline role editor for the Admin → Members table (admins only — the page itself is
 * admin-gated). Optimistic: the select shows the new role immediately and reverts with an
 * error if the server rejects it (e.g. demoting the last admin).
 */
export function MemberRoleSelect({
  teamSlug,
  memberId,
  role,
}: {
  teamSlug: string;
  memberId: string;
  role: Role;
}) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<Role>(role);
  const [error, setError] = useState<string | null>(null);

  function change(next: Role) {
    if (next === value) return;
    const prev = value;
    setValue(next); // optimistic: reflect the new role instantly
    setError(null);
    startTransition(async () => {
      const res = await setMemberRole(teamSlug, memberId, next);
      // No router.refresh(): the select is the only surface showing role, and it's already updated.
      // Skipping the full-route re-render (2nd round-trip + layout re-query) is what removes the lag.
      if (!res.ok) {
        setValue(prev); // revert on server rejection (e.g. demoting the last admin)
        setError(res.error ?? "could not change role");
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <select
        value={value}
        disabled={pending}
        onChange={(e) => change(e.target.value as Role)}
        aria-label="Member role"
        className={`rounded-full border-0 px-2 py-0.5 text-xs outline-none disabled:opacity-50 ${BADGE_CLS[value]}`}
      >
        <option value="member">member</option>
        <option value="lead">lead</option>
        <option value="admin">admin</option>
      </select>
      {error ? <span className="text-[11px] text-red-600">{error}</span> : null}
    </div>
  );
}
