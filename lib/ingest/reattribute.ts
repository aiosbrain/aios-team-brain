import "server-only";
import type { DbClient } from "@/lib/db/types";
import { buildIdentityMap, resolveByProviderId, resolveMember, type IdentityMap } from "@/lib/identity/resolve";
import { parseAuthorIdentity } from "@/lib/codebases/commits-to-items";

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

/** Resolve the author member for one item from its frontmatter, by source. Null when not resolvable. */
function resolveItemAuthor(idMap: IdentityMap, fm: Record<string, unknown>): string | null {
  const s = (k: string): string => (typeof fm[k] === "string" ? (fm[k] as string) : "");
  switch (s("source")) {
    case "slack":
      return resolveByProviderId(idMap, "slack", s("author_id"));
    case "linear":
      return resolveByProviderId(idMap, "linear", s("assignee_id"));
    case "plane":
      return resolveByProviderId(idMap, "plane", s("assignee_id"));
    case "git":
      return resolveMember(idMap, parseAuthorIdentity(s("author")));
    default:
      return null;
  }
}

export async function reattributeItems(
  db: DbClient,
  teamId: string
): Promise<ReattributeSummary> {
  const idMap = await buildIdentityMap(db, teamId);
  const { data: items } = await db
    .from("items")
    .select("id, member_id, frontmatter")
    .eq("team_id", teamId);
  const { data: connectors } = await db
    .from("members")
    .select("id")
    .eq("team_id", teamId)
    .eq("is_connector", true);
  const connectorIds = new Set((connectors ?? []).map((c) => (c as { id: string }).id));

  const rows = (items ?? []) as {
    id: string;
    member_id: string | null;
    frontmatter: Record<string, unknown> | null;
  }[];

  let updated = 0;
  for (const it of rows) {
    const resolved = resolveItemAuthor(idMap, it.frontmatter ?? {});
    if (resolved && resolved !== it.member_id) {
      const { error } = await db.from("items").update({ member_id: resolved }).eq("id", it.id);
      if (error) throw new Error(`reattribute item ${it.id}: ${error.message}`);
      updated++;
    } else if (!resolved && it.member_id && connectorIds.has(it.member_id)) {
      // Never "good attribution" — a pre-fix row still standing on a connector member with no
      // real author resolvable. Clear it, same conservative bar (only touches a strictly-worse
      // value), never applied to a previously-resolved human's attribution.
      const { error } = await db.from("items").update({ member_id: null }).eq("id", it.id);
      if (error) throw new Error(`reattribute item ${it.id}: ${error.message}`);
      updated++;
    }
  }
  return { scanned: rows.length, updated };
}
