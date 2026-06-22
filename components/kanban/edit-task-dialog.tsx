"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, X } from "lucide-react";
import { updateTaskAction } from "@/app/actions/tasks";
import { TASK_PRIORITIES, type Task } from "./types";

export type ParentOption = { row_key: string; title: string };

/**
 * Dashboard hierarchical edit (brain-api v1.2 Phase 4). Edits the projectable fields — title,
 * sprint, due, parent (epic), labels, priority, body — through `updateTaskAction`, which persists
 * them and schedules reactive projection into the primary PM tool. `router.refresh()` re-renders the
 * server hierarchy so the new grouping/badges show without a full reload.
 */
export function EditTaskButton({ task, parents }: { task: Task; parents: ParentOption[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md p-1 text-ink-tertiary hover:bg-surface-overlay hover:text-ink"
        aria-label={`Edit ${task.title}`}
      >
        <Pencil className="size-3.5" />
      </button>
      {open ? <EditTaskDialog task={task} parents={parents} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function EditTaskDialog({
  task,
  parents,
  onClose,
}: {
  task: Task;
  parents: ParentOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(task.title);
  const [sprint, setSprint] = useState(task.sprint ?? "");
  const [due, setDue] = useState(task.due_date ? String(task.due_date).slice(0, 10) : "");
  const [parent, setParent] = useState(task.parent_row_key ?? "");
  const [labels, setLabels] = useState((task.labels ?? []).join(", "));
  const [priority, setPriority] = useState(task.priority || "none");
  const [body, setBody] = useState(task.body ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const res = await updateTaskAction({
      taskId: task.id,
      title: title.trim(),
      sprint,
      dueDate: due || null,
      parentRowKey: parent || null,
      labels: labels.split(",").map((l) => l.trim()).filter(Boolean),
      priority,
      body,
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error ?? "Could not save the task.");
      return;
    }
    onClose();
    router.refresh();
  }

  // A task can't parent itself; epics offered exclude this row.
  const parentChoices = parents.filter((p) => p.row_key !== task.row_key);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border-subtle bg-surface-inset p-6 shadow-[0_12px_48px_rgba(124,58,237,0.16)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-ink">Edit task</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-ink-tertiary hover:bg-surface-overlay hover:text-ink"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <input
            autoFocus
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
            className="prism-input"
          />
          <div className="grid grid-cols-2 gap-3">
            <select value={parent} onChange={(e) => setParent(e.target.value)} className="prism-input">
              <option value="">No parent (epic)</option>
              {parentChoices.map((p) => (
                <option key={p.row_key} value={p.row_key}>
                  {p.row_key} · {p.title}
                </option>
              ))}
            </select>
            <select value={priority} onChange={(e) => setPriority(e.target.value)} className="prism-input">
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              value={sprint}
              onChange={(e) => setSprint(e.target.value)}
              placeholder="Sprint / Wave"
              className="prism-input"
            />
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="prism-input" />
          </div>
          <input
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
            placeholder="Labels (comma-separated)"
            className="prism-input"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Description (dashboard-only; projected into the PM tool)"
            rows={4}
            className="prism-input resize-y"
          />
          {error ? <p className="text-sm text-red">{error}</p> : null}
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn-ghost">
              Cancel
            </button>
            <button type="submit" disabled={saving || !title.trim()} className="btn-prism">
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
