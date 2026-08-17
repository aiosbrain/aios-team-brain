import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * READ-ONLY coverage query over the §11 context substrate: which of a team's items have no
 * membership, i.e. exactly the rows an `enforcing` read would serve to nobody.
 *
 * It lives in its own module rather than inside its caller for a structural reason: the
 * access-chain single-writer guard flags any file that so much as NAMES `project_context_units` /
 * `project_context_memberships` while containing a write verb (the variable-table-name net). A
 * module that only reads them can never be that file, so the coverage question stays expressible
 * without adding an exemption that would also blunt the net for real writes.
 *
 * Kept deliberately separate from `backfillAllTeams`'s cheap count heuristic (`memberships >=
 * items`), which is a scheduler-tick optimization: counts can agree while a specific item is
 * uncovered (one item in two projects masks another in none). A caller about to change what a
 * whole team can see needs the per-item answer, not the aggregate.
 */

const SCAN_BATCH = 500;
const MAX_SCAN_BATCHES = 10_000;

export interface CoverageResult {
  scanned: number;
  /** Items no principal could reach: no ACTIVE item-grain unit carrying a CURRENT
   *  include-membership into a project that at least one group is GRANTED. */
  count: number;
  /** Up to `EXAMPLE_LIMIT` paths, so an operator sees WHAT would vanish, not only how much. */
  examples: string[];
  /** True when the scan hit its batch guard — the count is a floor, not the total. */
  truncated: boolean;
}

const EXAMPLE_LIMIT = 5;

export async function findUnpartitionedItems(db: DbClient, teamId: string): Promise<CoverageResult> {
  let after: string | null = null;
  let scanned = 0;
  let count = 0;
  const examples: string[] = [];

  for (let batch = 0; batch < MAX_SCAN_BATCHES; batch++) {
    let q = db.from("items").select("id, path").eq("team_id", teamId).order("id", { ascending: true }).limit(SCAN_BATCH);
    if (after) q = q.gt("id", after);
    const { data, error } = await q;
    if (error) throw new Error(`items read failed: ${error.message}`);
    const items = (data ?? []) as { id: string; path: string }[];
    if (items.length === 0) return { scanned, count, examples, truncated: false };

    const covered = await coveredItemIds(
      db,
      teamId,
      items.map((i) => i.id)
    );
    for (const item of items) {
      scanned++;
      if (!covered.has(item.id)) {
        count++;
        if (examples.length < EXAMPLE_LIMIT) examples.push(item.path);
      }
    }
    after = items[items.length - 1].id;
    if (items.length < SCAN_BATCH) return { scanned, count, examples, truncated: false };
  }
  // A corpus bigger than the guard must NOT read as fully scanned — the caller decides what to do
  // with a floor, but it has to know it has one.
  return { scanned, count, examples, truncated: true };
}

/** The subset of `itemIds` that an enforcing read could serve to SOMEONE. */
async function coveredItemIds(db: DbClient, teamId: string, itemIds: string[]): Promise<Set<string>> {
  const { data: unitRows, error: uErr } = await db
    .from("project_context_units")
    .select("id, source_item_id")
    .eq("team_id", teamId)
    .eq("state", "active")
    .eq("unit_kind", "item")
    .in("source_item_id", itemIds);
  if (uErr) throw new Error(`context-unit read failed: ${uErr.message}`);
  const itemByUnit = new Map(
    ((unitRows ?? []) as { id: string; source_item_id: string | null }[])
      .filter((u) => u.source_item_id)
      .map((u) => [u.id, u.source_item_id!])
  );
  const covered = new Set<string>();
  if (itemByUnit.size === 0) return covered;

  const { data: memRows, error: memErr } = await db
    .from("project_context_memberships")
    .select("context_unit_id, project_id")
    .eq("team_id", teamId)
    .eq("decision", "include")
    .is("valid_to", null)
    .in("context_unit_id", [...itemByUnit.keys()]);
  if (memErr) throw new Error(`membership read failed: ${memErr.message}`);
  const granted = await grantedProjectIds(db, teamId);
  for (const r of (memRows ?? []) as { context_unit_id: string; project_id: string }[]) {
    // A membership into a project NO GROUP is granted reaches nobody: the oracle derives its
    // project set from grants, so such an item is as invisible under enforcing as an
    // unpartitioned one. The sanctioned writers only ever route into the two just-granted system
    // projects, so this cannot happen through them — but a brain repaired by hand in SQL is
    // exactly this command's audience, and "has a membership" was the wrong question to ask it.
    if (!granted.has(r.project_id)) continue;
    const itemId = itemByUnit.get(r.context_unit_id);
    if (itemId) covered.add(itemId);
  }
  return covered;
}

/** Projects reachable by SOME group. Read-only; the grant table is written only by
 *  `lib/access/groups.ts` (single writer) and this module never writes anything. */
async function grantedProjectIds(db: DbClient, teamId: string): Promise<Set<string>> {
  const { data, error } = await db.from("project_groups").select("project_id").eq("team_id", teamId);
  if (error) throw new Error(`grant read failed: ${error.message}`);
  return new Set(((data ?? []) as { project_id: string }[]).map((r) => r.project_id));
}
