import "server-only";
import type { DbClient } from "@/lib/db/types";
import { runSql } from "@/lib/db/pg/pool";
import { buildIdentityMap, type IdentityMap } from "@/lib/identity/resolve";
import { resolveItemAuthorMember } from "@/lib/attribution/resolve-authors";
import { transactionCapability } from "@/lib/projects/context/transaction";
import { bumpSlackIdentityGenerationIfCurrent, readSlackTeamGenerations,
  SlackIdentityChangedDuringReattribution } from "@/lib/ingest/slack-message-ledger";

/**
 * Re-attribute existing items to the CURRENT identity mappings. `ingestItem` only stamps
 * `items.member_id` on create/change, so when an admin adds or corrects an identity mapping (or an
 * email alias) AFTER content was ingested, those already-stored unchanged rows keep their old
 * attribution. This pass re-resolves each item's author from its frontmatter against the freshly-
 * built identity map and re-points `member_id`.
 *
 * Lives in lib/ingest because it writes `items` (the single-writer guard). Conservative: it only
 * RE-POINTS to a positively-resolved member that differs from the current one — it never erases a
 * previously-resolved HUMAN's attribution (a row that no longer resolves and isn't on a connector
 * is left as-is). The one exception: a row still attributed to a connector service-account
 * (`is_connector = true` — a pre-fix leftover from before ingestion correctly left unresolved
 * authors unattributed) that STILL doesn't resolve is cleared to `null` rather than left on the
 * connector, since that was never "good attribution" to begin with. Idempotent: a second run with
 * no mapping changes updates nothing.
 */

export interface ReattributeSummary {
  scanned: number;
  updated: number;
  /** item_versions rows re-pointed too (the work ledger — see `reattributeVersions`). */
  versionsUpdated: number;
}

function isSlackItem(path: string, source: unknown): boolean {
  return path.startsWith("slack/") ||
    (typeof source === "string" && source.trim().toLowerCase() === "slack");
}

export async function reattributeItems(
  db: DbClient,
  teamId: string
): Promise<ReattributeSummary> {
  const progress = { updated: 0, versionsUpdated: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await reattributeOnce(db, teamId, progress);
    } catch (error) {
      if (!(error instanceof SlackIdentityChangedDuringReattribution) || attempt === 1) throw error;
      // The first scan may have committed some rows, each with its own revision. A fresh map and
      // scan converge those rows too; a second concurrent remap fails visibly instead of looping.
    }
  }
  throw new Error("reattribution retry exhausted");
}

async function reattributeOnce(
  db: DbClient, teamId: string, progress: { updated: number; versionsUpdated: number }
): Promise<ReattributeSummary> {
  const generation = () => transactionCapability(db).transaction(async (session) =>
    (await readSlackTeamGenerations(session, teamId)).identityGeneration);
  let expectedGeneration = await generation();
  const idMap = await buildIdentityMap(db, teamId, { strict: true });
  if (await generation() !== expectedGeneration) throw new SlackIdentityChangedDuringReattribution();
  // EXCLUDE external-tier rows. Frontmatter is free-form on the wire, so an external (client) key can
  // push an item whose frontmatter names a team member; the ingest route already refuses to resolve
  // author for external keys (keeps actor attribution), and this batch must not become the way back in
  // — re-resolving that frontmatter here would attribute the client's content to the named team member.
  const { data: items, error: itemsError } = await db
    .from("items")
    .select("id, path, member_id, member_id_locked, frontmatter")
    .eq("team_id", teamId)
    .neq("access", "external");
  if (itemsError) throw new Error(`reattribute items read: ${itemsError.message}`);
  const { data: connectors, error: connectorsError } = await db
    .from("members")
    .select("id")
    .eq("team_id", teamId)
    .eq("is_connector", true);
  if (connectorsError) throw new Error(`reattribute connectors read: ${connectorsError.message}`);
  const connectorIds = new Set((connectors ?? []).map((c) => (c as { id: string }).id));

  const rows = (items ?? []) as {
    id: string;
    path: string;
    member_id: string | null;
    member_id_locked: boolean | null;
    frontmatter: Record<string, unknown> | null;
  }[];

  for (const it of rows) {
    // A LOCKED item's member_id was set by a deliberate admin correction — never auto-revert it. The
    // snapshot check skips already-locked rows; the `.eq("member_id_locked", false)` on the writes below
    // closes the TOCTOU window — a correction applied MID-SCAN (after this snapshot, before the update)
    // is protected by the DB re-checking the flag at write time, so the scan can't clobber it.
    if (it.member_id_locked) continue;
    const resolved = resolveItemAuthorMember(idMap, it.frontmatter ?? {}, connectorIds);
    const isSlack = isSlackItem(it.path, it.frontmatter?.source);
    if (resolved && resolved !== it.member_id) {
      if (isSlack) {
        const write = await writeSlackAttribution(db, teamId, expectedGeneration,
          `update items set member_id = $3 where id = $1 and team_id = $2
             and member_id_locked = false and member_id is distinct from $3 returning id`,
          [it.id, teamId, resolved]);
        expectedGeneration = write.generation;
        progress.updated += Number(write.changed);
      } else {
        const { error } = await db.from("items").update({ member_id: resolved }).eq("id", it.id).eq("member_id_locked", false);
        if (error) throw new Error(`reattribute item ${it.id}: ${error.message}`);
        progress.updated++;
      }
    } else if (!resolved && it.member_id && connectorIds.has(it.member_id)) {
      // Never "good attribution" — a pre-fix row still standing on a connector member with no
      // real author resolvable. Clear it, same conservative bar (only touches a strictly-worse
      // value), never applied to a previously-resolved human's attribution.
      if (isSlack) {
        const write = await writeSlackAttribution(db, teamId, expectedGeneration,
          `update items set member_id = null where id = $1 and team_id = $2
             and member_id_locked = false and member_id = $3 returning id`,
          [it.id, teamId, it.member_id]);
        expectedGeneration = write.generation;
        progress.updated += Number(write.changed);
      } else {
        const { error } = await db.from("items").update({ member_id: null }).eq("id", it.id).eq("member_id_locked", false);
        if (error) throw new Error(`reattribute item ${it.id}: ${error.message}`);
        progress.updated++;
      }
    }
  }
  expectedGeneration = await reattributeVersions(db, teamId, idMap, connectorIds, expectedGeneration, progress);
  if (await generation() !== expectedGeneration) throw new SlackIdentityChangedDuringReattribution();
  return { scanned: rows.length, ...progress };
}

async function writeSlackAttribution(
  db: DbClient, teamId: string, expectedGeneration: string, sql: string, params: unknown[]
): Promise<{ changed: boolean; generation: string }> {
  return transactionCapability(db).transaction(async (session) => {
    const result = await session.executeSql(sql, params);
    if (result.rowCount === 0) return { changed: false, generation: expectedGeneration };
    const generation = await bumpSlackIdentityGenerationIfCurrent(session, teamId, expectedGeneration);
    return { changed: true, generation };
  });
}

/**
 * Heal the WORK LEDGER (`item_versions.member_id`) alongside the item. A version's author is stamped at
 * push time, so a version whose author signal was PRESENT but UNMAPPED then (a mapping added later) keeps a
 * stale author — which skews evidence-gated arc credit (`lib/attribution/contributor-credit`, #342/#343).
 * We re-resolve each version from its OWN stored frontmatter (same resolver, same conservative bar), so:
 *   • a version whose frontmatter genuinely names a person resolves to the SAME member → untouched — a real
 *     HANDOFF's per-version history is preserved (we never blind-copy the item's current owner onto versions);
 *   • a version whose author became resolvable only after a mapping change → re-pointed to the real author;
 *   • a version still standing on a CONNECTOR with no resolvable author → cleared to null (never good credit).
 * Scoped to the SAME rows as the item pass (non-external, non-locked — a locked item's credit is the lock's
 * job) via the join. Idempotent. Best-effort per row via the shared conservative rule.
 */
async function reattributeVersions(
  db: DbClient,
  teamId: string,
  idMap: IdentityMap,
  connectorIds: ReadonlySet<string>,
  initialGeneration: string,
  progress: { versionsUpdated: number }
): Promise<string> {
  // The item↔version join isn't expressible in the compat builder, so the READ (a SELECT) goes straight to
  // the pool via `runSql` — Postgres-only path, one `DATABASE_URL`. Slack writes re-check the parent
  // lock and advance the identity revision in their own transaction. Other providers retain the
  // existing single-table builder update by version id.
  const { rows } = await runSql<{ id: string; member_id: string | null; frontmatter: Record<string, unknown> | null;
    path: string; source: string | null }>(
    `select v.id, v.member_id, v.frontmatter, i.path, i.frontmatter->>'source' as source
       from item_versions v
       join items i on i.id = v.item_id
      where i.team_id = $1 and i.access::text <> 'external' and i.member_id_locked = false`,
    [teamId]
  );
  let generation = initialGeneration;
  for (const v of rows) {
    const resolved = resolveItemAuthorMember(idMap, v.frontmatter ?? {}, connectorIds);
    let next: string | null | undefined;
    if (resolved && resolved !== v.member_id) next = resolved; // re-point to the positively-resolved author
    else if (!resolved && v.member_id && connectorIds.has(v.member_id)) next = null; // clear a connector-standing row
    if (next === undefined) continue;
    if (isSlackItem(v.path, v.source)) {
      const write = await writeSlackAttribution(db, teamId, generation,
        `update item_versions v set member_id = $3 from items i
          where v.id = $1 and v.item_id = i.id and i.team_id = $2
            and i.access::text <> 'external' and i.member_id_locked = false
            and v.member_id is distinct from $3 returning v.id`,
        [v.id, teamId, next]);
      generation = write.generation;
      progress.versionsUpdated += Number(write.changed);
    } else {
      const { error } = await db.from("item_versions").update({ member_id: next }).eq("id", v.id);
      if (error) throw new Error(`reattribute version ${v.id}: ${error.message}`);
      progress.versionsUpdated++;
    }
  }
  return generation;
}
