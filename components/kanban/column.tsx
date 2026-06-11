"use client";

import { useDroppable } from "@dnd-kit/core";
import { TaskCard } from "./task-card";
import { STATUS_LABELS, type Task, type TaskStatus } from "./types";

const DOT: Record<TaskStatus, string> = {
  backlog: "bg-ink-tertiary",
  ready: "bg-cyan",
  in_progress: "bg-violet",
  blocked: "bg-red",
  done: "bg-emerald",
};

export function Column({ status, tasks }: { status: TaskStatus; tasks: Task[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div
      ref={setNodeRef}
      className={`flex min-h-64 w-64 shrink-0 flex-col rounded-xl border px-2.5 py-3 transition-colors ${
        isOver
          ? "border-violet/40 bg-violet/5"
          : "border-border-subtle bg-surface-card"
      }`}
    >
      <div className="mb-3 flex items-center gap-2 px-1.5">
        <span className={`size-2 rounded-full ${DOT[status]}`} />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-secondary">
          {STATUS_LABELS[status]}
        </h3>
        <span className="ml-auto text-xs text-ink-tertiary">{tasks.length}</span>
      </div>
      <div className="flex flex-1 flex-col gap-2">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} />
        ))}
      </div>
    </div>
  );
}
