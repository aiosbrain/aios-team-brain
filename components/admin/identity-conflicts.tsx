import Link from "next/link";

import type { ConflictMember, IdentityConflictPage, IdentityConflictRow } from "@/lib/identity/discovery-conflicts";

/**
 * Admin → Members: automatic identity links that were refused (AIO-1167 R45, AC-08). Read-only.
 *
 * Each row is ONE historical observation (latest of any repeats) shown beside the identity's CURRENT
 * mapping, re-read now — so an event an Admin has since resolved reads as history, not as a standing
 * conflict. The fix is the existing Identities control on the member row this links to; nothing here
 * changes a mapping.
 */

const PROVIDER_LABEL: Record<string, string> = { gdrive: "Google Drive", slack: "Slack", linear: "Linear", plane: "Plane" };

function name(member: ConflictMember | null, fallback: string): string {
  return member ? member.displayName || "(unnamed member)" : fallback;
}

function MemberLink({ member, fallback }: { member: ConflictMember | null; fallback: string }) {
  if (!member) return <span className="text-ink-tertiary">{fallback}</span>;
  return <a href={`#member-${member.id}`} className="text-violet hover:underline">{name(member, fallback)}</a>;
}

function currentText(row: IdentityConflictRow): string {
  switch (row.current.state) {
    case "linked": return `Linked to ${name(row.current.holder, "a removed member")} (revision ${row.current.revision})`;
    case "unreviewed": return `Held by ${name(row.current.holder, "a removed member")} through a legacy mapping that was never reviewed`;
    case "unlinked": return "Unlinked";
    default: return "Not mapped";
  }
}

const STANDING: Record<IdentityConflictRow["standing"], { label: string; tone: string }> = {
  still_conflicting: { label: "Still mapped to another member", tone: "text-amber-600" },
  now_candidate: { label: "Since mapped to the observed member", tone: "text-emerald-600" },
  unlinked: { label: "Since unlinked", tone: "text-ink-tertiary" },
};

export function IdentityConflicts({ page, nextHref }: { page: IdentityConflictPage; nextHref: string | null }) {
  if (page.status === "forbidden") return null;
  return (
    <section className="prism-card flex flex-col gap-2 p-4" aria-labelledby="identity-conflicts-heading">
      <h2 id="identity-conflicts-heading" className="text-sm font-semibold text-ink">
        Automatic identity links that were refused
      </h2>
      <p className="text-xs text-ink-secondary">
        A connector observed an account whose confirmed email named one member while the account was
        already mapped to another. The automatic link was refused and the existing mapping was kept.
        Review each in that member&apos;s <strong>Identities</strong> column and link, remap or unlink it there.
      </p>
      {page.status === "unavailable" ? (
        <p role="status" className="text-xs text-amber-600">
          Refused-link diagnostics are unavailable right now. This does not mean there are none — try again.
        </p>
      ) : page.rows.length === 0 ? (
        <p className="text-xs text-ink-tertiary">No automatic links have been refused.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border-subtle text-left uppercase tracking-wide text-ink-tertiary">
              <th className="py-2 pr-3">Last observed</th>
              <th className="py-2 pr-3">Account</th>
              <th className="py-2 pr-3">Observed member</th>
              <th className="py-2 pr-3">Mapped to then</th>
              <th className="py-2 pr-3">Mapping now</th>
              <th className="py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => (
              <tr key={`${row.provider}:${row.externalId}:${row.candidate?.id ?? "removed"}`} className="border-b border-border-subtle last:border-0 align-top">
                <td className="py-2 pr-3 text-ink-secondary">
                  {new Date(row.observedAt).toISOString().replace("T", " ").slice(0, 16)} UTC
                  {row.occurrences > 1 ? <span className="text-ink-tertiary"> · {row.occurrences}×</span> : null}
                </td>
                <td className="py-2 pr-3 font-mono">{PROVIDER_LABEL[row.provider] ?? row.provider} · {row.externalId}</td>
                <td className="py-2 pr-3"><MemberLink member={row.candidate} fallback="a removed member" /></td>
                <td className="py-2 pr-3"><MemberLink member={row.heldThen} fallback="a removed member" /></td>
                <td className="py-2 pr-3 text-ink-secondary">{currentText(row)}</td>
                <td className={`py-2 ${STANDING[row.standing].tone}`}>{STANDING[row.standing].label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {page.status === "ok" && nextHref ? (
        <Link href={nextHref} className="self-start text-xs text-violet hover:underline">Older refused links →</Link>
      ) : null}
    </section>
  );
}
