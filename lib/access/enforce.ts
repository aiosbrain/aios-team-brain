import "server-only";
import { createHash } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import { visibleProjects, effectiveVisibleProjects, type Principal } from "@/lib/access/oracle";
import { newSqlParams, itemVisibleSql, provenanceRowSql, type ProvenanceSqlCtx } from "@/lib/access/provenance-sql";
import { runSql } from "@/lib/db/pg/pool";

/**
 * The enforced-read primitive (Phase B slice 1, spec §5/§11; PRET-6: the ONLY read model).
 * Visibility = the ORACLE's membership filter: every caller intersects its item set with
 * `visibleItemIds(...)` — there is no mode, no flag, and no posture wall (PRET-4 ruling 2:
 * placement is the sharing act; the retired tier conjunct never overrides it).
 *
 * SCOPE: `GET /api/v1/items` (member AND agent keys), the retrieval path
 * (`lib/query/retrieve.ts` → both query routes — retrieve THROWS without a view), delegated
 * `aiosd_*` query (ALWAYS attenuated — see `delegatedVisibleItemIds`), the work-timeline read
 * path (§5.8 visibility-variant cache — see `memberEnforcement` + `lib/dashboard/timeline-cache`),
 * and the arcs partition scope (`lib/graph/partition-read`). The §11 backfill + the boot
 * materialization are what make membership state complete — the PRET-6 release's preDeploy
 * precondition refuses a fleet where they haven't run.
 */


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
/** The ONE unit-row predicate deciding whether a membership's unit serves its item — shared by
 *  the list materialization and the by-id probe (ENFB-1 §2.1: one owner, no drift). Only an
 *  ACTIVE ITEM-GRAIN unit with a source serves (defensive: today the CHECK forces item+non-null
 *  source and nothing writes 'retracted', but when Phase D relaxes the CHECK a membership on a
 *  retracted or non-item unit must not re-serve the item — slice-B1 Fable LOW). */
type UnitRow = { source_item_id: string | null; state: string; unit_kind: string };
function unitServesItem(u: UnitRow | null | undefined): u is UnitRow & { source_item_id: string } {
  return !!u && u.state === "active" && u.unit_kind === "item" && !!u.source_item_id;
}

/** The ONE membership WHERE shape (current include rows within a project set) — the other half
 *  of the shared predicate, applied identically by the list and by-id paths. */
function currentIncludeMemberships<T extends { eq(c: string, v: unknown): T; is(c: string, v: null): T; in(c: string, v: string[]): T }>(
  q: T,
  teamId: string,
  projectIds: ReadonlySet<string>
): T {
  return q.eq("team_id", teamId).eq("decision", "include").is("valid_to", null).in("project_id", [...projectIds]);
}

export async function visibleItemIdsForProjects(
  db: DbClient,
  teamId: string,
  projectIds: ReadonlySet<string>
): Promise<VisibleItemIds> {
  if (projectIds.size === 0) return { ids: new Set(), empty: true };

  const { data, error } = await currentIncludeMemberships(
    db.from("project_context_memberships").select("project_context_units(source_item_id, state, unit_kind)"),
    teamId,
    projectIds
  );
  if (error) return { ids: new Set(), empty: true, error: true }; // fail closed on read error (flagged: see `error`)

  const ids = new Set<string>();
  for (const row of (data ?? []) as { project_context_units: UnitRow | null }[]) {
    const u = row.project_context_units;
    if (unitServesItem(u)) ids.add(u.source_item_id);
  }
  return { ids, empty: ids.size === 0 };
}

/**
 * By-id membership probe (ENFB-1 §2.1): can THIS principal see THIS item — without
 * materializing their whole visible-id set (the by-id surfaces' cost shape, and the documented
 * >65k IN-list wall). Shares BOTH halves of the visibility predicate with the list path
 * (`unitServesItem` + `currentIncludeMemberships`), so the pair cannot disagree by drift —
 * dm-pinned for agreement across granted/ungranted/General/retracted arms.
 * Fail-closed: no principal resolution, read error, empty project set, no active item-grain
 * unit, no current include membership in a visible project → false.
 */
export async function canSeeItem(db: DbClient, principal: Principal, itemId: string): Promise<boolean> {
  const { projectIds } = await visibleProjects(db, principal);
  if (projectIds.size === 0) return false;

  const { data: unit, error: uErr } = await db
    .from("project_context_units")
    .select("id, source_item_id, state, unit_kind")
    .eq("team_id", principal.teamId)
    .eq("source_item_id", itemId)
    // unit_kind in-query: today's CHECK guarantees one item-grain unit per item, but when
    // Phase D admits non-item units sharing a source, maybeSingle must not error (which would
    // deny an entitled member and disagree with the list — diff-review Low).
    .eq("unit_kind", "item")
    .maybeSingle();
  if (uErr || !unitServesItem(unit as UnitRow | null)) return false;

  const { data: mems, error: mErr } = await currentIncludeMemberships(
    db.from("project_context_memberships").select("project_id").eq("context_unit_id", (unit as { id: string }).id),
    principal.teamId,
    projectIds
  );
  if (mErr) return false;
  return ((mems ?? []) as unknown[]).length > 0;
}

/** Member convenience: resolve the principal's visible projects via the oracle, then the item ids.
 * Also RETURNS the project ids (PCCC-6): the graph legs partition by project, and recomputing the
 * oracle a second time for them would be a disagreement surface. */
export async function visibleItemIds(
  db: DbClient,
  principal: Principal
): Promise<VisibleItemIds & { projectIds: string[] }> {
  const { projectIds } = await visibleProjects(db, principal);
  const items = await visibleItemIdsForProjects(db, principal.teamId, projectIds);
  return { ...items, projectIds: [...projectIds] };
}

/**
 * Delegated principals are ALWAYS attenuated (Phase B slice 3, spec §10/§5.8b): the enforce arg
 * for an `aiosd_*` query, always computed — the retired rollout flag was the
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
 * hit) would defeat what the cache is for (Fable B4 Medium). PRET-6: always resolves (never
 * null) — a substrate read error throws and the caller fails closed (500/no data).
 */
export interface MemberVisibility {
  visibleProjectIds: ReadonlySet<string>;
  /** Keys the cache variant; derived ONLY from the sorted effective project set. */
  visibilityHash: string;
}

export async function memberVisibility(db: DbClient, principal: Principal): Promise<MemberVisibility> {
  const { projectIds } = await visibleProjects(db, principal);
  const visibilityHash = createHash("sha256").update([...projectIds].sort().join(",")).digest("hex").slice(0, 16);
  return { visibleProjectIds: projectIds, visibilityHash };
}

/**
 * The EXPENSIVE half — the membership-visible item-id set — resolved lazily from a
 * `MemberVisibility` only when a surface actually BUILDS (cache miss / stale rebuild), never on a
 * hit. Structured rows gate on their source item; null-source rows go through the CREATED_BY
 * provenance rule (`lib/access/provenance`, ENFB-1 — `origin` is durability, never provenance;
 * `tasks.project_id` is the INGEST project, not an access-control project).
 */
export interface TimelineEnforcement {
  visibleItemIds: ReadonlySet<string>;
  /** The oracle's project set the item set was resolved FROM (PCCC6B-1: the arcs routes resolve
   *  the principal's graph partition scope from this — same source of truth, one substrate read). */
  visibleProjectIds: ReadonlySet<string>;
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
  return { visibleItemIds: ids, visibleProjectIds: vis.visibleProjectIds };
}

/**
 * Convenience for DIRECT build paths (no cache layer to shield — e.g. the >7d timeline expansion):
 * resolve the full enforcement in one call. PRET-6: always resolves for a live principal. The
 * cache layer does NOT use this — it splits cheap-hash / lazy-items across the hit/miss boundary.
 */
export async function memberEnforcement(db: DbClient, principal: Principal): Promise<TimelineEnforcement> {
  const vis = await memberVisibility(db, principal);
  return resolveTimelineEnforcement(db, principal.teamId, vis);
}

/**
 * PROJECT-ROW visibility (ENFB-2 §2.1): may this principal see that a project EXISTS — its
 * name, slug, counts, dropdown entry, detail page. A row is visible iff
 *   granted        — the project is in the oracle's granted set (`visibleProjects`), OR
 *   content-visible — the member can see ≥1 item WHOSE CONTAINER it is, or ≥1
 *                     provenance-visible task or decision in it.
 * The content arms are what keep the source containers visible for a stock member — measured
 * (2026-08-19): prod grants cover ONLY the two system projects, so a grants-only rule would
 * empty the projects list, 404 every container page, and blank the create dropdowns.
 * NOT the same set as `visibleItemIds(...).projectIds` (that is the GRANTED set alone —
 * design round 2 BLOCKER 1); consumers resolve THIS set.
 * Fail-closed: no principal / read error → empty set (flagged), `canSeeProjectRow` → false.
 */
export interface VisibleProjectRows {
  ids: ReadonlySet<string>;
  /** True when empty is the product of a READ ERROR, not a genuinely-empty visible set. */
  error?: boolean;
}

/**
 * AUDITFIX-1 §2b. The three project-row helpers below (`visibleProjectRows`, `canSeeProjectRow`,
 * `visibleProjectCards`) are member-only, and as of Codex's diff review they are member-only BY
 * TYPE rather than only by call-site enumeration.
 *
 * The review's point was sharp: they took a `Principal`, whose `projectScope` makes it token-shaped,
 * while unconditionally asserting memberhood inside. That combination is a footgun the type system
 * endorsed — a future token route could legitimately call `visibleProjectRows(db, tokenPrincipal)`,
 * get the hand-typed arm opened for it, and redden nothing, because the member literal lives in this
 * allow-listed file and the new caller need not contain one. So the parameter is now
 * `MemberPrincipal`, which cannot carry a scope, and the assertion inside is true by construction.
 *
 * The value is still named once, HERE, rather than spelled at each call site — a bare `"member"`
 * literal scattered through the file is the shape a future token path would copy.
 */
const MEMBER_ONLY_SURFACE = "member" as const;

/**
 * A principal that CANNOT be a delegated token. `projectScope?: never` makes a token-shaped value a
 * compile error at the call site rather than a silent widening inside. Do not infer member-vs-token
 * from `projectScope` being absent at runtime — an UNATTENUATED token also has a null scope, which
 * is exactly why this is a type constraint on the caller and not a check in here.
 */
export type MemberPrincipal = Principal & { projectScope?: never };

/**
 * The discriminator is a parameter of this SQL builder so the policy stays in one place
 * (`admitsUnsourced`), and its three callers below all pass `MEMBER_ONLY_SURFACE` — which is honest
 * only because they now take a `MemberPrincipal` that cannot be a token. An earlier version of this
 * comment claimed the parameterisation itself was the safety property; it was not, and Codex's diff
 * review caught the claim before the type made it true.
 */
function projectRowVisibleSql(
  teamId: string,
  granted: readonly string[],
  teamPosture: boolean,
  principal: "member" | "token" | undefined
) {
  const p = newSqlParams();
  const ctx: ProvenanceSqlCtx = { teamId, grantedProjectIds: granted, teamPosture, principal };
  const team = p.add(teamId);
  const grantedPh = p.add([...granted]);
  // Posture stays a CONJUNCT on every content arm (Fable diff L10): an external-posture
  // member's row-visibility must not exceed what the container's own surfaces would list for
  // them (membership ∧ audience, matching the pages' visibleItems/visibleTasks walls).
  const posture = p.add(teamPosture);
  const where = `p.team_id = ${team} and (
      p.id = any(${grantedPh}::uuid[])
      or exists (select 1 from items i where i.team_id = ${team} and i.project_id = p.id and (${posture} or i.access = 'external') and ${itemVisibleSql("i.id", p, ctx)})
      or exists (select 1 from tasks t where t.team_id = ${team} and t.project_id = p.id and (${posture} or t.audience = 'external') and ${provenanceRowSql("t", p, ctx)})
      or exists (select 1 from decisions d where d.team_id = ${team} and d.project_id = p.id and (${posture} or d.audience = 'external') and ${provenanceRowSql("d", p, ctx)})
    )`;
  return { p, where };
}

export async function visibleProjectRows(db: DbClient, principal: MemberPrincipal): Promise<VisibleProjectRows> {
  try {
    const { projectIds } = await visibleProjects(db, principal);
    const posture = await teamPostureFor(db, principal);
    const { p, where } = projectRowVisibleSql(principal.teamId, [...projectIds], posture, MEMBER_ONLY_SURFACE);
    const res = await runSql<{ id: string }>(`select p.id from projects p where ${where}`, p.values);
    return { ids: new Set(res.rows.map((r) => r.id)) };
  } catch {
    return { ids: new Set(), error: true }; // fail closed on substrate error
  }
}

export async function canSeeProjectRow(db: DbClient, principal: MemberPrincipal, projectId: string): Promise<boolean> {
  try {
    const { projectIds } = await visibleProjects(db, principal);
    const posture = await teamPostureFor(db, principal);
    const { p, where } = projectRowVisibleSql(principal.teamId, [...projectIds], posture, MEMBER_ONLY_SURFACE);
    const idPh = p.add(projectId);
    const res = await runSql<{ id: string }>(
      `select p.id from projects p where p.id = ${idPh} and ${where} limit 1`,
      p.values
    );
    return res.rows.length > 0;
  } catch {
    return false; // fail closed
  }
}

/** The projects-LIST card read (ENFB-2 §1 row 1): row-visible non-system projects with
 *  VIEWER-VISIBLE item/task counts — the `items(count)`/`tasks(count)` embeds counted
 *  per-project TOTALS (invisible content included), so they are replaced, not filtered. */
export interface ProjectRowCard {
  id: string;
  slug: string;
  name: string;
  last_synced_at: string | null;
  visibleItems: number;
  visibleTasks: number;
}

export async function visibleProjectCards(
  db: DbClient,
  principal: MemberPrincipal
): Promise<{ rows: ProjectRowCard[]; error?: boolean }> {
  try {
    const { projectIds } = await visibleProjects(db, principal);
    const posture0 = await teamPostureFor(db, principal);
    const { p, where } = projectRowVisibleSql(principal.teamId, [...projectIds], posture0, MEMBER_ONLY_SURFACE);
    // AUDITFIX-1: the count ctx takes the SAME discriminator as the row rule above. Omitting it here
    // is not fail-safe — it silently CLOSES the hand-typed arm for a member, so a card would report
    // fewer tasks than the project page lists. That is a member-visible regression, and this slice
    // narrows tokens only (§1). Pinned by the visibleTasks assertion in enfb2-project-rows.
    const ctx: ProvenanceSqlCtx = {
      teamId: principal.teamId,
      grantedProjectIds: [...projectIds],
      teamPosture: posture0,
      principal: MEMBER_ONLY_SURFACE,
    };
    // The card counts carry the SAME posture conjuncts as the row rule and the detail page's
    // walls (Fable diff L10 — counts must never exceed what the container page lists).
    const posture = p.add(posture0);
    const res = await runSql<{ id: string; slug: string; name: string; last_synced_at: string | Date | null; visible_items: number; visible_tasks: number }>(
      `select p.id, p.slug, p.name, p.last_synced_at,
              (select count(*) from items i where i.team_id = p.team_id and i.project_id = p.id and (${posture} or i.access = 'external') and ${itemVisibleSql("i.id", p, ctx)})::int as visible_items,
              (select count(*) from tasks t where t.team_id = p.team_id and t.project_id = p.id and (${posture} or t.audience = 'external') and ${provenanceRowSql("t", p, ctx)})::int as visible_tasks
         from projects p
        where p.kind <> 'system' and ${where}
        order by p.last_synced_at desc nulls last`,
      p.values
    );
    return {
      rows: res.rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        last_synced_at: r.last_synced_at instanceof Date ? r.last_synced_at.toISOString() : r.last_synced_at,
        visibleItems: r.visible_items,
        visibleTasks: r.visible_tasks,
      })),
    };
  } catch {
    return { rows: [], error: true }; // fail closed
  }
}

/** The hand-typed arm's audience wall: team posture per the everyone-group resolution —
 *  the SAME source `resolveViewerPosture` reads, resolved here per-principal. */
async function teamPostureFor(db: DbClient, principal: Principal): Promise<boolean> {
  const { resolveViewerPosture } = await import("@/lib/access/posture");
  const posture = await resolveViewerPosture(db, principal.teamId, principal.memberId);
  return posture === "team";
}

/**
 * ENFB-3 (Fable diff H2 — the adjacent-write-route class, merge edition): merge CANDIDACY is
 * bounded to SYSTEM-visible sources (an open include into General or external-shared).
 * Without this, the nightly dedupe (or any member's overlapping upload) could match a
 * RESTRICTED meeting, write the merged transcript to a fresh merge-owned item, and the inline
 * reconcile would route that fresh unit into General — silently re-publishing restricted
 * content to the whole team. External-shared sources stay mergeable (the merge's own access
 * floor handles the tier math — the M1 arms pin that flow); only initiative-curated sources
 * leave candidacy. Two restricted copies of one meeting stay separate (fail-closed
 * over-restriction, stated in the spec). An unbootstrapped team yields the empty set —
 * nothing is candidate (fail closed).
 */
export async function systemVisibleSourceIds(
  db: DbClient,
  teamId: string,
  itemIds: readonly string[]
): Promise<Set<string>> {
  if (!itemIds.length) return new Set();
  const { data: sys } = await db
    .from("projects")
    .select("id")
    .eq("team_id", teamId)
    .eq("kind", "system");
  const sysIds = ((sys ?? []) as { id: string }[]).map((p) => p.id);
  if (!sysIds.length) return new Set();
  const { data: units } = await db
    .from("project_context_units")
    .select("id, source_item_id")
    .eq("team_id", teamId)
    .eq("unit_kind", "item")
    .eq("state", "active")
    .in("source_item_id", [...itemIds]);
  const unitRows = (units ?? []) as { id: string; source_item_id: string }[];
  if (!unitRows.length) return new Set();
  const { data: mems } = await db
    .from("project_context_memberships")
    .select("context_unit_id")
    .eq("team_id", teamId)
    .eq("decision", "include")
    .is("valid_to", null)
    .in("project_id", sysIds)
    .in("context_unit_id", unitRows.map((u) => u.id));
  const included = new Set(((mems ?? []) as { context_unit_id: string }[]).map((m) => m.context_unit_id));
  return new Set(unitRows.filter((u) => included.has(u.id)).map((u) => u.source_item_id));
}
