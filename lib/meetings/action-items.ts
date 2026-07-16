import "server-only";

import type { DbClient } from "@/lib/db/types";
import { callMeetingsLLM, extractJsonObject, type ProviderKeys, type RosterPerson } from "./llm-extract";
import {
  extractTodosFromNotes,
  toExtractedTodoRows,
  createMeetingTodoTasks,
  type ExtractedTodo,
} from "./extract-todos";

/**
 * Pull concrete action items / follow-up tasks out of a meeting transcript. An LLM pass is the
 * primary extractor — real transcripts (Granola, Zoom, …) phrase commitments in prose ("Alex will
 * send the deck by Friday"), which the line-oriented markdown scanner in `extract-todos.ts` can't
 * see. When the LLM is unavailable OR returns nothing, we fall back to that deterministic markdown
 * scanner, so extraction still works for checkbox/"action item:"-style notes with no LLM key.
 *
 * Never throws: the whole point is a best-effort feed for the Meetings page's "push to Linear"
 * flow, so any failure degrades to the regex result (possibly empty) rather than erroring.
 *
 * Output is the SAME `ExtractedTodo` shape the markdown scanner emits, so callers materialize both
 * sources identically through `toExtractedTodoRows` → `createMeetingTodoTasks` (stable row_keys).
 */

const MAX_TRANSCRIPT_CHARS = 15_000;

const SYSTEM_PROMPT =
  "You are reading a meeting transcript or notes document. Extract the concrete action items — the " +
  "specific follow-up tasks, commitments, and next steps someone agreed to do. For each, give a " +
  "short imperative title, the assignee's full name exactly as referred to in the text (empty string " +
  "if unclear — never guess), and a due date as YYYY-MM-DD if one is stated (else null). Return ONLY " +
  'a JSON object of the form {"actionItems":[{"title":"...","assignee":"Full Name","due":"YYYY-MM-DD"|null}]}. ' +
  "No prose, no markdown code fences — the raw JSON object only. Include ONLY real, actionable " +
  "commitments; if there are none, return an empty array. Never invent tasks.";

interface RawActionItem {
  title?: unknown;
  assignee?: unknown;
  due?: unknown;
}

function toExtractedTodo(item: RawActionItem, index: number): ExtractedTodo | null {
  const title = typeof item.title === "string" ? item.title.trim() : "";
  if (!title) return null;
  const assignee = typeof item.assignee === "string" ? item.assignee.trim() : "";
  const dueRaw = typeof item.due === "string" ? item.due.trim() : "";
  const due = /^\d{4}-\d{2}-\d{2}$/.test(dueRaw) ? dueRaw : null;
  // line/sourceText are only used for the task body; LLM items have no source line, so anchor on
  // a stable synthetic index and echo the title.
  return { title, assignee, due, line: index + 1, sourceText: title };
}

/** Dedupe by lowercased title, preserving first-seen order. */
function dedupe(todos: ExtractedTodo[]): ExtractedTodo[] {
  const seen = new Set<string>();
  const out: ExtractedTodo[] = [];
  for (const t of todos) {
    const key = t.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * LLM-first action-item extraction with a deterministic markdown fallback. `roster` is a hint that
 * helps the model resolve first-name mentions to full names; it is NOT used to filter results.
 */
export async function extractActionItems(
  rawText: string,
  roster: RosterPerson[],
  keys: ProviderKeys,
  timeoutMs?: number
): Promise<ExtractedTodo[]> {
  const fallback = () => dedupe(extractTodosFromNotes(rawText));

  const truncated = rawText.slice(0, MAX_TRANSCRIPT_CHARS);
  const rosterHint = roster.length
    ? `\n\nKnown team members (resolve first-name mentions against these full names): ${roster.map((p) => p.displayName).join(", ")}.`
    : "";
  const raw = await callMeetingsLLM(SYSTEM_PROMPT, `Transcript:\n\n${truncated}${rosterHint}`, keys, timeoutMs);
  if (!raw) return fallback();

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch {
    return fallback();
  }
  if (typeof parsed !== "object" || parsed === null) return fallback();
  const arr = (parsed as { actionItems?: unknown }).actionItems;
  if (!Array.isArray(arr)) return fallback();

  const items = dedupe(
    arr
      .map((it, i) => toExtractedTodo((it ?? {}) as RawActionItem, i))
      .filter((t): t is ExtractedTodo => t !== null)
  );
  // An empty LLM result on a transcript that clearly has checkbox todos would be a regression — fall
  // back to the markdown scanner so we never show fewer items than the deterministic path would.
  return items.length ? items : fallback();
}

/**
 * Extract a transcript's action items and materialize them as tasks in the "Extracted from Meetings"
 * project — the ONE place both the on-demand button (`extractMeetingActionItemsAction`) and the
 * import/backfill path (`backfillMeetingNotesFromItems`) go through, so pushed meetings arrive with
 * their action items already filled in rather than empty until someone clicks "extract". Idempotent
 * (tasks upsert on a stable row_key). Returns the number of tasks materialized.
 */
export async function extractAndStoreActionItems(
  db: DbClient,
  teamId: string,
  item: { id: string; path: string; access: "team" | "external" },
  rawText: string,
  roster: RosterPerson[],
  keys: ProviderKeys,
  // Injectable so the backfill/tests can stub the LLM step; defaults to the real extractor.
  extract?: (rawText: string, roster: RosterPerson[], keys: ProviderKeys) => Promise<ExtractedTodo[]>,
  // Extra timeout for the default extractor (background/backfill can allow a slower model).
  timeoutMs?: number
): Promise<number> {
  const run = extract ?? ((t: string, r: RosterPerson[], k: ProviderKeys) => extractActionItems(t, r, k, timeoutMs));
  const todos = await run(rawText, roster, keys);
  const rows = toExtractedTodoRows(item, todos);
  if (rows.length) await createMeetingTodoTasks(db, teamId, rows);
  return rows.length;
}
