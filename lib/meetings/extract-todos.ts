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

export function toExtractedTodoRows(
  item: Pick<ItemRow, "id" | "path" | "access">,
  todos: ExtractedTodo[]
): ExtractedTodoRow[] {
  const sourceHash = stableHash(item.id, 10);
  return todos.map((todo, index) => ({
    ...todo,
    rowKey: `${ROW_PREFIX}-${sourceHash}-${String(index + 1).padStart(3, "0")}`,
    sourceItemId: item.id,
    sourcePath: item.path,
    audience: item.access,
  }));
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

export async function createMeetingTodoTasks(
  db: DbClient,
  teamId: string,
  rows: ExtractedTodoRow[]
): Promise<{ projectId: string; upserted: number }> {
  const projectId = await ensureMeetingTodoProject(db, teamId);
  let upserted = 0;

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
          status: "backlog",
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

  return { projectId, upserted };
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
