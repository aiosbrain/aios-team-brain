import type { Metadata } from "next";
import Link from "next/link";
import { ListTodo, ScanLine } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { getSessionUser } from "@/lib/auth/session";
import { currentMember } from "@/lib/auth/guard";
import { rowVisibleByProvenanceCtx } from "@/lib/access/provenance";
import { Board } from "@/components/kanban/board";
import { TaskHierarchy } from "@/components/kanban/task-hierarchy";
import { EmptyState } from "@/components/empty-state";
import type { MemberOption, ProjectOption, Task } from "@/components/kanban/types";

export const metadata: Metadata = { title: "Tasks" };

export default async function TasksPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const db = await serverClient();

  const { data: team } = await db
    .from("teams")
    .select("id")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null;

  const user = await getSessionUser();
  const viewer = await currentMember(team.id);
  // Posture still gates the team-only WRITE affordance below (meeting extraction); it no longer
  // gates what the board READS (TIERRET-1).
  const tier = viewer?.tier ?? "external";
  // ENFB-1: the board serves task BODIES — the settled provenance rule gates each row (sourced →
  // source item in the viewer's oracle set; null-source → hand-typed and admitted). TIERRET-1: the
  // reader and its label ceiling come from the one admission resolver (an admitted member has no
  // audience ceiling). Resolved once; no member → empty board (fail closed).
  const { visibleProjectRows } = await import("@/lib/access/enforce");
  const { resolveContentView, contentLabelTier, provenanceCtxFor } = await import("@/lib/access/admission");
  const { adminClient } = await import("@/lib/db/admin");
  const vis = viewer ? await resolveContentView(adminClient(), team.id, viewer.id) : null;
  const provCtx = vis ? provenanceCtxFor(vis) : { visibleItemIds: new Set<string>(), teamPosture: false };
  // ENFB-2 §2.1: the create-form dropdown lists only containers this member may FILE into — the
  // WRITER row set (unchanged by TIERRET-1), NOT vis.projectIds (the granted set).
  const projRows = viewer ? await visibleProjectRows(adminClient(), { teamId: team.id, memberId: viewer.id }) : null;

  // PM links are fetched as a sibling query and grouped in JS rather than as an embedded resource:
  // the pg adapter (the deployed backend) only supports to-many embeds as `(count)`, so a
  // `task_pm_links(provider, ...)` embed silently returns no tasks. A separate named-column query
  // works on both backends and keeps the per-task badge wiring intact.
  // ENFB-2 §2.2: the 500-row board window compiles the provenance predicate IN-QUERY via the
  // structured-windows domain service (the post-LIMIT filter below stays as the guard-pinned
  // defense-in-depth layer over the same contract) — invisible rows can no longer starve
  // visible ones out of the window. The label conjunct applies only under the reader's ceiling.
  const { boardTaskWindow } = await import("@/lib/access/structured-windows");
  const boardTasksP = boardTaskWindow<Task & { source_item_id?: string | null; created_by?: string | null; project_id?: string | null }>(
    team.id,
    provCtx,
    vis ? contentLabelTier(vis.admission) === "external" : true
  ).then((rows) => ({ data: rows }));
  const [{ data: tasks }, { data: links }, { data: projects }, { data: members }, { data: me }] =
    await Promise.all([
      boardTasksP,
      db
        .from("task_pm_links")
        .select("task_id, provider, provider_url, last_synced_status, last_error")
        .eq("team_id", team.id),
      db
        .from("projects")
        .select("id, slug, name")
        .eq("team_id", team.id)
        .in("id", projRows && !projRows.error ? [...projRows.ids] : [])
        .order("slug"),
      db
        .from("members")
        .select("id, display_name, actor_handle")
        .eq("team_id", team.id)
        .eq("status", "active")
        .order("display_name"),
      db
        .from("members")
        .select("id")
        .eq("team_id", team.id)
        .eq("auth_user_id", user?.id ?? "")
        .eq("status", "active")
        .maybeSingle(),
    ]);

  type LinkRow = { task_id: string | null } & NonNullable<Task["task_pm_links"]>[number];
  const linksByTask = new Map<string, NonNullable<Task["task_pm_links"]>>();
  for (const l of (links ?? []) as LinkRow[]) {
    if (!l.task_id) continue;
    const { task_id, ...badge } = l;
    const arr = linksByTask.get(task_id) ?? [];
    arr.push(badge);
    linksByTask.set(task_id, arr);
  }
  const taskRows = ((tasks ?? []) as (Task & { source_item_id?: string | null; created_by?: string | null; project_id?: string | null })[])
    // ENFB-1 provenance rule — the ONE shared owner (lib/access/provenance), over the same ctx.
    .filter((t) => rowVisibleByProvenanceCtx(t, provCtx))
    .map((t) => ({
      ...t,
      task_pm_links: linksByTask.get(t.id) ?? [],
    }));

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-ink">Tasks</h1>
        {tier === "team" ? (
          <Link href={`/t/${teamSlug}/tasks/extract`} className="btn-ghost">
            <ScanLine className="size-4" />
            Extract from meetings
          </Link>
        ) : null}
      </div>
      {taskRows.length === 0 && (projects ?? []).length === 0 ? (
        <EmptyState
          icon={ListTodo}
          title="No tasks yet"
          action="Tasks appear here when a synced tasks.md lands via aios push, or once a project exists you can create them with the New task button."
        />
      ) : (
        <>
          <TaskHierarchy tasks={taskRows} />
          <Board
            teamId={team.id}
            initialTasks={taskRows}
            projects={(projects ?? []) as ProjectOption[]}
            members={(members ?? []) as MemberOption[]}
            myMemberId={me?.id ?? ""}
          />
        </>
      )}
    </div>
  );
}
