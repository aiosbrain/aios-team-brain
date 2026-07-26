import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * Clear the RETAINED bodies of an item's superseded versions, keeping the version rows.
 *
 * For a source whose item body is a re-render of live, source-owned content — Slack, today the only
 * one (`lib/ingest/source-rules`.`retainSupersededBodies`) — `item_versions` is where a deletion
 * leaks: a thread's body is the whole conversation, so deleting one message self-heals the CURRENT
 * body on the next sync while every superseded body still quotes it, verbatim, indefinitely. The
 * brain ends up holding a copy the source deliberately retracted.
 *
 * Two deliberate narrownesses:
 *  • **Only the content columns** (`body` + `frontmatter` — the latter because Slack's `title` is the
 *    root message's first 100 characters). `item_versions` is the WORK LEDGER — `member_id` + `created_at` are what
 *    attribute contributor credit, the timeline and narrative arcs. Deleting rows would silently
 *    rewrite who did what, which is exactly the harm the deletion feature is meant to avoid.
 *    Nothing reads `item_versions.body`; it is history, not a served surface.
 *  • **Only the superseded ones.** The row matching `keepSha` is the version just written — it holds
 *    the body that is currently live in `items`, so clearing it would forget content the source
 *    still has.
 *
 * Returns how many bodies were cleared.
 */
/** Does this retained frontmatter still hold anything? `{}` is the forgotten state. */
function hasContent(fm: Record<string, unknown> | null): boolean {
  return Boolean(fm) && Object.keys(fm ?? {}).length > 0;
}

export async function forgetSupersededBodies(
  db: DbClient,
  itemId: string,
  keepSha: string
): Promise<number> {
  const { data, error } = await db
    .from("item_versions")
    .select("id, body, frontmatter, content_sha256")
    .eq("item_id", itemId);
  if (error) throw new Error(`superseded-body read: ${error.message}`);
  const rows = (data ?? []) as {
    id: string;
    body: string;
    frontmatter: Record<string, unknown> | null;
    content_sha256: string;
  }[];
  const stale = rows.filter(
    (r) => r.content_sha256 !== keepSha && (r.body !== "" || hasContent(r.frontmatter))
  );
  for (const row of stale) {
    const { error: updateError } = await db
      .from("item_versions")
      // `frontmatter` goes too, not just `body`: Slack's `title` is the root message's first 100
      // characters, so a retracted message would otherwise survive — quoted, verbatim — in exactly
      // the rows this pass exists to clear. Nothing reads `item_versions.frontmatter` either.
      .update({ body: "", frontmatter: {} })
      .eq("id", row.id);
    if (updateError) throw new Error(`superseded-body forget ${row.id}: ${updateError.message}`);
  }
  return stale.length;
}
