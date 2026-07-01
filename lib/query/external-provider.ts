import "server-only";
import type { RetrievalProvider, RetrievalRequest, RetrievedContext, Source } from "./provider";

/**
 * Context provider backed ENTIRELY by an external retrieval service (e.g. a gbrain adapter) —
 * selected with `CONTEXT_PROVIDER=external`. It speaks the same vendor-neutral contract the native
 * provider uses for optional augmentation, so one adapter serves both roles:
 *
 *   POST { query, limit, tier } -> { sources: [{ path, text, score?, project?, kind? }], structured? }
 *
 * ⚠️ Tier (CLAUDE.md §5): the remote service is responsible for scoping results to `tier` — there
 * is no DB backstop here. Only point this at a service that enforces the caller's access tier.
 * Best-effort: on timeout/error/misconfig it returns an empty context (the query still answers,
 * just ungrounded) rather than throwing.
 */

const URL = process.env.RETRIEVAL_AUGMENT_URL;
const TOKEN = process.env.RETRIEVAL_AUGMENT_TOKEN;
const TIMEOUT_MS = Number(process.env.RETRIEVAL_AUGMENT_TIMEOUT_MS ?? 5000);
const LIMIT = Number(process.env.RETRIEVAL_AUGMENT_LIMIT ?? 12);

type Hit = { path?: string; text?: string; score?: number; project?: string; kind?: string };

const EMPTY: RetrievedContext = { sources: [], structured: "", grounded: false };

export const externalProvider: RetrievalProvider = {
  name: "external",
  async retrieve(req: RetrievalRequest): Promise<RetrievedContext> {
    if (!URL) return EMPTY;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        },
        body: JSON.stringify({ query: req.question, limit: LIMIT, tier: req.tier }),
        signal: ctrl.signal,
      });
      if (!res.ok) return EMPTY;
      const data = (await res.json()) as { sources?: Hit[]; structured?: string };
      const hits = Array.isArray(data.sources) ? data.sources : [];
      const sources: Source[] = hits
        .filter((h) => h.text)
        .map((h, i) => ({
          sid: `S${i + 1}`,
          item_id: null,
          project: h.project ?? "",
          path: h.path ?? `ext:${i + 1}`,
          kind: h.kind ?? "brain",
          synced_at: "",
          text: h.text as string,
        }));
      return { sources, structured: data.structured ?? "", grounded: sources.length > 0 };
    } catch {
      return EMPTY; // timeout / network / bad JSON → degrade, never throw
    } finally {
      clearTimeout(timer);
    }
  },
};
