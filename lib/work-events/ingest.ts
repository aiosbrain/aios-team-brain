import "server-only";

import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import type { WorkEventPayload } from "@/lib/api/schemas";
import { extractWorkKeys } from "@/lib/pm-sync/work-keys";
import { projectTask, projectionToSyncReport, type ProjectionTaskRow, type TaskPmSyncReport } from "@/lib/pm-sync";

export interface WorkEventAuth {
  teamId: string;
  memberId: string;
  apiKeyId: string;
}

export interface AppliedWorkEvent {
  row_key: string;
  task_id: string;
}

export interface WorkEventIngestResult {
  status: "ok";
  applied: AppliedWorkEvent[];
  unresolved: { row_key: string }[];
  pm_sync: TaskPmSyncReport[];
}

function eventKeys(payload: WorkEventPayload): string[] {
  const keys = payload.work_keys.length
    ? payload.work_keys
    : extractWorkKeys({ title: payload.pr_title, body: payload.pr_body, branch: payload.branch });
  const unique = [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
  return unique.length ? unique : [`unresolved:${payload.merged_sha.slice(0, 12)}`];
}

export async function ingestWorkEvent(
  db: DbClient,
  auth: WorkEventAuth,
  payload: WorkEventPayload,
  opts: { syncPm?: boolean; fetchImpl?: typeof fetch } = {}
): Promise<WorkEventIngestResult> {
  const now = new Date().toISOString();
  const { data: project } = await db
    .from("projects")
    .select("id")
    .eq("team_id", auth.teamId)
    .eq("slug", payload.project)
    .maybeSingle();

  const projectId = (project as { id: string } | null)?.id ?? null;
  const applied: AppliedWorkEvent[] = [];
  const unresolved: { row_key: string }[] = [];
  const pm_sync: TaskPmSyncReport[] = [];

  for (const rowKey of eventKeys(payload)) {
    const { data: task } = projectId
      ? await db
          .from("tasks")
          .select("id, team_id, project_id, row_key")
          .eq("team_id", auth.teamId)
          .eq("project_id", projectId)
          .eq("row_key", rowKey)
          .maybeSingle()
      : { data: null };

    const found = task as { id: string; team_id: string; project_id: string; row_key: string } | null;
    const status = found ? "applied" : "unresolved";

    const { data: event, error: eventErr } = await db
      .from("work_events")
      .upsert(
        {
          team_id: auth.teamId,
          project_id: projectId,
          task_id: found?.id ?? null,
          row_key: rowKey,
          event_kind: payload.event_kind,
          repo: payload.repo,
          merged_sha: payload.merged_sha,
          pr_url: payload.pr_url,
          pr_title: payload.pr_title,
          pr_body: payload.pr_body,
          actor: payload.actor,
          status,
          error: found ? null : "no matching task row",
          updated_at: now,
        },
        { onConflict: "team_id,repo,merged_sha,row_key,event_kind" }
      )
      .select("id")
      .single();
    if (eventErr || !event) throw new Error(`work event upsert failed: ${eventErr?.message}`);

    if (!found) {
      unresolved.push({ row_key: rowKey });
      await audit(db, {
        team_id: auth.teamId,
        actor_kind: "api_key",
        member_id: auth.memberId,
        api_key_id: auth.apiKeyId,
        action: "work_event.unresolved",
        target_type: "work_event",
        target_id: (event as { id: string }).id,
        meta: { row_key: rowKey, repo: payload.repo, merged_sha: payload.merged_sha },
      });
      continue;
    }

    const { error: taskErr } = await db
      .from("tasks")
      .update({ status: "done", updated_at: now })
      .eq("id", found.id)
      .eq("team_id", auth.teamId);
    if (taskErr) throw new Error(`task completion update failed: ${taskErr.message}`);
    applied.push({ row_key: rowKey, task_id: found.id });

    await audit(db, {
      team_id: auth.teamId,
      actor_kind: "api_key",
      member_id: auth.memberId,
      api_key_id: auth.apiKeyId,
      action: "work_event.applied",
      target_type: "task",
      target_id: found.id,
      meta: { row_key: rowKey, repo: payload.repo, merged_sha: payload.merged_sha, pr_url: payload.pr_url },
    });

    if (opts.syncPm !== false) {
      // Full projection (not done-only): load the now-done task row and project it through the
      // upsert path so a task with no pre-existing link/item still gets created + linked.
      const { data: fullRow } = await db
        .from("tasks")
        .select("id, team_id, project_id, row_key, title, status, sprint, priority, labels, body, parent_row_key")
        .eq("id", found.id)
        .maybeSingle();
      if (fullRow) {
        const report = await projectTask(db, fullRow as ProjectionTaskRow, { fetchImpl: opts.fetchImpl });
        pm_sync.push(projectionToSyncReport(report));
      }
    }
  }

  return { status: "ok", applied, unresolved, pm_sync };
}
