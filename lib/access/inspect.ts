import "server-only";
import type { DbClient } from "@/lib/db/types";
import { visibleProjects } from "@/lib/access/oracle";
import { visibleItemIds, teamEnforcesAccess } from "@/lib/access/enforce";
import { isPrincipal } from "@/lib/access/eligibility";
import { canSeeAccess, type ViewerTier } from "@/lib/auth/visibility";
import { EVERYONE_SLUG, EXTERNAL_SLUG } from "@/lib/access/groups";

/** A substrate read errored — the caller (route) turns this into a 500. A diagnostics tool must
 *  fail LOUD, never emit a confident wrong verdict from a swallowed error (Codex B6 Medium). */
function throwOnReadError(error: unknown, what: string): void {
  if (error) throw new Error(`inspect: ${what} read failed`);
}

/**
 * The permission inspector (spec §15.6, "build early, not last"). Answers "why can ⟨member⟩ see
 * ⟨item⟩?" — the person → group → project → unit-membership chain, each edge with its provenance —
 * and doubles as the runtime cache-leak check (§5.8): given a rendered payload's item ids, which
 * ones must this principal NOT see.
 *
 * CRITICAL — the inspector must AGREE with the ACTUAL enforced read, never a partial re-derivation
 * (spec: divergence is the risk; "an inspector that disagrees with enforcement is worse than none").
 * The enforced read is **legacy-tier ∧ (enforcing ? oracle : allow-all-in-tier)** (`lib/access/enforce`
 * "oracle ∧ legacy-tier"; the oracle conjunct is GATED by `teams.access_enforcement`). So this module
 * applies BOTH conjuncts, mode-aware:
 *   - the TIER conjunct (`canSeeAccess(member.tier, item.access)`) is ALWAYS a factor — it is the
 *     standing app-code invariant with no RLS backstop (CLAUDE.md §5), and a §5.8 leak check that
 *     ignored it would be blind to the very leak class it exists to catch (Fable B6 High);
 *   - the ORACLE conjunct (the project-membership chain) applies ONLY on an `enforcing` team. On a
 *     `permissive` team the member genuinely sees everything in their tier, so an un-granted item is
 *     NOT a leak (serving it is by-design) — reporting it as one would be a false incident (Fable B6
 *     Medium). The returned `mode` tells the admin which semantics the verdict reflects.
 *
 * This is a READ-ONLY diagnostic — it writes nothing.
 */

/** How a member holds a group. `singleton` is the §4 "direct person add": the API returns
 *  `via:"singleton"` + `grant.addedBy` (the admin who added them); the deferred inspector UI renders
 *  that as "directly added by ⟨admin⟩, not as a group" (§15.6). The presentation is the UI's job —
 *  this module returns the structured facts. */
export type MembershipVia = "builtin_tier" | "singleton" | "added";
export type GroupKind = "everyone" | "external" | "singleton" | "ordinary";
export type EnforcementMode = "enforcing" | "permissive";

export interface VisibilityChain {
  projectId: string;
  group: { id: string; slug: string; name: string; kind: GroupKind };
  membership: { via: MembershipVia; addedBy: string | null; at: string | null };
  grant: { addedBy: string | null; at: string | null };
  unit: { method: string; decidedBy: string | null; validFrom: string | null };
}

export interface ItemVisibility {
  itemId: string;
  memberId: string;
  /** The team's enforcement mode — the verdict below reflects THIS mode's semantics. */
  mode: EnforcementMode;
  visible: boolean;
  /** The project-grant paths that make the item visible under ENFORCING. Empty when not visible, or
   *  on a permissive team (no project gate is active — visibility is by tier alone). */
  chains: VisibilityChain[];
  /** Set only when NOT visible — coarse, never names the restricted project (§5.7). */
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
  const mode: EnforcementMode = (await teamEnforcesAccess(db, teamId)) ? "enforcing" : "permissive";

  const [{ data: member, error: memberErr }, { data: item, error: itemErr }] = await Promise.all([
    db.from("members").select("kind, is_connector, status, tier").eq("team_id", teamId).eq("id", memberId).maybeSingle(),
    db.from("items").select("access").eq("team_id", teamId).eq("id", itemId).maybeSingle(),
  ]);
  throwOnReadError(memberErr, "member");
  throwOnReadError(itemErr, "item");
  if (!member) return { itemId, memberId, mode, visible: false, chains: [], reason: "member not found in this team" };
  if (!item) return { itemId, memberId, mode, visible: false, chains: [], reason: "item not found in this team" };
  const m = member as { kind: string; is_connector: boolean; status: string; tier: string | null };

  // A NON-PRINCIPAL (disabled / connector / invited) cannot read anything — the runtime auth + the
  // oracle both reject them. In permissive mode there is no oracle to catch it, so gate it here so
  // the verdict matches reality in BOTH modes (Codex B6 Medium).
  if (!isPrincipal({ kind: m.kind, is_connector: m.is_connector, status: m.status })) {
    return { itemId, memberId, mode, visible: false, chains: [], reason: "member is not an active principal (disabled, connector, or non-active)" };
  }
  const tier = (m.tier ?? "external") as ViewerTier;
  const tierOk = canSeeAccess(tier, (item as { access: string | null }).access ?? "team");

  // THE TIER CONJUNCT — always a factor. A tier miss is a hard no in any mode.
  if (!tierOk) {
    return { itemId, memberId, mode, visible: false, chains: [], reason: "your access tier cannot see this item's access level" };
  }
  // Permissive team: enforcement's oracle conjunct is inactive → visible by tier, no project chain.
  if (mode === "permissive") {
    return { itemId, memberId, mode, visible: true, chains: [] };
  }

  // Enforcing: the ORACLE conjunct. The member's oracle-visible projects + post-eligibility groups.
  const { projectIds: visibleProjIds, groupIds } = await visibleProjects(db, { teamId, memberId });

  // The item's ACTIVE include-memberships: which project(s) hold it + the unit edge's provenance.
  const { data: unitRows, error: unitErr } = await db
    .from("project_context_memberships")
    .select("project_id, method, decided_by, valid_from, project_context_units(source_item_id, state, unit_kind)")
    .eq("team_id", teamId)
    .eq("decision", "include")
    .is("valid_to", null);
  throwOnReadError(unitErr, "memberships"); // never a false "not partitioned" from a swallowed error
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
      if (!itemProjects.has(r.project_id)) {
        itemProjects.set(r.project_id, { method: r.method, decidedBy: r.decided_by, validFrom: r.valid_from });
      }
    }
  }

  const grantingProjects = [...itemProjects.keys()].filter((p) => visibleProjIds.has(p));
  if (grantingProjects.length === 0) {
    const reason = itemProjects.size === 0
      ? "the item has no active project membership (not yet partitioned, or removed)"
      : groupIds.size === 0
        ? "you are in no groups that grant access"
        : "no group you are in is granted a project that holds this item";
    return { itemId, memberId, mode, visible: false, chains: [], reason };
  }

  // Build the chain per (project, group) grant path — ONLY through the member's post-eligibility
  // groups. Because `visibleProjIds` is DERIVED from those groups (oracle.ts), every granting project
  // has ≥1 grant row through a kept group, so `chains` is empty here only on a concurrent grant
  // delete or a swallowed read error — not the "eligibility dropped the group" case.
  const { data: grantRows, error: grantErr } = await db
    .from("project_groups")
    .select("project_id, group_id, added_by, created_at")
    .eq("team_id", teamId)
    .in("project_id", grantingProjects)
    .in("group_id", [...groupIds]);
  throwOnReadError(grantErr, "grants");
  const grants = (grantRows ?? []) as { project_id: string; group_id: string; added_by: string | null; created_at: string | null }[];

  const groupIdsInPlay = [...new Set(grants.map((g) => g.group_id))];
  const [{ data: groupRows, error: groupErr }, { data: gmRows, error: gmErr }] = await Promise.all([
    db.from("groups").select("id, slug, name, is_builtin, person_member_id").eq("team_id", teamId).in("id", groupIdsInPlay.length ? groupIdsInPlay : ["-"]),
    db.from("group_members").select("group_id, added_by, created_at").eq("team_id", teamId).eq("member_id", memberId).in("group_id", groupIdsInPlay.length ? groupIdsInPlay : ["-"]),
  ]);
  throwOnReadError(groupErr, "groups");
  throwOnReadError(gmErr, "group_members"); // a chain the tool cannot build must 500, not render empty
  const groupById = new Map(((groupRows ?? []) as { id: string; slug: string; name: string; is_builtin: boolean; person_member_id: string | null }[]).map((g) => [g.id, g]));
  const gmByGroup = new Map(((gmRows ?? []) as { group_id: string; added_by: string | null; created_at: string | null }[]).map((r) => [r.group_id, r]));

  const chains: VisibilityChain[] = [];
  for (const grant of grants) {
    const g = groupById.get(grant.group_id);
    if (!g) continue;
    const via: MembershipVia = g.is_builtin ? "builtin_tier" : g.person_member_id === memberId ? "singleton" : "added";
    const gm = gmByGroup.get(grant.group_id);
    const unit = itemProjects.get(grant.project_id)!;
    chains.push({
      projectId: grant.project_id,
      group: { id: g.id, slug: g.slug, name: g.name, kind: groupKind(g) },
      membership: { via, addedBy: gm?.added_by ?? null, at: gm?.created_at ?? null },
      grant: { addedBy: grant.added_by, at: grant.created_at },
      unit,
    });
  }

  // `visible` tracks the oracle∧tier verdict, not `chains.length` (a raced chain read must not flip
  // the verdict the enforcement path would actually take).
  return { itemId, memberId, mode, visible: true, chains };
}

/**
 * The runtime cache-leak check (spec §5.8): given a set of item ids a surface is about to render,
 * return the subset this principal must NOT see under the ACTIVE enforcement — legacy-tier ∧
 * (enforcing ? oracle : allow). Empty = clean FOR THAT MODE. Applies the SAME two conjuncts the read
 * path does, so a reported leak is a real one; and it is NOT blind to the tier-isolation leak class
 * (external reading team content), which the oracle set alone would miss (Fable B6 High).
 */
export async function auditVisibilityAgainstItemIds(
  db: DbClient,
  { teamId, memberId }: { teamId: string; memberId: string },
  itemIds: readonly string[]
): Promise<string[]> {
  if (itemIds.length === 0) return [];
  const ids = [...new Set(itemIds)];
  const enforcing = await teamEnforcesAccess(db, teamId);

  const [{ data: member, error: memberErr }, { data: itemRows, error: itemErr }] = await Promise.all([
    db.from("members").select("kind, is_connector, status, tier").eq("team_id", teamId).eq("id", memberId).maybeSingle(),
    db.from("items").select("id, access").eq("team_id", teamId).in("id", ids),
  ]);
  // Throw (→ route 500) on a substrate error rather than returning a wrong leak list: over-reporting
  // false leaks OR under-reporting real ones both violate "every reported leak is real" (Codex B6 Medium).
  throwOnReadError(memberErr, "member");
  throwOnReadError(itemErr, "items");
  const m = member as { kind: string; is_connector: boolean; status: string; tier: string | null } | null;
  // A non-principal (disabled/connector/invited) may see NOTHING — every id is a leak (Codex B6 Medium).
  if (!m || !isPrincipal({ kind: m.kind, is_connector: m.is_connector, status: m.status })) return ids;
  const tier = (m.tier ?? "external") as ViewerTier;
  const accessById = new Map(((itemRows ?? []) as { id: string; access: string | null }[]).map((r) => [r.id, r.access ?? "team"]));
  const oracleVisible = enforcing ? (await visibleItemIds(db, { teamId, memberId })).ids : null;

  return ids.filter((id) => {
    const access = accessById.get(id);
    if (access == null) return true; // unknown item (not in this team) → fail closed → a leak
    const tierOk = canSeeAccess(tier, access);
    const oracleOk = oracleVisible ? oracleVisible.has(id) : true; // permissive → oracle not applied
    return !(tierOk && oracleOk);
  });
}
