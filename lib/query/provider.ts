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
  /** When we last SYNCED it. Kept for provenance; it is NOT a work-time (every tick bumps it). */
  synced_at: string;
  /** When the WORK happened (R1, `items.work_at`) — this is what the answering prompt shows and what
   *  the recency legs order by. Empty only for a source an external provider supplied. */
  work_at: string;
  text: string;
};

export type RetrievedContext = {
  sources: Source[];
  structured: string; // decisions/tasks/graph digest (always included by the native provider)
  /** True when query-specific search matched something; false = only recency padding. */
  grounded: boolean;
  /** PCCC-6 (spec's expansion budget): how many of the principal's visible projects the K-capped
   * graph stage actually covered — the deliberate own-scope disclosure exception to §5.7. Absent
   * when the graph leg didn't run partitioned (no enforcement view, external omit, no graph). */
  graphScope?: { covered: number; total: number };
};

export interface RetrievalRequest {
  db: DbClient;
  teamId: string;
  tier: "team" | "external";
  question: string;
  projectSlug?: string | null;
  /** Access enforcement (Phase B slice 2 + PCCC-6 + QMIR-1): present = 'enforcing', supplies the
   *  principal's membership-visible item set; item legs filter to it. `graphProjectIds` — present
   *  only for a team-tier MEMBER on an enforcing team — re-enables the graph leg over their
   *  K-capped ready partitions (the PCCC-6 read cutover); absent keeps the §5.8b omit (external
   *  principals, delegated tokens). `principal` discriminates the org-structural mirror legs
   *  (QMIR-1) — "member" regains actors + REPORTS_TO; anything else is token semantics.
   *  Absent/null enforce does NOT mean permissive — PRET-6 retired that model. `retrieve()`'s
   *  public entry throws without it, and this seam (independently callable) yields
   *  `principal: undefined`, which CLOSES the hand-typed structured arm (AUDITFIX-1 §2d).
   *  Never synthesise "member" here: that is the sentence that would reopen the leak. */
  enforce?: { visibleItemIds: ReadonlySet<string>; graphProjectIds?: readonly string[]; principal: "member" | "token" } | null;
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
