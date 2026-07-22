import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * Evidence-gated per-item CONTRIBUTOR credit — "who actually did work on this item", not merely its
 * current owner. Closes the reassignment blind spot: after an item moves A→B, crediting only B erases A's
 * real contribution (the `narrative-arcs-representation` bug — a contributor goes invisible in Learning).
 *
 * The work ledger is **`item_versions`**: every body change writes a version attributed to the
 * then-resolved author (`member_id` at that push), so an item's distinct version authors ARE the people
 * who produced work on it, in a time base consistent with when the work landed. This is the evidence gate
 * the ownership-timeline design calls for (docs/design/attribution-ownership-timeline.md) — a mislabeled
 * assigned-but-never-worked owner leaves no version, so it earns no credit automatically. A LOCKED
 * attribution (an admin correction) is the authoritative override: credit collapses to the corrected owner.
 */

/**
 * The pure credit rule for ONE item (member ids; connectors already excluded by the caller).
 *  - LOCKED (an admin correction is authoritative) → ONLY the current owner (nobody if cleared to null).
 *  - UNLOCKED → everyone who produced a version (real work) — captures a genuine handoff (A's versions +
 *    B's versions) and starves a mislabel (assigned but never worked → no version → no credit). Falls back
 *    to the current owner when the item has no attributable version history.
 */
export function creditedContributorIds(item: {
  locked: boolean;
  currentMemberId: string | null;
  versionMemberIds: string[]; // distinct, work order, connector-excluded
}): string[] {
  if (item.locked) return item.currentMemberId ? [item.currentMemberId] : [];
  if (item.versionMemberIds.length > 0) return item.versionMemberIds;
  return item.currentMemberId ? [item.currentMemberId] : [];
}

/**
 * item id → evidence-gated contributor DISPLAY NAMES (non-connector), for a batch of item ids. Batches
 * items + item_versions + members. Best-effort (empty map on failure): an unattributed arc is more honest
 * than a thrown error — mirrors `resolveHumanActorsByItem`, which this generalizes from "current owner" to
 * "everyone who did the work".
 */
export async function resolveContributorsByItem(
  db: DbClient,
  teamId: string,
  itemIds: string[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(itemIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const [itemsRes, versionsRes] = await Promise.all([
      db.from("items").select("id, member_id, member_id_locked").eq("team_id", teamId).in("id", ids),
      db
        .from("item_versions")
        .select("item_id, member_id, created_at")
        .in("item_id", ids)
        .order("created_at", { ascending: true }),
    ]);
    const items = (itemsRes.data ?? []) as { id: string; member_id: string | null; member_id_locked: boolean | null }[];
    const versions = (versionsRes.data ?? []) as { item_id: string; member_id: string | null }[];

    // members → {display_name, is_connector} for every referenced id (current owners + version authors).
    const memberIds = [
      ...new Set([...items.map((i) => i.member_id), ...versions.map((v) => v.member_id)].filter((m): m is string => !!m)),
    ];
    const memberMap = new Map<string, { name: string | null; connector: boolean }>();
    if (memberIds.length) {
      const { data } = await db
        .from("members")
        .select("id, display_name, is_connector")
        .eq("team_id", teamId)
        .in("id", memberIds);
      for (const m of (data ?? []) as { id: string; display_name: string | null; is_connector: boolean }[]) {
        memberMap.set(m.id, { name: m.display_name, connector: m.is_connector });
      }
    }
    const humanName = (id: string | null): string | null => {
      if (!id) return null;
      const m = memberMap.get(id);
      return m && !m.connector && m.name ? m.name : null;
    };

    // Distinct non-connector version authors per item, in work (created_at) order.
    const versionMembersByItem = new Map<string, string[]>();
    for (const v of versions) {
      if (!v.member_id || !humanName(v.member_id)) continue;
      const list = versionMembersByItem.get(v.item_id) ?? [];
      if (!list.includes(v.member_id)) list.push(v.member_id);
      versionMembersByItem.set(v.item_id, list);
    }

    for (const it of items) {
      const creditedIds = creditedContributorIds({
        locked: it.member_id_locked === true,
        currentMemberId: humanName(it.member_id) ? it.member_id : null,
        versionMemberIds: versionMembersByItem.get(it.id) ?? [],
      });
      const names = [...new Set(creditedIds.map(humanName).filter((n): n is string => !!n))];
      if (names.length) out.set(it.id, names);
    }
  } catch {
    // best-effort — empty map on failure
  }
  return out;
}
