import "server-only";

/**
 * Typed REST client for the self-hosted Graphiti graph service (graphiti/docker-compose.yml).
 * The brain calls Graphiti over HTTP only — no Python in this codebase. Endpoints verified
 * against getzep/graphiti `server/graph_service`:
 *   POST /messages  — add episodes (async, 202)
 *   POST /search    — hybrid (vector + BM25 + graph) fact search, scoped by group_ids
 * `fetchImpl`/`baseUrl` are injectable so the client is unit-testable without a live Graphiti.
 */

export interface GraphEpisode {
  /** The episode text Graphiti extracts entities/relationships from. */
  content: string;
  /** When it actually happened (NOT ingestion time) — ISO 8601. */
  timestamp: string;
  /** Human-readable origin, e.g. "Slack thread in #engineering". */
  sourceDescription: string;
  /** Stable label for the episode (we use the brain source id). */
  name?: string;
  roleType?: "user" | "assistant" | "system";
}

/** A fact (graph edge) returned by /search — citable via source + temporal validity. */
export interface GraphFact {
  uuid?: string;
  fact: string;
  valid_at?: string | null;
  invalid_at?: string | null;
  source_node_name?: string;
  target_node_name?: string;
}

export interface GraphitiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class GraphitiClient {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: GraphitiClientOptions = {}) {
    this.base = (opts.baseUrl ?? process.env.GRAPHITI_URL ?? "").replace(/\/$/, "");
    this.fetch = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  get configured(): boolean {
    return this.base.length > 0;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    if (!this.configured) throw new Error("GRAPHITI_URL not set — Graphiti graph memory is not configured.");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`graphiti ${path} → ${res.status}`);
      // /messages returns 202 with no useful body; /search returns JSON.
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(t);
    }
  }

  /** Add episodes to a group (async on Graphiti's side — returns once accepted). */
  async addEpisodes(groupId: string, episodes: GraphEpisode[]): Promise<void> {
    if (episodes.length === 0) return;
    await this.post("/messages", {
      group_id: groupId,
      messages: episodes.map((e) => ({
        content: e.content,
        timestamp: e.timestamp,
        source_description: e.sourceDescription,
        name: e.name,
        role_type: e.roleType ?? "user",
      })),
    });
  }

  /** Hybrid search over the given group_ids. Returns facts with source + temporal validity. */
  async search(query: string, groupIds: string[], maxFacts = 20): Promise<GraphFact[]> {
    if (groupIds.length === 0) return [];
    const out = await this.post<{ facts?: GraphFact[] }>("/search", {
      query,
      group_ids: groupIds,
      max_facts: maxFacts,
    });
    return out.facts ?? [];
  }
}
