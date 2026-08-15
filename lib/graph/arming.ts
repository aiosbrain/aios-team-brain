import "server-only";
import type { DbClient } from "@/lib/db/types";
import { armDeferredRowsForGroups } from "./project";
import { chunk, IN_CLAUSE_BATCH } from "@/lib/db/batch";
import { runSql } from "@/lib/db/pg/pool";

/**
 * Arm-on-read + the read-ready MONOTONE latch (PCCC-6; design §2.2/§2.3, three review rounds).
 *
 * ARMING is a side effect of an enforcing team-tier principal's read: their oracle-visible
 * initiative projects get an arming row and their deferred fan-out rows flip pushable — the
 * projector's next pass extracts under its budget. The first query arms-and-omits; later queries
 * get the leg. The obligation snapshot IS the set of rows armed at that moment (no id array):
 * items tagged later arrive DEFERRED and don't join the snapshot until a later arm.
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
  // Which are already armed? (Arming is first-wins and permanent.)
  const armed = new Set<string>();
  for (const batch of chunk([...args.projectIds], IN_CLAUSE_BATCH)) {
    const { data, error } = await db
      .from("graph_project_arming")
      .select("project_id")
      .eq("team_id", args.teamId)
      .in("project_id", batch);
    if (error) throw new Error(`arming read failed: ${error.message}`);
    for (const r of (data ?? []) as { project_id: string }[]) armed.add(r.project_id);
  }
  const fresh = args.projectIds.filter((p) => !armed.has(p));

  // The FLIP runs for EVERY requested project — fresh AND already-armed. First-wins applies to the
  // arming ROW only: a project armed last week whose items were tagged yesterday holds deferred
  // rows that nothing else ever flips — without this, late-tagged content on an armed project
  // would stay un-extracted forever (caught while proving the latch monotone: the late rows are
  // exactly what the latch must survive). The latch keeps readiness monotone through the flip.
  const groups: string[] = [];
  for (const batch of chunk([...args.projectIds], IN_CLAUSE_BATCH)) {
    const { data, error } = await db
      .from("projects")
      .select("id, graph_group_id")
      .eq("team_id", args.teamId)
      .in("id", batch)
      .not("graph_group_id", "is", null);
    if (error) throw new Error(`arming pointer read failed: ${error.message}`);
    for (const r of (data ?? []) as { id: string; graph_group_id: string }[]) groups.push(r.graph_group_id);
  }

  // Row first, flip second: a crash between the two leaves an armed project whose rows flip on the
  // NEXT arm touch (readiness simply stays unlatched meanwhile) — never flipped rows with no
  // arming record, which would push without any latch ever forming.
  for (const projectId of fresh) {
    const { error } = await db.from("graph_project_arming").insert({ team_id: args.teamId, project_id: projectId });
    // A racer's insert is benign — first arm wins, both flips are idempotent.
    if (error && !error.message.includes("graph_project_arming_pkey")) {
      throw new Error(`arming write failed for project ${projectId}: ${error.message}`);
    }
  }
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
    .in("project_id", args.projects.map((p) => p.id));
  if (armErr) throw new Error(`arming state read failed: ${armErr.message}`);
  const armRows = (armData ?? []) as { project_id: string; ready_at: string | null }[];
  const armedIds = new Set(armRows.map((r) => r.project_id));
  for (const r of armRows) if (r.ready_at) ready.add(r.project_id);

  // One aggregate over the groups: outstanding obligations (armed rows not confirmed landed) and
  // outstanding purges. Deferred rows are NOT obligations (they join the snapshot at a later arm).
  const agg = await runSql<{ group_id: string; unlanded: number; purging: number }>(
    `select group_id,
            count(*) filter (where deferred = false and (content_sha256 = '' or episode_uuid is null))::int as unlanded,
            count(*) filter (where pending_delete_group_id = group_id)::int as purging
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
