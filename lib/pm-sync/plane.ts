import "server-only";

import {
  desiredStateForStatus,
  htmlToPlainText,
  normalizeName,
  plainTextToHtml,
  PmSyncError,
  requireString,
  sameLabelSet,
  type DesiredState,
  type PmAdapter,
  type PrepareInput,
  type ProviderSyncInput,
  type ProviderSyncResult,
  type UpsertWorkItemInput,
  type UpsertWorkItemResult,
} from "@/lib/pm-sync/provider";

type PlaneState = { id: string; name: string; group?: string };
type PlaneModule = { id: string; name?: string };
type PlaneLabel = { id: string; name: string };
type PlaneWorkItem = {
  id: string;
  name?: string;
  description_html?: string | null;
  state?: string;
  priority?: string | null;
  labels?: string[] | null;
  parent?: string | null;
  external_id?: string | null;
  external_source?: string | null;
};

// Opaque per-run prefetch shared across a projectAllTasks batch. Module memberships are filled in
// lazily (only for the waves actually projected) and cached here by reference.
interface PlaneBootstrap {
  states: PlaneState[];
  items: Map<string, PlaneWorkItem>; // by id
  itemsByExt: Map<string, PlaneWorkItem>; // by `${external_source}::${external_id}`
  labelIds: Map<string, string>; // name → id
  moduleIds: Map<string, string>; // name → id
  moduleMembers: Map<string, Set<string>>; // moduleId → issue ids
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as { results?: unknown[] }).results)) {
    return (value as { results: unknown[] }).results;
  }
  return [];
}

interface PlaneCtx {
  fetchImpl: typeof fetch;
  base: string;
  apiKey: string;
  workspaceSlug: string;
  projectId: string;
  externalSource: string;
}

function planeCtx(input: { integration: { config?: Record<string, unknown> | null; secret: string | null }; link?: { provider_external_source?: string } | null; fetchImpl?: typeof fetch }): PlaneCtx {
  const config = input.integration.config ?? {};
  const apiKey = requireString(input.integration.secret, "Plane API key");
  const base = requireString((config.baseUrl as string | undefined) || "https://api.plane.so", "Plane base URL").replace(/\/$/, "");
  const workspaceSlug = requireString(config.workspaceSlug, "Plane workspaceSlug");
  const projectId = requireString(config.projectId, "Plane projectId");
  // Default to "aios-backlog" for back-compat with the seeded board (the seed wrote that source);
  // a fresh integration can override via config.externalSource.
  const externalSource =
    (config.externalSource as string | undefined) || input.link?.provider_external_source || "aios-backlog";
  return { fetchImpl: input.fetchImpl ?? fetch, base, apiKey, workspaceSlug, projectId, externalSource };
}

async function planeApi(ctx: PlaneCtx, method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
  const url = `${ctx.base}${path}`;
  for (let attempt = 0; ; attempt++) {
    const res = await ctx.fetchImpl(url, {
      method,
      headers: { "X-API-Key": ctx.apiKey, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 6) {
      const retry = Number(res.headers.get("Retry-After") || 5) * 1000;
      await new Promise((r) => setTimeout(r, retry));
      continue;
    }
    const json = await readJson(res);
    if (!res.ok) {
      throw new PmSyncError(`Plane ${method} ${path} failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
    }
    return json;
  }
}

function projPath(ctx: PlaneCtx, suffix: string): string {
  return `/api/v1/workspaces/${ctx.workspaceSlug}/projects/${ctx.projectId}${suffix}`;
}

async function fetchAllPaged(ctx: PlaneCtx, suffix: string): Promise<unknown[]> {
  const out: unknown[] = [];
  let cursor = "100:0:0";
  for (let i = 0; i < 100; i++) {
    const sep = suffix.includes("?") ? "&" : "?";
    const page = await planeApi(ctx, "GET", `${projPath(ctx, suffix)}${sep}per_page=100&cursor=${encodeURIComponent(cursor)}`);
    if (Array.isArray(page)) {
      out.push(...page);
      break;
    }
    out.push(...asArray(page));
    const next = page && typeof page === "object" ? (page as { next_page_results?: boolean; next_cursor?: string }) : null;
    if (!next?.next_page_results || !next.next_cursor) break;
    cursor = next.next_cursor;
  }
  return out;
}

function extKey(source: string | null | undefined, ext: string | null | undefined): string {
  return `${source ?? ""}::${ext ?? ""}`;
}

function resolveStateByGroup(states: PlaneState[], desired: DesiredState): PlaneState {
  const wantName = normalizeName(desired.preferredName);
  const ofGroup = states.filter((s) => s.group === desired.group);
  const named = states.find((s) => normalizeName(s.name) === wantName);
  // Prefer a state literally named like the desired (so a configured "Blocked" wins), else the
  // first state in the target group.
  const target = (named && (named.group === desired.group || desired.group === "started") ? named : null) || ofGroup[0] || named;
  if (!target?.id) throw new PmSyncError(`Plane state not found for group=${desired.group}`);
  return target;
}

function indexItems(itemsRaw: PlaneWorkItem[]): { items: Map<string, PlaneWorkItem>; itemsByExt: Map<string, PlaneWorkItem> } {
  const items = new Map<string, PlaneWorkItem>();
  const itemsByExt = new Map<string, PlaneWorkItem>();
  for (const it of itemsRaw) {
    items.set(it.id, it);
    if (it.external_id) itemsByExt.set(extKey(it.external_source, it.external_id), it);
  }
  return { items, itemsByExt };
}

// Lite prefetch for the status-only / moveToDone paths: states + items only (no labels/modules),
// so a caller that just moves state never needs label/module endpoints.
async function buildLiteBootstrap(ctx: PlaneCtx): Promise<PlaneBootstrap> {
  const [statesRaw, itemsRaw] = await Promise.all([fetchAllPaged(ctx, "/states/"), fetchAllPaged(ctx, "/work-items/")]);
  const { items, itemsByExt } = indexItems(itemsRaw as PlaneWorkItem[]);
  return { states: statesRaw as PlaneState[], items, itemsByExt, labelIds: new Map(), moduleIds: new Map(), moduleMembers: new Map() };
}

async function buildBootstrap(ctx: PlaneCtx, labels: string[]): Promise<PlaneBootstrap> {
  const [statesRaw, itemsRaw, labelsRaw, modulesRaw] = await Promise.all([
    fetchAllPaged(ctx, "/states/"),
    fetchAllPaged(ctx, "/work-items/"),
    fetchAllPaged(ctx, "/labels/"),
    fetchAllPaged(ctx, "/modules/"),
  ]);
  const { items, itemsByExt } = indexItems(itemsRaw as PlaneWorkItem[]);
  const labelIds = new Map<string, string>((labelsRaw as PlaneLabel[]).map((l) => [l.name, l.id]));
  const moduleIds = new Map<string, string>((modulesRaw as PlaneModule[]).filter((m) => m.name).map((m) => [m.name as string, m.id]));

  // Ensure requested labels exist (create missing once per run).
  for (const name of labels) {
    if (!name || labelIds.has(name)) continue;
    const created = (await planeApi(ctx, "POST", projPath(ctx, "/labels/"), { name })) as PlaneLabel;
    labelIds.set(name, created.id);
  }
  return { states: statesRaw as PlaneState[], items, itemsByExt, labelIds, moduleIds, moduleMembers: new Map() };
}

async function ensureLabelIds(ctx: PlaneCtx, boot: PlaneBootstrap, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    if (!name) continue;
    let id = boot.labelIds.get(name);
    if (!id) {
      const created = (await planeApi(ctx, "POST", projPath(ctx, "/labels/"), { name })) as PlaneLabel;
      id = created.id;
      boot.labelIds.set(name, id);
    }
    ids.push(id);
  }
  return ids;
}

async function ensureModuleMembership(ctx: PlaneCtx, boot: PlaneBootstrap, waveName: string, itemId: string): Promise<void> {
  const name = waveName.trim();
  if (!name) return;
  let moduleId = boot.moduleIds.get(name);
  if (!moduleId) {
    const created = (await planeApi(ctx, "POST", projPath(ctx, "/modules/"), { name })) as PlaneModule;
    moduleId = created.id;
    boot.moduleIds.set(name, moduleId);
  }
  let members = boot.moduleMembers.get(moduleId);
  if (!members) {
    const rows = (await fetchAllPaged(ctx, `/modules/${moduleId}/module-issues/`)) as { issue?: string; id?: string }[];
    members = new Set(rows.map((m) => m.issue || m.id).filter(Boolean) as string[]);
    boot.moduleMembers.set(moduleId, members);
  }
  if (!members.has(itemId)) {
    await planeApi(ctx, "POST", projPath(ctx, `/modules/${moduleId}/module-issues/`), { issues: [itemId] });
    members.add(itemId);
  }
}

// Does the adopted Plane item already match the desired projection? (avoids a redundant PATCH,
// preserves seeded descriptions on first adoption.)
function planeItemMatches(item: PlaneWorkItem, desired: { name: string; stateId: string; priority: string; labelIds: string[]; parent: string | null; body: string }): boolean {
  if ((item.name ?? "") !== desired.name) return false;
  if ((item.state ?? "") !== desired.stateId) return false;
  if ((item.priority ?? "none") !== desired.priority) return false;
  if ((item.parent ?? null) !== desired.parent) return false;
  if (!sameLabelSet(item.labels ?? [], desired.labelIds)) return false;
  if (htmlToPlainText(item.description_html) !== desired.body.trim()) return false;
  return true;
}

async function patchStateOnly(ctx: PlaneCtx, boot: PlaneBootstrap, link: { provider_resource_id: string | null; provider_external_id: string }, desired: DesiredState): Promise<{ item: PlaneWorkItem; stateId: string; changed: boolean }> {
  const item =
    (link.provider_resource_id ? boot.items.get(link.provider_resource_id) : undefined) ||
    boot.itemsByExt.get(extKey(ctx.externalSource, link.provider_external_id)) ||
    boot.itemsByExt.get(extKey("aios", link.provider_external_id));
  if (!item?.id) {
    throw new PmSyncError(`Plane work item not found for external_source=${ctx.externalSource} external_id=${link.provider_external_id}`);
  }
  const state = resolveStateByGroup(boot.states, desired);
  const changed = item.state !== state.id;
  if (changed) {
    await planeApi(ctx, "PATCH", projPath(ctx, `/work-items/${item.id}/`), { state: state.id });
    item.state = state.id;
  }
  return { item, stateId: state.id, changed };
}

export const planeAdapter: PmAdapter = {
  provider: "plane",

  async prepare({ integration, labels = [], fetchImpl }: PrepareInput): Promise<PlaneBootstrap> {
    const ctx = planeCtx({ integration, fetchImpl });
    return buildBootstrap(ctx, labels);
  },

  async upsertWorkItem({ task, link, integration, desiredFingerprint, statusOnly, bootstrap, fetchImpl }: UpsertWorkItemInput): Promise<UpsertWorkItemResult> {
    const ctx = planeCtx({ integration, link, fetchImpl });
    const boot =
      (bootstrap as PlaneBootstrap | undefined) ?? (statusOnly ? await buildLiteBootstrap(ctx) : await buildBootstrap(ctx, task.labels));
    const desired = desiredStateForStatus(task.status);

    // statusOnly: only reconcile workflow state; never touch title/body/labels/priority/parent.
    if (statusOnly) {
      if (!link) throw new PmSyncError("Plane statusOnly upsert requires an existing link");
      const { item, stateId, changed } = await patchStateOnly(ctx, boot, link, desired);
      return {
        provider: "plane",
        status: changed ? "synced" : "skipped",
        providerResourceId: item.id,
        providerUrl: link.provider_url || "",
        externalSource: ctx.externalSource,
        syncedStatus: stateId,
        fingerprint: desiredFingerprint,
      };
    }

    // Adopt-or-create. Resource id wins; else match external_id across legacy + current sources.
    const existing =
      (link?.provider_resource_id ? boot.items.get(link.provider_resource_id) : undefined) ||
      boot.itemsByExt.get(extKey(ctx.externalSource, task.row_key)) ||
      boot.itemsByExt.get(extKey("aios", task.row_key)) ||
      boot.itemsByExt.get(extKey("aios-backlog", task.row_key));

    const state = resolveStateByGroup(boot.states, desired);
    const labelIds = await ensureLabelIds(ctx, boot, task.labels);
    const priority = task.priority || "none";
    const parent = task.parentResourceId ?? null;
    const desiredFields = { name: task.title, stateId: state.id, priority, labelIds, parent, body: task.body };

    let item: PlaneWorkItem;
    let mutated = false;
    if (existing?.id) {
      item = existing;
      if (!planeItemMatches(item, desiredFields)) {
        const patched = (await planeApi(ctx, "PATCH", projPath(ctx, `/work-items/${item.id}/`), {
          name: task.title,
          description_html: plainTextToHtml(task.body),
          state: state.id,
          priority,
          labels: labelIds,
          parent,
        })) as PlaneWorkItem;
        item = { ...item, ...patched, labels: labelIds, state: state.id, priority, parent, name: task.title, description_html: plainTextToHtml(task.body) };
        boot.items.set(item.id, item);
        mutated = true;
      }
    } else {
      item = (await planeApi(ctx, "POST", projPath(ctx, "/work-items/"), {
        name: task.title,
        description_html: plainTextToHtml(task.body),
        external_id: task.row_key,
        external_source: ctx.externalSource,
        state: state.id,
        priority,
        labels: labelIds,
        ...(parent ? { parent } : {}),
      })) as PlaneWorkItem;
      boot.items.set(item.id, item);
      boot.itemsByExt.set(extKey(ctx.externalSource, task.row_key), item);
      mutated = true;
    }

    // Wave module membership (idempotent add).
    if (task.sprint) {
      const before = mutated;
      await ensureModuleMembership(ctx, boot, task.sprint, item.id);
      mutated = before || mutated;
    }

    return {
      provider: "plane",
      status: mutated ? "synced" : "skipped",
      providerResourceId: item.id,
      providerUrl: link?.provider_url || "",
      parentResourceId: item.id,
      externalSource: ctx.externalSource,
      syncedStatus: state.id,
      fingerprint: desiredFingerprint,
    };
  },

  // Thin delegate: reconcile only the workflow state of an already-linked item to "done".
  async moveToDone({ link, integration, fetchImpl }: ProviderSyncInput): Promise<ProviderSyncResult> {
    const ctx = planeCtx({ integration, link, fetchImpl });
    const boot = await buildLiteBootstrap(ctx);
    const { item, stateId, changed } = await patchStateOnly(ctx, boot, link, desiredStateForStatus("done"));
    return {
      provider: "plane",
      status: changed ? "synced" : "skipped",
      providerResourceId: item.id,
      syncedStatus: (boot.states.find((s) => s.id === stateId)?.name) ?? stateId,
    };
  },
};
