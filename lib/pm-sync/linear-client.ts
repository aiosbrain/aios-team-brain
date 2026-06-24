import "server-only";

import { PmSyncError } from "@/lib/pm-sync/provider";

/**
 * Low-level Linear GraphQL client shared by the OUTBOUND pm-sync projection
 * (`lib/pm-sync/linear.ts`) and the INBOUND ingestion source
 * (`lib/ingest/sources/linear.ts`). Connection-only: POST + auth + error mapping.
 */

export type LinearGraphqlResponse<T> = { data?: T; errors?: { message: string }[] };

export async function linearGraphql<T>(
  fetchImpl: typeof fetch,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const res = await fetchImpl("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json().catch(() => null)) as LinearGraphqlResponse<T> | null;
  if (!res.ok || json?.errors?.length || !json?.data) {
    const message = json?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new PmSyncError(`Linear GraphQL failed: ${message}`);
  }
  return json.data;
}

// ── Idempotency footer marker (shared by outbound projection + inbound import dedupe) ──
// Brain-projected Linear issues carry this footer in their description. The importer uses it to
// recognize round-trippers (issues the brain itself created) and skip re-importing them.
export const EXT_RE = /aios-ext:\s*([A-Za-z0-9._-]+)\s*[·•]\s*source:\s*([A-Za-z0-9._-]+)/;

export const extMarker = (rowKey: string, source: string) => `aios-ext: ${rowKey} · source: ${source}`;

/** The brain row_key carried by a projected issue's footer, or null if not brain-originated. */
export function parseExt(description: string | null | undefined): string | null {
  const m = String(description ?? "").match(EXT_RE);
  return m ? m[1] : null;
}

export function withFooter(body: string, rowKey: string, source: string): string {
  const text = (body ?? "").trim();
  return `${text}\n\n${extMarker(rowKey, source)}`;
}

export function stripFooter(description: string | null | undefined): string {
  return String(description ?? "").replace(EXT_RE, "").trim();
}
