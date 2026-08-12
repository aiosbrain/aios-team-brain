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
 * SCOPE (this slice): only `GET /api/v1/items` (member AND agent keys) is enforced. `POST
 * /api/v1/query`, FTS, timeline, arcs, and every dashboard surface are NOT yet enforced — an
 * operator flipping the flag must know that; those are later Phase B slices.
 *
 * Only flip a team to 'enforcing' once its §11 backfill is complete — an un-partitioned item has no
 * membership and would fail closed (vanish). The flag is the fail-open-to-today transition control.
 */

/**
 * Whether the team enforces access. THROWS on a flag-read error rather than defaulting — a
 * silent `false` would degrade an ENFORCING team to an unfiltered read (the leak direction, and
 * the one input that must not fail open — slice-B1 Fable HIGH). The route turns a throw into a
 * 500 (fail closed: no data served), never a wrong mode.
 */
export async function teamEnforcesAccess(db: DbClient, teamId: string): Promise<boolean> {
  const { data, error } = await db.from("teams").select("access_enforcement").eq("id", teamId).maybeSingle();
  if (error) throw new Error(`access_enforcement read failed: ${error.message}`);
  return (data as { access_enforcement?: string } | null)?.access_enforcement === "enforcing";
}

export interface VisibleItemIds {
  ids: Set<string>;
  empty: boolean;
}

/**
 * The set of item ids visible through a GIVEN project set: items whose ACTIVE item-grain unit has
 * a CURRENT include-membership into one of `projectIds`. Takes the project set directly so both
 * the member path (oracle `visibleProjects`) and the agent path (effective set) share ONE filter —
 * an agent must never exceed its launcher under enforcing (slice-B1 Fable HIGH). Returns the ids so
 * the caller can `.in("id", …)` — the oracle conjunct on top of its own tier filter.
 *
 * Fail-closed: an empty project set OR a read error yields an EMPTY set (`empty:true`), so the
 * caller serves zero rows, never an unfiltered query.
 *
 * NOTE (deferred, scaling): materialized app-side because the pg adapter has no EXISTS/join surface;
 * for a large corpus this is a large IN list (and >65k ids errors → 500, which fails closed, not
 * open). Moves into SQL (an RPC or the covering index the spec names) when it bites.
 */
export async function visibleItemIdsForProjects(
  db: DbClient,
  teamId: string,
  projectIds: ReadonlySet<string>
): Promise<VisibleItemIds> {
  if (projectIds.size === 0) return { ids: new Set(), empty: true };

  const { data, error } = await db
    .from("project_context_memberships")
    // only ACTIVE item-grain units (defensive: today the CHECK forces item+non-null source, and
    // nothing writes 'retracted' — but when Phase D relaxes the CHECK, a membership on a retracted
    // or non-item unit must not re-serve the item — slice-B1 Fable LOW).
    .select("project_context_units(source_item_id, state, unit_kind)")
    .eq("team_id", teamId)
    .eq("decision", "include")
    .is("valid_to", null)
    .in("project_id", [...projectIds]);
  if (error) return { ids: new Set(), empty: true }; // fail closed on read error

  const ids = new Set<string>();
  for (const row of (data ?? []) as { project_context_units: { source_item_id: string | null; state: string; unit_kind: string } | null }[]) {
    const u = row.project_context_units;
    if (u && u.state === "active" && u.unit_kind === "item" && u.source_item_id) ids.add(u.source_item_id);
  }
  return { ids, empty: ids.size === 0 };
}

/** Member convenience: resolve the principal's visible projects via the oracle, then the item ids. */
export async function visibleItemIds(db: DbClient, principal: Principal): Promise<VisibleItemIds> {
  const { projectIds } = await visibleProjects(db, principal);
  return visibleItemIdsForProjects(db, principal.teamId, projectIds);
}
