"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { browserClient } from "@/lib/supabase/client";
import type { MemberOption, ProjectOption, Task } from "./types";

export function NewTaskDialog({
  teamId,
  myMemberId,
  projects,
  members,
  onCreated,
  onClose,
}: {
  teamId: string;
  myMemberId: string;
  projects: ProjectOption[];
  members: MemberOption[];
  onCreated: (task: Task) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [sprint, setSprint] = useState("");
  const [due, setDue] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !projectId) return;
    setSaving(true);
    setError("");
    const supabase = browserClient();
    const { data, error: err } = await supabase
      .from("tasks")
      .insert({
        team_id: teamId,
        project_id: projectId,
        title: title.trim(),
        assignee,
        sprint,
        due_date: due || null,
        status: "backlog",
        origin: "ui",
        created_by: myMemberId,
      })
      .select("id, row_key, title, assignee, status, sprint, due_date, origin, project_id, updated_at")
      .single();
    setSaving(false);
    if (err || !data) {
      setError(err?.message ?? "Could not create the task.");
      return;
    }
    onCreated(data as Task);
    onClose();
  }

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
          <h3 className="text-lg font-semibold text-ink">New task</h3>
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
            placeholder="What needs doing?"
            className="prism-input"
          />
          <div className="grid grid-cols-2 gap-3">
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="prism-input"
              required
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.slug}
                </option>
              ))}
            </select>
            <select
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              className="prism-input"
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.actor_handle}>
                  {m.display_name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              value={sprint}
              onChange={(e) => setSprint(e.target.value)}
              placeholder="Sprint (e.g. sprint-2)"
              className="prism-input"
            />
            <input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              className="prism-input"
            />
          </div>
          {projects.length === 0 ? (
            <p className="text-sm text-amber-700">
              No projects yet — run <code className="font-mono text-xs">aios push</code> first to
              create one.
            </p>
          ) : null}
          {error ? <p className="text-sm text-red">{error}</p> : null}
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn-ghost">
              Cancel
            </button>
            <button type="submit" disabled={saving || !projectId} className="btn-prism">
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              Create task
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
