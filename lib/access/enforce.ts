import "server-only";
import type { DbClient } from "@/lib/db/types";
import { visibleProjects, type Principal } from "@/lib/access/oracle";

/**
 * The enforced-read primitive (Phase B slice 1, spec §5/§11). Visibility = **oracle ∧ legacy-tier**:
 * a read applies the oracle's membership filter (this module) AND keeps its existing legacy tier
 * filter, so a bug in either conjunct fails CLOSED. Gated per team by `teams.access_enforcement`:
 *
 *   'permissive' (default) — this module contributes NOTHING; the read is byte-identical to today.
 *   'enforcing'            — the caller intersects its item set with `visibleItemIds(...)`.
 *
 * Only flip a team to 'enforcing' once its §11 backfill is complete — an un-partitioned item has no
 * membership and would fail closed (vanish). The flag is the fail-open-to-today transition control.
 */

export async function teamEnforcesAccess(db: DbClient, teamId: string): Promise<boolean> {
  const { data } = await db.from("teams").select("access_enforcement").eq("id", teamId).maybeSingle();
  return (data as { access_enforcement?: string } | null)?.access_enforcement === "enforcing";
}

/**
 * The set of item ids a principal may see through the access chain: items whose item-grain unit has
 * a CURRENT include-membership into a project in the principal's visible set. Returns the ids so a
 * caller can intersect (`.in("id", …)`) — the oracle conjunct on top of its own tier filter.
 *
 * Fail-closed contract: an empty visible-project set, an ineligible principal, or a read error all
 * yield an EMPTY set (the caller then serves zero rows — never an unfiltered query). The empty case
 * is distinguishable via the returned discriminator so the caller can short-circuit correctly.
 *
 * NOTE (deferred, scaling): this materializes the id set app-side because the pg adapter has no
 * EXISTS-subquery / join surface; for a large corpus that is a large IN list. When it bites, the
 * membership filter moves into SQL (an RPC or the covering index the spec names). Bounded and
 * correct for the alpha; flagged so nobody mistakes it for the final shape.
 */
export async function visibleItemIds(
  db: DbClient,
  principal: Principal
): Promise<{ ids: Set<string>; empty: boolean }> {
  const { projectIds } = await visibleProjects(db, principal);
  if (projectIds.size === 0) return { ids: new Set(), empty: true };

  const { data, error } = await db
    .from("project_context_memberships")
    .select("project_context_units(source_item_id)")
    .eq("team_id", principal.teamId)
    .eq("decision", "include")
    .is("valid_to", null)
    .in("project_id", [...projectIds]);
  if (error) return { ids: new Set(), empty: true }; // fail closed on read error

  const ids = new Set<string>();
  for (const row of (data ?? []) as { project_context_units: { source_item_id: string | null } | null }[]) {
    const itemId = row.project_context_units?.source_item_id;
    if (itemId) ids.add(itemId);
  }
  return { ids, empty: ids.size === 0 };
}
