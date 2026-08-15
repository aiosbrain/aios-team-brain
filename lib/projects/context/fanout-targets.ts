import "server-only";
import type { DbClient } from "@/lib/db/types";
import { chunk, IN_CLAUSE_BATCH } from "@/lib/db/batch";

/**
 * READ-ONLY resolver: each item's ACTIVE initiative include memberships → the initiative's graph
 * group (PCCC-5 fan-out targets). Unit-anchored, matching the substrate's grain: item → active
 * unit → open include membership → initiative pointer.
 *
 * Lives HERE, not in the projector, deliberately: the access-single-writer guard's coarse net
 * flags the substrate table literals in any file that also carries write verbs — which the
 * projector inherently does. A read of the permission-model tables belongs in a module that can
 * PROVE it only reads (this file has no write verb to its name).
 */
export interface FanoutResolution {
  /** itemId → the initiative graph groups its ACTIVE include memberships fan out to. */
  targets: Map<string, Set<string>>;
  /** itemIds holding an ACTIVE include membership in the GENERAL built-in (PCCC-6: an item
   *  RESTRICTED out of General is absent here — the projector's landed-gated move purges its home
   *  row once a landed initiative copy exists; spec rule 2, restriction-moves-not-copies). */
  inGeneral: Set<string>;
}

export async function resolveFanoutTargets(
  db: DbClient,
  args: {
    teamId: string;
    itemIds: readonly string[];
    /** initiative projectId → stored graph_group_id (pointerless initiatives are not surfaces). */
    initiativeGroupByProject: ReadonlyMap<string, string>;
    /** The General built-in's project id (null when unbootstrapped — every item then reads as
     *  in-General, which disables the restriction move: fail open to today's behavior). */
    generalProjectId?: string | null;
  }
): Promise<FanoutResolution> {
  const targets = new Map<string, Set<string>>();
  const inGeneral = new Set<string>();
  const itemsWithUnits = new Set<string>();
  const generalDisabled = !args.generalProjectId;
  if (generalDisabled) for (const id of args.itemIds) inGeneral.add(id);
  if (args.itemIds.length === 0) return { targets, inGeneral };

  for (const idBatch of chunk([...args.itemIds], IN_CLAUSE_BATCH)) {
    const { data: unitData, error: unitErr } = await db
      .from("project_context_units")
      .select("id, source_item_id")
      .eq("team_id", args.teamId)
      .eq("state", "active")
      .in("source_item_id", idBatch);
    if (unitErr) throw new Error(`fanout-targets: context-unit read failed: ${unitErr.message}`);
    const units = (unitData ?? []) as { id: string; source_item_id: string }[];
    for (const u of units) itemsWithUnits.add(u.source_item_id);
    if (units.length === 0) continue;
    const itemByUnit = new Map(units.map((u) => [u.id, u.source_item_id]));
    for (const unitBatch of chunk([...itemByUnit.keys()], IN_CLAUSE_BATCH)) {
      const { data: memData, error: memErr } = await db
        .from("project_context_memberships")
        .select("context_unit_id, project_id, decision, valid_to")
        .eq("team_id", args.teamId)
        .eq("decision", "include")
        .is("valid_to", null)
        .in("context_unit_id", unitBatch);
      if (memErr) throw new Error(`fanout-targets: membership read failed: ${memErr.message}`);
      for (const m of (memData ?? []) as { context_unit_id: string; project_id: string }[]) {
        const itemId = itemByUnit.get(m.context_unit_id);
        if (!itemId) continue;
        if (!generalDisabled && m.project_id === args.generalProjectId) {
          inGeneral.add(itemId);
          continue;
        }
        const group = args.initiativeGroupByProject.get(m.project_id);
        if (!group) continue; // non-initiative or pointerless target — not a fan-out surface
        const set = targets.get(itemId) ?? new Set<string>();
        set.add(group);
        targets.set(itemId, set);
      }
    }
  }
  // An item with NO substrate rows at all defaults to in-General: only an EXPLICIT membership
  // state may restrict (a substrate-hook race or failure must never silently drop content from the
  // graph — spec rule 1's default-to-General, applied at the graph layer). NOTE the unit read
  // filters state='active': a fully-RETRACTED-units item (nothing writes that state yet — the
  // Phase-D relaxation lib/access/enforce also defends against) reads as substrate-less and
  // defaults in-General here; when retraction gains a writer, decide whether it must imply
  // restriction BEFORE relying on it — this default would resurrect its content into General.
  if (!generalDisabled) {
    for (const id of args.itemIds) if (!itemsWithUnits.has(id)) inGeneral.add(id);
  }
  return { targets, inGeneral };
}
