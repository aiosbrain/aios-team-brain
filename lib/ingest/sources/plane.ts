import "server-only";

import { fetchAllPaged, planeApi, type PlaneConnection } from "@/lib/pm-sync/plane-client";
import type { PlaneState, PlaneWorkItemRaw } from "./plane-normalize";

/**
 * Read-only Plane fetch for the inbound ingestion runner. Pulls a project's
 * work-items plus the lookup tables normalize needs (states, labels, module/epic
 * membership, member display names) via the shared low-level client. Every
 * auxiliary lookup is best-effort: a missing scope/endpoint degrades gracefully
 * (ids instead of names, empty module map) rather than aborting the import.
 */

export interface FetchedPlaneProject {
  projectId: string;
  projectIdentifier?: string;
  workspaceSlug: string;
  baseUrl: string;
  items: PlaneWorkItemRaw[];
  states: PlaneState[];
  labels: { id: string; name: string }[];
  members: Record<string, string>;
  moduleByItem: Record<string, string>;
  cycleByItem: Record<string, string>;
}

/** Project's short identifier (e.g. "ENG") for stable, human-readable row_keys. Best-effort. */
async function fetchIdentifier(conn: PlaneConnection): Promise<string | undefined> {
  try {
    const proj = (await planeApi(
      conn,
      "GET",
      `/api/v1/workspaces/${conn.workspaceSlug}/projects/${conn.projectId}/`
    )) as { identifier?: string };
    return proj.identifier || undefined;
  } catch {
    return undefined;
  }
}

/** Workspace member id → display name. Best-effort (needs member-read scope). */
async function fetchMembers(conn: PlaneConnection): Promise<Record<string, string>> {
  try {
    const rows = (await planeApi(
      conn,
      "GET",
      `/api/v1/workspaces/${conn.workspaceSlug}/members/`
    )) as unknown;
    const list = Array.isArray(rows)
      ? rows
      : (rows as { results?: unknown[] })?.results ?? [];
    const map: Record<string, string> = {};
    for (const m of list as {
      member?: string;
      id?: string;
      display_name?: string;
      first_name?: string;
      last_name?: string;
      email?: string;
    }[]) {
      const id = m.member || m.id;
      if (!id) continue;
      const name =
        m.display_name ||
        [m.first_name, m.last_name].filter(Boolean).join(" ").trim() ||
        m.email ||
        id;
      map[id] = name;
    }
    return map;
  } catch {
    return {};
  }
}

/** work-item id → module (epic) name, by walking each module's issue membership. Best-effort. */
async function fetchModuleByItem(conn: PlaneConnection): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const modules = (await fetchAllPaged(conn, "/modules/")) as { id: string; name?: string }[];
    for (const mod of modules) {
      if (!mod.name) continue;
      try {
        const members = (await fetchAllPaged(conn, `/modules/${mod.id}/module-issues/`)) as {
          issue?: string;
          id?: string;
        }[];
        for (const mi of members) {
          const issueId = mi.issue || mi.id;
          if (issueId) out[issueId] = mod.name;
        }
      } catch {
        // one module's membership failed — skip it, keep the rest.
      }
    }
  } catch {
    // no module access — import without epic grouping.
  }
  return out;
}

/** work-item id → cycle (iteration) name, by walking each cycle's issue membership. Best-effort. */
async function fetchCycleByItem(conn: PlaneConnection): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const cycles = (await fetchAllPaged(conn, "/cycles/")) as { id: string; name?: string }[];
    for (const cyc of cycles) {
      if (!cyc.name) continue;
      try {
        const members = (await fetchAllPaged(conn, `/cycles/${cyc.id}/cycle-issues/`)) as {
          issue?: string;
          id?: string;
        }[];
        for (const ci of members) {
          const issueId = ci.issue || ci.id;
          if (issueId) out[issueId] = cyc.name;
        }
      } catch {
        // one cycle's membership failed — skip it, keep the rest.
      }
    }
  } catch {
    // no cycle access — import without iteration grouping.
  }
  return out;
}

export async function fetchPlaneProject(conn: PlaneConnection): Promise<FetchedPlaneProject> {
  const [items, states, labels, identifier, members, moduleByItem, cycleByItem] = await Promise.all([
    fetchAllPaged(conn, "/work-items/") as Promise<PlaneWorkItemRaw[]>,
    fetchAllPaged(conn, "/states/") as Promise<PlaneState[]>,
    fetchAllPaged(conn, "/labels/") as Promise<{ id: string; name: string }[]>,
    fetchIdentifier(conn),
    fetchMembers(conn),
    fetchModuleByItem(conn),
    fetchCycleByItem(conn),
  ]);
  return {
    projectId: conn.projectId,
    projectIdentifier: identifier,
    workspaceSlug: conn.workspaceSlug,
    baseUrl: conn.base,
    items,
    states,
    labels,
    members,
    moduleByItem,
    cycleByItem,
  };
}
