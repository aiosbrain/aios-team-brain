"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, X } from "lucide-react";
import { createProjectAction } from "@/app/actions/projects";

export function NewProjectButton({ teamId }: { teamId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError("");
    const res = await createProjectAction({ teamId, name: name.trim() });
    setSaving(false);
    if (!res.ok) {
      setError(res.error ?? "Could not create the project.");
      return;
    }
    setOpen(false);
    setName("");
    router.refresh();
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-prism">
        <Plus className="size-4" /> New project
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 px-4 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-border-subtle bg-surface-inset p-6 shadow-[0_12px_48px_rgba(124,58,237,0.16)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-ink">New project</h3>
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
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Project name (e.g. AIOS Team Brain)"
                className="prism-input"
              />
              <p className="text-xs text-ink-tertiary">
                A project groups tasks, decisions and synced content. The slug is derived from
                the name and reconciles with a later <code className="font-mono">aios push</code>.
              </p>
              {error ? <p className="text-sm text-red">{error}</p> : null}
              <div className="mt-1 flex justify-end gap-2">
                <button type="button" onClick={() => setOpen(false)} className="btn-ghost">
                  Cancel
                </button>
                <button type="submit" disabled={saving || !name.trim()} className="btn-prism">
                  {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                  Create project
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
