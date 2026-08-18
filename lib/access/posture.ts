import "server-only";
import type { DbClient } from "@/lib/db/types";
import { EVERYONE_SLUG } from "@/lib/access/groups";

/**
 * Viewer POSTURE (PRET-4, docs/design/pret4-tier-wall-teardown.md §1a): the two-bucket wall
 * input that replaces `members.tier` on every read path. `"team"` iff the member holds a row
 * in the team's `everyone` built-in group; else `"external"` (default-deny). The vocabulary is
 * deliberately identical to the retired tier vocabulary so every downstream consumer
 * (visibleItems/canSeeAccess/the timeline cache keys/the meetings-codebases-maturity gates)
 * survives verbatim with a changed input.
 *
 * Cutover window (cold-read H2 — fails CLOSED): until the PRET-4 materialization marker is
 * confirmed, posture is the LEGACY tier read — pre-slice semantics exactly, so a stale
 * `everyone` row from a failed recompute-era hook sync is never served live before the
 * sweep's DROP has run. The confirmation is process-cached and flips once, monotonically.
 *
 * No eligibility re-check here: the auth boundaries refuse non-active members before posture
 * is consulted, and the enforcing oracle applies its own eligibility independently. A row for
 * an agent/connector is a POSTURE source only — grant-inert under enforcing (the oracle's
 * isBuiltinEligible check, unchanged).
 *
 * Fail directions: a READ ERROR throws (the boundary's existing 401/500 handling — never a
 * silent widen or narrow); a structurally-absent row is `"external"`.
 */

export type ViewerPosture = "team" | "external";

export const PRET4_MATERIALIZE_MARKER = "pret4_builtin_materialize";

let materializationConfirmedCache = false;

/** Test-only: reset the process-level marker cache so pre/post-marker behavior is assertable. */
export function _resetPostureConfirmationForTests(): void {
  materializationConfirmedCache = false;
}

/**
 * Has the one-time builtin materialization completed on this fleet? Monotone process cache:
 * one marker read per process until it flips, then zero. Exported for the oracle, which keys
 * its legacy builtin-tier conjunct on the same confirmation (§1c).
 */
export async function materializationConfirmed(db: DbClient): Promise<boolean> {
  if (materializationConfirmedCache) return true;
  const { data, error } = await db
    .from("migration_markers")
    .select("name")
    .eq("name", PRET4_MATERIALIZE_MARKER)
    .maybeSingle();
  if (error) return false; // unconfirmed on read error → legacy semantics (fail closed to pre-slice)
  if (data) materializationConfirmedCache = true;
  return materializationConfirmedCache;
}

export async function resolveViewerPosture(
  db: DbClient,
  teamId: string,
  memberId: string
): Promise<ViewerPosture> {
  if (!(await materializationConfirmed(db))) {
    // Legacy window: the tier record decides, exactly as before this slice. This branch (and
    // this file's only members.tier read) dies the moment the marker is confirmed.
    const { data, error } = await db
      .from("members")
      .select("tier")
      .eq("team_id", teamId)
      .eq("id", memberId)
      .maybeSingle();
    if (error) throw new Error(`posture read failed (legacy window): ${error.message}`);
    return (data as { tier?: string } | null)?.tier === "team" ? "team" : "external";
  }
  const { data, error } = await db
    .from("group_members")
    .select("group_id, groups(slug, is_builtin)")
    .eq("team_id", teamId)
    .eq("member_id", memberId);
  if (error) throw new Error(`posture read failed: ${error.message}`);
  const rows = (data ?? []) as { groups: { slug: string; is_builtin: boolean } | null }[];
  return rows.some((r) => r.groups?.is_builtin === true && r.groups.slug === EVERYONE_SLUG)
    ? "team"
    : "external";
}
