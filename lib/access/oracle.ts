import "server-only";
import type { DbClient } from "@/lib/db/types";
import { isPrincipal } from "@/lib/access/eligibility";

/**
 * The visibility oracle (spec §5.1): ONE place computes what a principal can see; every
 * downstream read takes the resulting immutable set. The formula, verbatim from the spec:
 *
 *   visibleProjects(principal) =
 *     eligible(principal) ? { p | ∃ g : member ∈ g ∧ (p,g) ∈ project_groups } : ∅
 *     ∩ (project_scope ?? U)
 *
 * Eligibility is applied READ-side here even though the groups writer already refuses
 * ineligible memberships — a flag flipped after a row snuck in must still resolve to nothing.
 *
 * `projectScope` is token attenuation (spec §10): `null`/`undefined` = unattenuated (the spawn
 * default — the ONE access-input where null opens rather than closes, deliberate and named in
 * the spec); `[]` = sees nothing. The two must never be conflated.
 *
 * Authorship is never an access input: nothing in this module reads the items table or any
 * authorship column (guarded by the oracle-no-authorship check in
 * test/guards/access-single-writer.test.ts).
 */

export interface Principal {
  teamId: string;
  memberId: string;
  /** Token attenuation set: null/undefined = unattenuated; [] = sees nothing. */
  projectScope?: string[] | null;
}

/** Frozen result: the project-id set plus the group-id set (graph/RLS consumers need both). */
export interface VisibleSet {
  projectIds: ReadonlySet<string>;
  groupIds: ReadonlySet<string>;
}

const EMPTY: VisibleSet = { projectIds: new Set(), groupIds: new Set() };

export async function visibleProjects(db: DbClient, principal: Principal): Promise<VisibleSet> {
  const { data: member } = await db
    .from("members")
    .select("id, kind, is_connector, status")
    .eq("team_id", principal.teamId)
    .eq("id", principal.memberId)
    .maybeSingle();
  if (!member || !isPrincipal(member)) return EMPTY;

  const { data: memberships, error: gmErr } = await db
    .from("group_members")
    .select("group_id")
    .eq("team_id", principal.teamId)
    .eq("member_id", principal.memberId);
  if (gmErr) return EMPTY; // fail closed on read error
  const groupIds = new Set(((memberships ?? []) as { group_id: string }[]).map((r) => r.group_id));
  if (groupIds.size === 0) return EMPTY;

  const { data: grants, error: pgErr } = await db
    .from("project_groups")
    .select("project_id")
    .eq("team_id", principal.teamId)
    .in("group_id", [...groupIds]);
  if (pgErr) return EMPTY;
  let projectIds = new Set(((grants ?? []) as { project_id: string }[]).map((r) => r.project_id));

  // Attenuation: intersection only — a scope naming an invisible project contributes nothing.
  if (principal.projectScope != null) {
    const scope = new Set(principal.projectScope);
    projectIds = new Set([...projectIds].filter((p) => scope.has(p)));
  }
  return { projectIds, groupIds };
}

/** Convenience predicate over the oracle result. */
export async function canSeeProject(db: DbClient, principal: Principal, projectId: string): Promise<boolean> {
  const { projectIds } = await visibleProjects(db, principal);
  return projectIds.has(projectId);
}
