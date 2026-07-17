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
export const CHUNK_CHARS = Number(process.env.GRAPH_CHUNK_CHARS ?? 2500);
export const MAX_EPISODE_CHUNKS = Number(process.env.GRAPH_MAX_EPISODE_CHUNKS ?? 16);

/**
 * Split an item's body into ≤ `maxChunks` chunks of ≤ `chunkChars` each, preserving every character
 * (content beyond `chunkChars * maxChunks` is dropped — a runaway-size backstop, not the common path).
 * Whitespace-only bodies yield `[]` (nothing to extract). Pure + unit-tested; the chunk boundaries are
 * deterministic so the content hash (taken over the full body) stays stable across runs.
 */
export function chunkContent(body: string, chunkChars = CHUNK_CHARS, maxChunks = MAX_EPISODE_CHUNKS): string[] {
  const text = body ?? "";
  if (!text.trim()) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length && chunks.length < maxChunks; i += chunkChars) {
    chunks.push(text.slice(i, i + chunkChars));
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
 * Delete ALL of an item's episodes (every chunk: `items:<id>` and `items:<id>#k`) from `groupId`.
 * `/messages` is fire-and-forget and never returns a uuid, so we resolve names→uuids via
 * `listEpisodes` (audit M6). Best-effort: a chunk the async worker never created just isn't found.
 */
export async function deleteItemEpisodes(client: GraphitiClient, groupId: string, itemId: string): Promise<void> {
  const episodes = await client.listEpisodes(groupId);
  for (const e of episodes) {
    if (itemIdFromEpisodeName(e.name) === itemId) await client.deleteEpisode(e.uuid);
  }
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
  const ts = typeof fm.source_ts === "string" ? fm.source_ts : item.synced_at; // when it happened
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
  const kinds = args.kinds ?? PROJECTABLE_KINDS;

  let q = db
    .from("items")
    .select("id, kind, access, body, path, synced_at, frontmatter")
    .eq("team_id", args.teamId)
    .in("kind", kinds as string[])
    .order("synced_at", { ascending: true })
    .limit(limit);
  if (args.since) q = q.gt("synced_at", args.since);
  const { data, error } = await q;
  if (error) throw new Error(`project: load items failed: ${error.message}`);
  const rows = (data ?? []) as ItemRow[];

  let projected = 0;
  let skipped = 0;
  for (const item of rows) {
    const episodes = toEpisodes(item);
    if (episodes.length === 0) {
      skipped++;
      continue; // empty body → nothing to extract
    }
    // Idempotency key = the FULL body (chunk boundaries derive deterministically from it), so an
    // unchanged item is a no-op regardless of how many chunks it splits into.
    const contentSha = sha(item.body ?? "");
    const groupId = episodeGroupId(args.teamSlug, item.access);

    const { data: existing } = await db
      .from("graph_episodes")
      .select("content_sha256, group_id")
      .eq("team_id", args.teamId)
      .eq("source_table", SOURCE_TABLE)
      .eq("source_id", item.id)
      .maybeSingle();
    const existingRow = existing as { content_sha256: string; group_id: string } | null;
    const tierChanged = existingRow && existingRow.group_id !== groupId;
    if (existingRow && existingRow.content_sha256 === contentSha && !tierChanged) {
      skipped++;
      continue; // unchanged content, same tier → no-op (idempotent)
    }

    // Audit M6: a tier reclassification (e.g. external→team) must not leave the old episodes
    // searchable in the old group forever — delete ALL the item's chunks there before projecting into
    // the new group. Best-effort: the async worker may not have created a node yet, or it's already
    // gone; either way we proceed with the new-group push so projection isn't blocked on it.
    if (tierChanged && existingRow) {
      await deleteItemEpisodes(client, existingRow.group_id, item.id).catch(() => {});
    }

    await client.addEpisodes(groupId, episodes);

    await db.from("graph_episodes").upsert(
      {
        team_id: args.teamId,
        source_table: SOURCE_TABLE,
        source_id: item.id,
        group_id: groupId,
        content_sha256: contentSha,
        projected_at: new Date().toISOString(),
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
