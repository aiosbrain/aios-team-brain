import { normalizeTaskStatus, normalizeTaskPriority } from "@/lib/api/schemas";

/**
 * Changed-rows detection for the reactive push path. A sync push must re-project ONLY the rows whose
 * *projected* fields changed — so an unchanged backlog never re-projects on every push (bounded; no
 * board spam). The projected field set the engine writes to the PM tool is:
 *
 *   title · normalized status · sprint · priority · labels · parent_row_key · assignee
 *
 * `assignee` joined this set once the projection engine started writing it to the PM tool (resolved
 * to a provider user). Notably still NOT: `due_date` (never projected) and `body` (dashboard/DB-only
 * on the push path — `tasks.body` is owned by the dashboard, not the markdown table). A push that
 * only flips `due_date` or whose body/content_sha256 changed but projected columns didn't ⇒ no projection.
 */
export interface ProjectableSnapshot {
  title: string;
  status: string; // normalized task_status
  sprint: string;
  priority: string; // normalized: none | low | medium | high | urgent
  labels: string[];
  parent_row_key: string | null;
  assignee: string;
}

// The subset of a parsed task row this predicate reads. Presence of `parent`/`labels`/`priority`
// keys mirrors materializeTasks' partial-write rule: absent key ⇒ the stored value is preserved.
export interface IncomingProjectableRow {
  title: string;
  status?: string | null;
  sprint?: string | null;
  parent?: string | null;
  labels?: string[];
  priority?: string | null;
  assignee?: string | null;
}

function sameLabels(a: string[], b: string[]): boolean {
  const sa = [...a].map((l) => l.trim()).filter(Boolean).sort();
  const sb = [...b].map((l) => l.trim()).filter(Boolean).sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

// Compute the post-upsert projectable values, applying the SAME partial-write rules as
// materializeTasks: a key present in the push is authoritative (even when empty → clears); a key
// absent falls back to the stored snapshot value. `snapshot` is null for a brand-new row.
export function effectiveProjectable(
  row: IncomingProjectableRow,
  snapshot: ProjectableSnapshot | null
): ProjectableSnapshot {
  return {
    title: row.title,
    status: normalizeTaskStatus(row.status || "").status,
    sprint: row.sprint ?? "",
    priority: "priority" in row ? normalizeTaskPriority(row.priority) : snapshot?.priority || "none",
    labels: "labels" in row ? row.labels ?? [] : snapshot?.labels ?? [],
    parent_row_key:
      "parent" in row ? (row.parent ?? "").trim() || null : snapshot?.parent_row_key ?? null,
    assignee: "assignee" in row ? (row.assignee ?? "").trim() : snapshot?.assignee ?? "",
  };
}

// True when the row's projected fields changed (or the row is brand-new, i.e. no snapshot).
export function projectableChanged(
  snapshot: ProjectableSnapshot | null,
  effective: ProjectableSnapshot
): boolean {
  if (!snapshot) return true;
  return !(
    snapshot.title === effective.title &&
    snapshot.status === effective.status &&
    snapshot.sprint === effective.sprint &&
    (snapshot.priority || "none") === effective.priority &&
    (snapshot.parent_row_key ?? null) === (effective.parent_row_key ?? null) &&
    (snapshot.assignee ?? "") === effective.assignee &&
    sameLabels(snapshot.labels ?? [], effective.labels ?? [])
  );
}

/** Normalize a due value (Date | ISO | 'YYYY-MM-DD' | null) to a `YYYY-MM-DD` key for comparison. */
export function normalizeDue(due: string | Date | null | undefined): string {
  if (!due) return "";
  if (due instanceof Date) return Number.isNaN(due.getTime()) ? "" : due.toISOString().slice(0, 10);
  return due.slice(0, 10);
}

/**
 * True when a *persisted* field changed — the wider set that gates `tasks.updated_at` (distinct from
 * `projectableChanged`, which gates PM projection and deliberately ignores `due_date`). This is the
 * projected set PLUS `due_date`, so a due-date-only edit bumps `updated_at` (a real edit) WITHOUT
 * re-projecting to the PM tool. `body` is excluded — it never travels the push contract. A brand-new
 * row (no snapshot) is always changed. `worked_at`/`assigned_at` are NOT here: they are their own
 * signals and are written unconditionally / on assignee-change respectively (see materializeTasks).
 */
export function persistedChanged(
  snapshot: ProjectableSnapshot | null,
  effective: ProjectableSnapshot,
  snapshotDue: string | Date | null | undefined,
  effectiveDue: string | Date | null | undefined
): boolean {
  if (!snapshot) return true;
  if (projectableChanged(snapshot, effective)) return true;
  return normalizeDue(snapshotDue) !== normalizeDue(effectiveDue);
}
