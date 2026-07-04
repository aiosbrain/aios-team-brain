import "server-only";
import type { DbClient } from "@/lib/db/types";
import { buildIdentityMap, resolveByProviderId, resolveMember, type IdentityMap } from "@/lib/identity/resolve";
import { parseAuthorIdentity } from "@/lib/codebases/commits-to-items";

/**
 * Re-attribute existing items to the CURRENT identity mappings. `ingestItem` only stamps
 * `items.member_id` on create/change, so when an admin adds or corrects an identity mapping (or an
 * email alias) AFTER content was ingested, those already-stored unchanged rows keep their old
 * attribution (often the connector member). This pass re-resolves each item's author from its
 * frontmatter against the freshly-built identity map and re-points `member_id`.
 *
 * Lives in lib/ingest because it writes `items` (the single-writer guard). Conservative: it only
 * RE-POINTS to a positively-resolved member that differs from the current one — it never
 * un-attributes (a row that no longer resolves is left as-is), so it can't erase good attribution.
 * Idempotent: a second run with no mapping changes updates nothing.
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
  supabase: DbClient,
  teamId: string
): Promise<ReattributeSummary> {
  const idMap = await buildIdentityMap(supabase, teamId);
  const { data: items } = await supabase
    .from("items")
    .select("id, member_id, frontmatter")
    .eq("team_id", teamId);

  const rows = (items ?? []) as {
    id: string;
    member_id: string | null;
    frontmatter: Record<string, unknown> | null;
  }[];

  let updated = 0;
  for (const it of rows) {
    const resolved = resolveItemAuthor(idMap, it.frontmatter ?? {});
    if (resolved && resolved !== it.member_id) {
      const { error } = await supabase.from("items").update({ member_id: resolved }).eq("id", it.id);
      if (error) throw new Error(`reattribute item ${it.id}: ${error.message}`);
      updated++;
    }
  }
  return { scanned: rows.length, updated };
}
