import "server-only";
import type { DbClient } from "@/lib/db/types";
import { buildIdentityMap } from "@/lib/identity/resolve";
import { resolveItemAuthorMember } from "@/lib/attribution/resolve-authors";

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
}

export async function reattributeItems(
  db: DbClient,
  teamId: string
): Promise<ReattributeSummary> {
  const idMap = await buildIdentityMap(db, teamId);
  // EXCLUDE external-tier rows. Frontmatter is free-form on the wire, so an external (client) key can
  // push an item whose frontmatter names a team member; the ingest route already refuses to resolve
  // author for external keys (keeps actor attribution), and this batch must not become the way back in
  // — re-resolving that frontmatter here would attribute the client's content to the named team member.
  const { data: items } = await db
    .from("items")
    .select("id, member_id, member_id_locked, frontmatter")
    .eq("team_id", teamId)
    .neq("access", "external");
  const { data: connectors } = await db
    .from("members")
    .select("id")
    .eq("team_id", teamId)
    .eq("is_connector", true);
  const connectorIds = new Set((connectors ?? []).map((c) => (c as { id: string }).id));

  const rows = (items ?? []) as {
    id: string;
    member_id: string | null;
    member_id_locked: boolean | null;
    frontmatter: Record<string, unknown> | null;
  }[];

  let updated = 0;
  for (const it of rows) {
    // A LOCKED item's member_id was set by a deliberate admin correction — never auto-revert it. The
    // snapshot check skips already-locked rows; the `.eq("member_id_locked", false)` on the writes below
    // closes the TOCTOU window — a correction applied MID-SCAN (after this snapshot, before the update)
    // is protected by the DB re-checking the flag at write time, so the scan can't clobber it.
    if (it.member_id_locked) continue;
    const resolved = resolveItemAuthorMember(idMap, it.frontmatter ?? {}, connectorIds);
    if (resolved && resolved !== it.member_id) {
      const { error } = await db.from("items").update({ member_id: resolved }).eq("id", it.id).eq("member_id_locked", false);
      if (error) throw new Error(`reattribute item ${it.id}: ${error.message}`);
      updated++;
    } else if (!resolved && it.member_id && connectorIds.has(it.member_id)) {
      // Never "good attribution" — a pre-fix row still standing on a connector member with no
      // real author resolvable. Clear it, same conservative bar (only touches a strictly-worse
      // value), never applied to a previously-resolved human's attribution.
      const { error } = await db.from("items").update({ member_id: null }).eq("id", it.id).eq("member_id_locked", false);
      if (error) throw new Error(`reattribute item ${it.id}: ${error.message}`);
      updated++;
    }
  }
  return { scanned: rows.length, updated };
}
