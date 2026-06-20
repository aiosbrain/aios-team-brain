import "server-only";

import {
  normalizeName,
  PmSyncError,
  requireString,
  type PmAdapter,
  type ProviderSyncInput,
  type ProviderSyncResult,
} from "@/lib/pm-sync/provider";

type PlaneState = { id: string; name: string; group?: string };
type PlaneWorkItem = {
  id: string;
  name?: string;
  state?: string;
  external_id?: string | null;
  external_source?: string | null;
};

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

async function planeApi(
  fetchImpl: typeof fetch,
  base: string,
  apiKey: string,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const res = await fetchImpl(`${base}${path}`, {
    method,
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await readJson(res);
  if (!res.ok) {
    throw new PmSyncError(`Plane ${method} ${path} failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as { results?: unknown[] }).results)) {
    return (value as { results: unknown[] }).results;
  }
  return [];
}

async function fetchAllWorkItems(
  fetchImpl: typeof fetch,
  base: string,
  apiKey: string,
  workspaceSlug: string,
  projectId: string
): Promise<PlaneWorkItem[]> {
  const out: PlaneWorkItem[] = [];
  let cursor = "100:0:0";
  for (let i = 0; i < 100; i++) {
    const path = `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/work-items/?per_page=100&cursor=${encodeURIComponent(cursor)}`;
    const page = await planeApi(fetchImpl, base, apiKey, "GET", path);
    out.push(...(asArray(page) as PlaneWorkItem[]));
    const next = page && typeof page === "object" ? (page as { next_page_results?: boolean; next_cursor?: string }) : null;
    if (!next?.next_page_results || !next.next_cursor) break;
    cursor = next.next_cursor;
  }
  return out;
}

async function resolveDoneState(
  fetchImpl: typeof fetch,
  base: string,
  apiKey: string,
  workspaceSlug: string,
  projectId: string,
  preferredName?: string
): Promise<PlaneState> {
  const states = asArray(
    await planeApi(
      fetchImpl,
      base,
      apiKey,
      "GET",
      `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/states/`
    )
  ) as PlaneState[];
  const normalized = preferredName ? normalizeName(preferredName) : "";
  const byName = normalized ? states.find((s) => normalizeName(s.name) === normalized) : null;
  const completed = states.find((s) => s.group === "completed");
  const done = states.find((s) => normalizeName(s.name) === "done");
  const target = byName || done || completed;
  if (!target?.id) throw new PmSyncError("Plane completed state not found");
  return target;
}

export const planeAdapter: PmAdapter = {
  provider: "plane",
  async moveToDone({ link, integration, fetchImpl = fetch }: ProviderSyncInput): Promise<ProviderSyncResult> {
    const config = integration.config ?? {};
    const apiKey = requireString(integration.secret, "Plane API key");
    const base = requireString((config.baseUrl as string | undefined) || "https://api.plane.so", "Plane base URL").replace(/\/$/, "");
    const workspaceSlug = requireString(config.workspaceSlug, "Plane workspaceSlug");
    const projectId = requireString(config.projectId, "Plane projectId");
    const externalSource = (config.externalSource as string | undefined) || link.provider_external_source || "aios";
    const doneState = await resolveDoneState(
      fetchImpl,
      base,
      apiKey,
      workspaceSlug,
      projectId,
      config.doneStateName as string | undefined
    );

    const items = await fetchAllWorkItems(fetchImpl, base, apiKey, workspaceSlug, projectId);
    const item =
      (link.provider_resource_id ? items.find((it) => it.id === link.provider_resource_id) : null) ||
      items.find((it) => it.external_id === link.provider_external_id && it.external_source === externalSource);
    if (!item?.id) {
      throw new PmSyncError(
        `Plane work item not found for external_source=${externalSource} external_id=${link.provider_external_id}`
      );
    }

    if (item.state !== doneState.id) {
      await planeApi(
        fetchImpl,
        base,
        apiKey,
        "PATCH",
        `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/work-items/${item.id}/`,
        { state: doneState.id }
      );
    }

    return {
      provider: "plane",
      status: item.state === doneState.id ? "skipped" : "synced",
      providerResourceId: item.id,
      syncedStatus: doneState.name,
    };
  },
};
