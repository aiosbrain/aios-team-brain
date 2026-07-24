import "server-only";
import { createHash } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import { GraphitiClient, type GraphEpisode } from "./graphiti-client";
import { episodeGroupId, type AccessTier } from "./group";
import { episodeName, itemIdFromEpisodeName } from "./episode-name";

/**
 * Brain → Graphiti projector. Reads already-normalized, tier-tagged rows from the brain (`items` —
 * ALL ingestions: Slack transcripts, GitHub/Notion/Drive deliverables, decisions, tasks, …) and
 * pushes them to Graphiti as episodes. The SOLE writer of `graph_episodes` (the idempotency-state
 * table) — single-writer guarded.
 *
 * Idempotent: re-projecting an unchanged row is a no-op (matched by content hash); changed content
 * re-pushes (Graphiti's temporal model supersedes the old fact). Source of truth stays the brain;
 * Graphiti is a downstream projection.
 */

const SOURCE_TABLE = "items";

/**
 * Graphiti extracts entities/edges from each episode with its OWN LLM, and that call's OUTPUT is
 * hard-capped (graphiti_core `DEFAULT_MAX_TOKENS`; 16384 on the patched image — gpt-4o's ceiling, can't
 * go higher). A dense episode whose extraction output overflows that cap raises `Output length exceeded
 * max tokens` in `resolve_extracted_nodes`, so it's accepted (202) but never becomes facts — the item's
 * work then never appears in the graph or narrative arcs (prod 2026-06/07). Truncating to fit LOSES
 * content, so instead we CHUNK: a large item is projected as several small episodes (`items:<id>#0`,
 * `#1`, …), each ≤ `CHUNK_CHARS`, preserving all content while keeping every episode extractable.
 * `MAX_EPISODE_CHUNKS` caps a pathologically huge item (full text still lives in `items`/pgvector/FTS
 * regardless; median item ~240 chars = a single chunk, unchanged from before). Both env-tunable. See
 * the "202 ≠ extracted" note in docs/ARCHITECTURE.md.
 */
/**
 * Parse a positive-integer env knob, falling back to `fallback` on anything malformed. A bad
 * `GRAPH_CHUNK_CHARS`/`GRAPH_MAX_EPISODE_CHUNKS` must NOT silently break projection: `Number("")` is 0
 * and `Number("abc")` is NaN. A 0/NaN chunk SIZE makes `chunkContent` emit empty-content episodes; a
 * 0/NaN chunk CAP makes it emit none — either way the projector "succeeds" feeding the graph nothing
 * (or garbage). `Math.floor` also closes the fractional hole (0.5 → 0). Pure + exported, unit-tested.
 */
export function resolvePositiveInt(raw: unknown, fallback: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}
export const CHUNK_CHARS = resolvePositiveInt(process.env.GRAPH_CHUNK_CHARS, 2500);
export const MAX_EPISODE_CHUNKS = resolvePositiveInt(process.env.GRAPH_MAX_EPISODE_CHUNKS, 16);

/**
 * How many episodes to scan when resolving an item's chunk names → uuids for a delete (tier-cleanup)
 * or an emptiness check. `listEpisodes` defaults to the most-recent 1000; in a group past that, a
 * reclassified item's episodes fall outside the window, so the delete finds nothing and SILENTLY
 * no-ops — leaving the old-tier facts searchable (Pass-1 review B2). We scan deep so the delete is
 * real for any realistic group; a group larger than this keeps its `pending_delete_group_id` set
 * (reconcile never confirms it empty) rather than reporting a false success.
 */
export const GROUP_SCAN_DEPTH = resolvePositiveInt(process.env.GRAPH_GROUP_SCAN_DEPTH, 100_000);

/**
 * "When it happened" for an episode: prefer the item's own `source_ts`, but only if it actually parses.
 * A present-but-garbage `source_ts` must fall back to `synced_at` (always a real timestamptz), NOT to
 * graphiti-client's last-resort now() — otherwise an old/undated doc gets stamped "today" and floats to
 * the top of the recency-ranked arcs (rankArcs). (Locale-ambiguous strings like "09/07/2026" still parse
 * — wrongly — under JS Date; we can't disambiguate DD/MM here, so connectors should emit ISO.) Pure +
 * exported for tests.
 */
export function pickEpisodeTimestamp(sourceTs: unknown, syncedAt: string): string {
  const raw = typeof sourceTs === "string" ? sourceTs : syncedAt;
  return Number.isNaN(new Date(raw).getTime()) ? syncedAt : raw;
}

/**
 * Split an item's body into ≤ `maxChunks` chunks of ≤ `chunkChars` each, preserving every character
 * (content beyond `chunkChars * maxChunks` is dropped — a runaway-size backstop, not the common path).
 * Whitespace-only bodies yield `[]` (nothing to extract). Pure + unit-tested; the chunk boundaries are
 * deterministic so the content hash (taken over the full body) stays stable across runs.
 */
export function chunkContent(body: string, chunkChars = CHUNK_CHARS, maxChunks = MAX_EPISODE_CHUNKS): string[] {
  const text = body ?? "";
  if (!text.trim()) return [];
  // Clamp the params too (not just the env at module load) so a direct caller passing 0/NaN can't
  // emit empty/garbage chunks or stall the loop — belt-and-suspenders around the same landmine.
  const size = resolvePositiveInt(chunkChars, CHUNK_CHARS);
  const cap = resolvePositiveInt(maxChunks, MAX_EPISODE_CHUNKS);
  const chunks: string[] = [];
  for (let i = 0; i < text.length && chunks.length < cap; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

/** Item kinds worth projecting as graph episodes — content-bearing knowledge, not raw config.
 * `skill`/`blueprint` are configuration manifests, not events/knowledge, so they're excluded. */
export const PROJECTABLE_KINDS = ["transcript", "deliverable", "decision", "task", "artifact"] as const;

/** Human label per kind for the episode's source description (provenance the LLM extractor sees). */
const KIND_LABEL: Record<string, string> = {
  transcript: "Transcript",
  deliverable: "Document",
  decision: "Decision",
  task: "Task",
  artifact: "Artifact",
  skill: "Skill",
  blueprint: "Blueprint",
};

export interface ProjectSummary {
  scanned: number;
  projected: number;
  skipped: number;
  /** `synced_at` of the last row scanned this batch — the cursor the runner pages forward from
   * (audit H2). `undefined` when the batch was empty (nothing left to scan). */
  lastSyncedAt?: string;
}

type ItemRow = {
  id: string;
  kind: string;
  access: AccessTier;
  body: string | null;
  path: string;
  synced_at: string;
  frontmatter: Record<string, unknown> | null;
};

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Delete ALL of an item's episodes (every chunk: `items:<id>` and `items:<id>#k`) from `groupId`, and
 * return how many were deleted. `/messages` is fire-and-forget and never returns a uuid, so we resolve
 * names→uuids via `listEpisodes` (audit M6), scanning `GROUP_SCAN_DEPTH` deep so the delete doesn't
 * silently no-op on a large group. Throws on a Graphiti error (list or delete) — the caller decides
 * whether to retry (the projector records the group as pending-delete; reconcile finishes it). A chunk
 * the async worker never created simply isn't found and doesn't count.
 */
export async function deleteItemEpisodes(
  client: GraphitiClient,
  groupId: string,
  itemId: string
): Promise<number> {
  const episodes = await client.listEpisodes(groupId, GROUP_SCAN_DEPTH);
  let deleted = 0;
  for (const e of episodes) {
    if (itemIdFromEpisodeName(e.name) === itemId) {
      await client.deleteEpisode(e.uuid);
      deleted++;
    }
  }
  return deleted;
}

/**
 * The episode(s) + provenance for an item, labeled by kind. A normal item → ONE episode (plain
 * `items:<id>` name, unchanged from before); a large item → SEVERAL chunk episodes (`items:<id>#k`,
 * each ≤ CHUNK_CHARS, "(part k/N)" in the description) so every chunk stays under Graphiti's extraction
 * cap. Empty body → `[]` (skipped upstream — nothing to extract).
 */
function toEpisodes(item: ItemRow): GraphEpisode[] {
  const fm = item.frontmatter ?? {};
  const title = typeof fm.title === "string" ? fm.title : undefined;
  const url = typeof fm.source_url === "string" ? fm.source_url : undefined;
  const ts = pickEpisodeTimestamp(fm.source_ts, item.synced_at); // when it happened (see helper)
  const label = KIND_LABEL[item.kind] ?? "Item";
  const chunks = chunkContent(item.body ?? "");
  const total = chunks.length;
  return chunks.map((content, i) => ({
    content,
    timestamp: ts,
    sourceDescription: `${label} — ${title ?? item.path}${total > 1 ? ` (part ${i + 1}/${total})` : ""}${url ? ` (${url})` : ""}`,
    name: episodeName(item.id, i, total),
  }));
}

/**
 * Project this team's items into Graphiti. `kinds` selects which item kinds to project (default:
 * PROJECTABLE_KINDS — all content-bearing ingestions). `since` (ISO) bounds the backfill; `limit`
 * caps a single run (episodes are LLM-extracted on Graphiti's side — keep runs bounded). Rows with
 * an empty body are skipped (nothing to extract).
 */
export async function projectItemsToGraph(
  db: DbClient,
  args: {
    teamId: string;
    teamSlug: string;
    client?: GraphitiClient;
    kinds?: readonly string[];
    since?: string;
    limit?: number;
  }
): Promise<ProjectSummary> {
  const client = args.client ?? new GraphitiClient();
  const limit = args.limit ?? 50;
  const kinds: readonly string[] = args.kinds ?? PROJECTABLE_KINDS;

  let q = db
    .from("items")
    .select("id, kind, access, body, path, synced_at, frontmatter")
    .eq("team_id", args.teamId)
    .order("synced_at", { ascending: true })
    .limit(limit);
  // The DEFAULT (full) projection scans EVERY kind and decides projectability per row below, so an item
  // whose kind changed to a non-projectable one (deliverable → skill) still reaches the cleanup branch
  // instead of dropping out of the projector's view with its old episodes stranded in the graph — a
  // permanent tier leak by the same mechanism B2 closes. A caller that names `kinds` explicitly
  // (projectSlackToGraph) keeps its exact scope: it must not touch other kinds' episodes.
  if (args.kinds) q = q.in("kind", args.kinds as string[]);
  if (args.since) q = q.gt("synced_at", args.since);
  const { data, error } = await q;
  if (error) throw new Error(`project: load items failed: ${error.message}`);
  const rows = (data ?? []) as ItemRow[];

  let projected = 0;
  let skipped = 0;
  for (const item of rows) {
    const episodes = kinds.includes(item.kind) ? toEpisodes(item) : [];
    // Idempotency key = the FULL body (chunk boundaries derive deterministically from it), so an
    // unchanged item is a no-op regardless of how many chunks it splits into.
    const contentSha = sha(item.body ?? "");
    const groupId = episodeGroupId(args.teamSlug, item.access);

    // Read the ledger BEFORE the "nothing to project" skip: an item that stops projecting still owns
    // episodes we put in the graph, and they have to come back out (see the branch below).
    const { data: existing } = await db
      .from("graph_episodes")
      .select("content_sha256, group_id, pending_delete_group_id")
      .eq("team_id", args.teamId)
      .eq("source_table", SOURCE_TABLE)
      .eq("source_id", item.id)
      .maybeSingle();
    const existingRow = existing as {
      content_sha256: string;
      group_id: string;
      pending_delete_group_id: string | null;
    } | null;

    if (episodes.length === 0) {
      // Nothing to extract NOW — but if we projected this item before, its old episodes are still in
      // the graph. This is the redaction/blanking path (a body emptied upstream, with or without a tier
      // flip) and the kind-change path: both used to `continue` straight past the tier-change block
      // below, so the ledger kept pointing at the old group, `pending_delete_group_id` was never set,
      // and the pre-redaction episodes stayed searchable by the OLD tier forever with nothing to retry
      // — the exact leak B2 closes, arriving by a door B2 didn't cover. Record the holding group as
      // pending-delete (reconcile purges it durably) and park the row on the "" sentinel sha so the
      // projector re-pushes if the body ever comes back.
      //
      // Only when no cleanup is already outstanding: re-recording every pass would reset
      // `pending_delete_at` and the grace would never elapse. The single flag slot converges — the
      // outstanding one is cleaned and cleared, then the next pass records this one.
      if (existingRow && !existingRow.pending_delete_group_id) {
        await deleteItemEpisodes(client, existingRow.group_id, item.id).catch(() => {});
        const at = new Date().toISOString();
        await db.from("graph_episodes").upsert(
          {
            team_id: args.teamId,
            source_table: SOURCE_TABLE,
            source_id: item.id,
            group_id: existingRow.group_id, // nothing was pushed to the new group — don't claim it
            content_sha256: "",
            projected_at: at,
            pending_delete_group_id: existingRow.group_id,
            pending_delete_at: at,
          },
          { onConflict: "team_id,source_table,source_id" }
        );
      }
      skipped++;
      continue;
    }

    const tierChanged = existingRow !== null && existingRow.group_id !== groupId;
    // Pushing back INTO a group we still owe a purge on (a redaction that was undone before reconcile
    // finished): the pending purge deletes by item id, so leaving the flag set would delete the episodes
    // we're about to push and silently drop the item from the graph. Purge the stale ones first, then
    // this push is authoritative and the flag clears below.
    const purgeBeforeRepush = existingRow?.pending_delete_group_id === groupId;
    if (existingRow && existingRow.content_sha256 === contentSha && !tierChanged && !purgeBeforeRepush) {
      skipped++;
      continue; // unchanged content, same tier → no-op (idempotent)
    }

    // Audit M6 (durability hardened — Pass-1 review B2): a tier reclassification (e.g. external→team)
    // must not leave the old episodes searchable in the old group. We RECORD the old group as
    // pending-delete regardless of the inline attempt below, because the inline delete is best-effort
    // and can silently fail (a Graphiti blip) or miss a chunk the async worker creates AFTER it runs —
    // and once the ledger flips `group_id` to the new group, nothing would ever retry, leaving the old
    // tier searchable forever. `reconcile` retries the cleanup until the old group is verified empty and
    // only then clears `pending_delete_group_id`. The inline delete stays as the fast path.
    if (tierChanged && existingRow) {
      await deleteItemEpisodes(client, existingRow.group_id, item.id).catch(() => {});
    }
    // Independent of the tier check, NOT an else-arm: on a double flip (A→B→A while A's cleanup is
    // still outstanding) both are true, and the push target is exactly the group holding the stale
    // episodes the flag was recorded for. Skipping it there would leave them beside the fresh push.
    let purgeFailed = false;
    if (purgeBeforeRepush) {
      purgeFailed = await deleteItemEpisodes(client, groupId, item.id).then(
        () => false,
        () => true
      );
    }

    await client.addEpisodes(groupId, episodes);

    const projectedAt = new Date().toISOString();
    // Pending-delete bookkeeping for THIS push. Written only when it changes; an ordinary content
    // re-push omits both columns, so the pg upsert (which only SETs keys present in the object) leaves
    // an outstanding cleanup intact — that retention is what makes the flag durable.
    //
    // The flag is cleared ONLY on a purge we watched succeed. If that delete threw (a Graphiti blip),
    // clearing it would silently abandon the cleanup — the pre-redaction episodes would sit in the
    // group forever with nothing to retry and `pendingCleanups` reading 0, which is the failure mode
    // this whole mechanism exists to prevent. Keeping it set is safe: reconcile purges the group and
    // the landed-check's sentinel re-queue re-pushes, so the row converges to fresh-content-only.
    const pending: Record<string, string | null> =
      tierChanged && existingRow
        ? { pending_delete_group_id: existingRow.group_id, pending_delete_at: projectedAt }
        : purgeBeforeRepush && !purgeFailed
          ? { pending_delete_group_id: null, pending_delete_at: null } // purge confirmed + re-pushed
          : {};

    await db.from("graph_episodes").upsert(
      {
        team_id: args.teamId,
        source_table: SOURCE_TABLE,
        source_id: item.id,
        group_id: groupId,
        content_sha256: contentSha,
        projected_at: projectedAt,
        ...pending,
      },
      { onConflict: "team_id,source_table,source_id" }
    );
    projected++;
  }

  // Cursor for the runner: rows are ordered by synced_at ascending, so the last row is the high-water
  // mark to page past next batch (audit H2). Without this the runner only ever re-scanned the oldest
  // `limit` rows and never reached items beyond that window.
  const lastSyncedAt = rows.length ? rows[rows.length - 1].synced_at : undefined;
  return { scanned: rows.length, projected, skipped, lastSyncedAt };
}

/** Back-compat: project only Slack transcripts. Prefer `projectItemsToGraph` (all ingestions). */
export async function projectSlackToGraph(
  db: DbClient,
  args: { teamId: string; teamSlug: string; client?: GraphitiClient; since?: string; limit?: number }
): Promise<ProjectSummary> {
  return projectItemsToGraph(db, { ...args, kinds: ["transcript"] });
}
