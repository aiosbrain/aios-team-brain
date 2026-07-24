import "server-only";
import type { DbClient } from "@/lib/db/types";
import { GraphitiClient } from "./graphiti-client";
import { itemIdFromEpisodeName } from "./episode-name";
import { GROUP_SCAN_DEPTH } from "./project";

/**
 * Reconcile pass for the brain→Graphiti seam (audit H3, Option B — chosen over blocking-confirm
 * because `/messages` is async/LLM-extraction-backed and polling every push would serialize a whole
 * projector batch behind unpredictable per-item latency). `graph_episodes` records a push
 * optimistically on the 202-accept; this pass periodically checks whether each recorded episode
 * ACTUALLY landed in Graphiti (via `GET /episodes/{group}`, matched by our stable `name`). Anything
 * that never landed (a worker crash before/while extracting it) is cleared so the next projector run
 * treats it as unprojected and re-pushes — self-healing, off the hot ingest/push path. Confirmed
 * rows get their `episode_uuid` backfilled (used later for targeted deletes — see deleteItemEpisodes).
 */

const GRACE_MS = 5 * 60_000; // don't judge a row pushed in the last 5 min — extraction may still be running

export interface ReconcileSummary {
  groupsChecked: number;
  confirmed: number;
  reQueued: number;
  /** Rows whose OLD-group cleanup (after a tier change) was verified complete this pass. */
  cleaned: number;
}

type EpisodeRow = {
  id: string;
  source_id: string;
  group_id: string;
  projected_at: string;
  episode_uuid: string | null;
  pending_delete_group_id: string | null;
};

export async function reconcileProjectedEpisodes(
  db: DbClient,
  client: GraphitiClient,
  teamId: string
): Promise<ReconcileSummary> {
  if (!client.configured) return { groupsChecked: 0, confirmed: 0, reQueued: 0, cleaned: 0 };

  const { data } = await db
    .from("graph_episodes")
    .select("id, source_id, group_id, projected_at, episode_uuid, pending_delete_group_id")
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
    // An item is projected as one OR MANY chunk episodes (`items:<id>` / `items:<id>#k`) — it "landed"
    // if ANY of its chunks is present. Map each item id → one of its episode uuids.
    const uuidByItemId = new Map<string, string>();
    for (const e of episodes) {
      const itemId = itemIdFromEpisodeName(e.name);
      if (itemId && !uuidByItemId.has(itemId)) uuidByItemId.set(itemId, e.uuid);
    }

    for (const row of groupRows) {
      if (new Date(row.projected_at).getTime() > cutoff) continue; // too recent, still may be processing
      const uuid = uuidByItemId.get(row.source_id);
      if (uuid) {
        confirmed++;
        if (!row.episode_uuid) {
          await db.from("graph_episodes").update({ episode_uuid: uuid }).eq("id", row.id);
        }
      } else {
        await db.from("graph_episodes").delete().eq("id", row.id);
        reQueued++;
      }
    }
  }

  // Tier-reclassification cleanup (audit M6 durability, Pass-1 review B2). A row with
  // `pending_delete_group_id` had its tier changed; its OLD-group episodes must be purged, but the
  // projector's inline delete is best-effort (a swallowed Graphiti error, or the async worker creating
  // a straggler chunk after it ran). Retry the delete here until the old group is verified empty, THEN
  // clear the flag. Independent of the landed-check above (that confirms the NEW group).
  let cleaned = 0;
  const pendingByGroup = new Map<string, EpisodeRow[]>();
  for (const row of rows) {
    if (!row.pending_delete_group_id) continue;
    const arr = pendingByGroup.get(row.pending_delete_group_id) ?? [];
    arr.push(row);
    pendingByGroup.set(row.pending_delete_group_id, arr);
  }
  for (const [oldGroup, groupRows] of pendingByGroup) {
    // List the old group once (deep — a large group must not hide the item's episodes past the default
    // window). Graphiti unreachable → leave the flags set and retry next tick.
    const episodes = await client.listEpisodes(oldGroup, GROUP_SCAN_DEPTH).catch(() => null);
    if (episodes === null) continue;
    // If the scan hit the cap, the item's episodes MIGHT be beyond the window — treat "not found" as
    // inconclusive and never clear the flag on a saturated scan (else we'd false-clear while old-tier
    // episodes still exist — the very bug this fixes, just at a larger N). The flag then stays set +
    // observable rather than silently declaring a phantom cleanup.
    const saturated = episodes.length >= GROUP_SCAN_DEPTH;
    const uuidsByItem = new Map<string, string[]>();
    for (const e of episodes) {
      const itemId = itemIdFromEpisodeName(e.name);
      if (!itemId) continue;
      const arr = uuidsByItem.get(itemId) ?? [];
      arr.push(e.uuid);
      uuidsByItem.set(itemId, arr);
    }
    for (const row of groupRows) {
      const uuids = uuidsByItem.get(row.source_id) ?? [];
      let deleteFailed = false;
      for (const uuid of uuids) {
        try {
          await client.deleteEpisode(uuid);
        } catch {
          deleteFailed = true; // keep the flag; retry next pass
        }
      }
      // Clear the flag ONLY when the old group is confirmed empty of this item AND enough time has
      // passed that a late-extracting worker won't still create a straggler chunk (same grace as the
      // landed-check). If we purged some this pass, leave it set so the next pass re-verifies empty.
      const pastGrace = new Date(row.projected_at).getTime() <= cutoff;
      if (uuids.length === 0 && !deleteFailed && pastGrace && !saturated) {
        await db.from("graph_episodes").update({ pending_delete_group_id: null }).eq("id", row.id);
        cleaned++;
      }
    }
  }

  return { groupsChecked: byGroup.size, confirmed, reQueued, cleaned };
}
