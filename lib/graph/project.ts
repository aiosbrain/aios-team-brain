import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GraphitiClient, type GraphEpisode } from "./graphiti-client";
import { episodeGroupId, type AccessTier } from "./group";

/**
 * Brain → Graphiti projector. Reads already-normalized, tier-tagged rows from the brain
 * (Phase 1: Slack transcripts in `items`) and pushes them to Graphiti as episodes. The
 * SOLE writer of `graph_episodes` (the idempotency-state table) — single-writer guarded.
 *
 * Idempotent: re-projecting an unchanged row is a no-op (matched by content hash); changed
 * content re-pushes (Graphiti's temporal model supersedes the old fact). Source of truth stays
 * the brain; Graphiti is a downstream projection.
 */

const SOURCE_TABLE = "items";

export interface ProjectSummary {
  scanned: number;
  projected: number;
  skipped: number;
}

type ItemRow = {
  id: string;
  access: AccessTier;
  body: string | null;
  path: string;
  synced_at: string;
  frontmatter: Record<string, unknown> | null;
};

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Episode content + provenance from a Slack-transcript item. */
function toEpisode(item: ItemRow): GraphEpisode {
  const fm = item.frontmatter ?? {};
  const title = typeof fm.title === "string" ? fm.title : undefined;
  const url = typeof fm.source_url === "string" ? fm.source_url : undefined;
  const ts = typeof fm.source_ts === "string" ? fm.source_ts : item.synced_at; // when it happened
  return {
    content: item.body ?? "",
    timestamp: ts,
    sourceDescription: `Slack thread — ${title ?? item.path}${url ? ` (${url})` : ""}`,
    name: `${SOURCE_TABLE}:${item.id}`,
  };
}

/**
 * Project this team's Slack transcripts into Graphiti. `since` (ISO) bounds the backfill;
 * `limit` caps a single run (episodes are LLM-extracted on Graphiti's side — keep runs bounded).
 */
export async function projectSlackToGraph(
  supabase: SupabaseClient,
  args: { teamId: string; teamSlug: string; client?: GraphitiClient; since?: string; limit?: number }
): Promise<ProjectSummary> {
  const client = args.client ?? new GraphitiClient();
  const limit = args.limit ?? 50;

  let q = supabase
    .from("items")
    .select("id, access, body, path, synced_at, frontmatter")
    .eq("team_id", args.teamId)
    .eq("kind", "transcript")
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
    const contentSha = sha(episode.content);

    const { data: existing } = await supabase
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

    await supabase.from("graph_episodes").upsert(
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
