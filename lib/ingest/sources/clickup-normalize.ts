import { createHash } from "node:crypto";
import { normalizeTaskStatus, type ItemPayload } from "@/lib/api/schemas";
import type {
  ClickUpDoc,
  ClickUpDocPage,
  ClickUpId,
  ClickUpReadDoc,
  ClickUpTask,
  ClickUpTaskRecord,
} from "@/lib/ingest/sources/clickup";

export interface NormalizeClickUpTasksInput {
  workspaceId: ClickUpId;
  records: ClickUpTaskRecord[];
}

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

/**
 * ClickUp `status.type` → brain status. ClickUp's type vocabulary is a small closed set — `open`
 * (not started), `custom` (anything a List author invented between start and finish), `done` and
 * `closed` (both terminal) — exactly the shape `linearStatus`'s TYPE_TO_STATUS and `planeStatus`'s
 * GROUP_TO_STATUS map from.
 *
 * `open → ready`, NOT `backlog`. ClickUp has one not-started type and no separate backlog concept,
 * so mapping it to `backlog` would put every ClickUp workspace's entire not-started column outside
 * `OPEN_STATUSES` (lib/tasks/activity-policy.ts) and therefore invisible to Home, Pulse in-flight
 * and the timeline. A List that genuinely has a backlog column still gets it, by name.
 */
const TYPE_TO_STATUS: Record<string, string> = {
  open: "ready",
  custom: "in_progress",
  done: "done",
  closed: "done",
};

/**
 * The one heuristic in this mapper, deliberately tiny and deliberately ClickUp-only.
 *
 * ClickUp collapses EVERY status between "not started" and "finished" into the single `custom`
 * type, so unlike Linear (where a review state is at least typed `started` and usually NAMED
 * "In Review", which the name-first rule already catches) the type carries no review signal at all.
 * A ClickUp approval loop — "team approval", "client approval", "ready for review" — is therefore
 * indistinguishable from active work by type alone, and would land on `in_progress`, which is the
 * fidelity loss `in_review` was added to stop.
 *
 * Word-boundary anchored on purpose: the past-tense forms "reviewed" and "client approved" mean the
 * work has come BACK from review and is active again, so they must NOT match — `\b` after `review`
 * fails against the trailing "ed". Being a display-name match it is fallible by construction, which
 * is exactly why it sits LAST before the type fallback and can never fail an import: the worst case
 * is one row on `in_review` instead of `in_progress`, both of which are active and open.
 */
const REVIEW_NAME_RE = /\b(review|approval)\b/;

/**
 * A ClickUp status literally NAMED like a brain status wins (so a List with a "Blocked" or
 * "Backlog" column gets it exactly), then the review-name heuristic, then ClickUp's own `type`.
 *
 * FAIL-OPEN to `backlog`, mirroring `linearStatus`/`planeStatus`. It never throws: the predecessor
 * threw from inside `rows.map`, so a single unrecognised status aborted the ENTIRE workspace
 * payload and every per-task document with it. A status the brain can't place is one row landing in
 * intake, not an unimportable workspace — and the native string survives verbatim in
 * `native_status`/`native_status_type` regardless (see `taskMetadata`).
 */
export function clickUpStatus(statusName: string | undefined, statusType: string | undefined): string {
  return clickUpStatusOrNull(statusName, statusType) ?? "backlog";
}

/**
 * Strict variant, mirroring `linearStatusOrNull`. Returns null when neither the name, the review
 * heuristic nor the type resolves — the semantics a future ClickUp inbound-apply needs, where an
 * unresolvable native status is a CONFLICT rather than a silent default. Unused by ingest today;
 * exported so the write path (§4 of docs/design/task-status-model.md) inherits it rather than
 * inventing a second, subtly different mapper.
 */
export function clickUpStatusOrNull(statusName: string | undefined, statusType: string | undefined): string | null {
  const name = (statusName ?? "").trim();
  // `raw_status === null` is the ONLY correct match test, and it is exact: `normalizeTaskStatus`
  // returns `{status: "backlog", raw_status: null}` for a real "Backlog" and
  // `{status: "backlog", raw_status: <input>}` for anything it could not place.
  //
  // DIVERGENCE FROM `linearStatusOrNull`, on purpose. That function additionally requires
  // `byName.status !== "backlog"` before trusting a name, deferring a "Backlog"-named state to its
  // type. Harmless there — Linear HAS a `backlog` state type to fall into. ClickUp does not: its
  // only not-started type is `open`, which this file maps to `ready`. Mirroring the extra clause
  // line-for-line therefore sent a List's literal "Backlog" column to `ready`, which is precisely
  // the case docs/design/task-status-model.md §3(b) claims the name-first rule rescues ("a list
  // that genuinely has a backlog column gets it from the name-first rule"). Naming the column is
  // the ONLY way a ClickUp List can express intake, so the name has to be believed here.
  const byName = normalizeTaskStatus(name);
  if (name && byName.raw_status === null) return byName.status;
  if (name && REVIEW_NAME_RE.test(name.toLowerCase())) return "in_review";
  return TYPE_TO_STATUS[(statusType ?? "").trim().toLowerCase()] ?? null;
}

function resolveStatus(record: ClickUpTaskRecord): string {
  return clickUpStatus(record.task.status?.status, record.task.status?.type);
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
    // The fidelity layer. `status` (canonical) collapses a List's approval loop; these two keep the
    // native pair verbatim and searchable, mirroring Linear's `state`/`state_type`/`status` triple.
    // `native_status_type` is here so a downstream gate never has to regex a display name to find
    // out whether a status was terminal — the mistake `clickUpStatus`'s heuristic has to make.
    native_status: task.status?.status ?? "",
    native_status_type: task.status?.type ?? "",
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

/**
 * The task's assignees as the SOURCE-AGNOSTIC author refs `lib/attribution/resolve-authors` reads.
 *
 * `taskMetadata` already stamps `assignee_ids`/`assignee_emails`, but nothing consumes them:
 * `parseAuthorRefs` handles the SINGULAR `assignee_id` for linear/plane only, and `lib/ingest/run.ts`
 * reads that same singular key — so every ClickUp task document resolved to zero authors and the work
 * landed unattributed while every test stayed green (AIO-924).
 *
 * The fix is branch #1 of `parseAuthorRefs` — structured `frontmatter.authors[]`, which takes
 * precedence over every source-specific branch — rather than a fifth per-source special case. It also
 * carries what a singular key structurally cannot: ClickUp tasks are MULTI-assignee, and it ships the
 * provider id AND the email on each ref, so a team that has never run a ClickUp identity sync still
 * resolves people by email (`resolveRef` tries the id, misses, then the email).
 *
 * `assignee_ids`/`assignee_emails` stay as provenance — this is additive.
 *
 * FOR WHOEVER BUILDS `runClickUpIngestion`: attribute these documents through
 * `attributeIncomingItem` (or `resolveAuthors(map, parseAuthorRefs(fm), connectors)`), NOT by
 * copying the `resolveByProviderId(idMap, "linear", doc.frontmatter.assignee_id)` line the Linear
 * and Plane legs of `lib/ingest/run.ts` use. That line reads a key ClickUp does not emit, would
 * silently resolve to null for every task, and would throw away every assignee after the first.
 */
function authorRefsFor(task: ClickUpTask): Array<Record<string, string>> {
  return (task.assignees ?? [])
    .map((assignee) => {
      const ref: Record<string, string> = {
        role: "assignee",
        provider: "clickup",
        external_id: String(assignee.id),
      };
      const email = assignee.email?.trim();
      const name = assignee.username?.trim();
      if (email) ref.email = email;
      if (name) ref.display_name = name;
      return ref;
    })
    // A blank id with no email and no name is no author at all; `parseAuthorRefs` would drop it
    // anyway, and an entry it drops is one the "add a mapping" queue never gets to see.
    .filter((ref) => ref.external_id.trim() !== "" || ref.email || ref.display_name);
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
      status: resolveStatus(record),
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
  // second chunk would delete the first. So `rows` stays complete and carries the data, and only the
  // human-readable detail in the body is bounded.
  //
  // `rows` is no longer UNBOUNDED, though: brain-api 1.20 caps it at `MAX_PAYLOAD_ROWS` (5,000) so an
  // over-large workspace fails as a 422 naming `rows` and the limit rather than an opaque 413 (AIO-923).
  // A workspace above that ceiling must be split by SELECTING FEWER LISTS — i.e. into separate brain
  // projects — never into two pushes of the same project, which is the delete-the-first case above.
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
        // Read by `parseAuthorRefs` branch #1 — see `authorRefsFor`. Must stay AFTER the spread so a
        // future `taskMetadata` key can never shadow the one signal attribution depends on.
        authors: authorRefsFor(task),
        status: resolveStatus(record),
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
      // Same AIO-924 gap as the task documents: `creator_id`/`editor_ids` are provenance nothing reads.
      // A Doc's creator outranks its editors (ROLE_RANK: creator 1, editor 2), so the primary author is
      // the person who wrote it, and every editor still gets multi-author credit.
      authors: [
        ...(input.doc.creator === undefined
          ? []
          : [{ role: "creator", provider: "clickup", external_id: String(input.doc.creator) }]),
        ...editors
          .filter((id) => String(input.doc.creator ?? "") !== id)
          .map((id) => ({ role: "editor", provider: "clickup", external_id: id })),
      ],
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
