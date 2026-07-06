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
 * Max episode content length pushed to Graphiti. getzep's ingest worker has NO per-job exception
 * handling (`graph_service/routers/ingest.py` catches only `CancelledError`), so ANY exception from
 * `add_episode` permanently kills the worker and wedges the whole queue. A large episode whose
 * entity/edge extraction overflows the LLM's output-token cap raises exactly such an exception (seen
 * in prod 2026-06-25 and again 2026-07-03: `Output length exceeded max tokens 8192`). Capping content
 * keeps extraction output well under that limit. Full item text still lives in `items`/pgvector/FTS —
 * only the graph episode is truncated (affects a handful of outlier docs; median item is ~240 chars).
 */
export const MAX_EPISODE_CHARS = 6000;

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

    const { data: existing } = await db
      .from("graph_episodes")
      .select("content_sha256")
      .eq("team_id", args.teamId)
      .eq("source_table", SOURCE_TABLE)
      .eq("source_id", item.id)
      .maybeSingle();
    if (existing && existing.content_sha256 === contentSha) {
      skipped++;
      continue; // unchanged → no-op (idempotent)
    }

    const groupId = episodeGroupId(args.teamSlug, item.access);
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

  return { scanned: rows.length, projected, skipped };
}

/** Back-compat: project only Slack transcripts. Prefer `projectItemsToGraph` (all ingestions). */
export async function projectSlackToGraph(
  db: DbClient,
  args: { teamId: string; teamSlug: string; client?: GraphitiClient; since?: string; limit?: number }
): Promise<ProjectSummary> {
  return projectItemsToGraph(db, { ...args, kinds: ["transcript"] });
}
