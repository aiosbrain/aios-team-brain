import "server-only";
import type { DbClient } from "@/lib/db/types";
import { armDeferredRowsForGroups } from "./project";
import { ensureArmingRows } from "./arming-row";
import { chunk, IN_CLAUSE_BATCH } from "@/lib/db/batch";
import { runSql } from "@/lib/db/pg/pool";

/**
 * Arm-on-read + the read-ready MONOTONE latch (PCCC-6; design §2.2/§2.3, three review rounds).
 *
 * ARMING is a side effect of an enforcing team-tier principal's read: their oracle-visible
 * initiative projects get an arming row and their deferred fan-out rows flip pushable — the
 * projector's next pass extracts under its budget. The first query arms-and-omits; later queries
 * get the leg. The obligation snapshot IS the set of rows armed at that moment (no id array):
 * items tagged later arrive DEFERRED and don't join the snapshot until a POST-LATCH arm — an
 * unlatched project's re-arm must not grow the obligation set (Codex code-review Blocker 2).
 *
 * READY is a latch, never a live predicate (round-2 High 4 / Codex-plan Blocker 2 history): a
 * project latches once every armed row is reconcile-CONFIRMED landed (real sha AND episode_uuid —
 * 202 ≠ extracted), and once latched stays latched. SUPPRESSION is the separate read-time conjunct
 * (Codex-plan Blocker 3): a partition owing a purge is omitted from enforced reads until the purge
 * confirms — narrowing fails closed — without ever un-latching.
 *
 * Sole writer of `graph_project_arming`; the graph_episodes flip lives in lib/graph/project
 * (its single-writer boundary).
 */
export async function armProjectsForPrincipal(
  db: DbClient,
  args: { teamId: string; projectIds: readonly string[] }
): Promise<void> {
  if (args.projectIds.length === 0) return;
  // Arming state — the ROW is first-wins and permanent; ready_at tells latched from pending.
  const armed = new Map<string, boolean>(); // projectId -> latched?
  for (const batch of chunk([...args.projectIds], IN_CLAUSE_BATCH)) {
    const { data, error } = await db
      .from("graph_project_arming")
      .select("project_id, ready_at")
      .eq("team_id", args.teamId)
      .in("project_id", batch);
    if (error) throw new Error(`arming read failed: ${error.message}`);
    for (const r of (data ?? []) as { project_id: string; ready_at: string | null }[]) {
      armed.set(r.project_id, r.ready_at != null);
    }
  }
  const fresh = args.projectIds.filter((p) => !armed.has(p));

  const groupByProject = new Map<string, string>();
  for (const batch of chunk([...args.projectIds], IN_CLAUSE_BATCH)) {
    const { data, error } = await db
      .from("projects")
      .select("id, graph_group_id")
      .eq("team_id", args.teamId)
      .in("id", batch)
      .not("graph_group_id", "is", null);
    if (error) throw new Error(`arming pointer read failed: ${error.message}`);
    for (const r of (data ?? []) as { id: string; graph_group_id: string }[]) groupByProject.set(r.id, r.graph_group_id);
  }

  // WHICH projects get the bulk deferred flip is the latch's snapshot semantics (Codex code-review
  // Blocker 2 — the design's arm-time obligation snapshot, with no extra schema):
  //   FRESH    → flip: this IS the arm-time snapshot being taken.
  //   LATCHED  → flip: late-tagged content extracts eventually; the latch is already set and
  //              monotone, so new obligations can never block it.
  //   ARMED-BUT-UNLATCHED → flip ONLY when the snapshot was never taken (zero non-deferred rows in
  //              the group). Two producers of that state, one routine: arm-on-restrict's first
  //              pass writes the arming row before the fan-out row exists to flip, and a crashed
  //              arm dies between its row write and its flip. Taking the snapshot now is the
  //              liveness repair — without it those rows stay deferred and the partition dark
  //              forever. Otherwise DO NOT flip: the first latch must evaluate
  //              exactly the rows the first arm flipped. Re-arms feeding every later tag into the
  //              pending obligation set is precisely the busy-project starvation the design
  //              rejected (rows tagged after the snapshot stay deferred — invisible to the latch —
  //              until a post-latch arm).
  // (Restriction-arms are separate, per-item, and deliberately unconditional: a moved item's copy
  // is REQUIRED content for its partition, so it may — must — hold that partition's first latch.)
  const armedUnlatched = args.projectIds.filter((p) => armed.get(p) === false);
  const neverSnapshotted = new Set<string>();
  if (armedUnlatched.length > 0) {
    const probeGroups = armedUnlatched.map((p) => groupByProject.get(p)).filter((g): g is string => g != null);
    if (probeGroups.length > 0) {
      const probe = await runSql<{ group_id: string }>(
        `select group_id from graph_episodes where team_id = $1 and group_id = any($2) and deferred = false group by group_id`,
        [args.teamId, probeGroups]
      );
      const snapshotted = new Set(probe.rows.map((r) => r.group_id));
      for (const p of armedUnlatched) {
        const g = groupByProject.get(p);
        if (g != null && !snapshotted.has(g)) neverSnapshotted.add(p);
      }
    }
  }
  const flipEligible = args.projectIds.filter(
    (p) => !armed.has(p) || armed.get(p) === true || neverSnapshotted.has(p)
  );
  const groups = [...new Set(flipEligible.map((p) => groupByProject.get(p)).filter((g): g is string => g != null))];

  // Row first, flip second: a crash between the two leaves an armed project with zero non-deferred
  // rows — exactly the never-snapshotted state the eligibility above repairs on the next arm touch.
  // (readyPartitions refuses to latch that state, so the window can't latch vacuously either.) The
  // reverse order would be worse: flipped rows with no arming record push without any latch ever
  // forming.
  await ensureArmingRows(db, args.teamId, fresh);
  if (groups.length > 0) await armDeferredRowsForGroups(db, args.teamId, groups);
}

/** Evaluate (and latch) readiness + read-time suppression for the given projects. */
export async function readyPartitions(
  db: DbClient,
  args: { teamId: string; projects: readonly { id: string; group: string }[] }
): Promise<{ ready: Set<string>; suppressed: Set<string> }> {
  const ready = new Set<string>();
  const suppressed = new Set<string>();
  if (args.projects.length === 0) return { ready, suppressed };

  const byGroup = new Map(args.projects.map((p) => [p.group, p.id]));
  const groups = [...byGroup.keys()];

  // Latched already?
  const { data: armData, error: armErr } = await db
    .from("graph_project_arming")
    .select("project_id, ready_at")
    .eq("team_id", args.teamId)
    .in("project_id", args.projects.map((p) => p.id)); // bounded by the caller's oracle-visible set (≤ team project count) — no 65k-bind risk at any real cardinality
  if (armErr) throw new Error(`arming state read failed: ${armErr.message}`);
  const armRows = (armData ?? []) as { project_id: string; ready_at: string | null }[];
  const armedIds = new Set(armRows.map((r) => r.project_id));
  for (const r of armRows) if (r.ready_at) ready.add(r.project_id);

  // One aggregate over the groups: outstanding obligations (armed rows not confirmed landed) and
  // outstanding purges. Deferred rows are NOT obligations (they join the snapshot at a later arm) —
  // EXCEPT when the group holds ONLY deferred rows: the arm-time snapshot was never taken (the arm
  // crashed between its row write and its flip), and latching over an untaken snapshot is the
  // vacuous-readiness defect this design's history rejects. The arm path repairs that state on its
  // next touch; until then the latch must refuse, not lie.
  const agg = await runSql<{ group_id: string; unlanded: number; purging: number; snapshotted: boolean }>(
    `select group_id,
            count(*) filter (where deferred = false and pending_delete_group_id is null and (content_sha256 = '' or episode_uuid is null))::int as unlanded,
            count(*) filter (where pending_delete_group_id = group_id)::int as purging,
            bool_or(deferred = false) as snapshotted
       from graph_episodes
      where team_id = $1 and group_id = any($2)
      group by group_id`,
    [args.teamId, groups]
  );
  const byAggGroup = new Map(agg.rows.map((r) => [r.group_id, r]));

  for (const [group, projectId] of byGroup) {
    const a = byAggGroup.get(group);
    if ((a?.purging ?? 0) > 0) suppressed.add(projectId);
    if (ready.has(projectId)) continue; // latched — nothing to re-evaluate, by design
    if (!armedIds.has(projectId)) continue; // never armed — never ready
    if (a != null && !a.snapshotted) continue; // rows exist but ALL deferred — snapshot never taken
    if ((a?.unlanded ?? 0) === 0) {
      // Latch. `.is("ready_at", null)` keeps a concurrent evaluator from bumping the timestamp —
      // the latch is set exactly once.
      const { error } = await db
        .from("graph_project_arming")
        .update({ ready_at: new Date().toISOString() })
        .eq("team_id", args.teamId)
        .eq("project_id", projectId)
        .is("ready_at", null);
      if (error) throw new Error(`readiness latch failed for project ${projectId}: ${error.message}`);
      ready.add(projectId);
    }
  }
  return { ready, suppressed };
}
