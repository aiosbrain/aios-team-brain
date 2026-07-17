import "server-only";
import { createHash } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import { GraphitiClient, type GraphEpisode } from "./graphiti-client";
import { episodeGroupId, type AccessTier } from "./group";

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
 * Max episode content length pushed to Graphiti. Graphiti extracts entities/edges from each episode
 * with its OWN LLM, and that call's OUTPUT is hard-capped at 8192 tokens by the pinned `zepai/graphiti`
 * image (graphiti_core's `DEFAULT_MAX_TOKENS`). The image's `graph_service` exposes NO env to raise it
 * (verified 2026-07-17 against getzep/graphiti `config.py`: only api_key/base_url/model_name/embedding
 * are configurable) — so the ONLY app-side lever is to keep extraction output under 8192 by bounding
 * what we send. A richer/longer episode extracts more nodes → larger structured output → overflow:
 *   `Output length exceeded max tokens 8192` in `resolve_extracted_nodes` (prod 2026-06-25, 07-03, and
 *   again 07-17 where a 6000-char cap STILL overflowed and stalled the whole backlog — no facts, blank
 *   arcs). 2000 chars (~500 tokens) keeps extraction output comfortably bounded. Full item text still
 *   lives in `items`/pgvector/FTS — only the graph episode is truncated (median item is ~240 chars, so
 *   this clips only outlier docs). Tunable via `GRAPH_MAX_EPISODE_CHARS` without a redeploy; the deeper
 *   durable fix (a newer image that raises the cap / handles the length error) is a Graphiti-service
 *   bump, which carries rebuild/schema-coupling risk — see docs/ARCHITECTURE.md + the graphiti memory.
 */
export const MAX_EPISODE_CHARS = Number(process.env.GRAPH_MAX_EPISODE_CHARS ?? 2000);

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
 * Resolve our stable episode `name` to Graphiti's server-assigned uuid within `groupId`, then
 * delete it. `/messages` is fire-and-forget and never returns a uuid, so this is the only way to
 * target a specific episode for deletion (audit M6). A no-op if the episode isn't found (already
 * gone, or the async worker never got to it) — the caller treats this as best-effort.
 */
export async function deleteEpisodeByName(
  client: GraphitiClient,
  groupId: string,
  name: string
): Promise<void> {
  const episodes = await client.listEpisodes(groupId);
  const match = episodes.find((e) => e.name === name);
  if (match) await client.deleteEpisode(match.uuid);
}

/** Episode content + provenance from an item, labeled by kind. */
function toEpisode(item: ItemRow): GraphEpisode {
  const fm = item.frontmatter ?? {};
  const title = typeof fm.title === "string" ? fm.title : undefined;
  const url = typeof fm.source_url === "string" ? fm.source_url : undefined;
  const ts = typeof fm.source_ts === "string" ? fm.source_ts : item.synced_at; // when it happened
  const label = KIND_LABEL[item.kind] ?? "Item";
  return {
    // Cap content so a large episode can't overflow extraction and wedge getzep's worker (see
    // MAX_EPISODE_CHARS). The content hash is taken over this capped value, so idempotency holds.
    content: (item.body ?? "").slice(0, MAX_EPISODE_CHARS),
    timestamp: ts,
    sourceDescription: `${label} — ${title ?? item.path}${url ? ` (${url})` : ""}`,
    name: `${SOURCE_TABLE}:${item.id}`,
  };
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
    const episode = toEpisode(item);
    if (!episode.content.trim()) {
      skipped++;
      continue; // nothing to extract
    }
    const contentSha = sha(episode.content);
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

    // Audit M6: a tier reclassification (e.g. external→team) must not leave the old episode
    // searchable in the old group forever — delete it there before projecting into the new group.
    // Best-effort: Graphiti's async worker may not have created the node yet, or it may already be
    // gone; either way we still proceed with the new-group push so projection isn't blocked on it.
    if (tierChanged && existingRow) {
      await deleteEpisodeByName(client, existingRow.group_id, episode.name!).catch(() => {});
    }

    await client.addEpisodes(groupId, [episode]);

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
