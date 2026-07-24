import "server-only";
import type { DbClient } from "@/lib/db/types";
import { resolveWorkEventTask, isIssueShapedKey, type TaskCandidate } from "./resolve-task";

/**
 * LINK-ONLY backfill for work_events stranded `unresolved` by the project-scope bug (the lookup searched
 * only the pushed project, so a Linear-mirrored task in `linear-<teamKey>` could never be found — see
 * docs/design/pr-task-link-propagation.md).
 *
 * Writes ONLY `task_id` + `status='linked'`. It NEVER completes a task and NEVER projects back to the PM
 * tool — so re-resolving historical PRs cannot mass-mutate a live Linear workspace (the hazard that made a
 * naive backfill unshippable). Idempotent: a second run finds nothing left `unresolved` to link.
 *
 * Scoped to ISSUE-SHAPED keys — the extractor emits junk (`V1`, `GPT-5`) that must never match team-wide.
 */

export interface RelinkSummary {
  scanned: number;
  linked: number;
}

export async function relinkUnresolvedWorkEvents(db: DbClient, teamId: string): Promise<RelinkSummary> {
  const { data: rows, error } = await db
    .from("work_events")
    .select("id, row_key, project_id")
    .eq("team_id", teamId)
    .eq("status", "unresolved");
  if (error) throw new Error(`relink work_events read failed: ${error.message}`);

  const events = ((rows ?? []) as { id: string; row_key: string; project_id: string | null }[]).filter((e) =>
    isIssueShapedKey(e.row_key)
  );
  if (events.length === 0) return { scanned: 0, linked: 0 };

  // One read for every candidate task carrying any of these keys (team-scoped), then decide per event.
  const keys = [...new Set(events.map((e) => e.row_key))];
  const { data: taskRows, error: taskErr } = await db
    .from("tasks")
    .select("id, row_key, project_id, projects(slug)")
    .eq("team_id", teamId)
    .in("row_key", keys);
  if (taskErr) throw new Error(`relink tasks read failed: ${taskErr.message}`);

  const byKey = new Map<string, TaskCandidate[]>();
  for (const t of (taskRows ?? []) as {
    id: string;
    row_key: string;
    project_id: string;
    projects?: { slug: string | null } | null;
  }[]) {
    const list = byKey.get(t.row_key) ?? [];
    list.push({ id: t.id, project_id: t.project_id, projectSlug: t.projects?.slug ?? null });
    byKey.set(t.row_key, list);
  }

  let linked = 0;
  for (const e of events) {
    // Pass `null` as the pushed project: these rows are already known-unresolved under their own project,
    // so only the team-wide (LINK-ONLY) outcome can apply — a backfill must never produce `applied`.
    const outcome = resolveWorkEventTask(e.row_key, byKey.get(e.row_key) ?? [], null);
    if (outcome.status !== "linked") continue;
    const { error: upErr } = await db
      .from("work_events")
      .update({ task_id: outcome.taskId, status: "linked", error: null, updated_at: new Date().toISOString() })
      .eq("id", e.id)
      .eq("status", "unresolved"); // never clobber a row that resolved concurrently
    if (upErr) throw new Error(`relink work_event ${e.id} failed: ${upErr.message}`);
    linked++;
  }
  return { scanned: events.length, linked };
}
