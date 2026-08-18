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
 * PRET-6: the cutover legacy window is retired — the builtin row alone decides, everywhere.
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

export async function resolveViewerPosture(
  db: DbClient,
  teamId: string,
  memberId: string
): Promise<ViewerPosture> {
  // PRET-6: the marker-keyed legacy window retired — builtin rows are explicit state on every
  // supported upgrade path (the release's own preDeploy precondition refuses a fleet whose
  // materialization never completed), so the row alone decides.
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
