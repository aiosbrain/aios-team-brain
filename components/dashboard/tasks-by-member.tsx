import Link from "next/link";
import { Users } from "lucide-react";
import type { TaskRow } from "./types";

const STATUS_LABEL: Record<string, string> = {
  in_progress: "in progress",
  blocked: "blocked",
  ready: "ready",
};

const STATUS_DOT: Record<string, string> = {
  blocked: "bg-red",
  in_progress: "bg-violet",
  ready: "bg-cyan",
};

export function TasksByMember({ teamSlug, tasks }: { teamSlug: string; tasks: TaskRow[] }) {
  const byAssignee = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    const key = t.assignee || "unassigned";
    byAssignee.set(key, [...(byAssignee.get(key) ?? []), t]);
  }
  const assignees = [...byAssignee.entries()].sort((a, b) => b[1].length - a[1].length);

  return (
    <section className="prism-card px-5 py-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
        <Users className="size-3.5 text-violet" /> Open tasks by member
      </h2>
      {assignees.length === 0 ? (
        <p className="text-sm text-ink-tertiary">
          No tasks in flight —{" "}
          <Link href={`/t/${teamSlug}/tasks`} className="text-violet underline underline-offset-2">
            open the board
          </Link>{" "}
          to plan the sprint.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {assignees.map(([assignee, memberTasks]) => (
            <div
              key={assignee}
              className="rounded-lg border border-border-subtle bg-surface-inset px-4 py-3"
            >
              <p className="mb-2 flex items-center justify-between text-sm font-semibold text-ink">
                {assignee}
                <span className="text-xs font-normal text-ink-tertiary">{memberTasks.length}</span>
              </p>
              <ul className="flex flex-col gap-1.5">
                {memberTasks.slice(0, 5).map((t) => (
                  <li key={t.id} className="flex items-center gap-2 text-xs text-ink-secondary">
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[t.status] ?? "bg-ink-tertiary"}`}
                      title={STATUS_LABEL[t.status] ?? t.status}
                    />
                    <span className="truncate">{t.title}</span>
                  </li>
                ))}
                {memberTasks.length > 5 ? (
                  <li className="text-xs text-ink-tertiary">+{memberTasks.length - 5} more</li>
                ) : null}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
