import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import type { GraphitiClient } from "@/lib/graph/graphiti-client";
import { retireEpisodesForItems, chunk, IN_CLAUSE_BATCH } from "@/lib/graph/project";

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

/** How many paths an audit row records inline. A record, not a backup — the count stays authoritative. */
const AUDIT_PATH_SAMPLE = 200;

/**
 * The paths of the items about to be purged, for the audit record. Best-effort by design: failing to
 * READ the paths must never block the removal itself (the content still has to go), so a read error
 * degrades to an empty list rather than throwing. Sorted so two audits of the same purge compare.
 */
async function purgedPaths(
  db: DbClient,
  teamId: string,
  itemIds: string[]
): Promise<{ paths: string[]; readFailed: boolean }> {
  const out: string[] = [];
  let readFailed = false;
  for (const batch of chunk(itemIds, IN_CLAUSE_BATCH)) {
    const { data, error } = await db
      .from("items")
      .select("path")
      .eq("team_id", teamId)
      .in("id", batch);
    // Keep what we DID read — discarding earlier batches because a later one failed would throw away
    // the only record of those paths for no gain.
    if (error) {
      readFailed = true;
      continue;
    }
    for (const r of (data ?? []) as { path: string }[]) out.push(r.path);
  }
  return { paths: out.sort(), readFailed };
}

/**
 * The audit meta for a purge. Pure, and separated for that reason: the truncation branch is otherwise
 * only reachable by seeding 201 rows in the real-DB tier, so an off-by-one (or an accidental
 * `paths_truncated: 0`) would ship green.
 *
 * `paths` is capped — an audit row is a record, not a backup, and a whole-channel purge would
 * otherwise write thousands of strings into one jsonb column. The count stays authoritative. Note the
 * recorded slice is the lexicographic HEAD, not a sample: deterministic, and for Slack that means the
 * oldest thread timestamps.
 */
export function buildPurgeMeta(args: {
  reason: string;
  items: number;
  episodes: number;
  paths: string[];
  readFailed: boolean;
}): Record<string, unknown> {
  const extra = args.paths.length - AUDIT_PATH_SAMPLE;
  return {
    reason: args.reason,
    items: args.items,
    episodes: args.episodes,
    paths: args.paths.slice(0, AUDIT_PATH_SAMPLE),
    ...(extra > 0 ? { paths_truncated: extra } : {}),
    // MARKED, not silent. `paths: []` with no marker is indistinguishable from a build that never
    // recorded paths — which would recreate, on any transient read error, the exact prod blind spot
    // this field exists to close. "We deleted nothing" and "we couldn't record what we deleted" must
    // not look identical.
    ...(args.readFailed ? { paths_read_failed: true } : {}),
  };
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

  // WHAT we are about to delete, read BEFORE deleting it — the rows are the only record of their own
  // paths, so after the cascade the question "what did this purge remove?" has no answer anywhere.
  // A count and a prefix are enough to notice a purge happened and not enough to explain it, which is
  // the wrong trade for the one operation in the ingest path that cannot be undone. (Found by watching
  // the first live purge in prod: 13 items → 12, and nothing on the box could say which one went.)
  const { paths, readFailed } = await purgedPaths(db, teamId, itemIds);

  // Graph FIRST. Deleting the items first would strand the ledger rows AND leave the extracted facts
  // answering questions in Graphiti with nothing left pointing at them — the graph is the one
  // derivative Postgres can't clean up for us. If this throws, nothing has been deleted yet: the
  // purge fails loudly and is retried, rather than half-removing content.
  const episodes = await retireEpisodesForItems(db, teamId, itemIds, { client: opts.client });

  for (const id of itemIds) {
    // Team-scoped like the audit read above, deliberately: without it the delete's scope and the
    // AUDIT's scope could diverge — a caller passing another team's id would have the row removed but
    // its path filtered out of the record, so the primitive would delete more than it documents.
    const { error } = await db.from("items").delete().eq("id", id).eq("team_id", teamId); // versions + chunks + facts cascade
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
    meta: buildPurgeMeta({ reason, items: itemIds.length, episodes, paths, readFailed }),
  });

  // DERIVED CACHES. Removing the rows is not the whole removal: `work_timeline_cache` and the arc
  // snapshots are precomputed FROM them, so until their next scheduled recompute both still quote
  // content the brain no longer has — for a private channel purged by mistake, exactly the window the
  // purge exists to close. Busting them makes the next read rebuild from what survives.
  //
  // Routed through the shared `bustTeamLearningCaches` choke-point rather than staling the two tables
  // here, so a cache added there later is busted by the purge too instead of quietly outliving it.
  //
  // Best-effort and LOUD: the content is already gone, so a bust failure must not fail (or retry) the
  // purge — but it must not be silent either, because the visible symptom is purged content still on
  // screen, and the caches self-heal only on their own TTL.
  try {
    const { data: team } = await db.from("teams").select("slug").eq("id", teamId).maybeSingle();
    const { bustTeamLearningCaches } = await import("@/lib/ingest/reconcile-attribution");
    await bustTeamLearningCaches(db, teamId, (team as { slug: string } | null)?.slug ?? "");
  } catch (err) {
    console.error(
      `[purge] derived-cache bust failed for team ${teamId} — timeline/arcs may quote purged content ` +
        `until their TTL: ${err instanceof Error ? err.message : err}`
    );
  }

  return { items: itemIds.length, episodes };
}
