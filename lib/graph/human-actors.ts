import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * Item id → resolved human (non-connector) display name, for a batch of brain item ids in ONE
 * Postgres query. The shared primitive behind BOTH narrative-arc attribution (`lib/graph/arcs.ts` —
 * facts fed to the synthesis prompt + the arc's `participants`) and Layer-2 event participant
 * attribution (`app/api/brain/events/route.ts`): every ingested item is already attributed to a
 * human via `items.member_id` (excluding connector service-accounts, `members.is_connector`), this
 * just batches that join. Best-effort: an empty map on failure or when an item has no resolvable
 * (non-connector) human — an unattributed AI agent is still more honest than a thrown error.
 */
export async function resolveHumanActorsByItem(
  db: DbClient,
  teamId: string,
  itemIds: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(itemIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const { data } = await db
      .from("items")
      .select("id, members(display_name, is_connector)")
      .eq("team_id", teamId)
      .in("id", ids);
    const rows = (data ?? []) as {
      id: string;
      members: { display_name: string | null; is_connector: boolean } | null;
    }[];
    for (const r of rows) {
      const m = r.members;
      if (m && !m.is_connector && m.display_name) out.set(r.id, m.display_name);
    }
  } catch {
    // best-effort — empty map on failure
  }
  return out;
}

/** Distinct human (non-connector) display names behind a set of brain item ids. Thin wrapper over
 *  `resolveHumanActorsByItem` for callers that only need the deduped name list, not the per-item map. */
export async function resolveHumanActors(db: DbClient, teamId: string, itemIds: string[]): Promise<string[]> {
  const byItem = await resolveHumanActorsByItem(db, teamId, itemIds);
  return [...new Set(byItem.values())];
}
