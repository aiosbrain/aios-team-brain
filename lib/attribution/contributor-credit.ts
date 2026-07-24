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

/** Evidence-gated credit for one item, as member IDs: the full `contributorIds` SET (arc participants /
 *  a surface's per-person rows) + the single `primaryId` worker (one representative). Non-connector. This
 *  is THE canonical attribution shape — every surface that answers "who did the work" resolves through it,
 *  so they can't drift (guarded by `test/guards/attribution-single-source`). */
export interface ItemCreditIds {
  contributorIds: string[];
  primaryId: string | null;
}

/** Display-name projection of `ItemCreditIds` (arcs render names; the admin drill-down shows them). */
export interface ItemCredit {
  contributors: string[];
  primary: string | null;
}

/** Prefetched item shape a caller can pass so the oracle skips its own `items` read (the timeline already
 *  holds these rows). `id, member_id, member_id_locked` — the only item fields the credit rule needs. */
export interface CreditItemRow {
  id: string;
  member_id: string | null;
  member_id_locked: boolean | null;
}

interface CreditCore {
  byItem: Map<string, ItemCreditIds>;
  /** member id → display label (`display_name ?? actor_handle`), non-connector only. */
  nameOf: (id: string | null) => string | null;
}

/**
 * The shared core: resolve per-item credit as member IDs + a name projector, from one batched read of
 * items + item_versions + members. `strict` propagates DB errors (the timeline must THROW so an empty
 * ledger is never cached as fresh — #249); non-strict swallows to an empty result (arcs/admin degrade to
 * "unattributed" rather than failing the page). `items` can be prefetched to skip the items read.
 */
async function resolveCreditCore(
  db: DbClient,
  teamId: string,
  itemIds: string[],
  opts: { strict?: boolean; items?: CreditItemRow[] } = {}
): Promise<CreditCore> {
  const empty: CreditCore = { byItem: new Map(), nameOf: () => null };
  const ids = [...new Set(itemIds.filter(Boolean))];
  if (ids.length === 0) return empty;

  const run = async (): Promise<CreditCore> => {
    const itemsP = opts.items
      ? Promise.resolve({ data: opts.items, error: null })
      : db.from("items").select("id, member_id, member_id_locked").eq("team_id", teamId).in("id", ids);
    const [itemsRes, versionsRes] = await Promise.all([
      itemsP,
      db
        .from("item_versions")
        .select("item_id, member_id, created_at")
        .in("item_id", ids)
        // `id` tiebreak: versions written in the same txn share `created_at` (Postgres `now()` is
        // txn-constant), so order deterministically → a stable `latestWorkerId`.
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }),
    ]);
    // In strict mode a query error must surface (never treat a failed read as "no work").
    if (opts.strict && (itemsRes.error || versionsRes.error)) {
      throw new Error(`resolveItemCredit: ${(itemsRes.error ?? versionsRes.error)?.message}`);
    }
    const items = (itemsRes.data ?? []) as CreditItemRow[];
    const versions = (versionsRes.data ?? []) as { item_id: string; member_id: string | null }[];

    // members → {label, is_connector} for every referenced id (current owners + version authors). Label =
    // display_name ?? actor_handle, so a HUMAN with no display name is still credited (was excluded).
    const memberIds = [
      ...new Set([...items.map((i) => i.member_id), ...versions.map((v) => v.member_id)].filter((m): m is string => !!m)),
    ];
    const memberMap = new Map<string, { label: string; connector: boolean }>();
    if (memberIds.length) {
      const membersRes = await db
        .from("members")
        .select("id, display_name, actor_handle, is_connector")
        .eq("team_id", teamId)
        .in("id", memberIds);
      if (opts.strict && membersRes.error) throw new Error(`resolveItemCredit members: ${membersRes.error.message}`);
      for (const m of (membersRes.data ?? []) as { id: string; display_name: string | null; actor_handle: string | null; is_connector: boolean }[]) {
        // `||` (not `??`): display_name is NOT NULL but can be EMPTY — fall through to the handle so a
        // human with a blank name is still credited (the old has-name gate excluded them entirely).
        memberMap.set(m.id, { label: m.display_name?.trim() || m.actor_handle?.trim() || "(unknown)", connector: m.is_connector });
      }
    }
    // A HUMAN member id (exists + not a connector). No name gate — nameless humans still count.
    const isHuman = (id: string | null): boolean => !!id && !!memberMap.get(id) && !memberMap.get(id)!.connector;
    const nameOf = (id: string | null): string | null => (id && isHuman(id) ? memberMap.get(id)!.label : null);

    // Per item: distinct HUMAN version authors (work order) + the LATEST human author (versions are
    // created_at ASC, so the last human author seen is the most recent).
    const versionMembersByItem = new Map<string, string[]>();
    const latestWorkerByItem = new Map<string, string>();
    for (const v of versions) {
      if (!isHuman(v.member_id)) continue;
      const list = versionMembersByItem.get(v.item_id) ?? [];
      if (!list.includes(v.member_id!)) list.push(v.member_id!);
      versionMembersByItem.set(v.item_id, list);
      latestWorkerByItem.set(v.item_id, v.member_id!); // overwrite → ends at the latest
    }

    const byItem = new Map<string, ItemCreditIds>();
    for (const it of items) {
      const currentMemberId = isHuman(it.member_id) ? it.member_id : null;
      const versionMemberIds = versionMembersByItem.get(it.id) ?? [];
      const locked = it.member_id_locked === true;
      const contributorIds = [...new Set(creditedContributorIds({ locked, currentMemberId, versionMemberIds }))];
      const primaryId = creditedPrimaryId({
        locked,
        currentMemberId,
        versionMemberIds,
        latestWorkerId: latestWorkerByItem.get(it.id) ?? null,
      });
      if (contributorIds.length || primaryId) byItem.set(it.id, { contributorIds, primaryId });
    }
    return { byItem, nameOf };
  };

  if (opts.strict) return run();
  try {
    return await run();
  } catch {
    return empty; // best-effort — empty result on failure
  }
}

/**
 * item id → `{contributorIds, primaryId}` (member IDs), for a batch of item ids. THE canonical oracle.
 * `strict` throws on any DB error (for the timeline's throw-on-error contract); default swallows to an
 * empty map. `items` may be prefetched to skip the items read.
 */
export async function resolveItemCreditIds(
  db: DbClient,
  teamId: string,
  itemIds: string[],
  opts: { strict?: boolean; items?: CreditItemRow[] } = {}
): Promise<Map<string, ItemCreditIds>> {
  return (await resolveCreditCore(db, teamId, itemIds, opts)).byItem;
}

/**
 * item id → `ItemCredit` (contributor DISPLAY NAMES + primary) — the name projection of the ID oracle,
 * for callers that render names (arcs, the admin drill-down). Best-effort (empty map on failure).
 */
export async function resolveItemCredit(
  db: DbClient,
  teamId: string,
  itemIds: string[]
): Promise<Map<string, ItemCredit>> {
  const { byItem, nameOf } = await resolveCreditCore(db, teamId, itemIds);
  const out = new Map<string, ItemCredit>();
  for (const [id, credit] of byItem) {
    const contributors = [...new Set(credit.contributorIds.map(nameOf).filter((n): n is string => !!n))];
    const primary = nameOf(credit.primaryId);
    if (contributors.length || primary) out.set(id, { contributors, primary });
  }
  return out;
}
