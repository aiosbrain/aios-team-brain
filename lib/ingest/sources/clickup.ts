/**
 * Read-only ClickUp API boundary for the AIO-819 pilot.
 *
 * The transport, clock, sleeper, and jitter source are injected so every request path can be
 * exercised without a credential or network access. This module intentionally exposes no mutation
 * methods; writeback belongs to the later PM adapter slice.
 */

export type ClickUpId = string | number;
export type ClickUpTransport = (input: string, init: RequestInit) => Promise<Response>;
export type ClickUpSleep = (milliseconds: number) => Promise<void>;

export interface ClickUpUser {
  id: ClickUpId;
  username?: string;
  email?: string;
  [key: string]: unknown;
}

export interface ClickUpTask {
  id: ClickUpId;
  custom_id?: ClickUpId | null;
  name?: string;
  description?: string | null;
  markdown_description?: string | null;
  status?: { id?: ClickUpId; status?: string; type?: string; [key: string]: unknown } | null;
  priority?: { id?: ClickUpId; priority?: string; [key: string]: unknown } | null;
  assignees?: ClickUpUser[] | null;
  tags?: Array<string | { name?: string; [key: string]: unknown }> | null;
  parent?: ClickUpId | null;
  date_created?: ClickUpId | null;
  date_updated?: ClickUpId | null;
  date_closed?: ClickUpId | null;
  date_done?: ClickUpId | null;
  start_date?: ClickUpId | null;
  due_date?: ClickUpId | null;
  archived?: boolean;
  url?: string;
  team_id?: ClickUpId;
  list?: { id?: ClickUpId; name?: string; [key: string]: unknown } | null;
  locations?: Array<{ id?: ClickUpId; name?: string; [key: string]: unknown }> | null;
  [key: string]: unknown;
}

export interface ClickUpTaskRecord {
  task: ClickUpTask;
  /** Selected Lists through which this task was observed, in configured List order. */
  observedListIds: string[];
}

export interface ClickUpDoc {
  id: string;
  workspace_id: ClickUpId;
  name?: string;
  date_created?: number;
  date_updated?: number;
  creator?: ClickUpId;
  archived?: boolean;
  deleted?: boolean;
  url?: string;
  parent?: { id: string; type: number };
  [key: string]: unknown;
}

export interface ClickUpDocPage {
  id: string;
  doc_id?: string;
  workspace_id?: ClickUpId;
  parent_page_id?: string;
  name?: string;
  sub_title?: string;
  content?: string;
  date_created?: number;
  date_updated?: number;
  date_edited?: number;
  creator_id?: ClickUpId;
  edited_by?: ClickUpId;
  authors?: ClickUpId[];
  contributors?: ClickUpId[];
  archived?: boolean;
  deleted?: boolean;
  pages?: ClickUpDocPage[];
  [key: string]: unknown;
}

export interface ClickUpDocSelection {
  docIds?: string[];
  parent?: {
    type: "SPACE" | "FOLDER" | "LIST" | "EVERYTHING" | "WORKSPACE";
    id: string;
  };
}

export interface ClickUpReadDoc {
  doc: ClickUpDoc;
  pages: ClickUpDocPage[];
}

export interface ClickUpClientOptions {
  token: string;
  transport: ClickUpTransport;
  baseUrl?: string;
  maxConcurrency?: number;
  maxRetries?: number;
  maxPages?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  now?: () => number;
  sleep?: ClickUpSleep;
  random?: () => number;
}

type ErrorCode = "http" | "protocol" | "pagination" | "transport";

export class ClickUpClientError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;

  constructor(message: string, code: ErrorCode, status?: number) {
    super(message);
    this.name = "ClickUpClientError";
    this.code = code;
    this.status = status;
  }
}

class ConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await operation();
    } finally {
      const next = this.waiters.shift();
      // Transfer the occupied slot directly to the next waiter. Decrement only when nobody is
      // queued, otherwise a newly arriving request could steal the slot before the waiter resumes.
      if (next) next();
      else this.active -= 1;
    }
  }
}

const defaultSleep: ClickUpSleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return result;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return result;
}

function objectValue(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClickUpClientError(`ClickUp returned an invalid ${context} response`, "protocol");
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ClickUpClientError(`ClickUp returned an invalid ${context} response`, "protocol");
  }
  return value;
}

function idValue(value: unknown, context: string): string {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).length === 0) {
    throw new ClickUpClientError(`ClickUp returned an invalid ${context} id`, "protocol");
  }
  return String(value);
}

function retryAfterMilliseconds(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** An ABSENT header is not a value. `Number(null)` is 0, so testing finiteness alone reads a header
 *  the response never carried as a real zero — which is how a missing quota header became "quota
 *  exhausted" below. Both helpers check for absence explicitly. */
function headerNumber(header: string | null): number | null {
  if (header === null || header.trim() === "") return null;
  const value = Number(header);
  return Number.isFinite(value) ? value : null;
}

function resetMilliseconds(header: string | null, now: number): number | null {
  const seconds = headerNumber(header);
  if (seconds === null || seconds < 0) return null;
  return Math.max(0, seconds * 1000 - now);
}

function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || [500, 502, 503, 504].includes(status);
}

/** "Latest wins" for TIML dedupe. Mirrors `timestampMs` in clickup-normalize: a value ClickUp uses
 *  for UNSET (0) or one outside the Date range is NOT a recency signal, and the two must agree or the
 *  client and the normalizer pick different winners for the same duplicated task. */
function numericTimestamp(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") return Number.NEGATIVE_INFINITY;
  const direct = Number(value);
  if (direct === 0) return Number.NEGATIVE_INFINITY;
  if (Number.isFinite(direct)) return Math.abs(direct) <= 8.64e15 ? direct : Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export class ClickUpClient {
  private readonly token: string;
  private readonly transport: ClickUpTransport;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly maxPages: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly now: () => number;
  private readonly sleep: ClickUpSleep;
  private readonly random: () => number;
  private readonly gate: ConcurrencyGate;
  private blockedUntilMs = 0;

  constructor(options: ClickUpClientOptions) {
    if (!options.token.trim()) throw new TypeError("ClickUp token is required");
    this.token = options.token;
    this.transport = options.transport;
    this.baseUrl = options.baseUrl ?? "https://api.clickup.com";
    this.maxRetries = nonNegativeInteger(options.maxRetries, 4, "maxRetries");
    this.maxPages = positiveInteger(options.maxPages, 10_000, "maxPages");
    this.baseRetryDelayMs = positiveInteger(options.baseRetryDelayMs, 250, "baseRetryDelayMs");
    this.maxRetryDelayMs = positiveInteger(options.maxRetryDelayMs, 60_000, "maxRetryDelayMs");
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.gate = new ConcurrencyGate(positiveInteger(options.maxConcurrency, 4, "maxConcurrency"));
  }

  private async waitForRateWindow(): Promise<void> {
    const delay = this.blockedUntilMs - this.now();
    if (delay > 0) await this.sleep(Math.min(delay, this.maxRetryDelayMs));
  }

  private observeRateLimit(response: Response): void {
    // A response that carries `X-RateLimit-Reset` but NOT `X-RateLimit-Remaining` — a CDN error page,
    // or an endpoint whose header set differs — used to read as remaining === 0 via `Number(null)`,
    // parking `blockedUntilMs` and stalling every request on this client with no rate limit in force.
    const remaining = headerNumber(response.headers.get("X-RateLimit-Remaining"));
    const resetDelay = resetMilliseconds(response.headers.get("X-RateLimit-Reset"), this.now());
    if (remaining === 0 && resetDelay !== null && resetDelay > 0) {
      this.blockedUntilMs = Math.max(this.blockedUntilMs, this.now() + resetDelay);
    }
  }

  private retryDelay(response: Response | null, attempt: number): number {
    const now = this.now();
    const exponential = Math.min(this.maxRetryDelayMs, this.baseRetryDelayMs * 2 ** attempt);
    const retryAfter = response ? retryAfterMilliseconds(response.headers.get("Retry-After"), now) : null;
    const reset = response ? resetMilliseconds(response.headers.get("X-RateLimit-Reset"), now) : null;
    const floor = Math.max(exponential, retryAfter ?? 0, reset ?? 0);
    const jitterBound = Math.min(250, Math.max(1, Math.floor(exponential / 4)));
    const jitter = Math.floor(Math.max(0, Math.min(1, this.random())) * jitterBound);
    return Math.min(this.maxRetryDelayMs, floor + jitter);
  }

  private async requestJson<T>(path: string, query?: URLSearchParams): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (query) url.search = query.toString();
    const safePath = url.pathname;

    return this.gate.run(async () => {
      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        await this.waitForRateWindow();
        let response: Response;
        try {
          response = await this.transport(url.toString(), {
            method: "GET",
            headers: {
              Authorization: this.token,
              Accept: "application/json",
            },
          });
        } catch {
          if (attempt < this.maxRetries) {
            await this.sleep(this.retryDelay(null, attempt));
            continue;
          }
          throw new ClickUpClientError(`ClickUp GET ${safePath} failed after ${attempt + 1} attempts`, "transport");
        }

        this.observeRateLimit(response);
        if (!response.ok) {
          if (isRetriableStatus(response.status) && attempt < this.maxRetries) {
            await this.sleep(this.retryDelay(response, attempt));
            continue;
          }
          throw new ClickUpClientError(`ClickUp GET ${safePath} failed (${response.status})`, "http", response.status);
        }

        try {
          return (await response.json()) as T;
        } catch {
          throw new ClickUpClientError(`ClickUp GET ${safePath} returned invalid JSON`, "protocol", response.status);
        }
      }
      throw new ClickUpClientError(`ClickUp GET ${safePath} exhausted retries`, "transport");
    });
  }

  async getAuthorizedUser(): Promise<Record<string, unknown>> {
    return objectValue(await this.requestJson<unknown>("/api/v2/user"), "authorized user");
  }

  async getAuthorizedWorkspaces(): Promise<Record<string, unknown>[]> {
    const payload = objectValue(await this.requestJson<unknown>("/api/v2/team"), "authorized workspaces");
    return arrayValue(payload.teams, "authorized workspaces").map((workspace) =>
      objectValue(workspace, "authorized workspace")
    );
  }

  async getList(listId: ClickUpId): Promise<Record<string, unknown>> {
    const id = encodeURIComponent(String(listId));
    return objectValue(await this.requestJson<unknown>(`/api/v2/list/${id}`), "List");
  }

  async getTask(taskId: ClickUpId): Promise<ClickUpTask> {
    const id = encodeURIComponent(String(taskId));
    const task = objectValue(await this.requestJson<unknown>(`/api/v2/task/${id}`), "task") as ClickUpTask;
    idValue(task.id, "task");
    return task;
  }

  async getTasksForList(listId: ClickUpId): Promise<ClickUpTask[]> {
    const id = encodeURIComponent(String(listId));
    const tasks: ClickUpTask[] = [];

    for (let page = 0; page < this.maxPages; page += 1) {
      const query = new URLSearchParams({
        include_closed: "true",
        subtasks: "true",
        include_timl: "true",
        include_markdown_description: "true",
        page: String(page),
      });
      const payload = objectValue(
        await this.requestJson<unknown>(`/api/v2/list/${id}/task`, query),
        "task page"
      );
      const pageTasks = arrayValue(payload.tasks, "task page").map((task) => {
        const value = objectValue(task, "task") as ClickUpTask;
        idValue(value.id, "task");
        return value;
      });
      tasks.push(...pageTasks);

      if (payload.last_page === true || pageTasks.length === 0) return tasks;
      if (typeof payload.last_page !== "boolean" && pageTasks.length < 100) return tasks;
    }

    throw new ClickUpClientError(`ClickUp task pagination exceeded ${this.maxPages} pages`, "pagination");
  }

  /** Fetch selected Lists concurrently within the per-token gate and de-duplicate TIML tasks by native id. */
  async getTasksForLists(listIds: ClickUpId[]): Promise<ClickUpTaskRecord[]> {
    const normalizedListIds = [...new Set(listIds.map(String))];
    const pages = await Promise.all(
      normalizedListIds.map(async (listId) => ({ listId, tasks: await this.getTasksForList(listId) }))
    );
    const byId = new Map<string, ClickUpTaskRecord>();

    for (const { listId, tasks } of pages) {
      for (const task of tasks) {
        const taskId = idValue(task.id, "task");
        const existing = byId.get(taskId);
        if (!existing) {
          byId.set(taskId, { task, observedListIds: [listId] });
          continue;
        }
        if (!existing.observedListIds.includes(listId)) existing.observedListIds.push(listId);
        if (numericTimestamp(task.date_updated) > numericTimestamp(existing.task.date_updated)) {
          existing.task = task;
        }
      }
    }

    return [...byId.values()].sort((a, b) => String(a.task.id).localeCompare(String(b.task.id)));
  }

  async searchDocs(
    workspaceId: ClickUpId,
    filter: ClickUpDocSelection["parent"] | undefined
  ): Promise<ClickUpDoc[]> {
    const workspace = encodeURIComponent(String(workspaceId));
    const docs: ClickUpDoc[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < this.maxPages; page += 1) {
      const query = new URLSearchParams({ limit: "100" });
      if (filter) {
        query.set("parent_type", filter.type);
        query.set("parent_id", filter.id);
      }
      if (cursor) query.set("cursor", cursor);

      const payload = objectValue(
        await this.requestJson<unknown>(`/api/v3/workspaces/${workspace}/docs`, query),
        "Docs page"
      );
      const pageDocs = arrayValue(payload.docs, "Docs page").map((doc) => {
        const value = objectValue(doc, "Doc") as unknown as ClickUpDoc;
        // KEEP the coerced id. `ClickUpDoc.id` is typed `string` and `discoverDocs` sorts with
        // `localeCompare`, but ClickUp returns ids as numbers too (the fixtures mix both) — discarding
        // the return validated the id and then handed the raw number on, so two numeric Doc ids threw
        // `TypeError: a.id.localeCompare is not a function` and took down the whole Docs read.
        // Task ids are deliberately NOT coerced: `ClickUpTask.id` is `string | number` by contract.
        value.id = idValue(value.id, "Doc");
        return value;
      });
      docs.push(...pageDocs);

      const next = typeof payload.next_cursor === "string" && payload.next_cursor ? payload.next_cursor : undefined;
      if (!next) return docs;
      if (seenCursors.has(next)) {
        throw new ClickUpClientError("ClickUp Docs pagination repeated a cursor", "pagination");
      }
      seenCursors.add(next);
      cursor = next;
    }

    throw new ClickUpClientError(`ClickUp Docs pagination exceeded ${this.maxPages} pages`, "pagination");
  }

  async getDoc(workspaceId: ClickUpId, docId: string): Promise<ClickUpDoc> {
    const workspace = encodeURIComponent(String(workspaceId));
    const doc = encodeURIComponent(docId);
    const value = objectValue(
      await this.requestJson<unknown>(`/api/v3/workspaces/${workspace}/docs/${doc}`),
      "Doc"
    ) as unknown as ClickUpDoc;
    value.id = idValue(value.id, "Doc");
    return value;
  }

  async getDocPages(workspaceId: ClickUpId, docId: string): Promise<ClickUpDocPage[]> {
    const workspace = encodeURIComponent(String(workspaceId));
    const doc = encodeURIComponent(docId);
    const query = new URLSearchParams({ max_page_depth: "-1", content_format: "text/md" });
    return arrayValue(
      await this.requestJson<unknown>(`/api/v3/workspaces/${workspace}/docs/${doc}/pages`, query),
      "Doc pages"
    ).map((page) => {
      const value = objectValue(page, "Doc page") as unknown as ClickUpDocPage;
      value.id = idValue(value.id, "Doc page");
      return value;
    });
  }

  async discoverDocs(workspaceId: ClickUpId, selection: ClickUpDocSelection): Promise<ClickUpDoc[]> {
    const explicitIds = [...new Set(selection.docIds ?? [])];
    const [explicit, underParent] = await Promise.all([
      Promise.all(explicitIds.map((docId) => this.getDoc(workspaceId, docId))),
      selection.parent ? this.searchDocs(workspaceId, selection.parent) : Promise.resolve([]),
    ]);
    const byId = new Map<string, ClickUpDoc>();
    // An explicitly configured Doc remains observable even when archived/deleted so the caller can
    // surface health instead of silently treating it as an unselected Doc. Parent discovery omits
    // inactive Docs, matching the endpoint's default selection semantics.
    for (const doc of explicit) byId.set(String(doc.id), doc);
    for (const doc of underParent) {
      if (!doc.deleted && !doc.archived && !byId.has(String(doc.id))) byId.set(String(doc.id), doc);
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async readDoc(workspaceId: ClickUpId, docOrId: ClickUpDoc | string): Promise<ClickUpReadDoc> {
    const doc = typeof docOrId === "string" ? await this.getDoc(workspaceId, docOrId) : docOrId;
    const pages = await this.getDocPages(workspaceId, doc.id);
    return { doc, pages };
  }

  async readDocs(workspaceId: ClickUpId, selection: ClickUpDocSelection): Promise<ClickUpReadDoc[]> {
    const docs = await this.discoverDocs(workspaceId, selection);
    return Promise.all(docs.map((doc) => this.readDoc(workspaceId, doc)));
  }
}
