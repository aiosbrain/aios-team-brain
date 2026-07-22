import "server-only";

import { createHash } from "node:crypto";

import type { DbClient } from "@/lib/db/types";

export const MEETING_TODO_PROJECT_SLUG = "extracted-from-meetings";
export const MEETING_TODO_PROJECT_NAME = "Extracted from Meetings";
export const MEETING_TODO_LABEL = "Extracted from Meetings";
const ROW_PREFIX = "meet";

export interface ExtractedTodo {
  title: string;
  assignee: string;
  due: string | null;
  line: number;
  sourceText: string;
}

export interface ExtractedTodoRow extends ExtractedTodo {
  rowKey: string;
  sourceItemId: string;
  sourcePath: string;
  audience: "team" | "external";
}

export interface ExtractMeetingTodosOptions {
  sourceProject?: string;
  pathPrefix?: string;
  kinds?: string[];
  since?: string;
  limit?: number;
  dryRun?: boolean;
}

export interface ExtractMeetingTodosResult {
  projectId: string | null;
  scanned: number;
  extracted: number;
  upserted: number;
  deleted: number;
  rows: ExtractedTodoRow[];
}

type ItemRow = {
  id: string;
  path: string;
  kind: string;
  access: "team" | "external";
  body: string;
  updated_at: string;
  projects?: { slug?: string } | null;
};

function stableHash(input: string, len = 16): string {
  return createHash("sha256").update(input).digest("hex").slice(0, len);
}

function cleanupTitle(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/\s+#\w[\w-]*\s*$/g, "")
    .replace(/\s*\((?:due|by)\s+\d{4}-\d{2}-\d{2}\)\s*$/i, "")
    .replace(/\s*\(\s*\)\s*$/g, "")
    .trim();
}

function extractDue(text: string): { title: string; due: string | null } {
  const m =
    text.match(/\b(?:due|by)\s*:?\s*(\d{4}-\d{2}-\d{2})\b/i) ||
    text.match(/\[(?:due|by):\s*(\d{4}-\d{2}-\d{2})\]/i);
  if (!m) return { title: text, due: null };
  return {
    title: cleanupTitle(text.replace(m[0], "")),
    due: m[1],
  };
}

function extractAssignee(text: string): { title: string; assignee: string } {
  const owner = text.match(/^(?:owner|assignee)\s*:\s*([^\u2014:-]+?)\s*[\u2014:-]\s*(.+)$/i);
  if (owner) return { assignee: owner[1].trim(), title: owner[2].trim() };

  const mention = text.match(/^@([A-Za-z0-9._-]+)\s+(.+)$/);
  if (mention) return { assignee: mention[1].trim(), title: mention[2].trim() };

  const colon = text.match(/^([A-Z][A-Za-z0-9 ._-]{1,40})\s*:\s+(.+)$/);
  if (colon) return { assignee: colon[1].trim(), title: colon[2].trim() };

  return { assignee: "", title: text };
}

function normalizeTodoLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || /^```|^~~~/.test(trimmed)) return null;
  if (/^[-*+]\s+\[[xX]\]\s+/.test(trimmed)) return null;

  const checkbox = trimmed.match(/^[-*+]?\s*\[\s\]\s+(.+)$/);
  if (checkbox) return checkbox[1].trim();

  const explicit = trimmed.match(
    /^(?:[-*+]\s*)?(?:todo|to do|action item|action|follow[- ]?up|next step)\s*[:\-]\s+(.+)$/i
  );
  if (explicit) return explicit[1].trim();

  return null;
}

export function extractTodosFromNotes(markdown: string): ExtractedTodo[] {
  const rows: ExtractedTodo[] = [];
  const seen = new Set<string>();
  let inFence = false;

  markdown.split(/\r?\n/).forEach((line, idx) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const candidate = normalizeTodoLine(line);
    if (!candidate) return;

    const withDue = extractDue(candidate);
    const withAssignee = extractAssignee(withDue.title);
    const title = cleanupTitle(withAssignee.title);
    if (!title) return;

    const key = title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      title,
      assignee: withAssignee.assignee,
      due: withDue.due,
      line: idx + 1,
      sourceText: line.trim(),
    });
  });

  return rows;
}

/** Normalize a todo title for stable identity: lowercased, whitespace-collapsed, trimmed. */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Map extracted todos → task rows, keyed by CONTENT (transcript id + normalized title), NOT ordinal
 * position. So re-extracting the same transcript maps each todo to the SAME `row_key`/task
 * regardless of the LLM's order or count — preserving any PM-tool (Linear/Plane) push link on it,
 * and letting the caller prune todos that genuinely disappeared. Identical titles within one
 * extraction collapse to a single row (dedup) — the same action item stated twice is one task.
 */
export function toExtractedTodoRows(
  item: Pick<ItemRow, "id" | "path" | "access">,
  todos: ExtractedTodo[]
): ExtractedTodoRow[] {
  const sourceHash = stableHash(item.id, 10);
  const seen = new Set<string>();
  const out: ExtractedTodoRow[] = [];
  for (const todo of todos) {
    const rowKey = `${ROW_PREFIX}-${sourceHash}-${stableHash(normalizeTitle(todo.title), 12)}`;
    if (seen.has(rowKey)) continue; // identical titles in one transcript → one task
    seen.add(rowKey);
    out.push({ ...todo, rowKey, sourceItemId: item.id, sourcePath: item.path, audience: item.access });
  }
  return out;
}

function taskBody(row: ExtractedTodoRow): string {
  return [
    `Extracted from meeting notes: ${row.sourcePath}`,
    `Source line: ${row.line}`,
    "",
    row.sourceText,
  ].join("\n");
}

export async function scanMeetingTodosForTeam(
  db: DbClient,
  teamId: string,
  opts: ExtractMeetingTodosOptions = {}
): Promise<{ scanned: number; extracted: number; rows: ExtractedTodoRow[] }> {
  const kinds = opts.kinds ?? ["transcript", "deliverable", "artifact"];
  let q = db
    .from("items")
    .select("id, path, kind, access, body, updated_at, projects(slug)")
    .eq("team_id", teamId)
    .in("kind", kinds)
    .order("updated_at", { ascending: false })
    .limit(opts.limit ?? 1000);
  if (opts.pathPrefix) q = q.like("path", `${opts.pathPrefix.replace(/[%_\\]/g, "\\$&")}%`);
  if (opts.since) q = q.gte("updated_at", opts.since);

  const { data: items, error: itemsErr } = await q;
  if (itemsErr) throw new Error(`items read failed: ${itemsErr.message}`);

  const sourceItems = ((items ?? []) as ItemRow[]).filter((item) => {
    const slug = item.projects?.slug ?? "";
    return !opts.sourceProject || slug === opts.sourceProject;
  });

  const rows = sourceItems.flatMap((item) => toExtractedTodoRows(item, extractTodosFromNotes(item.body)));
  return { scanned: sourceItems.length, extracted: rows.length, rows };
}

export async function ensureMeetingTodoProject(db: DbClient, teamId: string): Promise<string> {
  const { data: project, error: projectErr } = await db
    .from("projects")
    .upsert(
      {
        team_id: teamId,
        slug: MEETING_TODO_PROJECT_SLUG,
        name: MEETING_TODO_PROJECT_NAME,
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "team_id,slug" }
    )
    .select("id")
    .single();
  if (projectErr || !project) throw new Error(`project upsert failed: ${projectErr?.message}`);
  return (project as { id: string }).id;
}

/**
 * Delete a transcript's meeting-todo tasks that are NOT in `keepKeys` — EXCEPT any already pushed to
 * a PM tool (a `task_pm_links` row), which are preserved so a re-extract never orphans a live Linear/
 * Plane issue's local mirror. Scoped to (team, project, source_item_id). Returns the count deleted.
 */
async function pruneStaleMeetingTodos(
  db: DbClient,
  teamId: string,
  projectId: string,
  sourceItemId: string,
  keepKeys: Set<string>
): Promise<number> {
  // FAIL CLOSED on any read error — an unknown task list or push-state must never let the prune
  // delete something (a transient DB error must not empty the preserve set; see the #249 pool wedge).
  const { data: existing, error: tasksErr } = await db
    .from("tasks")
    .select("id, row_key")
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .eq("source_item_id", sourceItemId);
  if (tasksErr) throw new Error(`prune: load meeting todos: ${tasksErr.message}`);
  const stale = ((existing ?? []) as { id: string; row_key: string }[]).filter((t) => !keepKeys.has(t.row_key));
  if (!stale.length) return 0;
  const staleKeys = stale.map((t) => t.row_key);
  // Preserve any pushed to a PM tool — never delete the local mirror of a live Linear/Plane issue.
  // Match on ROW_KEY (the link's stable identity), so a link whose `task_id` was nulled (FK on-delete
  // set null) still protects, and a key-scheme change can't silently drop the preservation.
  const { data: links, error: linksErr } = await db
    .from("task_pm_links")
    .select("row_key")
    .eq("team_id", teamId)
    .in("row_key", staleKeys);
  if (linksErr) throw new Error(`prune: load pm links: ${linksErr.message}`);
  const pushedKeys = new Set(((links ?? []) as { row_key: string }[]).map((l) => l.row_key));
  const toDelete = stale.filter((t) => !pushedKeys.has(t.row_key)).map((t) => t.id);
  if (!toDelete.length) return 0;
  const { error } = await db.from("tasks").delete().eq("team_id", teamId).in("id", toDelete);
  if (error) throw new Error(`prune stale meeting todos: ${error.message}`);
  return toDelete.length;
}

export async function createMeetingTodoTasks(
  db: DbClient,
  teamId: string,
  rows: ExtractedTodoRow[],
  // OPT-IN reconcile: for each transcript id here, delete its stale (no-longer-extracted, un-pushed)
  // todos after upserting. Only the deliberate on-demand re-extract of a SINGLE transcript passes
  // this; the additive backfill paths omit it so they never prune another path's todos.
  // `status` sets the brain status new/re-extracted todos get (default 'backlog') — the team's
  // configured target category (teams.meeting_task_status) so they land there when pushed.
  opts: { pruneSourceItemIds?: string[]; status?: string } = {}
): Promise<{ projectId: string; upserted: number; deleted: number }> {
  const projectId = await ensureMeetingTodoProject(db, teamId);
  let upserted = 0;

  // `status` is INSERT-ONLY: preserve the CURRENT status of any task that already exists so a
  // re-extract never resets a todo the user (or an inbound PM-tool sync) already progressed — e.g.
  // one moved to in_progress/done — back to the configured default category. The pg upsert clobbers
  // every non-conflict column via EXCLUDED, so we can't exclude `status` in the write; instead we
  // read the existing status and carry it forward. New rows fall through to the configured default.
  const rowKeys = [...new Set(rows.map((r) => r.rowKey))];
  const existingStatus = new Map<string, string>();
  if (rowKeys.length) {
    const { data: cur, error: curErr } = await db
      .from("tasks")
      .select("row_key, status")
      .eq("team_id", teamId)
      .eq("project_id", projectId)
      .in("row_key", rowKeys);
    if (curErr) throw new Error(`load existing meeting todos: ${curErr.message}`);
    for (const t of (cur ?? []) as { row_key: string; status: string }[]) existingStatus.set(t.row_key, t.status);
  }

  for (const row of rows) {
    const { error } = await db
      .from("tasks")
      .upsert(
        {
          team_id: teamId,
          project_id: projectId,
          source_item_id: row.sourceItemId,
          row_key: row.rowKey,
          title: row.title,
          assignee: row.assignee,
          status: existingStatus.get(row.rowKey) ?? opts.status ?? "backlog",
          raw_status: "extracted",
          sprint: MEETING_TODO_LABEL,
          due_date: row.due,
          origin: "sync",
          audience: row.audience,
          labels: [MEETING_TODO_LABEL, "meeting-notes"],
          priority: "none",
          body: taskBody(row),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "team_id,project_id,row_key" }
      );
    if (error) throw new Error(`task upsert ${row.rowKey}: ${error.message}`);
    upserted++;
  }

  let deleted = 0;
  for (const sourceItemId of opts.pruneSourceItemIds ?? []) {
    const keepKeys = new Set(rows.filter((r) => r.sourceItemId === sourceItemId).map((r) => r.rowKey));
    deleted += await pruneStaleMeetingTodos(db, teamId, projectId, sourceItemId, keepKeys);
  }
  return { projectId, upserted, deleted };
}

/**
 * Move already-extracted meeting-todo tasks from one source item's namespace to another — used when a
 * merge re-points a note onto a merge-owned item (audit H1). The row_key is namespaced by a hash of
 * the item id, so a re-point would otherwise orphan the old tasks: re-extraction on the new item would
 * mint DUPLICATES, `getMeetingNote` (which filters by the note's source_item_id) would stop showing the
 * originals, and pushing the new copies would create duplicate PM issues. Rewriting source_item_id +
 * row_key IN PLACE (same task id) keeps re-extraction upserting over them; the task's `task_pm_links`
 * row_key is moved too (the projection engine resolves links by row_key). No-op when item unchanged.
 */
export async function remapMeetingTodoSourceItem(
  db: DbClient,
  teamId: string,
  oldItemId: string,
  newItemId: string
): Promise<void> {
  if (oldItemId === newItemId) return;
  const oldPrefix = `${ROW_PREFIX}-${stableHash(oldItemId, 10)}-`;
  const newPrefix = `${ROW_PREFIX}-${stableHash(newItemId, 10)}-`;
  const { data } = await db.from("tasks").select("id, row_key").eq("team_id", teamId).eq("source_item_id", oldItemId);
  const rows = ((data ?? []) as { id: string; row_key: string }[]).filter((t) => t.row_key.startsWith(oldPrefix));
  const now = new Date().toISOString();
  for (const t of rows) {
    const newKey = newPrefix + t.row_key.slice(oldPrefix.length);
    const { error } = await db.from("tasks").update({ source_item_id: newItemId, row_key: newKey }).eq("id", t.id);
    if (error) throw new Error(`meeting-todo remap ${t.row_key}: ${error.message}`);
    // Follow the task's PM links to the new row_key — the projection engine resolves links by
    // (team_id, project_id, row_key, provider), so a stale key would make the next projection miss
    // the link and mint a DUPLICATE Linear/Plane issue. resource/external ids stay put so the
    // existing provider issue keeps updating.
    const { error: linkErr } = await db
      .from("task_pm_links")
      .update({ row_key: newKey, updated_at: now })
      .eq("team_id", teamId)
      .eq("task_id", t.id);
    if (linkErr) throw new Error(`meeting-todo link remap ${t.row_key}: ${linkErr.message}`);
  }
}

/** The pre-content-key row_key scheme: `meet-<10-hex source hash>-<3-digit ordinal>`. */
const ORDINAL_ROW_KEY = /^meet-[0-9a-f]{10}-\d{3}$/;

/** Recompute the CURRENT content-hash row_key for a task from its source item + title. */
function contentRowKey(sourceItemId: string, title: string): string {
  return `${ROW_PREFIX}-${stableHash(sourceItemId, 10)}-${stableHash(normalizeTitle(title), 12)}`;
}

export interface BackfillRowKeysResult {
  /** Ordinal-keyed tasks examined. */ scanned: number;
  /** Tasks renamed to their content key (link moved too). */ rekeyed: number;
  /** Duplicate ordinal tasks (same content key) deleted. */ collapsed: number;
}

/**
 * One-time migration for prod data created under the OLD ordinal row_key scheme (`meet-<hash>-001`).
 * The extractor now keys todos by CONTENT (`meet-<hash>-<titleHash>`); without this, a task pushed to
 * Linear/Plane BEFORE the switch keeps its ordinal key, so a re-extract mints a NEW content-keyed
 * task for the same todo — the pushed ordinal row is preserved by the prune, and pushing the new copy
 * opens a SECOND provider issue (the "duplicate Linear issue" bug Fable caught).
 *
 * This rewrites each ordinal-keyed task's `row_key` (and its `task_pm_links` row_key, matched by
 * task_id — the projection engine resolves links by row_key) to the content key it would get today, so
 * the next re-extract UPSERTS over it. Collisions (two ordinal rows → same content key; rare, since the
 * extractor already de-dups titles per transcript) collapse to one survivor, preferring a pushed row so
 * a live issue is never orphaned; an un-pushed duplicate is deleted. Idempotent — content-keyed rows are
 * skipped, so it's safe to re-run / replay.
 */
export async function backfillMeetingTodoRowKeys(
  db: DbClient,
  teamId: string
): Promise<BackfillRowKeysResult> {
  const result: BackfillRowKeysResult = { scanned: 0, rekeyed: 0, collapsed: 0 };

  // Resolve the meetings project WITHOUT creating it — nothing to backfill if the team has none.
  const { data: proj, error: projErr } = await db
    .from("projects")
    .select("id")
    .eq("team_id", teamId)
    .eq("slug", MEETING_TODO_PROJECT_SLUG)
    .maybeSingle();
  if (projErr) throw new Error(`backfill: load project: ${projErr.message}`);
  const projectId = (proj as { id: string } | null)?.id;
  if (!projectId) return result;

  const { data: taskRows, error: tasksErr } = await db
    .from("tasks")
    .select("id, source_item_id, title, row_key")
    .eq("team_id", teamId)
    .eq("project_id", projectId);
  if (tasksErr) throw new Error(`backfill: load tasks: ${tasksErr.message}`);
  const allTasks = (taskRows ?? []) as { id: string; source_item_id: string | null; title: string; row_key: string }[];
  const ordinal = allTasks.filter((t) => t.source_item_id && ORDINAL_ROW_KEY.test(t.row_key));
  result.scanned = ordinal.length;
  if (!ordinal.length) return result;

  // Which tasks are already pushed to a PM tool (prefer keeping those on a collision).
  const { data: linkRows, error: linksErr } = await db
    .from("task_pm_links")
    .select("task_id, row_key")
    .eq("team_id", teamId)
    .eq("project_id", projectId);
  if (linksErr) throw new Error(`backfill: load pm links: ${linksErr.message}`);
  const links = (linkRows ?? []) as { task_id: string | null; row_key: string }[];
  // A task is "pushed" if a PM link points at it. Match by BOTH task_id AND row_key — the same
  // reason the prune fix keys on row_key: `task_pm_links.task_id` is nullable (FK on-delete set null),
  // so a link whose task was deleted+recreated (its task_id nulled) still protects via its row_key,
  // which the ordinal task still carries. Missing this would treat a pushed task as un-pushed and
  // delete it / skip its orphaned link → the exact duplicate-issue bug this backfill fixes.
  const pushedTaskIds = new Set(links.map((l) => l.task_id).filter((id): id is string => Boolean(id)));
  const pushedRowKeys = new Set(links.map((l) => l.row_key));
  const isPushed = (t: { id: string; row_key: string }) => pushedTaskIds.has(t.id) || pushedRowKeys.has(t.row_key);
  // Content keys already taken (by a task a re-extract created) — fold ordinal rows into them, never
  // rename onto an occupied key (that would violate the (team,project,row_key) unique index).
  const takenKeys = new Set(allTasks.filter((t) => !ORDINAL_ROW_KEY.test(t.row_key)).map((t) => t.row_key));

  // Group ordinal tasks by the content key they map to.
  const groups = new Map<string, typeof ordinal>();
  for (const t of ordinal) {
    const key = contentRowKey(t.source_item_id as string, t.title);
    const g = groups.get(key) ?? [];
    g.push(t);
    groups.set(key, g);
  }

  const now = new Date().toISOString();
  for (const [newKey, group] of groups) {
    // Survivor is renamed to newKey; the rest are duplicates. If newKey is already occupied by a
    // content-keyed task, there is NO survivor to rename — every ordinal row is a duplicate.
    const survivor = takenKeys.has(newKey) ? undefined : group.find(isPushed) ?? group[0];

    if (survivor) {
      const oldKey = survivor.row_key;
      // Rekey the LINK FIRST (matched by its stable row_key, scoped to this project+key — so a link
      // whose task_id was nulled still moves), THEN the task. This ordering is crash-safe: if the
      // process dies between the two writes, the task is still ordinal, so a re-run reprocesses it and
      // the already-moved link update is a harmless no-op — no permanently stranded ordinal link.
      const { error: linkErr } = await db
        .from("task_pm_links")
        .update({ row_key: newKey, updated_at: now })
        .eq("team_id", teamId)
        .eq("project_id", projectId)
        .eq("row_key", oldKey);
      if (linkErr) throw new Error(`backfill: rekey link ${oldKey}: ${linkErr.message}`);
      const { error: upErr } = await db
        .from("tasks")
        .update({ row_key: newKey, updated_at: now })
        .eq("id", survivor.id);
      if (upErr) throw new Error(`backfill: rekey task ${oldKey}: ${upErr.message}`);
      result.rekeyed++;
    }

    // Delete the un-pushed duplicates; keep a pushed duplicate rather than orphan a live issue.
    for (const dup of group) {
      if (dup === survivor) continue;
      if (isPushed(dup)) continue;
      const { error: delErr } = await db.from("tasks").delete().eq("team_id", teamId).eq("id", dup.id);
      if (delErr) throw new Error(`backfill: collapse duplicate ${dup.row_key}: ${delErr.message}`);
      result.collapsed++;
    }
  }
  return result;
}

export async function extractMeetingTodosForTeam(
  db: DbClient,
  teamId: string,
  opts: ExtractMeetingTodosOptions = {}
): Promise<ExtractMeetingTodosResult> {
  const scan = await scanMeetingTodosForTeam(db, teamId, opts);
  if (opts.dryRun) return { ...scan, projectId: null, upserted: 0, deleted: 0 };

  const created = await createMeetingTodoTasks(db, teamId, scan.rows);
  return { ...scan, projectId: created.projectId, upserted: created.upserted, deleted: 0 };
}
