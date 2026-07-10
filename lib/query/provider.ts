import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * The pluggable context/retrieval layer.
 *
 * AIOS Team Brain retrieves context through a `RetrievalProvider`. The default is the `native`
 * provider (Postgres FTS + structured digests + Graphiti temporal facts, in `lib/query/retrieve`).
 * Because this is an open project, the whole layer is swappable: implement `RetrievalProvider`
 * against gbrain, a cloud RAG service, or anything else, and select it with `CONTEXT_PROVIDER`.
 *
 * ⚠️ Tier contract (CLAUDE.md §5): a provider MUST honor `req.tier` — an `external` caller must
 * never receive `team`/`admin` content. On the postgres target there is NO RLS backstop, so the
 * provider is the sole enforcement. The `native` provider filters in-DB; an `external` provider
 * delegates tier scoping to the remote service, so only point it at a service that enforces it.
 */

/** One retrieved passage, cited in the answer as [S1], [S2], … */
export type Source = {
  sid: string; // S1, S2…
  item_id: string | null;
  project: string;
  path: string;
  kind: string;
  synced_at: string;
  text: string;
};

export type RetrievedContext = {
  sources: Source[];
  structured: string; // decisions/tasks/graph digest (always included by the native provider)
  /** True when query-specific search matched something; false = only recency padding. */
  grounded: boolean;
};

export interface RetrievalRequest {
  db: DbClient;
  teamId: string;
  tier: "team" | "external";
  question: string;
  projectSlug?: string | null;
}

/** A context layer. Swap the default by implementing this and selecting via CONTEXT_PROVIDER. */
export interface RetrievalProvider {
  readonly name: string;
  retrieve(req: RetrievalRequest): Promise<RetrievedContext>;
}

export type ProviderName = "native" | "external";

/**
 * Which provider to use, from `CONTEXT_PROVIDER` (default `native`). Kept as a pure env read (no
 * provider imports) so it stays cycle-free and unit-testable; the concrete wiring lives in
 * `lib/query/retrieve` (the public `retrieve()` entry) to avoid an import cycle.
 */
export function selectedProviderName(): ProviderName {
  return (process.env.CONTEXT_PROVIDER ?? "native").trim().toLowerCase() === "external"
    ? "external"
    : "native";
}
