/**
 * Decide `member_id` on an UNCHANGED re-push. The `content_sha256` fast-path fires when body+title are
 * byte-identical — but a source can reassign an item WITHOUT touching its prose (a Linear/Plane issue's
 * `assignee` changes; the description doesn't). That reassignment lives in the frontmatter, which heals on
 * the unchanged path — but the OWNER (`items.member_id`) used to stay frozen at the old assignee until the
 * manual "Re-attribute content" batch ran. This decides whether to re-point it now.
 *
 * `resolved` = the author freshly resolved from THIS push's frontmatter (`opts.authorMemberId`): a real
 * member id, or `null` when there's no author signal or a connector's push didn't resolve.
 *
 * Policy — relies on `items.member_id_locked` (#333) as the safety guard:
 *  - LOCKED (a deliberate admin correction, incl. correct-to-nobody) → never touch. The lock is exactly
 *    what makes source-driven re-pointing safe: it protects corrections + human self-pushes.
 *  - `resolved === null` (no signal / connector-unresolved) → never touch; we NEVER auto-clear a set owner
 *    to nobody on a routine re-push (an unassignment stays the manual batch's / mismatch-flag's job).
 *  - `resolved === current` → nothing to do.
 *  - current `null`, resolved set → FIRST-time fill (an attribution heal), NOT a reassignment.
 *  - current set, resolved a DIFFERENT member → a genuine SOURCE reassignment (assignee A→B): re-point AND
 *    report the prior owner so the caller can log the transition (`item.reassigned`).
 */
export function decideReattribution(
  currentMemberId: string | null,
  resolved: string | null,
  locked: boolean
): { memberId?: string; reassignedFrom?: string } {
  if (locked || resolved === null || resolved === currentMemberId) return {};
  return currentMemberId === null
    ? { memberId: resolved }
    : { memberId: resolved, reassignedFrom: currentMemberId };
}
