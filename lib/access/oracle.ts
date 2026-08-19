import "server-only";
import type { DbClient } from "@/lib/db/types";
import { isBuiltinEligible, isPrincipal } from "@/lib/access/eligibility";
import { EVERYONE_SLUG, EXTERNAL_SLUG } from "@/lib/access/groups";

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

/**
 * Result sets. `groupIds` is the post-eligibility group set and is PRE-attenuation — token
 * `projectScope` intersects projects only, so a consumer deriving reads from `groupIds`
 * (future per-project graph partitions) must attenuate again at the project level. Fresh
 * sets per call: a shared instance behind a ReadonlySet type is one cast away from making
 * the fail-closed empty result fail-open for every subsequent caller (review F7).
 */
export interface VisibleSet {
  projectIds: ReadonlySet<string>;
  groupIds: ReadonlySet<string>;
}

function empty(): VisibleSet {
  return { projectIds: new Set(), groupIds: new Set() };
}

export async function visibleProjects(db: DbClient, principal: Principal): Promise<VisibleSet> {
  const { set } = await visibleProjectsWithError(db, principal);
  return set;
}

/**
 * The ERROR-VISIBLE oracle read (ENFB-3, design round-2 HIGH 2): `visibleProjects` collapses
 * substrate read errors into the same empty set a genuinely-grantless member gets — correct
 * fail-closed serving behavior, but a caller that must DISCRIMINATE (the graph feeds' degraded
 * arm: "oracle failed" ≠ "nothing visible") reads this variant. The `VisibleItemIds.error`
 * precedent (lib/access/enforce.ts): error implies empty, never widens.
 */
export async function visibleProjectsWithError(
  db: DbClient,
  principal: Principal
): Promise<{ set: VisibleSet; error?: boolean }> {
  const { data: member, error: mErr } = await db
    .from("members")
    .select("id, kind, is_connector, status")
    .eq("team_id", principal.teamId)
    .eq("id", principal.memberId)
    .maybeSingle();
  if (mErr) return { set: empty(), error: true };
  if (!member || !isPrincipal(member)) return { set: empty() };

  const { data: memberships, error: gmErr } = await db
    .from("group_members")
    .select("group_id, groups(slug, is_builtin)")
    .eq("team_id", principal.teamId)
    .eq("member_id", principal.memberId);
  if (gmErr) return { set: empty(), error: true }; // fail closed on read error

  // BUILT-IN membership acceptance — PRET-6: builtin rows are authoritative (the marker-keyed legacy conjunct retired with the
  // permissive model — the release precondition guarantees materialization). PERMANENT checks:
  // isBuiltinEligible (a planted non-human row never grants) and the unknown-slug fail-closed.
  const rows = (memberships ?? []) as { group_id: string; groups: { slug: string; is_builtin: boolean } | null }[];
  const groupIds = new Set(
    rows
      .filter((r) => {
        const g = r.groups;
        if (!g) return false; // missing embed: unresolvable group → fail closed (review M2)
        if (!g.is_builtin) return true;
        if (!isBuiltinEligible(member)) return false;
        return g.slug === EVERYONE_SLUG || g.slug === EXTERNAL_SLUG;
      })
      .map((r) => r.group_id)
  );
  if (groupIds.size === 0) return { set: empty() };

  const { data: grants, error: pgErr } = await db
    .from("project_groups")
    .select("project_id")
    .eq("team_id", principal.teamId)
    .in("group_id", [...groupIds]);
  if (pgErr) return { set: empty(), error: true };
  let projectIds = new Set(((grants ?? []) as { project_id: string }[]).map((r) => r.project_id));

  // Attenuation: intersection only — a scope naming an invisible project contributes nothing.
  if (principal.projectScope != null) {
    const scope = new Set(principal.projectScope);
    projectIds = new Set([...projectIds].filter((p) => scope.has(p)));
  }
  return { set: { projectIds, groupIds } };
}

/** Convenience predicate over the oracle result. */
export async function canSeeProject(db: DbClient, principal: Principal, projectId: string): Promise<boolean> {
  const { projectIds } = await visibleProjects(db, principal);
  return projectIds.has(projectId);
}

/**
 * The delegated-token formula (spec §10), verbatim:
 *   effective = visibleProjects(member) ∩ visibleProjects(on_behalf_of ?? member) ∩ (scope ?? U)
 * The launcher's own visibility ALWAYS intersects — a mixed credential (agent launcher +
 * human on_behalf_of) can never exceed the agent's own groups. Computed live per request:
 * no snapshot exists to drift when either leg's groups change.
 */
export async function effectiveVisibleProjects(
  db: DbClient,
  token: { teamId: string; memberId: string; onBehalfOf: string | null; projectScope: string[] | null }
): Promise<ReadonlySet<string>> {
  const launcher = await visibleProjects(db, {
    teamId: token.teamId,
    memberId: token.memberId,
    projectScope: token.projectScope,
  });
  if (!token.onBehalfOf || token.onBehalfOf === token.memberId) return launcher.projectIds;
  const represented = await visibleProjects(db, {
    teamId: token.teamId,
    memberId: token.onBehalfOf,
    projectScope: token.projectScope,
  });
  return new Set([...launcher.projectIds].filter((p) => represented.projectIds.has(p)));
}
