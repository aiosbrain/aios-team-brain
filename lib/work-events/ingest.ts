import "server-only";

import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import type { WorkEventPayload } from "@/lib/api/schemas";
import { extractWorkKeys } from "@/lib/pm-sync/work-keys";
import { resolveWorkEventTask, type TaskCandidate } from "./resolve-task";
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
  /** Matched TEAM-WIDE (the project-scope fix): `task_id` recorded, but the task was NOT completed and
   *  NOT written back to the PM tool. Additive to the response — `applied` keeps its exact meaning. */
  linked: AppliedWorkEvent[];
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
  const linked: AppliedWorkEvent[] = [];
  const unresolved: { row_key: string }[] = [];
  const pm_sync: TaskPmSyncReport[] = [];

  for (const rowKey of eventKeys(payload)) {
    // TEAM-WIDE candidate fetch (the project-scope fix): a work-key identifies one issue within a TEAM,
    // and Linear-mirrored tasks live in `linear-<teamKey>`, not the repo's project. `resolveWorkEventTask`
    // then decides: pushed-project hit → `applied` (legacy behavior, completes + projects); team-wide hit →
    // `linked` (records task_id ONLY — no completion, no PM write-back); else `unresolved`.
    const { data: candidateRows } = await db
      .from("tasks")
      .select("id, project_id, projects(slug)")
      .eq("team_id", auth.teamId)
      .eq("row_key", rowKey);
    const candidates: TaskCandidate[] = (
      (candidateRows ?? []) as { id: string; project_id: string; projects?: { slug: string | null } | null }[]
    ).map((r) => ({ id: r.id, project_id: r.project_id, projectSlug: r.projects?.slug ?? null }));

    const outcome = resolveWorkEventTask(rowKey, candidates, projectId);
    const status = outcome.status;

    const { data: event, error: eventErr } = await db
      .from("work_events")
      .upsert(
        {
          team_id: auth.teamId,
          project_id: projectId,
          // `linked` records the task too — that id is what lets the Timeline nest a PR's commits under it.
          task_id: outcome.status === "unresolved" ? null : outcome.taskId,
          row_key: rowKey,
          event_kind: payload.event_kind,
          repo: payload.repo,
          merged_sha: payload.merged_sha,
          pr_url: payload.pr_url,
          pr_title: payload.pr_title,
          pr_body: payload.pr_body,
          actor: payload.actor,
          status,
          error: outcome.status === "unresolved" ? outcome.error : null,
          updated_at: now,
        },
        { onConflict: "team_id,repo,merged_sha,row_key,event_kind" }
      )
      .select("id")
      .single();
    if (eventErr || !event) throw new Error(`work event upsert failed: ${eventErr?.message}`);

    if (outcome.status === "unresolved") {
      unresolved.push({ row_key: rowKey });
      await audit(db, {
        team_id: auth.teamId,
        actor_kind: "api_key",
        member_id: auth.memberId,
        api_key_id: auth.apiKeyId,
        action: "work_event.unresolved",
        target_type: "work_event",
        target_id: (event as { id: string }).id,
        meta: { row_key: rowKey, repo: payload.repo, merged_sha: payload.merged_sha, reason: outcome.error },
      });
      continue;
    }

    if (outcome.status === "linked") {
      // LINK-ONLY: the task is recorded but deliberately NOT completed and NOT projected back to the PM
      // tool (see resolve-task.ts for why: duplicate-issue, edit-clobber, and mention-vs-fix hazards).
      // Audit what completion WOULD have done, so a week of real data can be reviewed before enabling it.
      linked.push({ row_key: rowKey, task_id: outcome.taskId });
      await audit(db, {
        team_id: auth.teamId,
        actor_kind: "api_key",
        member_id: auth.memberId,
        api_key_id: auth.apiKeyId,
        action: "work_event.would_complete",
        target_type: "task",
        target_id: outcome.taskId,
        meta: { row_key: rowKey, repo: payload.repo, merged_sha: payload.merged_sha, pr_url: payload.pr_url },
      });
      continue;
    }

    const { error: taskErr } = await db
      .from("tasks")
      .update({ status: "done", updated_at: now })
      .eq("id", outcome.taskId)
      .eq("team_id", auth.teamId);
    if (taskErr) throw new Error(`task completion update failed: ${taskErr.message}`);
    applied.push({ row_key: rowKey, task_id: outcome.taskId });

    await audit(db, {
      team_id: auth.teamId,
      actor_kind: "api_key",
      member_id: auth.memberId,
      api_key_id: auth.apiKeyId,
      action: "work_event.applied",
      target_type: "task",
      target_id: outcome.taskId,
      meta: { row_key: rowKey, repo: payload.repo, merged_sha: payload.merged_sha, pr_url: payload.pr_url },
    });

    if (opts.syncPm !== false) {
      // Full projection (not done-only): load the now-done task row and project it through the
      // upsert path so a task with no pre-existing link/item still gets created + linked.
      const { data: fullRow } = await db
        .from("tasks")
        .select("id, team_id, project_id, row_key, title, status, sprint, priority, labels, body, parent_row_key")
        .eq("id", outcome.taskId)
        .maybeSingle();
      if (fullRow) {
        const report = await projectTask(db, fullRow as ProjectionTaskRow, { fetchImpl: opts.fetchImpl });
        pm_sync.push(projectionToSyncReport(report));
      }
    }
  }

  return { status: "ok", applied, linked, unresolved, pm_sync };
}
