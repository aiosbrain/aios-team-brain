import "server-only";
import type { DbClient } from "@/lib/db/types";
import { GraphitiClient } from "./graphiti-client";

/**
 * Reconcile pass for the brain→Graphiti seam (audit H3, Option B — chosen over blocking-confirm
 * because `/messages` is async/LLM-extraction-backed and polling every push would serialize a whole
 * projector batch behind unpredictable per-item latency). `graph_episodes` records a push
 * optimistically on the 202-accept; this pass periodically checks whether each recorded episode
 * ACTUALLY landed in Graphiti (via `GET /episodes/{group}`, matched by our stable `name`). Anything
 * that never landed (a worker crash before/while extracting it) is cleared so the next projector run
 * treats it as unprojected and re-pushes — self-healing, off the hot ingest/push path. Confirmed
 * rows get their `episode_uuid` backfilled (used later for targeted deletes — see deleteEpisodeByName).
 */

const GRACE_MS = 5 * 60_000; // don't judge a row pushed in the last 5 min — extraction may still be running

export interface ReconcileSummary {
  groupsChecked: number;
  confirmed: number;
  reQueued: number;
}

type EpisodeRow = {
  id: string;
  source_id: string;
  group_id: string;
  projected_at: string;
  episode_uuid: string | null;
};

export async function reconcileProjectedEpisodes(
  supabase: DbClient,
  client: GraphitiClient,
  teamId: string
): Promise<ReconcileSummary> {
  if (!client.configured) return { groupsChecked: 0, confirmed: 0, reQueued: 0 };

  const { data } = await supabase
    .from("graph_episodes")
    .select("id, source_id, group_id, projected_at, episode_uuid")
    .eq("team_id", teamId);
  const rows = (data ?? []) as EpisodeRow[];

  const byGroup = new Map<string, EpisodeRow[]>();
  for (const row of rows) {
    const arr = byGroup.get(row.group_id) ?? [];
    arr.push(row);
    byGroup.set(row.group_id, arr);
  }

  const cutoff = Date.now() - GRACE_MS;
  let confirmed = 0;
  let reQueued = 0;

  for (const [groupId, groupRows] of byGroup) {
    // Graphiti unreachable this pass — leave these rows alone and try again next tick, rather than
    // treating "couldn't check" as "never landed" and re-pushing everything.
    const episodes = await client.listEpisodes(groupId, 5000).catch(() => null);
    if (episodes === null) continue;
    const uuidByName = new Map(episodes.map((e) => [e.name, e.uuid]));

    for (const row of groupRows) {
      if (new Date(row.projected_at).getTime() > cutoff) continue; // too recent, still may be processing
      const uuid = uuidByName.get(`items:${row.source_id}`);
      if (uuid) {
        confirmed++;
        if (!row.episode_uuid) {
          await supabase.from("graph_episodes").update({ episode_uuid: uuid }).eq("id", row.id);
        }
      } else {
        await supabase.from("graph_episodes").delete().eq("id", row.id);
        reQueued++;
      }
    }
  }

  return { groupsChecked: byGroup.size, confirmed, reQueued };
}
