"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, X } from "lucide-react";
import { createDecisionAction } from "@/app/actions/decisions";

type ProjectOption = { id: string; slug: string; name: string };

export function NewDecisionButton({
  teamId,
  projects,
}: {
  teamId: string;
  projects: ProjectOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [decidedBy, setDecidedBy] = useState("");
  const [decidedAt, setDecidedAt] = useState("");
  const [rationale, setRationale] = useState("");
  const [impact, setImpact] = useState("");
  const [audience, setAudience] = useState<"team" | "external">("team");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !projectId) return;
    setSaving(true);
    setError("");
    const res = await createDecisionAction({
      teamId,
      projectId,
      title: title.trim(),
      rationale,
      decidedBy,
      impact,
      audience,
      decidedAt: decidedAt || null,
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error ?? "Could not record the decision.");
      return;
    }
    setOpen(false);
    setTitle("");
    setRationale("");
    setImpact("");
    setDecidedBy("");
    setDecidedAt("");
    router.refresh();
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-prism">
        <Plus className="size-4" /> Record decision
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 px-4 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-border-subtle bg-surface-inset p-6 shadow-[0_12px_48px_rgba(124,58,237,0.16)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-ink">Record decision</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
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
                placeholder="The decision (e.g. Adopt Apache-2.0 for the core)"
                className="prism-input"
              />
              <div className="grid grid-cols-2 gap-3">
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="prism-input"
                  required
                >
                  {projects.length === 0 ? <option value="">No projects</option> : null}
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || p.slug}
                    </option>
                  ))}
                </select>
                <select
                  value={audience}
                  onChange={(e) => setAudience(e.target.value as "team" | "external")}
                  className="prism-input"
                >
                  <option value="team">Team</option>
                  <option value="external">External</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input
                  value={decidedBy}
                  onChange={(e) => setDecidedBy(e.target.value)}
                  placeholder="Decided by"
                  className="prism-input"
                />
                <input
                  type="date"
                  value={decidedAt}
                  onChange={(e) => setDecidedAt(e.target.value)}
                  className="prism-input"
                />
              </div>
              <textarea
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                placeholder="Rationale — why this call"
                rows={3}
                className="prism-input resize-y"
              />
              <input
                value={impact}
                onChange={(e) => setImpact(e.target.value)}
                placeholder="Impact (optional)"
                className="prism-input"
              />
              {projects.length === 0 ? (
                <p className="text-sm text-amber-700">
                  Create a project first — decisions hang off a project.
                </p>
              ) : null}
              {error ? <p className="text-sm text-red">{error}</p> : null}
              <div className="mt-1 flex justify-end gap-2">
                <button type="button" onClick={() => setOpen(false)} className="btn-ghost">
                  Cancel
                </button>
                <button type="submit" disabled={saving || !title.trim() || !projectId} className="btn-prism">
                  {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                  Record decision
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
