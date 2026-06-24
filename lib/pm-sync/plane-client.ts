import "server-only";

import { PmSyncError } from "@/lib/pm-sync/provider";

/**
 * Low-level Plane REST client shared by the OUTBOUND pm-sync projection
 * (`lib/pm-sync/plane.ts`) and the INBOUND ingestion source
 * (`lib/ingest/sources/plane.ts`). Connection-only: auth header, project-scoped
 * path builder, cursor pagination, and 429 retry. No sync/ingest semantics live
 * here — callers layer those on top of `PlaneConnection`.
 */

export interface PlaneConnection {
  fetchImpl: typeof fetch;
  base: string;
  apiKey: string;
  workspaceSlug: string;
  projectId: string;
}

export async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

/** Plane list endpoints return either a bare array or a `{ results: [] }` envelope. */
export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as { results?: unknown[] }).results)) {
    return (value as { results: unknown[] }).results;
  }
  return [];
}

export async function planeApi(
  conn: PlaneConnection,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const url = `${conn.base}${path}`;
  for (let attempt = 0; ; attempt++) {
    const res = await conn.fetchImpl(url, {
      method,
      headers: { "X-API-Key": conn.apiKey, "Content-Type": "application/json" },
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

export function projPath(conn: PlaneConnection, suffix: string): string {
  return `/api/v1/workspaces/${conn.workspaceSlug}/projects/${conn.projectId}${suffix}`;
}

/** Walk a project-scoped list endpoint to completion (cursor pagination), capped at 100 pages. */
export async function fetchAllPaged(conn: PlaneConnection, suffix: string): Promise<unknown[]> {
  const out: unknown[] = [];
  let cursor = "100:0:0";
  for (let i = 0; i < 100; i++) {
    const sep = suffix.includes("?") ? "&" : "?";
    const page = await planeApi(conn, "GET", `${projPath(conn, suffix)}${sep}per_page=100&cursor=${encodeURIComponent(cursor)}`);
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
