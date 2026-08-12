import "server-only";
import type { DbClient } from "@/lib/db/types";
import { visibleProjects } from "@/lib/access/oracle";
import { visibleItemIds } from "@/lib/access/enforce";
import { EVERYONE_SLUG, EXTERNAL_SLUG } from "@/lib/access/groups";

/**
 * The permission inspector (spec §15.6, "build early, not last"). Answers "why can ⟨member⟩ see
 * ⟨item⟩?" — the person → group → project → unit-membership chain, each edge with its provenance —
 * and doubles as the runtime cache-leak check (§5.8): given a rendered payload's item ids, which
 * ones must this principal NOT see.
 *
 * CRITICAL — the inspector must AGREE with the oracle, never re-derive the decision from a second
 * source (spec: "the oracle, RLS policies, the inspector, the leak suite all union a second source,
 * which is the divergence risk"). So the `visible` verdict here comes from the SAME
 * `visibleProjects`/`visibleItemIds` the enforcement path uses; only the CHAIN (the explanation) is
 * assembled from the edge tables. This is a READ-ONLY diagnostic — it writes nothing.
 */

/** How a member holds a group — the three legitimate membership legs the oracle honors. */
export type MembershipVia = "builtin_tier" | "singleton" | "added";
export type GroupKind = "everyone" | "external" | "singleton" | "ordinary";

export interface VisibilityChain {
  projectId: string;
  group: { id: string; slug: string; name: string; kind: GroupKind };
  /** How the member is IN the group. */
  membership: { via: MembershipVia; addedBy: string | null; at: string | null };
  /** The project_groups grant edge (who granted the project to the group). */
  grant: { addedBy: string | null; at: string | null };
  /** The unit→project membership edge (why the item is in the project). */
  unit: { method: string; decidedBy: string | null; validFrom: string | null };
}

export interface ItemVisibility {
  itemId: string;
  memberId: string;
  visible: boolean;
  /** One entry per distinct (project, group) grant path that makes the item visible. Empty when not. */
  chains: VisibilityChain[];
  /** Set only when NOT visible — the coarse reason (never leaks WHICH restricted project holds it). */
  reason?: string;
}

function groupKind(g: { slug: string; is_builtin: boolean; person_member_id: string | null }): GroupKind {
  if (g.is_builtin) return g.slug === EXTERNAL_SLUG ? "external" : g.slug === EVERYONE_SLUG ? "everyone" : "ordinary";
  if (g.person_member_id) return "singleton";
  return "ordinary";
}

export async function explainItemVisibility(
  db: DbClient,
  { teamId, memberId, itemId }: { teamId: string; memberId: string; itemId: string }
): Promise<ItemVisibility> {
  // 1. The AUTHORITATIVE decision inputs — the member's oracle-visible projects + post-eligibility
  //    groups. Reusing the oracle is what keeps the inspector from disagreeing with enforcement.
  const { projectIds: visibleProjIds, groupIds } = await visibleProjects(db, { teamId, memberId });

  // 2. The item's ACTIVE include-memberships: which project(s) hold it, and the unit edge's provenance.
  const { data: unitRows } = await db
    .from("project_context_memberships")
    .select("project_id, method, decided_by, valid_from, project_context_units(source_item_id, state, unit_kind)")
    .eq("team_id", teamId)
    .eq("decision", "include")
    .is("valid_to", null);
  type UnitRow = {
    project_id: string;
    method: string;
    decided_by: string | null;
    valid_from: string | null;
    project_context_units: { source_item_id: string | null; state: string; unit_kind: string } | null;
  };
  const itemProjects = new Map<string, { method: string; decidedBy: string | null; validFrom: string | null }>();
  for (const r of (unitRows ?? []) as UnitRow[]) {
    const u = r.project_context_units;
    if (u && u.state === "active" && u.unit_kind === "item" && u.source_item_id === itemId) {
      // A unit can be tagged into a project once; first active include wins for the edge display.
      if (!itemProjects.has(r.project_id)) {
        itemProjects.set(r.project_id, { method: r.method, decidedBy: r.decided_by, validFrom: r.valid_from });
      }
    }
  }

  // 3. The projects that BOTH hold the item AND the member can see — the visibility intersection.
  const grantingProjects = [...itemProjects.keys()].filter((p) => visibleProjIds.has(p));
  if (grantingProjects.length === 0) {
    // Coarse reason only — never name a restricted project the member can't see (§5.7).
    const reason = itemProjects.size === 0
      ? "the item has no active project membership (not yet partitioned, or removed)"
      : groupIds.size === 0
        ? "you are in no groups that grant access"
        : "no group you are in is granted a project that holds this item";
    return { itemId, memberId, visible: false, chains: [], reason };
  }

  // 4. Build the chain per (project, group) grant path — ONLY through the member's post-eligibility
  //    groups (so a stale built-in membership the oracle already filtered out never shows as a path).
  const { data: grantRows } = await db
    .from("project_groups")
    .select("project_id, group_id, added_by, created_at")
    .eq("team_id", teamId)
    .in("project_id", grantingProjects)
    .in("group_id", [...groupIds]);
  const grants = (grantRows ?? []) as { project_id: string; group_id: string; added_by: string | null; created_at: string | null }[];

  const groupIdsInPlay = [...new Set(grants.map((g) => g.group_id))];
  const [{ data: groupRows }, { data: gmRows }] = await Promise.all([
    db.from("groups").select("id, slug, name, is_builtin, person_member_id").eq("team_id", teamId).in("id", groupIdsInPlay.length ? groupIdsInPlay : ["-"]),
    db.from("group_members").select("group_id, added_by, created_at").eq("team_id", teamId).eq("member_id", memberId).in("group_id", groupIdsInPlay.length ? groupIdsInPlay : ["-"]),
  ]);
  const groupById = new Map(((groupRows ?? []) as { id: string; slug: string; name: string; is_builtin: boolean; person_member_id: string | null }[]).map((g) => [g.id, g]));
  const gmByGroup = new Map(((gmRows ?? []) as { group_id: string; added_by: string | null; created_at: string | null }[]).map((r) => [r.group_id, r]));

  const chains: VisibilityChain[] = [];
  for (const grant of grants) {
    const g = groupById.get(grant.group_id);
    if (!g) continue; // group row missing → not a renderable path (defensive)
    const kind = groupKind(g);
    const gm = gmByGroup.get(grant.group_id);
    // How the member holds this group: a built-in via tier (no group_members row needed), a
    // singleton "directly added" (person_member_id === member), else an explicit `group_members` add.
    const via: MembershipVia =
      g.is_builtin ? "builtin_tier" : g.person_member_id === memberId ? "singleton" : "added";
    const unit = itemProjects.get(grant.project_id)!;
    chains.push({
      projectId: grant.project_id,
      group: { id: g.id, slug: g.slug, name: g.name, kind },
      membership: { via, addedBy: gm?.added_by ?? null, at: gm?.created_at ?? null },
      grant: { addedBy: grant.added_by, at: grant.created_at },
      unit,
    });
  }

  // If the oracle says the member sees a granting project but no chain row survives (e.g. the grant
  // is held only through a group the eligibility filter dropped), report visible with no chain
  // rather than lie either way — but this should be empty only in a genuine race, so keep visible
  // aligned to the oracle intersection, not to `chains.length`.
  return { itemId, memberId, visible: true, chains };
}

/**
 * The runtime cache-leak check (spec §5.8): given a set of item ids a surface is about to render (a
 * timeline/arc/query payload), return the subset this principal must NOT see. Empty = clean. Reuses
 * the SAME `visibleItemIds` resolver the enforcement path uses, so a "leak" it reports is a real one
 * by the enforcement's own definition — a genuine backstop, not a second opinion.
 */
export async function auditVisibilityAgainstItemIds(
  db: DbClient,
  { teamId, memberId }: { teamId: string; memberId: string },
  itemIds: readonly string[]
): Promise<string[]> {
  if (itemIds.length === 0) return [];
  const { ids: visible } = await visibleItemIds(db, { teamId, memberId });
  return [...new Set(itemIds)].filter((id) => !visible.has(id));
}
