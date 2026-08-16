import "server-only";
import type { DbClient } from "@/lib/db/types";
import { GraphitiClient } from "./graphiti-client";
import { itemIdFromEpisodeName } from "./episode-name";
import {
  GROUP_SCAN_DEPTH,
  IN_CLAUSE_BATCH,
  PROJECTION_INTERVAL_MS,
  chunk,
  resolvePositiveInt,
} from "./project";
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

/**
 * Floor on "too recent to judge". Extraction is asynchronous, so a just-pushed episode legitimately
 * isn't in the group yet.
 */
export const GRACE_MS = 5 * 60_000;

/**
 * The grace actually applied: at least one full projection cycle (H7).
 *
 * Five minutes was the amplifier. Graphiti's queue drains at LLM speed, so any backlog deeper than the
 * grace made reconcile read every still-queued episode as "never landed" — it deleted the ledger row,
 * the projector re-pushed on its next tick, and that deepened the very backlog causing the
 * misjudgement. Positive feedback, and a large backfill trips it deterministically: unbounded duplicate
 * episodes and extraction spend.
 *
 * Waiting a full cycle costs almost no healing latency, which is what makes this a floor rather than a
 * compromise: a re-queued row can't be re-pushed until the projector's next run anyway, so judging it
 * sooner mostly buys nothing while risking judging it wrongly. Two honest exceptions, both accepted:
 *   • Phase offset. A row pushed mid-run is aged ~one interval by the NEXT reconcile; land fractionally
 *     under and it waits one more cycle, so a genuinely crashed episode can take ~2 cycles to heal.
 *   • The admin "Project to graph" action used to double as a fast manual heal (push, wait 5 min, click).
 *     It now judges nothing younger than a full cycle. Recovering sooner means lowering the cadence.
 *
 * `PROJECTION_INTERVAL_MS` is imported, not re-read from the env, so this can't drift from the cadence
 * the scheduler actually runs at — the whole argument above is false if the two numbers disagree.
 */
export const LANDED_GRACE_MS = Math.max(GRACE_MS, PROJECTION_INTERVAL_MS);

/**
 * Most ledger rows one pass may re-queue FOR ONE TEAM. Defence in depth behind `LANDED_GRACE_MS` — the
 * grace removes the misjudgement that drives the loop; this bounds the damage if something still does.
 *
 * A crashed worker loses ONE episode. A wedged queue, an outage, or a Graphiti restart makes EVERY row
 * look absent at once, so "many rows absent simultaneously" is evidence about the SERVICE rather than
 * about N independent rows. The cap does a bounded number and reports the remainder; the un-judged rows
 * keep their ledger entry and come round next pass, by which time the service has usually recovered and
 * they confirm instead.
 *
 * The cost is real and worth stating: a team that genuinely needs 1000 rows re-pushed heals at 20 per
 * projection cycle — at the default hourly cadence, ~50 hours. In the case this cap exists for that is
 * the RIGHT speed: when Graphiti accepted the pushes and never extracted them, re-pushing all 1000 at
 * once just re-creates the wedge, and drip-feeding is what you'd want a human to do by hand.
 *
 * But that is not the only way a thousand rows go absent at once. A Neo4j rollback or a rebuilt-image
 * recovery (both of which have happened here) loses landed episodes while the service is perfectly
 * HEALTHY — every row is legitimately gone, re-pushing all of them is correct, and 50 hours is simply
 * slow. That case is a deliberate operator action, so the intended response is to raise
 * `GRAPH_REQUEUE_MAX_PER_PASS` for the recovery; `requeueThrottled` is the signal that tells an operator
 * this is the situation they're in, rather than leaving it to be inferred from the graph looking thin.
 *
 * LIMITATION: the bound is per team, and Graphiti's extraction queue is shared across all of them, so a
 * many-team instance can still exceed it in aggregate on one pass. Making the budget global means
 * threading it through `runGraphProjection`'s team loop; not done, because the grace is the actual fix
 * and no instance today has the team count for this to bite.
 */
export const REQUEUE_MAX_PER_PASS = resolvePositiveInt(process.env.GRAPH_REQUEUE_MAX_PER_PASS, 20);
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
  /** Rows this pass WANTED to re-queue but didn't, because the per-pass cap says a mass disappearance is
   * a service problem rather than N crashed workers. Non-zero means Graphiti is probably unhealthy; the
   * rows are untouched and retried next pass. */
  requeueThrottled: number;
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
  chunk_shas: string[] | null;
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
  teamId: string,
  /**
   * Re-queue budget for THIS pass, defaulting to the per-team constant. A parameter rather than a bare
   * module constant for two reasons: it lets a test exercise the throttle at a size it can actually
   * seed (depending on the env-derived value means the fixture grows with the knob), and it is the seam
   * a future global budget would use to spend one allowance across `runGraphProjection`'s team loop —
   * the LIMITATION named on `REQUEUE_MAX_PER_PASS`.
   */
  maxRequeuePerPass: number = REQUEUE_MAX_PER_PASS
): Promise<ReconcileSummary> {
  if (!client.configured)
    return {
      groupsChecked: 0,
      confirmed: 0,
      reQueued: 0,
      cleaned: 0,
      cleanedExternal: 0,
      pendingCleanups: 0,
      requeueThrottled: 0,
      saturatedGroups: 0,
    };

  const { data } = await db
    .from("graph_episodes")
    .select(
      "id, source_id, source_table, group_id, content_sha256, projected_at, episode_uuid, pending_delete_group_id, pending_delete_at, chunk_shas"
    )
    .eq("team_id", teamId)
    // DEFERRED rows are exempt from every judgement here (PCCC-5, design §2.5): they carry the ''
    // sentinel because extraction is deliberately WITHHELD (a cold initiative), not because a push
    // never landed — the never-landed delete would remove them, the projector would re-create them
    // next pass, and the loop would churn forever while reading as healthy self-healing.
    .eq("deferred", false);
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

  const cutoff = Date.now() - LANDED_GRACE_MS;
  let confirmed = 0;
  let reQueued = 0;
  let saturatedGroups = 0;
  let requeueThrottled = 0;

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
          // Throttled (H7) — see REQUEUE_MAX_PER_PASS. Checked here rather than above the branch so a
          // row already on the sentinel doesn't consume budget it isn't using.
          if (reQueued >= maxRequeuePerPass) {
            requeueThrottled++;
            continue;
          }
          await db.from("graph_episodes").update({ content_sha256: "" }).eq("id", row.id);
          reQueued++;
        }
      } else {
        // NEVER-PUSHED rows are the PROJECTOR's to converge, not this judge's to delete (review-2
        // Blocker 2): an ARMED-but-unpushed row ('' sha, EMPTY chunk ledger — reservation or an
        // arm awaiting its budgeted push) has claimed nothing in Graphiti, so "never landed" is
        // vacuous for it — and deleting it re-cold-starts the arm every cycle: on a reader-quiet
        // team the restriction-move copy deterministically never pushed and rule-2 exposure stayed
        // open forever. A row that EVER pushed keeps its chunk_shas (the re-queue resets only the
        // sha), so the empty ledger is the honest discriminator.
        if ((row.chunk_shas ?? []).length === 0 && row.content_sha256 === "") continue;
        // Throttled (H7) — see REQUEUE_MAX_PER_PASS. Past the cap the pass stops judging and reports
        // the remainder; the rows are untouched and come round again next pass.
        if (reQueued >= maxRequeuePerPass) {
          requeueThrottled++;
          continue;
        }
        // PARK ON THE SENTINEL RATHER THAN DELETE (STALLSCOPE-1, found by both code reviewers).
        //
        // This used to `delete()` the row, which has the same re-queue effect — the branch above says
        // so in its own comment ("the sentinel → the projector re-pushes it like a deleted row") — but
        // destroys the row's identity, and with it `first_seen_at`, the SET-ONCE clock the stall
        // probe's age gate reads. That matters in exactly the state the probe exists for: during a
        // dead-extractor outage nothing lands, so this path recycles rows every grace window and each
        // re-creation takes a fresh `default now()`. Detection survived only on an accident of the
        // defaults (`REQUEUE_MAX_PER_PASS` 20 < `MIN_ITEMS_FOR_EXTRACTION_SIGNAL` 25, so some row
        // always kept an old clock) — and raising that cap is the DOCUMENTED response to
        // `requeueThrottled`, which a dead extractor is what produces. It would have held the gate
        // open indefinitely.
        //
        // Keeping the row is also the more correct post-PCCC-3 behaviour on its own terms: the row IS
        // the `(item, group)` reservation, and re-pushing is what a reservation is for. The delta path
        // is skipped for a sentinel sha, so the next pass pushes the whole item exactly as before.
        await db.from("graph_episodes").update({ content_sha256: "" }).eq("id", row.id);
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
    requeueThrottled,
    saturatedGroups,
  };
}
