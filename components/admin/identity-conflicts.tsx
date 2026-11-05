import Link from "next/link";

import type { ConflictMember, IdentityConflictPage, IdentityConflictRow } from "@/lib/identity/discovery-conflicts";

/**
 * Admin → Members: RECORDED, LEGACY Google Drive refusals (AIO-1167 R45; scoped by R47 F2).
 * Read-only, and Drive-only by adjudication.
 *
 * Historical only. A refusal is recorded solely for a mapping that predates review state, which a
 * normally upgraded instance no longer has (the repair-ledger migration seeds state for every link).
 * A later email that disagrees with an approved mapping is NOT a conflict and is not listed here: the
 * approved mapping stands (AC-08). Reachable conflicting decisions surface where they are made — the
 * revision-fenced remap offer on a member's Identities control, and the OAuth existing-owner refusal.
 *
 * Each row is ONE historical observation (latest of any repeats) shown beside the identity's CURRENT
 * mapping, re-read now — so an event an Admin has since resolved reads as history, not as a standing
 * conflict. The fix is the existing Identities control on the member row this links to; nothing here
 * changes a mapping.
 */

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
        Google Drive: recorded legacy refusals (history)
      </h2>
      <p className="text-xs text-ink-secondary">
        Historical record. Before identity mappings were reviewed, the Google Drive connector refused to
        auto-link an account whose confirmed email named one member while an unreviewed mapping gave it to
        another, and kept the existing mapping. A later email that differs from an approved mapping is not
        a conflict and is not listed. To change a mapping, use that member&apos;s <strong>Identities</strong> column.
      </p>
      {page.status === "unavailable" ? (
        <p role="status" className="text-xs text-amber-600">
          Recorded Google Drive refusals are unavailable right now. This does not mean there are none — try again.
        </p>
      ) : page.rows.length === 0 ? (
        <p className="text-xs text-ink-tertiary">No legacy Google Drive refusals are recorded.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border-subtle text-left uppercase tracking-wide text-ink-tertiary">
              <th className="py-2 pr-3">Last observed</th>
              <th className="py-2 pr-3">Drive account</th>
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
                <td className="py-2 pr-3 font-mono">{row.externalId}</td>
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
        <Link href={nextHref} className="self-start text-xs text-violet hover:underline">Older recorded refusals →</Link>
      ) : null}
    </section>
  );
}
