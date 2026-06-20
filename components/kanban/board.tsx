"use client";

import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { LayoutGrid, List, Plus } from "lucide-react";
import { moveTaskAction } from "@/app/actions/tasks";
import { fmtDate } from "@/components/format";
import { Column } from "./column";
import { TaskCard } from "./task-card";
import { NewTaskDialog } from "./new-task-dialog";
import {
  STATUS_LABELS,
  TASK_STATUSES,
  type MemberOption,
  type ProjectOption,
  type Task,
  type TaskStatus,
} from "./types";

export function Board({
  teamId,
  initialTasks,
  projects,
  members,
  myMemberId,
}: {
  teamId: string;
  initialTasks: Task[];
  projects: ProjectOption[];
  members: MemberOption[];
  myMemberId: string;
}) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [view, setView] = useState<"board" | "list">("board");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [active, setActive] = useState<Task | null>(null);
  const [error, setError] = useState("");

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const byStatus = useMemo(() => {
    const map = Object.fromEntries(TASK_STATUSES.map((s) => [s, [] as Task[]])) as Record<
      TaskStatus,
      Task[]
    >;
    for (const t of tasks) (map[t.status] ?? map.backlog).push(t);
    return map;
  }, [tasks]);

  function onDragStart(e: DragStartEvent) {
    setActive((e.active.data.current?.task as Task) ?? null);
  }

  async function onDragEnd(e: DragEndEvent) {
    setActive(null);
    const task = e.active.data.current?.task as Task | undefined;
    const target = e.over?.id as TaskStatus | undefined;
    if (!task || !target || !TASK_STATUSES.includes(target) || task.status === target) return;

    const previous = tasks;
    const updatedAt = new Date().toISOString();
    // optimistic move
    setTasks((ts) =>
      ts.map((t) => (t.id === task.id ? { ...t, status: target, updated_at: updatedAt } : t))
    );
    setError("");

    const res = await moveTaskAction(task.id, target);
    if (!res.ok) {
      setTasks(previous); // revert
      setError(`Could not move "${task.title}": ${res.error}`);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-border-subtle bg-surface-card p-0.5">
          <button
            type="button"
            onClick={() => setView("board")}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              view === "board" ? "bg-violet/10 text-violet" : "text-ink-tertiary hover:text-ink"
            }`}
          >
            <LayoutGrid className="size-3.5" /> Board
          </button>
          <button
            type="button"
            onClick={() => setView("list")}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              view === "list" ? "bg-violet/10 text-violet" : "text-ink-tertiary hover:text-ink"
            }`}
          >
            <List className="size-3.5" /> List
          </button>
        </div>
        <button type="button" onClick={() => setDialogOpen(true)} className="btn-prism">
          <Plus className="size-4" /> New task
        </button>
      </div>

      {error ? (
        <p className="rounded-lg border border-red/30 bg-red/5 px-3 py-2 text-sm text-red">{error}</p>
      ) : null}

      {view === "board" ? (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div className="flex gap-3 overflow-x-auto pb-4">
            {TASK_STATUSES.map((status) => (
              <Column key={status} status={status} tasks={byStatus[status]} />
            ))}
          </div>
          <DragOverlay>{active ? <TaskCard task={active} overlay /> : null}</DragOverlay>
        </DndContext>
      ) : (
        <div className="prism-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-default text-left text-xs uppercase tracking-wider text-ink-tertiary">
                <th className="px-4 py-3 font-medium">Key</th>
                <th className="px-4 py-3 font-medium">Title</th>
                <th className="px-4 py-3 font-medium">Assignee</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">PM sync</th>
                <th className="px-4 py-3 font-medium">Sprint</th>
                <th className="px-4 py-3 font-medium">Due</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id} className="border-b border-border-subtle last:border-0">
                  <td className="px-4 py-2.5 font-mono text-xs text-ink-tertiary">
                    {t.row_key ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-ink">{t.title}</td>
                  <td className="px-4 py-2.5 text-ink-secondary">{t.assignee || "—"}</td>
                  <td className="px-4 py-2.5 text-ink-secondary">{STATUS_LABELS[t.status]}</td>
                  <td className="px-4 py-2.5 text-ink-secondary">
                    {t.task_pm_links?.length ? (
                      <span className={t.task_pm_links.some((l) => l.last_error) ? "text-red" : "text-emerald-700"}>
                        {t.task_pm_links.map((l) => `${l.provider}${l.last_synced_status ? `:${l.last_synced_status}` : ""}`).join(", ")}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-ink-secondary">{t.sprint || "—"}</td>
                  <td className="px-4 py-2.5 text-ink-secondary">
                    {t.due_date ? fmtDate(t.due_date) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialogOpen ? (
        <NewTaskDialog
          teamId={teamId}
          myMemberId={myMemberId}
          projects={projects}
          members={members}
          onCreated={(task) => setTasks((ts) => [task, ...ts])}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}
