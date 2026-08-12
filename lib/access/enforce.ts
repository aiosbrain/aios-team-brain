import "server-only";
import { createHash } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import { visibleProjects, effectiveVisibleProjects, type Principal } from "@/lib/access/oracle";

/**
 * The enforced-read primitive (Phase B slice 1, spec §5/§11). Visibility = **oracle ∧ legacy-tier**:
 * a read applies the oracle's membership filter (this module) AND keeps its existing legacy tier
 * filter, so a bug in either conjunct fails CLOSED. Gated per team by `teams.access_enforcement`:
 *
 *   'permissive' (default) — this module contributes NOTHING; the read is byte-identical to today.
 *   'enforcing'            — the caller intersects its item set with `visibleItemIds(...)`.
 *
 * SCOPE (through Phase B slice 4): `GET /api/v1/items` (member AND agent keys), the retrieval
 * path (`lib/query/retrieve.ts` → both query routes) for member keys under 'enforcing', delegated
 * `aiosd_*` query (ALWAYS attenuated — see `delegatedVisibleItemIds`), and the work-timeline read
 * path (§5.8 visibility-variant cache — see `memberEnforcement` + `lib/dashboard/timeline-cache`).
 * Arcs and the remaining dashboard surfaces are NOT yet enforced — an operator flipping the flag
 * must know that; those are later Phase B slices.
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
  /** True when `empty` is the result of a READ ERROR, not a genuinely-empty membership set. A
   *  per-request caller (the items route) treats both as "serve nothing" — self-heals next request.
   *  A CACHING caller (the timeline, §5.8) MUST distinguish: persisting an error-derived empty as a
   *  fresh shared variant hides every row for all members on that hash for a TTL (Codex B4 Medium).
   *  `resolveTimelineEnforcement` throws on this so the build aborts without writing. */
  error?: boolean;
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
  if (error) return { ids: new Set(), empty: true, error: true }; // fail closed on read error (flagged: see `error`)

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

/**
 * Delegated principals are ALWAYS attenuated (Phase B slice 3, spec §10/§5.8b): the enforce arg
 * for an `aiosd_*` query, computed regardless of `teams.access_enforcement` — that flag is the
 * MEMBER rollout control, and a scoped token must never ride a permissive team to full-corpus
 * answers. Effective projects = the live triple intersection (`effectiveVisibleProjects`), then
 * the item-grain membership set. Fail-closed end to end: an empty effective set, an un-backfilled
 * team, or a read error all yield an empty id set → retrieval serves zero rows.
 */
export async function delegatedVisibleItemIds(
  db: DbClient,
  token: { teamId: string; memberId: string; onBehalfOf: string | null; projectScope: string[] | null }
): Promise<VisibleItemIds> {
  const projects = await effectiveVisibleProjects(db, token);
  return visibleItemIdsForProjects(db, token.teamId, projects);
}

/**
 * A member's VISIBILITY for CACHED/derived surfaces (Phase B slice 4, spec §5.8): the effective
 * project set + the hash that KEYS the cache variant — sha256 of the SORTED post-attenuation
 * effective-project set, so two members with identical group signatures share one cache row and a
 * group change moves the member to a new key on the next read. This is the CHEAP half (projects
 * only): a cache HIT needs the hash alone, so materializing the item-id set on every read (even a
 * hit) would defeat what the cache is for (Fable B4 Medium). Null = permissive team (serve the
 * plain tier row). Throws on a flag-read error (the caller fails closed — 500/no data).
 */
export interface MemberVisibility {
  visibleProjectIds: ReadonlySet<string>;
  /** Keys the cache variant; derived ONLY from the sorted effective project set. */
  visibilityHash: string;
}

export async function memberVisibility(db: DbClient, principal: Principal): Promise<MemberVisibility | null> {
  if (!(await teamEnforcesAccess(db, principal.teamId))) return null;
  const { projectIds } = await visibleProjects(db, principal);
  const visibilityHash = createHash("sha256").update([...projectIds].sort().join(",")).digest("hex").slice(0, 16);
  return { visibleProjectIds: projectIds, visibilityHash };
}

/**
 * The EXPENSIVE half — the membership-visible item-id set — resolved lazily from a
 * `MemberVisibility` only when a surface actually BUILDS (cache miss / stale rebuild), never on a
 * hit. Structured rows gate on their source item (a null-source UI task is handled by `origin`, not
 * a project lookup — `tasks.project_id` is the INGEST project, not an access-control project).
 */
export interface TimelineEnforcement {
  visibleItemIds: ReadonlySet<string>;
}

export async function resolveTimelineEnforcement(
  db: DbClient,
  teamId: string,
  vis: MemberVisibility
): Promise<TimelineEnforcement> {
  const { ids, error } = await visibleItemIdsForProjects(db, teamId, vis.visibleProjectIds);
  // THROW on a substrate read error rather than build from a spuriously-empty set (Codex B4
  // Medium): the timeline CACHES its build under a shared visibility hash, so an error-derived
  // empty would hide every item-derived row for all members on that hash until the next rebuild.
  // The caller (cold-miss build → 500; background rebuild → caught, no write) fails closed WITHOUT
  // caching. A genuinely-empty membership set (no error) still builds + caches a real empty ledger.
  if (error) throw new Error("access substrate read failed while resolving timeline enforcement");
  return { visibleItemIds: ids };
}

/**
 * Convenience for DIRECT build paths (no cache layer to shield — e.g. the >7d timeline expansion):
 * resolve the full enforcement in one call. Null on a permissive team. The cache layer does NOT
 * use this — it splits cheap-hash / lazy-items across the hit/miss boundary.
 */
export async function memberEnforcement(db: DbClient, principal: Principal): Promise<TimelineEnforcement | null> {
  const vis = await memberVisibility(db, principal);
  return vis ? resolveTimelineEnforcement(db, principal.teamId, vis) : null;
}
