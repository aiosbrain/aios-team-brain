"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckSquare, ExternalLink, ListChecks, Loader2, Sparkles, Square } from "lucide-react";

import {
  extractMeetingActionItemsAction,
  pushMeetingTasksAction,
  type PushTaskResult,
} from "@/app/t/[team]/meetings/actions";

export interface ActionItemView {
  taskId: string;
  title: string;
  assignee: string;
  due: string | null;
  status: string;
  pushed: { provider: string; url: string } | null;
}

interface MeetingActionItemsProps {
  teamSlug: string;
  noteId: string;
  todos: ActionItemView[];
  /** The team's primary PM provider (e.g. "linear"), or null if none is configured. */
  provider: string | null;
}

function providerLabel(provider: string | null): string {
  if (!provider) return "PM tool";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/**
 * The "Action items" section of a meeting note: extracted tasks with checkboxes, and a control to
 * push the selected ones into the team's primary PM tool (Linear/Plane). Already-pushed tasks show a
 * link out and can't be re-selected. When no tasks have been extracted yet, offers to extract them
 * (the CLI/ingest import path doesn't do it automatically).
 */
export function MeetingActionItems({ teamSlug, noteId, todos, provider }: MeetingActionItemsProps) {
  const router = useRouter();
  const [extracting, startExtract] = useTransition();
  const [pushing, startPush] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [results, setResults] = useState<Map<string, PushTaskResult>>(new Map());

  const pushable = useMemo(() => todos.filter((t) => !t.pushed), [todos]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(pushable.map((t) => t.taskId)));

  function toggle(taskId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  function runExtract() {
    setMsg(null);
    startExtract(async () => {
      const res = await extractMeetingActionItemsAction(teamSlug, noteId);
      if (!res.ok) return setMsg(res.error ?? "extraction failed");
      setMsg(
        res.extracted
          ? `Extracted ${res.extracted} action item${res.extracted === 1 ? "" : "s"}.`
          : "No action items found in this transcript."
      );
      router.refresh();
    });
  }

  function runPush() {
    const ids = [...selected];
    if (!ids.length) return;
    setMsg(null);
    startPush(async () => {
      const res = await pushMeetingTasksAction(teamSlug, noteId, ids);
      if (!res.ok) return setMsg(res.error ?? "push failed");
      const byId = new Map((res.results ?? []).map((r) => [r.taskId, r]));
      setResults(byId);
      const synced = (res.results ?? []).filter((r) => r.status === "synced" || r.status === "skipped").length;
      const failed = (res.results ?? []).filter((r) => r.status === "failed").length;
      setMsg(
        `Sent ${synced} to ${providerLabel(res.provider ?? provider)}${failed ? ` · ${failed} failed` : ""}.`
      );
      router.refresh();
    });
  }

  const label = providerLabel(provider);
  const busy = extracting || pushing;

  return (
    <div className="prism-card flex flex-col gap-3 px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">
          <ListChecks className="size-3.5" /> Action items
        </h2>
        <button
          type="button"
          onClick={runExtract}
          disabled={busy}
          className="inline-flex items-center gap-1 text-xs text-ink-tertiary hover:text-ink disabled:opacity-50"
          title="Re-scan the transcript for action items"
        >
          {extracting ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          {todos.length ? "Re-extract" : "Extract action items"}
        </button>
      </div>

      {todos.length === 0 ? (
        <p className="text-sm text-ink-tertiary">
          No action items yet. Click <span className="font-medium text-ink-secondary">Extract action items</span> to
          pull follow-up tasks out of the transcript.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-1.5">
            {todos.map((t) => {
              const result = results.get(t.taskId);
              const isSelected = selected.has(t.taskId);
              return (
                <li key={t.taskId} className="flex items-start gap-2 text-sm">
                  {t.pushed ? (
                    <CheckSquare className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggle(t.taskId)}
                      disabled={pushing}
                      className="mt-0.5 shrink-0 text-ink-tertiary hover:text-ink disabled:opacity-50"
                      aria-label={isSelected ? "Deselect" : "Select"}
                    >
                      {isSelected ? (
                        <CheckSquare className="size-4 text-violet" />
                      ) : (
                        <Square className="size-4" />
                      )}
                    </button>
                  )}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-ink">{t.title}</span>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-tertiary">
                      {t.assignee ? <span>{t.assignee}</span> : null}
                      {t.due ? <span>· due {t.due}</span> : null}
                      {t.pushed ? (
                        <a
                          href={t.pushed.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-0.5 text-violet hover:underline"
                        >
                          in {providerLabel(t.pushed.provider)}
                          <ExternalLink className="size-3" />
                        </a>
                      ) : result?.status === "failed" ? (
                        <span className="text-rose-500">{result.error ?? "push failed"}</span>
                      ) : result?.url ? (
                        <a
                          href={result.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-0.5 text-violet hover:underline"
                        >
                          pushed
                          <ExternalLink className="size-3" />
                        </a>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {pushable.length ? (
            <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-3">
              <span className="text-xs text-ink-tertiary">
                {selected.size} of {pushable.length} selected
              </span>
              <div className="flex items-center gap-2">
                {msg ? <span className="text-xs text-ink-tertiary">{msg}</span> : null}
                <button
                  type="button"
                  onClick={runPush}
                  disabled={busy || selected.size === 0 || !provider}
                  className="btn-prism"
                  title={!provider ? "Configure a PM integration in Admin → Integrations" : undefined}
                >
                  {pushing ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
                  Send to {label}
                </button>
              </div>
            </div>
          ) : (
            <p className="border-t border-border-subtle pt-3 text-xs text-ink-tertiary">
              All action items pushed to {label}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
