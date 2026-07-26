import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import type { GraphitiClient } from "@/lib/graph/graphiti-client";
import { retireEpisodesForItems } from "@/lib/graph/project";

/**
 * REMOVAL of already-ingested content — the counterpart to `ingestItem`, and part of the same
 * single-writer contract (`items` is written only from `lib/ingest`).
 *
 * The brain has had no removal path at all: sync only ever adds or replaces, so content that should
 * no longer exist — a private channel that was configured by mistake, a message deleted at the
 * source — stayed in the store, in retrieval, in credit, and in the graph indefinitely. "Keep
 * everything forever" is a reasonable default for a knowledge base right up until the content is
 * something the source deliberately took back.
 *
 * Removal is a FAN-OUT, not a `delete from items`, because an item's derivatives live in four places
 * with three different lifetimes:
 *   • `item_versions` / `item_chunks` / `extracted_facts` / `stakeholder_mentions` / `task_evidence` /
 *     `meeting_notes` — FK ON DELETE CASCADE, so the stored body and its whole history go with the row.
 *     (`item_versions` is what makes this matter: it retains every superseded body, so a message the
 *     author deleted survives the re-render that dropped it from the current body.)
 *   • `graph_episodes` — NO FK, and the facts themselves live in Graphiti, not Postgres. Retired
 *     explicitly via `lib/graph` (see `retireEpisodesForItems`), which also owns the durable retry.
 *   • `tasks.source_item_id` / `decisions.source_item_id` — ON DELETE SET NULL. Deliberately kept:
 *     those rows are independently authored records that merely cite the item, and a UI-authored task
 *     must not vanish because its evidence was purged.
 */

export interface PurgeResult {
  items: number;
  /** Ledger rows retired — the graph cleanup is then finished durably by `reconcileProjectedEpisodes`. */
  episodes: number;
}

export interface PurgeOptions {
  /** Injectable for tests; defaults to the configured Graphiti (or a no-op when it isn't configured). */
  client?: GraphitiClient;
  actor?: { memberId?: string | null; apiKeyId?: string | null };
}

/**
 * Neutralize LIKE wildcards in a literal prefix. `path` segments legitimately contain `_`
 * (`safeSegment` keeps it), and in LIKE `_` matches ANY single character — so an unescaped
 * `github/my_repo/` would also match `github/myXrepo/` and delete a different source's items. A
 * removal primitive that can delete MORE than it was asked to is the one bug class here with no
 * recovery, so the escaping is unconditional rather than left to each caller. Postgres' default
 * LIKE escape character is `\`, which is why it needs escaping first.
 */
export function escapeLike(literal: string): string {
  return literal.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Purge every item under a path PREFIX for one team (e.g. `slack/c0b8v119g4d/` — one channel).
 * The prefix is matched with `like`, so it must end in `/`: `slack/c0b8v` would otherwise take out
 * every channel whose id merely starts the same way. Callers should build the prefix with the same
 * helper that writes the path (`slackChannelPathPrefix`) rather than formatting it by hand.
 */
export async function purgeItemsByPathPrefix(
  db: DbClient,
  teamId: string,
  pathPrefix: string,
  reason: string,
  opts: PurgeOptions = {}
): Promise<PurgeResult> {
  if (!pathPrefix.endsWith("/")) {
    throw new Error(`purgeItemsByPathPrefix: prefix must end in "/" (got "${pathPrefix}")`);
  }
  const { data: rows, error: readError } = await db
    .from("items")
    .select("id")
    .eq("team_id", teamId)
    .like("path", `${escapeLike(pathPrefix)}%`);
  if (readError) throw new Error(`purge read: ${readError.message}`);
  const ids = ((rows ?? []) as { id: string }[]).map((r) => r.id);
  return purgeItemIds(db, teamId, ids, reason, { ...opts, scope: pathPrefix });
}

/**
 * Purge an explicit set of item ids. The shared core: prefix-purge and (next) source-diff deletion
 * both land here so there is ONE removal implementation to keep correct.
 */
export async function purgeItemIds(
  db: DbClient,
  teamId: string,
  itemIds: string[],
  reason: string,
  opts: PurgeOptions & { scope?: string } = {}
): Promise<PurgeResult> {
  if (itemIds.length === 0) return { items: 0, episodes: 0 };

  // Graph FIRST. Deleting the items first would strand the ledger rows AND leave the extracted facts
  // answering questions in Graphiti with nothing left pointing at them — the graph is the one
  // derivative Postgres can't clean up for us. If this throws, nothing has been deleted yet: the
  // purge fails loudly and is retried, rather than half-removing content.
  const episodes = await retireEpisodesForItems(db, teamId, itemIds, { client: opts.client });

  for (const id of itemIds) {
    const { error } = await db.from("items").delete().eq("id", id); // versions + chunks + facts cascade
    if (error) throw new Error(`purge item ${id}: ${error.message}`);
  }

  // Removal is destructive and irreversible — it is exactly the thing an operator will later need to
  // explain, so it is always audited with its reason and scope.
  await audit(db, {
    team_id: teamId,
    actor_kind: opts.actor?.memberId ? "member" : "system",
    member_id: opts.actor?.memberId ?? null,
    api_key_id: opts.actor?.apiKeyId ?? null,
    action: "items.purged",
    target_type: opts.scope ? "path_prefix" : "item_ids",
    target_id: opts.scope ?? `${itemIds.length} item(s)`,
    meta: { reason, items: itemIds.length, episodes },
  });

  return { items: itemIds.length, episodes };
}
