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
 * The single PRIMARY contributor for BALANCING a fact (arc synthesis needs one representative per item).
 * Tightly scoped to the reassignment case — behavior is UNCHANGED except when the current owner exists but
 * did NO work:
 *  - LOCKED → the corrected owner (authoritative).
 *  - no current owner → null (unchanged: an unattributed item stays unattributed for balancing).
 *  - current owner produced a version (they worked) → the current owner (unchanged normal case).
 *  - current owner did NOT work (a pure reassignment / phantom label) → the LATEST actual worker, so a
 *    reassigned-away contributor gets their OWN balanced share, not the non-working new owner.
 */
export function creditedPrimaryId(item: {
  locked: boolean;
  currentMemberId: string | null;
  versionMemberIds: string[]; // distinct non-connector version authors
  latestWorkerId: string | null; // the latest non-connector version author (most-recent work)
}): string | null {
  if (item.locked) return item.currentMemberId;
  if (item.currentMemberId === null) return null;
  if (item.versionMemberIds.includes(item.currentMemberId)) return item.currentMemberId;
  return item.latestWorkerId ?? item.currentMemberId;
}

/** Evidence-gated credit for one item: the full `contributors` SET (for arc participants) + the single
 *  `primary` worker (for balancing one fact under one representative). Display names, non-connector. */
export interface ItemCredit {
  contributors: string[];
  primary: string | null;
}

/**
 * item id → `ItemCredit` (contributor DISPLAY NAMES + primary), for a batch of item ids. Batches
 * items + item_versions + members. Best-effort (empty map on failure): an unattributed arc is more honest
 * than a thrown error — mirrors `resolveHumanActorsByItem`, which this generalizes from "current owner" to
 * "everyone who did the work" (+ a work-based primary).
 */
export async function resolveItemCredit(
  db: DbClient,
  teamId: string,
  itemIds: string[]
): Promise<Map<string, ItemCredit>> {
  const out = new Map<string, ItemCredit>();
  const ids = [...new Set(itemIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const [itemsRes, versionsRes] = await Promise.all([
      db.from("items").select("id, member_id, member_id_locked").eq("team_id", teamId).in("id", ids),
      db
        .from("item_versions")
        .select("item_id, member_id, created_at")
        .in("item_id", ids)
        // `id` tiebreak: versions written in the same txn share `created_at` (Postgres `now()` is
        // txn-constant), so order deterministically → a stable `latestWorkerId`.
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }),
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

    // Per item: distinct non-connector version authors (work order) + the LATEST non-connector author
    // (versions are created_at ASC, so the last human author seen is the most recent).
    const versionMembersByItem = new Map<string, string[]>();
    const latestWorkerByItem = new Map<string, string>();
    for (const v of versions) {
      if (!v.member_id || !humanName(v.member_id)) continue;
      const list = versionMembersByItem.get(v.item_id) ?? [];
      if (!list.includes(v.member_id)) list.push(v.member_id);
      versionMembersByItem.set(v.item_id, list);
      latestWorkerByItem.set(v.item_id, v.member_id); // overwrite → ends at the latest
    }

    for (const it of items) {
      const currentMemberId = humanName(it.member_id) ? it.member_id : null;
      const versionMemberIds = versionMembersByItem.get(it.id) ?? [];
      const locked = it.member_id_locked === true;
      const contributors = [
        ...new Set(
          creditedContributorIds({ locked, currentMemberId, versionMemberIds }).map(humanName).filter((n): n is string => !!n)
        ),
      ];
      const primary = humanName(
        creditedPrimaryId({ locked, currentMemberId, versionMemberIds, latestWorkerId: latestWorkerByItem.get(it.id) ?? null })
      );
      if (contributors.length || primary) out.set(it.id, { contributors, primary });
    }
  } catch {
    // best-effort — empty map on failure
  }
  return out;
}
