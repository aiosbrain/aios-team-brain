import "server-only";

/**
 * Typed REST client for the self-hosted Graphiti graph service (graphiti/docker-compose.yml).
 * The brain calls Graphiti over HTTP only — no Python in this codebase. Endpoints verified
 * against getzep/graphiti `server/graph_service`:
 *   POST   /messages           — add episodes (async, 202)
 *   POST   /search             — hybrid (vector + BM25 + graph) fact search, scoped by group_ids
 *   GET    /episodes/{group}   — list a group's episodes (uuid + name) — the only way to resolve
 *                                 our stable `name` (`items:<id>`) to Graphiti's server-assigned
 *                                 uuid, since /messages is fire-and-forget and returns neither.
 *   DELETE /episode/{uuid}     — remove one episode (audit M6: tier-reclassification cleanup)
 * `fetchImpl`/`baseUrl` are injectable so the client is unit-testable without a live Graphiti.
 */

/**
 * Is `url` a USABLE Graphiti endpoint? A valid http(s) URL with a host. This is stricter than
 * "non-empty" on purpose: prod once carried a malformed `GRAPHITI_URL = "http://"`, which the old
 * `base.length > 0` check treated as configured → every query + scheduler tick fired a doomed HTTP
 * call and swallowed the error. Shared with the Admin retrieval-health card so the runtime and the
 * dashboard agree on whether the graph leg is on. Pure — unit-tested.
 */
export function graphitiConfigured(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.length > 0;
  } catch {
    return false;
  }
}

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
  /** Speaker/author label. Graphiti's Message requires the key present (may be null). */
  role?: string | null;
}

/** An episode as listed by Graphiti — enough to resolve our stable `name` to its server uuid. */
export interface GraphEpisodeRef {
  uuid: string;
  name: string;
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
    return graphitiConfigured(this.base);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.configured) throw new Error("GRAPHITI_URL not set — Graphiti graph memory is not configured.");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(`${this.base}${path}`, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`graphiti ${method} ${path} → ${res.status}`);
      // /messages returns 202 with no useful body; /search + /episodes return JSON; DELETE returns
      // a small ack body.
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(t);
    }
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
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
        // Graphiti's Message schema REQUIRES `role` to be present (nullable). Omitting it → HTTP 422
        // on every push. A Slack thread has many speakers, so we send null. Verified live 2026-06-24.
        role: e.role ?? null,
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

  /**
   * List a group's most recent episodes (uuid + name). Used to (a) resolve our stable episode
   * `name` (`items:<source_id>`) to Graphiti's server-assigned uuid before a delete, and (b)
   * confirm a previously-pushed episode actually landed (the reconcile pass — audit H3/M6, since
   * `/messages` is async and returns neither a uuid nor a name back).
   */
  async listEpisodes(groupId: string, lastN = 1000): Promise<GraphEpisodeRef[]> {
    const out = await this.request<{ episodes?: GraphEpisodeRef[] } | GraphEpisodeRef[]>(
      "GET",
      `/episodes/${encodeURIComponent(groupId)}?last_n=${lastN}`
    );
    return Array.isArray(out) ? out : (out.episodes ?? []);
  }

  /** Delete one episode by its Graphiti uuid (audit M6 — tier-reclassification cleanup). */
  async deleteEpisode(uuid: string): Promise<void> {
    await this.request("DELETE", `/episode/${encodeURIComponent(uuid)}`);
  }
}
