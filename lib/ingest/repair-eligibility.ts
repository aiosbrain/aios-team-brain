import "server-only";

import { runSql } from "@/lib/db/pg/pool";

/**
 * ATTRIBUTION REPAIR PROVENANCE — the rules both repair drains apply to a nominated item, in SQL
 * over the `items` row aliased `i`. Each rule is applied twice: by the bounded candidate selection,
 * and again by a statement of its own once the item's attribution advisory and its row are held.
 *
 * The trust root for "this row is a Google Drive document" is the PERSISTED same-team provider
 * mapping, and nothing else. Not its frontmatter, authors or contributions (a pusher writes those),
 * not a connection id on the payload or on the mapping (the mapping's is NULL by design), not an
 * active claim, a live lease or an enabled integration: the mapping is written only by the ingest
 * owner for a provider identity it resolved, and it outlives disconnect and a paired staging restore.
 * A mapping in another team, or from another source, names nothing here.
 *
 * THROUGH COMMIT. The recheck takes no provider or mapping lock — either would come after the item
 * row, the inverse of provider → path → attribution → item. It does not need one. `access` and
 * `frontmatter` are read from the locked row. And a mapping, once it names an item, keeps naming it:
 * `lib/ingest/index.ts` is the only writer, it only ever inserts a row for a provider identity
 * (do-nothing on conflict) and afterwards updates that row's project/path by item id; no application
 * path deletes a mapping or changes its `item_id`, `source` or `team_id`, and the row survives its
 * item's purge as a tombstone (`test/guards/source-item-mapping-stability.test.ts` holds that line).
 * So a read that is true under the item lock stays true until that transaction ends.
 */
export const DRIVE_MAPPING = `exists (
  select 1 from source_item_mappings m
   where m.team_id = i.team_id and m.item_id = i.id and m.source = 'gdrive')`;

/**
 * COMMON REPAIR ELIGIBILITY. A team-tier row is repairable. An `external` row is not — it is a
 * client's content, and its stored credit is never rewritten from roster state — with ONE exception:
 * a Google Drive document. Drive documents are stored `external` by construction (the unit tier is
 * the conservative one; claim memberships are the authority), so the tier alone would exclude every
 * one of them.
 *
 * The only transition is an unmapped row gaining a mapping when the ingest owner adopts it. A Drive
 * commit does that under the item's attribution advisory, so it queues behind the repair or is seen
 * by it. A row adopted after the cursor has passed it is not revisited at that revision: it was not
 * a Drive document when the repair looked, and the adopting ingest attributes the current row itself.
 */
export const COMMON_REPAIR_ELIGIBLE = `(i.access::text <> 'external' or ${DRIVE_MAPPING})`;

/**
 * DRIVE OBLIGATION PROVENANCE. A Google identity obligation rewrites retained Drive credit, so it
 * may only touch a row that IS a Drive document now: the persisted same-team mapping (the trust
 * root) AND the row's current Drive source evidence (what makes the Drive resolver applicable to
 * it). Either alone is not enough — source evidence without a mapping is exactly what a pusher can
 * forge, and a mapped row whose current content is no longer Drive-sourced has no Drive credit for
 * this obligation to decide.
 *
 * The rule is TWO-VALUED. A row whose `source` is absent, or JSON null, is simply not Drive-sourced
 * now: that is a definite `false` — an ineligible row the drain scans past — and must not surface
 * as SQL NULL, which the reader below reserves for "the read did not answer" and treats as a
 * failure. Hence the coalesce: only a read that actually failed, or answered nothing, fails closed.
 */
export const DRIVE_OBLIGATION_PROVENANCE = `(coalesce(i.frontmatter->>'source', '') = 'gdrive' and ${DRIVE_MAPPING})`;

/**
 * One fail-closed predicate read over an item the caller has ALREADY locked. Issued as a statement
 * of its own so it sees the locked row and whatever mapping is committed now, not what a statement
 * that had to wait for the lock saw when it started. Anything but exactly one boolean answer throws:
 * the caller's transaction rolls back and its cursor does not move.
 */
async function readLockedItemRule(
  rule: string,
  column: string,
  subject: string,
  teamId: string,
  itemId: string,
): Promise<boolean> {
  const { rows } = await runSql<Record<string, boolean | null>>(
    `select ${rule} as ${column} from items i where i.team_id=$1 and i.id=$2`,
    [teamId, itemId],
  );
  const answer = rows[0]?.[column];
  if (rows.length !== 1 || typeof answer !== "boolean") {
    throw new Error(`${subject} could not be read for a locked item`);
  }
  return answer;
}

/** The common rule for one locked item. */
export function readCommonRepairEligibility(teamId: string, itemId: string): Promise<boolean> {
  return readLockedItemRule(COMMON_REPAIR_ELIGIBLE, "eligible", "repair eligibility", teamId, itemId);
}

/** The Drive obligation rule for one locked item. */
export function readDriveObligationProvenance(teamId: string, itemId: string): Promise<boolean> {
  return readLockedItemRule(
    DRIVE_OBLIGATION_PROVENANCE, "drive_provenance", "Drive repair provenance", teamId, itemId,
  );
}
