import { ExternalLink } from "lucide-react";
import { STATUS_LABELS, type Task } from "./types";
import { EditTaskButton, type ParentOption } from "./edit-task-dialog";

/**
 * Server-rendered task hierarchy (brain-api v1.2 Phase 4): epics with their children grouped beneath
 * them, each row showing its primary-provider link + sync status. This is the brain's view of the
 * board it projects — read here, edit via the per-row dialog (which calls `updateTaskAction`). Tasks
 * whose `parent_row_key` is null (or points outside the loaded set) render as roots/epics.
 */

function PmLinks({ task }: { task: Task }) {
  const links = task.task_pm_links ?? [];
  if (!links.length) return <span className="text-xs text-ink-tertiary">no link</span>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {links.map((l) => {
        const label = `${l.provider}${l.last_synced_status ? `:${l.last_synced_status}` : ""}`;
        const tone = l.last_error ? "text-red" : "text-emerald-700";
        return l.provider_url ? (
          <a
            key={l.provider}
            href={l.provider_url}
            target="_blank"
            rel="noreferrer"
            className={`inline-flex items-center gap-1 text-xs font-medium ${tone} hover:underline`}
            title={l.last_error || l.last_synced_status || "PM link"}
          >
            {label}
            <ExternalLink className="size-3" />
          </a>
        ) : (
          <span key={l.provider} className={`text-xs font-medium ${tone}`} title={l.last_error ?? undefined}>
            {label}
          </span>
        );
      })}
    </span>
  );
}

function TaskRow({ task, parents, isEpic }: { task: Task; parents: ParentOption[]; isEpic: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface-card px-3.5 py-2.5">
      <div className="min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1">
        {task.row_key ? <span className="font-mono text-[11px] text-ink-tertiary">{task.row_key}</span> : null}
        <span className={`truncate ${isEpic ? "text-sm font-semibold text-ink" : "text-sm text-ink"}`}>
          {task.title}
        </span>
        <span className="text-[11px] uppercase tracking-wide text-ink-tertiary">{STATUS_LABELS[task.status]}</span>
        {task.priority && task.priority !== "none" ? (
          <span className="rounded bg-violet/10 px-1.5 py-0.5 text-[10px] font-medium text-violet">{task.priority}</span>
        ) : null}
        {(task.labels ?? []).map((label) => (
          <span key={label} className="rounded bg-surface-overlay px-1.5 py-0.5 text-[10px] text-ink-secondary">
            {label}
          </span>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <PmLinks task={task} />
        <EditTaskButton task={task} parents={parents} />
      </div>
    </div>
  );
}

export function TaskHierarchy({ tasks }: { tasks: Task[] }) {
  const byRowKey = new Map<string, Task>();
  for (const t of tasks) if (t.row_key) byRowKey.set(t.row_key, t);

  // Children grouped by parent row_key; a parent_row_key that points outside the loaded set is
  // treated as a root (so nothing is silently hidden).
  const childrenOf = new Map<string, Task[]>();
  const roots: Task[] = [];
  for (const t of tasks) {
    const parentKey = t.parent_row_key ?? null;
    if (parentKey && byRowKey.has(parentKey)) {
      const arr = childrenOf.get(parentKey) ?? [];
      arr.push(t);
      childrenOf.set(parentKey, arr);
    } else {
      roots.push(t);
    }
  }

  // Parent candidates for the edit dialog: any task with a row_key (a task can become a sub of any
  // other; the action rejects self/cycle).
  const parents: ParentOption[] = tasks
    .filter((t): t is Task & { row_key: string } => Boolean(t.row_key))
    .map((t) => ({ row_key: t.row_key, title: t.title }));

  if (!tasks.length) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-tertiary">Hierarchy</h2>
      <div className="flex flex-col gap-3">
        {roots.map((epic) => {
          const kids = epic.row_key ? childrenOf.get(epic.row_key) ?? [] : [];
          return (
            <div key={epic.id} data-epic={epic.row_key ?? undefined} className="flex flex-col gap-1.5">
              <TaskRow task={epic} parents={parents} isEpic={kids.length > 0} />
              {kids.length ? (
                <div className="ml-5 flex flex-col gap-1.5 border-l border-border-subtle pl-3">
                  {kids.map((child) => (
                    <div key={child.id} data-parent={epic.row_key ?? undefined}>
                      <TaskRow task={child} parents={parents} isEpic={false} />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
