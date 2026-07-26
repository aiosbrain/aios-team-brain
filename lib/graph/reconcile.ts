import "server-only";
import type { DbClient } from "@/lib/db/types";
import { GraphitiClient } from "./graphiti-client";
import { itemIdFromEpisodeName } from "./episode-name";
import { GROUP_SCAN_DEPTH, IN_CLAUSE_BATCH, chunk, resolvePositiveInt } from "./project";
import { isExternalGroupId } from "./group";

/**
 * Reconcile pass for the brain→Graphiti seam (audit H3, Option B — chosen over blocking-confirm
 * because `/messages` is async/LLM-extraction-backed and polling every push would serialize a whole
 * projector batch behind unpredictable per-item latency). `graph_episodes` records a push
 * optimistically on the 202-accept; this pass periodically checks whether each recorded episode
 * ACTUALLY landed in Graphiti (via `GET /episodes/{group}`, matched by our stable `name`). Anything
 * that never landed (a worker crash before/while extracting it) is cleared so the next projector run
 * treats it as unprojected and re-pushes — self-healing, off the hot ingest/push path. Confirmed
 * rows get their `episode_uuid` backfilled as provenance only — the deletes resolve names→uuids through
 * `listEpisodes` themselves, so nothing reads the stored value.
 */

const GRACE_MS = 5 * 60_000; // don't judge a row pushed in the last 5 min — extraction may still be running
// Clearing a tier-cleanup flag is a tier-isolation decision (no RLS backstop), so it uses a LONGER,
// dedicated grace: a straggler chunk of the pre-reclassification push that's still sitting in Graphiti's
// extraction queue (which demonstrably backs up — the oversized-episode wedge) could land AFTER a short
// grace cleared the flag and leak the old tier permanently. Cleanup is rare + off the hot path, so we
// can afford to wait an hour before declaring an old group durably empty. (The purge of any episode we
// DO see still runs every pass; only the flag-CLEAR waits out this window.)
const CLEANUP_GRACE_MS = 60 * 60_000;

/**
 * How deep the LANDED-check lists each group. Deliberately smaller than `GROUP_SCAN_DEPTH` (which the
 * rare tier cleanup uses): this runs for EVERY group on EVERY pass, so the window is a payload cost
 * paid hourly, not a one-off. A group past this window is not judged at all (see `saturated` below)
 * rather than judged wrongly, so the depth trades latency-to-heal for transfer size — not correctness.
 */
export const LANDED_SCAN_DEPTH = resolvePositiveInt(process.env.GRAPH_LANDED_SCAN_DEPTH, 5000);

export interface ReconcileSummary {
  groupsChecked: number;
  confirmed: number;
  reQueued: number;
  /** Rows whose OLD-group cleanup (after a tier change) was verified complete this pass. */
  cleaned: number;
  /** Of those, the ones whose old group was the EXTERNAL one — i.e. a NARROWING has now fully left the
   * graph. Direction-aware because only that case justifies hard-purging the external caches. */
  cleanedExternal: number;
  /** Cleanups STILL outstanding after this pass — old-tier episodes that are purgeable but not yet
   * verified purged. A number that never returns to 0 is a stuck tier cleanup, not bookkeeping. */
  pendingCleanups: number;
  /** Groups whose episode list came back FULL, so nothing in them could be judged this pass. Reported
   * rather than swallowed: it means the group has outgrown the scan window and self-healing has
   * quietly stopped for it (raise `GRAPH_LANDED_SCAN_DEPTH`). */
  saturatedGroups: number;
}

type EpisodeRow = {
  id: string;
  source_id: string;
  source_table: string;
  group_id: string;
  content_sha256: string;
  projected_at: string;
  episode_uuid: string | null;
  pending_delete_group_id: string | null;
  pending_delete_at: string | null;
};

/**
 * The `source_id`s in `rows` whose row in `items` is GONE — the orphan set (see the call site).
 *
 * Returns an EMPTY set when the lookup fails, and only ever classifies `source_table='items'` rows:
 * "couldn't check" must stay inconclusive here, exactly as an unreachable Graphiti does below. A
 * swallowed DB error would otherwise read as "every pending row is an orphan" and delete healthy
 * tier-cleanup bookkeeping, which the projector would answer by re-pushing — duplicate episodes,
 * double-weighted facts.
 */
async function findOrphanSourceIds(
  db: DbClient,
  teamId: string,
  rows: readonly EpisodeRow[]
): Promise<Set<string>> {
  const ids = [...new Set(rows.filter((r) => r.source_table === "items").map((r) => r.source_id))];
  if (ids.length === 0) return new Set();
  const alive = new Set<string>();
  // Chunked: this passes EVERY projected item's id, and the pg adapter binds one per element — past
  // Postgres' 65535-bind ceiling the statement is refused outright, which would silently switch off
  // the whole orphan-repair safety net at exactly the corpus size where it matters.
  for (const batch of chunk(ids, IN_CLAUSE_BATCH)) {
    const { data, error } = await db.from("items").select("id").eq("team_id", teamId).in("id", batch);
    if (error) {
      // LOUD: returning an empty set is the right direction (nothing is judged an orphan), but a
      // silent one means the repair is off and no signal says so.
      console.error(`[graph] orphan check failed — orphan repair skipped this pass: ${error.message}`);
      return new Set();
    }
    for (const r of (data ?? []) as { id: string }[]) alive.add(r.id);
  }
  return new Set(ids.filter((id) => !alive.has(id)));
}

/**
 * Flag every orphan row that isn't already carrying a cleanup, and return the rows as they now stand
 * (new objects — the caller's snapshot must not silently disagree with the DB). The flag reuses the
 * tier-cleanup mechanism wholesale: the loop below purges the group and drops the row once it's
 * verified empty, retrying across passes if Graphiti is down.
 */
async function repairOrphans(
  db: DbClient,
  rows: readonly EpisodeRow[],
  orphans: ReadonlySet<string>
): Promise<EpisodeRow[]> {
  const at = new Date().toISOString();
  const out: EpisodeRow[] = [];
  for (const row of rows) {
    if (!orphans.has(row.source_id) || row.pending_delete_group_id) {
      out.push(row);
      continue;
    }
    const patch = {
      content_sha256: "", // no longer a live projection
      pending_delete_group_id: row.group_id,
      pending_delete_at: at,
    };
    const { error } = await db.from("graph_episodes").update(patch).eq("id", row.id);
    out.push(error ? row : { ...row, ...patch });
  }
  return out;
}

export async function reconcileProjectedEpisodes(
  db: DbClient,
  client: GraphitiClient,
  teamId: string
): Promise<ReconcileSummary> {
  if (!client.configured)
    return {
      groupsChecked: 0,
      confirmed: 0,
      reQueued: 0,
      cleaned: 0,
      cleanedExternal: 0,
      pendingCleanups: 0,
      saturatedGroups: 0,
    };

  const { data } = await db
    .from("graph_episodes")
    .select(
      "id, source_id, source_table, group_id, content_sha256, projected_at, episode_uuid, pending_delete_group_id, pending_delete_at"
    )
    .eq("team_id", teamId);
  const rawRows = (data ?? []) as EpisodeRow[];

  // ── Orphan repair, BEFORE anything else judges these rows ────────────────────────────────────
  // A ledger row whose ITEM is gone is an orphan, and an orphan's episodes are content the brain no
  // longer holds still answering questions in Graphiti. `lib/ingest/purge` retires what it can see,
  // but it cannot see a projector batch already in flight: the projector loads an item, the purge
  // deletes it, and the projector then re-pushes the body it still holds in memory AND clears the
  // pending-delete flag (the `purgeBeforeRepush` branch). That row looks perfectly healthy
  // afterwards — fresh sha, no flag — so nothing would ever revisit it and the purged content would
  // stay searchable forever.
  //
  // So orphan-ness, not the flag, is the invariant: any row with no item is re-flagged here and the
  // ordinary cleanup loop below purges it and drops the row. This also covers orphans from any other
  // door (a hand-deleted item, a future diff-delete) for free.
  const orphans = await findOrphanSourceIds(db, teamId, rawRows);
  const rows = await repairOrphans(db, rawRows, orphans);

  const byGroup = new Map<string, EpisodeRow[]>();
  for (const row of rows) {
    const arr = byGroup.get(row.group_id) ?? [];
    arr.push(row);
    byGroup.set(row.group_id, arr);
  }

  const cutoff = Date.now() - GRACE_MS;
  let confirmed = 0;
  let reQueued = 0;
  let saturatedGroups = 0;

  for (const [groupId, groupRows] of byGroup) {
    // Graphiti unreachable this pass — leave these rows alone and try again next tick, rather than
    // treating "couldn't check" as "never landed" and re-pushing everything.
    const episodes = await client.listEpisodes(groupId, LANDED_SCAN_DEPTH).catch(() => null);
    if (episodes === null) continue;
    // A FULL window is inconclusive the same way an unreachable Graphiti is: an item's chunks may sit
    // just beyond it, and reading that as "never landed" would re-push the ENTIRE group every pass —
    // growing the group, pushing more rows out of the window, re-pushing more next pass. That
    // self-amplifying loop is worse than not healing, so a saturated group is skipped and counted.
    if (episodes.length >= LANDED_SCAN_DEPTH) {
      saturatedGroups++;
      continue;
    }
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
      } else if (row.pending_delete_group_id) {
        // This row still owes an OLD-group cleanup. DELETING it (the normal re-queue) would lose the
        // `pending_delete_group_id` flag → the old tier stays searchable forever with nothing to retry
        // it (the exact leak B2 closes, resurrected via a new-group worker crash). Instead, reset the
        // content hash so the projector re-pushes it (same re-queue effect), while the row — and its
        // pending flag — survive for the cleanup loop below to finish. The re-push's upsert omits the
        // pending column (its tier didn't change), so the flag is retained.
        //
        // Already on the sentinel → nothing to re-queue (a redacted item parks here for the whole
        // grace window). Writing and counting it every pass would inflate `requeued` in the logs and
        // the ingest_runs meta with work that isn't happening.
        if (row.content_sha256 !== "") {
          await db.from("graph_episodes").update({ content_sha256: "" }).eq("id", row.id);
          reQueued++;
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
  let cleanedExternal = 0;
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
      // passed (the LONGER cleanup grace) that a late-extracting worker won't still create a straggler
      // chunk. If we purged some this pass, leave it set so the next pass re-verifies empty.
      //
      // Anchored on `pending_delete_at` (when the cleanup was recorded), NOT `projected_at`: every
      // ordinary content re-push bumps `projected_at`, so an item edited more often than the grace
      // window would never become eligible and its flag would stick forever. `?? projected_at` covers
      // rows written before the column existed.
      const flaggedAt = new Date(row.pending_delete_at ?? row.projected_at).getTime();
      const pastCleanupGrace = flaggedAt <= Date.now() - CLEANUP_GRACE_MS;
      if (uuids.length === 0 && !deleteFailed && pastCleanupGrace && !saturated) {
        if (orphans.has(row.source_id) && oldGroup === row.group_id) {
          // Orphan, cleanup verified: the item is gone and the group it lives in is empty of it, so
          // the ledger row has nothing left to describe. Clearing the flag instead would leave the
          // row forever (the projector only ever visits rows whose item still exists).
          await db.from("graph_episodes").delete().eq("id", row.id);
        } else if (orphans.has(row.source_id)) {
          // Orphan whose flag pointed at a DIFFERENT group (a tier move whose cleanup was still
          // outstanding when the item was purged). That group is now verified empty — but the row's
          // OWN group has never been checked, and dropping the row here would delete the only pointer
          // to those episodes. Re-point the flag instead; the next pass verifies the second group and
          // then takes the branch above.
          await db
            .from("graph_episodes")
            .update({ pending_delete_group_id: row.group_id, pending_delete_at: new Date().toISOString() })
            .eq("id", row.id);
        } else {
          await db
            .from("graph_episodes")
            .update({ pending_delete_group_id: null, pending_delete_at: null })
            .eq("id", row.id);
        }
        cleaned++;
        if (isExternalGroupId(oldGroup)) cleanedExternal++;
      }
    }
  }

  // Outstanding cleanups AFTER this pass — the tier-isolation signal worth alerting on (old-tier
  // episodes that are purgeable but not yet verified purged). Re-read rather than derived from the
  // in-memory rows so a concurrent projector's new flags are counted. Uses the partial index.
  const { data: pendingRows } = await db
    .from("graph_episodes")
    .select("id")
    .eq("team_id", teamId)
    .not("pending_delete_group_id", "is", null);

  return {
    groupsChecked: byGroup.size,
    confirmed,
    reQueued,
    cleaned,
    cleanedExternal,
    pendingCleanups: (pendingRows ?? []).length,
    saturatedGroups,
  };
}
