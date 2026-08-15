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
export async function resolveFanoutTargets(
  db: DbClient,
  args: {
    teamId: string;
    itemIds: readonly string[];
    /** initiative projectId → stored graph_group_id (pointerless initiatives are not surfaces). */
    initiativeGroupByProject: ReadonlyMap<string, string>;
  }
): Promise<Map<string, Set<string>>> {
  const targets = new Map<string, Set<string>>();
  if (args.itemIds.length === 0 || args.initiativeGroupByProject.size === 0) return targets;

  for (const idBatch of chunk([...args.itemIds], IN_CLAUSE_BATCH)) {
    const { data: unitData, error: unitErr } = await db
      .from("project_context_units")
      .select("id, source_item_id")
      .eq("team_id", args.teamId)
      .eq("state", "active")
      .in("source_item_id", idBatch);
    if (unitErr) throw new Error(`fanout-targets: context-unit read failed: ${unitErr.message}`);
    const units = (unitData ?? []) as { id: string; source_item_id: string }[];
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
        const group = args.initiativeGroupByProject.get(m.project_id);
        const itemId = itemByUnit.get(m.context_unit_id);
        if (!group || !itemId) continue; // non-initiative or pointerless target — not a fan-out surface
        const set = targets.get(itemId) ?? new Set<string>();
        set.add(group);
        targets.set(itemId, set);
      }
    }
  }
  return targets;
}
