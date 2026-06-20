"use client";

import { useDraggable } from "@dnd-kit/core";
import { Clock } from "lucide-react";
import { fmtDate } from "@/components/format";
import type { Task } from "./types";

export function TaskCard({ task, overlay = false }: { task: Task; overlay?: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: { task },
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`prism-card prism-card-hover cursor-grab bg-surface-inset px-3.5 py-3 active:cursor-grabbing ${
        isDragging && !overlay ? "opacity-40" : ""
      } ${overlay ? "rotate-2 shadow-[0_8px_30px_rgba(124,58,237,0.18)]" : ""}`}
    >
      <p className="text-sm font-medium leading-snug text-ink">{task.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-tertiary">
        {task.row_key ? <span className="font-mono">{task.row_key}</span> : null}
        {task.assignee ? <span className="font-medium text-violet">{task.assignee}</span> : null}
        {task.sprint ? <span>{task.sprint}</span> : null}
        {task.task_pm_links?.map((link) => (
          <span
            key={link.provider}
            className={link.last_error ? "font-medium text-red" : "font-medium text-emerald-700"}
            title={link.last_error || link.last_synced_status || "PM link"}
          >
            {link.provider}{link.last_synced_status ? `:${link.last_synced_status}` : ""}
          </span>
        ))}
        {task.due_date ? (
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3" /> {fmtDate(task.due_date)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
