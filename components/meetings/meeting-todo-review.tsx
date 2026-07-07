"use client";

import { useMemo, useState } from "react";
import { CheckSquare, Loader2, Search, Send, Square, SquareCheckBig } from "lucide-react";
import {
  createMeetingTodosAction,
  scanMeetingTodosAction,
  type MeetingTodoCandidate,
} from "@/app/actions/meeting-todos";

type EditableCandidate = MeetingTodoCandidate & { selected: boolean };

export function MeetingTodoReview({ teamSlug }: { teamSlug: string }) {
  const [sourceProject, setSourceProject] = useState("");
  const [pathPrefix, setPathPrefix] = useState("");
  const [since, setSince] = useState("");
  const [limit, setLimit] = useState("1000");
  const [rows, setRows] = useState<EditableCandidate[]>([]);
  const [scanned, setScanned] = useState<number | null>(null);
  const [projectToLinear, setProjectToLinear] = useState(false);
  const [busy, setBusy] = useState<"scan" | "create" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const selectable = rows.filter((r) => !r.existingTaskId);
  const selected = rows.filter((r) => r.selected && !r.existingTaskId);
  const allSelected = selectable.length > 0 && selected.length === selectable.length;

  const stats = useMemo(() => {
    const existing = rows.filter((r) => r.existingTaskId).length;
    return { existing };
  }, [rows]);

  async function scan() {
    setBusy("scan");
    setError("");
    setMessage("");
    const parsedLimit = Number.parseInt(limit, 10);
    const res = await scanMeetingTodosAction({
      teamSlug,
      sourceProject: sourceProject || undefined,
      pathPrefix: pathPrefix || undefined,
      since: since || undefined,
      limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined,
    });
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "Could not scan meeting notes.");
      return;
    }
    setScanned(res.scanned ?? 0);
    setRows((res.candidates ?? []).map((row) => ({ ...row, selected: !row.existingTaskId })));
  }

  async function createSelected() {
    if (!selected.length) return;
    setBusy("create");
    setError("");
    setMessage("");
    const res = await createMeetingTodosAction({
      teamSlug,
      rows: selected.map(({ selected: _selected, existingTaskId: _existingTaskId, ...row }) => row),
      projectToLinear,
    });
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "Could not create tasks.");
      return;
    }
    const projection = res.projected ? Object.entries(res.projected).map(([k, v]) => `${k}=${v}`).join(" ") : "";
    setMessage(`Created ${res.upserted ?? 0} task${res.upserted === 1 ? "" : "s"}${projection ? `; Linear ${projection}` : ""}.`);
    setRows((current) =>
      current.map((row) =>
        row.selected && !row.existingTaskId ? { ...row, selected: false, existingTaskId: "created" } : row
      )
    );
  }

  function patchRow(rowKey: string, patch: Partial<EditableCandidate>) {
    setRows((current) => current.map((row) => (row.rowKey === rowKey ? { ...row, ...patch } : row)));
  }

  function toggleAll() {
    const next = !allSelected;
    setRows((current) => current.map((row) => (row.existingTaskId ? row : { ...row, selected: next })));
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="prism-card px-5 py-4">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_120px_auto] md:items-end">
          <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
            Source project
            <input
              value={sourceProject}
              onChange={(e) => setSourceProject(e.target.value)}
              className="prism-input normal-case tracking-normal"
              placeholder="optional"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
            Path prefix
            <input
              value={pathPrefix}
              onChange={(e) => setPathPrefix(e.target.value)}
              className="prism-input normal-case tracking-normal"
              placeholder="meetings/"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
            Since
            <input
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className="prism-input normal-case tracking-normal"
              placeholder="2026-07-01T00:00:00Z"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
            Limit
            <input value={limit} onChange={(e) => setLimit(e.target.value)} className="prism-input normal-case tracking-normal" />
          </label>
          <button type="button" onClick={scan} disabled={busy !== null} className="btn-prism justify-center">
            {busy === "scan" ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            Find action items
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-ink">Review candidates</h2>
            <p className="text-sm text-ink-tertiary">
              {scanned === null
                ? "Scan meeting notes, then choose what becomes a task."
                : `${rows.length} candidate${rows.length === 1 ? "" : "s"} from ${scanned} source item${scanned === 1 ? "" : "s"}. ${stats.existing} already created.`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-card px-3 py-2 text-sm text-ink-secondary">
              <input
                type="checkbox"
                checked={projectToLinear}
                onChange={(e) => setProjectToLinear(e.target.checked)}
                className="size-4 accent-violet"
              />
              Also send to Linear
            </label>
            <button type="button" onClick={toggleAll} disabled={!selectable.length || busy !== null} className="btn-ghost">
              {allSelected ? <Square className="size-4" /> : <SquareCheckBig className="size-4" />}
              {allSelected ? "Clear" : "Select all"}
            </button>
            <button type="button" onClick={createSelected} disabled={!selected.length || busy !== null} className="btn-prism">
              {busy === "create" ? <Loader2 className="size-4 animate-spin" /> : projectToLinear ? <Send className="size-4" /> : <CheckSquare className="size-4" />}
              Create selected
            </button>
          </div>
        </div>

        {error ? <p className="rounded-lg border border-red/30 bg-red/5 px-3 py-2 text-sm text-red">{error}</p> : null}
        {message ? <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700">{message}</p> : null}

        <div className="prism-card overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr className="border-b border-border-default text-left text-xs uppercase tracking-wider text-ink-tertiary">
                <th className="w-12 px-4 py-3 font-medium">Use</th>
                <th className="px-4 py-3 font-medium">Task</th>
                <th className="w-44 px-4 py-3 font-medium">Assignee</th>
                <th className="w-40 px-4 py-3 font-medium">Due</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="w-32 px-4 py-3 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? (
                rows.map((row) => (
                  <tr key={row.rowKey} className="border-b border-border-subtle last:border-0">
                    <td className="px-4 py-3 align-top">
                      <input
                        type="checkbox"
                        checked={row.selected}
                        disabled={!!row.existingTaskId || busy !== null}
                        onChange={(e) => patchRow(row.rowKey, { selected: e.target.checked })}
                        className="size-4 accent-violet"
                      />
                    </td>
                    <td className="px-4 py-3 align-top">
                      <input
                        value={row.title}
                        disabled={!!row.existingTaskId}
                        onChange={(e) => patchRow(row.rowKey, { title: e.target.value })}
                        className="prism-input"
                      />
                      <p className="mt-1 line-clamp-2 text-xs text-ink-tertiary">{row.sourceText}</p>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <input
                        value={row.assignee}
                        disabled={!!row.existingTaskId}
                        onChange={(e) => patchRow(row.rowKey, { assignee: e.target.value })}
                        className="prism-input"
                        placeholder="Unassigned"
                      />
                    </td>
                    <td className="px-4 py-3 align-top">
                      <input
                        type="date"
                        value={row.due ?? ""}
                        disabled={!!row.existingTaskId}
                        onChange={(e) => patchRow(row.rowKey, { due: e.target.value || null })}
                        className="prism-input"
                      />
                    </td>
                    <td className="px-4 py-3 align-top">
                      <p className="break-all font-mono text-xs text-ink-secondary">{row.sourcePath}</p>
                      <p className="mt-1 text-xs text-ink-tertiary">line {row.line}</p>
                    </td>
                    <td className="px-4 py-3 align-top">
                      {row.existingTaskId ? (
                        <span className="rounded-full bg-surface-overlay px-2 py-1 text-xs text-ink-tertiary">Already created</span>
                      ) : (
                        <span className="rounded-full bg-violet/10 px-2 py-1 text-xs text-violet">Ready</span>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-sm text-ink-tertiary">
                    No candidates loaded.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
