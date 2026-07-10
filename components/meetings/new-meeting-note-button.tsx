"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Upload, X } from "lucide-react";
import { uploadMeetingNoteAction } from "@/app/t/[team]/meetings/actions";

export function NewMeetingNoteButton({ teamSlug }: { teamSlug: string }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [rawText, setRawText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function reset() {
    setTitle("");
    setOccurredAt("");
    setRawText("");
    setError("");
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();
    setRawText(text);
    if (!title.trim()) setTitle(file.name.replace(/\.(txt|md)$/i, ""));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !rawText.trim()) return;
    setSaving(true);
    setError("");
    const res = await uploadMeetingNoteAction({
      teamSlug,
      title: title.trim(),
      rawText,
      occurredAt: occurredAt || null,
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error ?? "Could not save the meeting note.");
      return;
    }
    setOpen(false);
    reset();
    if (res.id) router.push(`/t/${teamSlug}/meetings/${res.id}`);
    router.refresh();
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-prism">
        <Plus className="size-4" /> Upload transcript
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 px-4 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-xl rounded-2xl border border-border-subtle bg-surface-inset p-6 shadow-[0_12px_48px_rgba(124,58,237,0.16)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-ink">Upload meeting notes</h3>
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
                placeholder="Title (e.g. Weekly product sync)"
                className="prism-input"
              />
              <input
                type="date"
                value={occurredAt}
                onChange={(e) => setOccurredAt(e.target.value)}
                className="prism-input"
              />
              <div className="flex items-center justify-between">
                <p className="text-xs text-ink-tertiary">
                  Paste the transcript below, or upload a .txt/.md file.
                </p>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 rounded-lg border border-border-default px-2.5 py-1 text-xs text-ink-secondary hover:text-ink"
                >
                  <Upload className="size-3.5" /> Choose file
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.md,text/plain,text/markdown"
                  className="hidden"
                  onChange={onFilePicked}
                />
              </div>
              <textarea
                required
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder="Paste the transcript or notes here..."
                rows={10}
                className="prism-input resize-y font-mono text-xs"
              />
              <p className="text-xs text-ink-tertiary">
                Attendees and a summary are inferred automatically; you can also mark todos with{" "}
                <code>- [ ] like this</code> and they&apos;ll land in Tasks.
              </p>
              {error ? <p className="text-sm text-red">{error}</p> : null}
              <div className="mt-1 flex justify-end gap-2">
                <button type="button" onClick={() => setOpen(false)} className="btn-ghost">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !title.trim() || !rawText.trim()}
                  className="btn-prism"
                >
                  {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                  Save meeting note
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
