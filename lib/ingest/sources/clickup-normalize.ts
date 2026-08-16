import { createHash } from "node:crypto";
import type { ItemPayload } from "@/lib/api/schemas";
import type {
  ClickUpDoc,
  ClickUpDocPage,
  ClickUpId,
  ClickUpReadDoc,
  ClickUpTask,
  ClickUpTaskRecord,
} from "@/lib/ingest/sources/clickup";

export type ClickUpBrainStatus = "backlog" | "ready" | "in_progress" | "blocked" | "done";

export interface ClickUpStatusMap {
  backlog: string;
  ready: string;
  in_progress: string;
  blocked: string;
  done: string;
}

export interface NormalizeClickUpTasksInput {
  workspaceId: ClickUpId;
  records: ClickUpTaskRecord[];
  /** Selected List id -> configured reversible AIOS-to-ClickUp status map. */
  statusMaps: Record<string, ClickUpStatusMap>;
}

export class ClickUpNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClickUpNormalizationError";
  }
}

const BRAIN_STATUSES: ClickUpBrainStatus[] = ["backlog", "ready", "in_progress", "blocked", "done"];
const PRIORITY_BY_ID: Record<string, string> = { "1": "urgent", "2": "high", "3": "medium", "4": "low" };

/**
 * The bounds `taskRowSchema` (lib/api/item-payload-schema.ts) enforces on the fields we fill.
 *
 * That parser is STRICT and the whole workspace arrives as ONE `task` item, so a single over-long
 * ClickUp name would 422 every task in the payload rather than its own field — the failure mode the
 * label cap already avoids. Truncating here keeps the blast radius at the field.
 */
const TITLE_MAX = 2000;
const ASSIGNEE_MAX = 200;
const SPRINT_MAX = 200;

/** Beyond this the ECMAScript Date range ends and `new Date(ms).toISOString()` throws. */
const MAX_TIMESTAMP_MS = 8.64e15;

/** `commonItemFields.body` in lib/api/item-payload-schema.ts. Exceeding it 422s the whole payload. */
const BODY_MAX = 1_000_000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pathSegment(value: ClickUpId): string {
  const segment = String(value).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return segment || sha256(String(value)).slice(0, 16);
}

function projectFor(workspaceId: ClickUpId): string {
  return `clickup-${pathSegment(workspaceId).toLowerCase()}`;
}

export function clickUpTaskIdentity(workspaceId: ClickUpId, taskId: ClickUpId): string {
  return `clickup:${String(workspaceId)}:task:${String(taskId)}`;
}

export function clickUpDocIdentity(workspaceId: ClickUpId, docId: string): string {
  return `clickup:${String(workspaceId)}:doc:${docId}`;
}

/** A field the Date constructor cannot represent is no timestamp at all — see `timestampMs`. */
function inDateRange(milliseconds: number): number | null {
  return Math.abs(milliseconds) <= MAX_TIMESTAMP_MS ? milliseconds : null;
}

/**
 * The ONE place a ClickUp wire value becomes milliseconds — and therefore the one place to reject a
 * value `new Date()` cannot represent. A third-party ClickUp integration writing MICROSECONDS into
 * `date_done` (`"1786000600000000"`) is finite, so it used to reach `toISOString()` and throw
 * `RangeError: Invalid time value` — aborting the whole workspace import, not the one task, with an
 * error naming no field. Rejecting at the choke point means every caller degrades to "no timestamp".
 */
function timestampMs(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const numeric = Number(value);
  // ClickUp writes 0 (and "0") for an UNSET date, not for the Unix epoch. Reading it literally dated
  // closed tasks to 1970-01-01 — a real work-time in the timeline's eyes, and a due date in 1970.
  if (numeric === 0) return null;
  if (Number.isFinite(numeric)) return inDateRange(numeric);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? inDateRange(parsed) : null;
}

/** Every `toISOString()` in this file goes through here, so none of them can throw. */
function isoFromMilliseconds(milliseconds: number): string {
  const date = new Date(milliseconds);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : "";
}

function isoTimestamp(value: unknown): string {
  const milliseconds = timestampMs(value);
  return milliseconds === null ? "" : isoFromMilliseconds(milliseconds);
}

/**
 * Row fields are bounded by a STRICT parser; truncating keeps one long field from 422-ing the batch.
 *
 * `slice` cuts UTF-16 CODE UNITS, so a boundary landing mid-surrogate leaves a lone half that the
 * UTF-8 round-trip into Postgres turns into U+FFFD. An emoji in a long ClickUp task name is enough.
 * Dropping the orphan costs one character and keeps the text valid.
 */
function capped(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(max - 1);
  const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return isHighSurrogate ? cut.slice(0, -1) : cut;
}

/** A completion/closure transition is work time; a generic ClickUp updated timestamp is not. */
export function clickUpWorkedAt(task: ClickUpTask): string {
  const transitions = [task.date_done, task.date_closed]
    .map(timestampMs)
    .filter((value): value is number => value !== null);
  return transitions.length > 0 ? isoFromMilliseconds(Math.max(...transitions)) : "";
}

function nativePriority(task: ClickUpTask): string {
  const id = task.priority?.id === undefined || task.priority?.id === null ? "" : String(task.priority.id);
  const name = task.priority?.priority?.trim().toLowerCase() ?? "";
  if (PRIORITY_BY_ID[id]) return PRIORITY_BY_ID[id];
  if (name === "normal") return "medium";
  if (["urgent", "high", "medium", "low"].includes(name)) return name;
  return "none";
}

function tagsFor(task: ClickUpTask): string[] {
  const tags = (task.tags ?? [])
    .map((tag) => (typeof tag === "string" ? tag : tag.name ?? ""))
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => tag.slice(0, 80));
  return [...new Set(tags)].sort((a, b) => a.localeCompare(b)).slice(0, 50);
}

function assigneeName(task: ClickUpTask): string {
  const assignees = task.assignees ?? [];
  if (assignees.length !== 1) return "";
  const assignee = assignees[0];
  return assignee.username?.trim() || assignee.email?.trim() || String(assignee.id);
}

function invertStatusMap(listId: string, map: ClickUpStatusMap): Map<string, ClickUpBrainStatus> {
  const inverse = new Map<string, ClickUpBrainStatus>();
  for (const status of BRAIN_STATUSES) {
    const native = map[status]?.trim().toLowerCase();
    if (!native) throw new ClickUpNormalizationError(`ClickUp List ${listId} is missing its ${status} status mapping`);
    if (inverse.has(native)) {
      throw new ClickUpNormalizationError(`ClickUp List ${listId} has a non-bijective status mapping`);
    }
    inverse.set(native, status);
  }
  return inverse;
}

function resolveStatus(record: ClickUpTaskRecord, statusMaps: Record<string, ClickUpStatusMap>): ClickUpBrainStatus {
  const taskId = String(record.task.id);
  const native = record.task.status?.status?.trim().toLowerCase();
  if (!native) throw new ClickUpNormalizationError(`ClickUp task ${taskId} has no status name`);

  const homeListId = record.task.list?.id === undefined ? undefined : String(record.task.list.id);
  // A selected home List is authoritative for the task's native status. Only fall back to observed
  // TIML Lists when the home List itself is outside the configured selection.
  const listIds = homeListId && statusMaps[homeListId] ? [homeListId] : record.observedListIds;
  const candidateListIds = listIds
    .filter((value): value is string => Boolean(value))
    .filter((value, index, all) => all.indexOf(value) === index)
    .filter((listId) => Boolean(statusMaps[listId]));
  const resolved = new Set<ClickUpBrainStatus>();
  for (const listId of candidateListIds) {
    const status = invertStatusMap(listId, statusMaps[listId]).get(native);
    if (status) resolved.add(status);
  }

  // FAIL-CLOSED is deliberate: a status the brain cannot interpret must not be guessed into one.
  // The blast radius is the whole workspace payload (this runs inside `rows.map`), so the message has
  // to name the status and the Lists that were consulted — otherwise "one new custom status stopped
  // every ClickUp task importing" is a bug report with nothing in it to act on.
  const consulted = candidateListIds.length > 0 ? candidateListIds.join(", ") : "none";
  if (resolved.size === 0) {
    throw new ClickUpNormalizationError(
      `ClickUp task ${taskId} status "${record.task.status?.status ?? ""}" is not mapped by an observed List (consulted: ${consulted})`
    );
  }
  if (resolved.size > 1) {
    throw new ClickUpNormalizationError(
      `ClickUp task ${taskId} status "${record.task.status?.status ?? ""}" maps ambiguously across observed Lists (consulted: ${consulted})`
    );
  }
  return [...resolved][0];
}

function listIdsFor(record: ClickUpTaskRecord): string[] {
  const home = record.task.list?.id === undefined ? [] : [String(record.task.list.id)];
  const locations = (record.task.locations ?? [])
    .map((location) => location.id)
    .filter((id): id is ClickUpId => id !== undefined)
    .map(String);
  return [...new Set([...home, ...record.observedListIds.map(String), ...locations])].sort((a, b) =>
    a.localeCompare(b)
  );
}

/** ClickUp's human-facing ticket key: the custom id when the Space has them on, else the native id. */
function taskIdentifier(task: ClickUpTask): string {
  const custom = task.custom_id === null || task.custom_id === undefined ? "" : String(task.custom_id).trim();
  return custom || String(task.id);
}

function taskMetadata(record: ClickUpTaskRecord, workspaceId: ClickUpId): Record<string, unknown> {
  const task = record.task;
  return {
    identity: clickUpTaskIdentity(workspaceId, task.id),
    // The field `lib/dashboard/work-timeline.ts` gates on (with `emitsTicketDocuments`) to keep a
    // tracker's own ticket documents out of the timeline's evidence lane. `identity` does NOT satisfy
    // that gate — it reads `frontmatter.identifier`, the same key Linear and Plane stamp — so without
    // this every ClickUp task document would count as evidence and turn the timeline into a backlog
    // dump. NEVER let it be empty: the gate treats an empty identifier as "not a ticket document".
    identifier: taskIdentifier(task),
    native_id: String(task.id),
    custom_id: task.custom_id === null || task.custom_id === undefined ? "" : String(task.custom_id),
    url: task.url ?? "",
    list_id: task.list?.id === undefined ? "" : String(task.list.id),
    list_name: task.list?.name ?? "",
    list_ids: listIdsFor(record),
    parent_id: task.parent === null || task.parent === undefined ? "" : String(task.parent),
    native_status: task.status?.status ?? "",
    native_priority: task.priority?.priority ?? "",
    assignee_ids: (task.assignees ?? []).map((assignee) => String(assignee.id)).sort((a, b) => a.localeCompare(b)),
    assignee_emails: (task.assignees ?? [])
      .map((assignee) => assignee.email ?? "")
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b)),
    date_created: isoTimestamp(task.date_created),
    date_updated: isoTimestamp(task.date_updated),
    date_closed: isoTimestamp(task.date_closed),
    date_done: isoTimestamp(task.date_done),
    start_date: isoTimestamp(task.start_date),
    due_date: isoTimestamp(task.due_date),
  };
}

function dedupeRecords(records: ClickUpTaskRecord[]): ClickUpTaskRecord[] {
  const byId = new Map<string, ClickUpTaskRecord>();
  for (const record of records) {
    const id = String(record.task.id);
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, {
        task: record.task,
        observedListIds: [...new Set(record.observedListIds.map(String))].sort((a, b) => a.localeCompare(b)),
      });
      continue;
    }
    existing.observedListIds = [
      ...new Set([...existing.observedListIds, ...record.observedListIds.map(String)]),
    ].sort((a, b) => a.localeCompare(b));
    const currentUpdated = timestampMs(record.task.date_updated) ?? Number.NEGATIVE_INFINITY;
    const previousUpdated = timestampMs(existing.task.date_updated) ?? Number.NEGATIVE_INFINITY;
    if (currentUpdated > previousUpdated) existing.task = record.task;
  }
  return [...byId.values()].sort((a, b) => String(a.task.id).localeCompare(String(b.task.id)));
}

export function normalizeClickUpTasks(input: NormalizeClickUpTasksInput): ItemPayload {
  const records = dedupeRecords(input.records);
  const includedIds = new Set(records.map((record) => String(record.task.id)));
  const rows = records.map((record) => {
    const task = record.task;
    const rowKey = clickUpTaskIdentity(input.workspaceId, task.id);
    const parentId = task.parent === null || task.parent === undefined ? null : String(task.parent);
    return {
      row_key: rowKey,
      // `title`/`assignee`/`sprint` are capped for the same reason `tagsFor` caps labels: ClickUp
      // permits names longer than the strict row schema accepts (a List name may run to 255, `sprint`
      // stops at 200), and one over-long field rejects the ENTIRE workspace payload at ingest.
      title: capped(task.name?.trim() || "(untitled)", TITLE_MAX),
      status: resolveStatus(record, input.statusMaps),
      priority: nativePriority(task),
      labels: tagsFor(task),
      assignee: capped(assigneeName(task), ASSIGNEE_MAX),
      sprint: capped(task.list?.name ?? "", SPRINT_MAX),
      due: isoTimestamp(task.due_date) || null,
      parent: parentId && includedIds.has(parentId) ? clickUpTaskIdentity(input.workspaceId, parentId) : null,
      worked_at: clickUpWorkedAt(task),
    };
  });

  // JSON lines keep every projectable field and the source provenance deterministic without relying
  // on Markdown table escaping. Any metadata change advances the item sha; an identical replay does not.
  const lines = rows.map((row, index) =>
    JSON.stringify({ row, source: taskMetadata(records[index], input.workspaceId) })
  );

  // The whole workspace is ONE item, and `commonItemFields` bounds `body` at 1,000,000 chars — so at
  // roughly 700 B/task the body crossed the cap around 1,400 tasks and the strict parser then rejected
  // the payload, importing NOTHING. Chunking into several `task` items is NOT the fix: the row sweep in
  // `lib/ingest/tasks.ts` deletes every synced row in the PROJECT that the incoming item omits, so a
  // second chunk would delete the first. So `rows` (unbounded in the schema) stays complete and carries
  // the data, and only the human-readable detail in the body is bounded.
  //
  // The digest is what preserves the idempotency property: it covers EVERY line, including any the body
  // drops, so a metadata-only change still advances `content_sha256` and an identical replay still
  // doesn't. Truncation is declared in frontmatter rather than left silent.
  const digest = sha256(lines.join("\n"));
  const workspace = pathSegment(input.workspaceId);
  const header = `# ClickUp import — ${workspace}\n\ndigest: ${digest}\ntasks: ${rows.length}\n\n`;
  const budget = BODY_MAX - header.length - 1;
  const included: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    included.push(line);
    used += line.length + 1;
  }
  const body = `${header}${included.join("\n")}\n`;

  return {
    project: projectFor(input.workspaceId),
    path: `clickup/${workspace}/tasks.md`,
    kind: "task",
    content_sha256: sha256(body),
    actor: "",
    access: "team",
    frontmatter: {
      source: "clickup",
      workspace_id: String(input.workspaceId),
      task_count: rows.length,
      // Every task is in `rows` regardless; these say how much of the per-task detail the body kept.
      detail_count: included.length,
      detail_truncated: included.length < lines.length,
      rows_digest: digest,
    },
    body,
    rows,
  };
}

/** Searchable task bodies and complete native provenance, separate from the task-row mirror. */
export function normalizeClickUpTaskDocs(input: NormalizeClickUpTasksInput): ItemPayload[] {
  const workspace = pathSegment(input.workspaceId);
  return dedupeRecords(input.records).map((record) => {
    const task = record.task;
    const title = task.name?.trim() || "(untitled)";
    const description = (task.markdown_description ?? task.description ?? "").trim();
    const body = `# ${title}\n\n${description}\n`;
    return {
      project: projectFor(input.workspaceId),
      path: `clickup/${workspace}/tasks/${pathSegment(task.id)}.md`,
      kind: "deliverable" as const,
      content_sha256: sha256(body),
      actor: "",
      access: "team" as const,
      frontmatter: {
        source: "clickup",
        workspace_id: String(input.workspaceId),
        ...taskMetadata(record, input.workspaceId),
        status: resolveStatus(record, input.statusMaps),
        source_ts: clickUpWorkedAt(task),
      },
      body,
    };
  });
}

interface PageAtDepth {
  page: ClickUpDocPage;
  depth: number;
}

function orderedPages(pages: ClickUpDocPage[]): PageAtDepth[] {
  const ordered: PageAtDepth[] = [];
  const visited = new Set<string>();
  const visit = (page: ClickUpDocPage, depth: number) => {
    if (visited.has(String(page.id))) return;
    visited.add(String(page.id));
    const kept = !page.deleted;
    if (kept) ordered.push({ page, depth });
    // A deleted page emits no heading and no `page_ids` entry, so its surviving descendants RE-BASE
    // onto its depth instead of staying one level below a parent that appears nowhere in the output.
    // Otherwise soft-deleting "Agenda" leaves its live "Decisions" child rendering as an orphan `###`
    // under no `##`. Re-basing rather than dropping the subtree: the child's content is still real.
    for (const child of page.pages ?? []) visit(child, kept ? depth + 1 : depth);
  };
  for (const page of pages) visit(page, 0);
  return ordered;
}

function docSourceTimestamp(doc: ClickUpDoc, pages: PageAtDepth[]): string {
  const values = [doc.date_updated, ...pages.flatMap(({ page }) => [page.date_edited, page.date_updated])]
    .map(timestampMs)
    .filter((value): value is number => value !== null);
  // `reduce`, not `Math.max(...values)`: a Doc's page array is unbounded and spreading it as arguments
  // blows the stack on a large enough tree.
  return values.length > 0 ? isoFromMilliseconds(values.reduce((a, b) => (b > a ? b : a))) : "";
}

/**
 * One configured ClickUp Doc becomes one stable, read-only DELIVERABLE item.
 *
 * `transcript` was wrong and silently cost the Doc all of its credit: `classifyWork` maps
 * `transcript` from a non-Slack source to `signal`, and `work-timeline.ts` drops every
 * `kind === "transcript"` row one line BEFORE the `emitsTicketDocuments` gate — while
 * `isMeetingTranscript` excludes clickup too, so the Doc landed in no lane at all. A team writing its
 * specs in ClickUp Docs would have seen zero rollup or timeline credit for them.
 *
 * `deliverable` is what the sidecar's own rule gives a document: "Conversations/notes are
 * transcripts; documents are deliverables" (`DEFAULT_KIND_BY_SOURCE` in
 * `ingestion/aios_ingest/normalize.py` — gdrive, notion and confluence are all `deliverable`). A
 * ClickUp Doc is a document, not a meeting recording. Docs carry no `identifier`, so the ticket-document
 * gate this connector now opts into does not touch them.
 */
export function normalizeClickUpDoc(workspaceId: ClickUpId, input: ClickUpReadDoc): ItemPayload {
  const pages = orderedPages(input.pages);
  const docTitle = input.doc.name?.trim() || "Untitled ClickUp Doc";
  const sections = pages.map(({ page, depth }) => {
    const heading = "#".repeat(Math.min(6, depth + 2));
    const title = page.name?.trim() || "Untitled page";
    const subtitle = page.sub_title?.trim() ? `\n\n_${page.sub_title.trim()}_` : "";
    const content = page.content?.trim() ? `\n\n${page.content.trim()}` : "";
    return `${heading} ${title}${subtitle}${content}`;
  });
  // Same 1 MB `body` bound as the task item. For a Doc the body IS the content, so truncating loses
  // real text — but exceeding the bound loses the ENTIRE Doc to a 422, which is strictly worse. Cut at
  // the bound and SAY so, in the body and in frontmatter, rather than shipping a silently short Doc.
  const full = `# ${docTitle}\n\n${sections.join("\n\n")}\n`;
  const notice = "\n\n_[Truncated: this ClickUp Doc exceeds the item body limit.]_\n";
  const bodyTruncated = full.length > BODY_MAX;
  const body = bodyTruncated ? `${capped(full, BODY_MAX - notice.length)}${notice}` : full;
  const workspace = pathSegment(workspaceId);
  // Coerce BEFORE the Set, as `listIdsFor`/`assignee_ids` do: ClickUp returns user ids as both numbers
  // and strings (see the doc-alpha fixture), so de-duplicating first lets `7` and `"7"` both survive —
  // and a re-sync where ClickUp flips the representation would rewrite the frontmatter with no edit.
  const editors = [
    ...new Set(
      pages
        .map(({ page }) => page.edited_by)
        .filter((id): id is ClickUpId => id !== undefined)
        .map(String)
    ),
  ];

  return {
    project: projectFor(workspaceId),
    path: `clickup/${workspace}/docs/${pathSegment(input.doc.id)}.md`,
    kind: "deliverable",
    content_sha256: sha256(body),
    actor: "",
    access: "team",
    frontmatter: {
      source: "clickup",
      identity: clickUpDocIdentity(workspaceId, input.doc.id),
      workspace_id: String(workspaceId),
      doc_id: input.doc.id,
      url: input.doc.url ?? "",
      creator_id: input.doc.creator === undefined ? "" : String(input.doc.creator),
      editor_ids: editors,
      page_ids: pages.map(({ page }) => String(page.id)),
      source_ts: docSourceTimestamp(input.doc, pages),
      content_format: "text/md",
      body_truncated: bodyTruncated,
    },
    body,
  };
}

export function normalizeClickUpDocs(workspaceId: ClickUpId, docs: ClickUpReadDoc[]): ItemPayload[] {
  return [...docs]
    .sort((a, b) => a.doc.id.localeCompare(b.doc.id))
    .map((doc) => normalizeClickUpDoc(workspaceId, doc));
}
