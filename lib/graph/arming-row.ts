import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * THE writer of `graph_project_arming` rows (extracted so BOTH arm paths can insert without an
 * import cycle: lib/graph/arming → project for the deferred flip, lib/graph/project → here for
 * arm-on-restrict — review-2 Blocker 1: flipping the copies without the arming ROW left the
 * partition permanently un-latchable, so a PERMISSIVE team's restriction-moved content vanished
 * from the graph forever, since no permissive read ever arms).
 *
 * First-wins and permanent; a racer's duplicate insert is benign. Ready-latching lives in
 * lib/graph/arming.readyPartitions.
 */
export async function ensureArmingRows(
  db: DbClient,
  teamId: string,
  projectIds: readonly string[]
): Promise<void> {
  for (const projectId of projectIds) {
    const { error } = await db.from("graph_project_arming").insert({ team_id: teamId, project_id: projectId });
    // Benign on the pkey race AND on generic duplicate wording (review-2 Low 9: a bare
    // constraint-name match breaks loudly-on-benign if the adapter's message shape drifts).
    if (error && !/graph_project_arming_pkey|duplicate key/i.test(error.message)) {
      throw new Error(`arming row write failed for project ${projectId}: ${error.message}`);
    }
  }
}
