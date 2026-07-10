import type { Metadata } from "next";
import Link from "next/link";
import { ListTodo, ScanLine } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { getSessionUser } from "@/lib/auth/session";
import { currentMember } from "@/lib/auth/guard";
import { visibleTasks } from "@/lib/auth/visibility";
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
  // Tier isolation (audit H1): an external-tier dashboard member must not see internal task boards.
  const viewer = await currentMember(team.id);
  const tier = viewer?.tier ?? "external";

  // PM links are fetched as a sibling query and grouped in JS rather than as an embedded resource:
  // the pg adapter (the deployed backend) only supports to-many embeds as `(count)`, so a
  // `task_pm_links(provider, ...)` embed silently returns no tasks. A separate named-column query
  // works on both backends and keeps the per-task badge wiring intact.
  const [{ data: tasks }, { data: links }, { data: projects }, { data: members }, { data: me }] =
    await Promise.all([
      visibleTasks(
        db
          .from("tasks")
          .select("id, row_key, title, assignee, status, sprint, due_date, origin, project_id, updated_at, parent_row_key, labels, priority, body")
          .eq("team_id", team.id)
          .order("updated_at", { ascending: false })
          .limit(500),
        tier
      ),
      db
        .from("task_pm_links")
        .select("task_id, provider, provider_url, last_synced_status, last_error")
        .eq("team_id", team.id),
      db
        .from("projects")
        .select("id, slug, name")
        .eq("team_id", team.id)
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
  const taskRows = ((tasks ?? []) as Task[]).map((t) => ({
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
