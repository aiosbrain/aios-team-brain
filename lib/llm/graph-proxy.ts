import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import { selectLlmBackend, type LlmBackend } from "@/lib/query/llm-backend";
import { resolveEmbeddingBackend } from "@/lib/query/embedding-key";
import { EMBEDDING_DIM } from "@/lib/api/schemas";

/**
 * The GRAPH LLM PROXY — an OpenAI-compatible façade so the Graphiti service uses the key configured
 * in Admin → Integrations instead of one of its own.
 *
 * WHY THIS EXISTS. Graphiti is getzep's FastAPI service running in its own container. It has no
 * connection to this database, so it cannot read `teams.answering_provider` or the encrypted
 * per-team keys — it reads its own env at startup. That left a SECOND provider key, on a second
 * service, that nothing in this app could see. On 2026-07-28 that key hit `insufficient_quota` and
 * graph extraction died for hours while the admin card showed green, because nobody knew there was
 * a second key to keep funded.
 *
 * So: Graphiti points `OPENAI_BASE_URL` at this app, authenticates with a shared secret, and we
 * resolve the real provider key here. The admin console becomes the one place a key is configured,
 * the provider key never leaves this process, and rotation is one field.
 *
 * `MODEL_NAME` ON THE GRAPHITI SERVICE IS DELIBERATELY IGNORED. Whatever the client asks for is
 * discarded and replaced with the model the console resolves. Honouring it would recreate the exact
 * problem this is here to remove — a second place that decides. If you are wondering why changing
 * `MODEL_NAME` on that service does nothing, this comment is the answer.
 *
 * This module is the ONLY sanctioned raw transport for the graph leg (allowlisted in
 * `test/guards/llm-single-caller.test.ts`) — it holds `chat/completions` here so the route handlers
 * stay thin and every backend decision still flows through `selectLlmBackend`.
 */

/** Minimum shared-secret length. Not a password — a machine credential on a private network. */
const MIN_SECRET_LEN = 32;

export type ProxyRefusal = { status: number; code: string; message: string };
export type ProxyTarget = { url: string; headers: Record<string, string>; model: string };

const refuse = (status: number, code: string, message: string): ProxyRefusal => ({ status, code, message });

/**
 * Constant-time bearer check against `GRAPH_LLM_PROXY_SECRET`.
 *
 * Fails CLOSED when the secret is unset or too short: an unauthenticated endpoint that spends money
 * on a paid API is worse than a broken one, and "we forgot to set it" must not silently become "open
 * to anything that can reach the private network".
 */
export function authorizeGraphProxy(
  authorization: string | null,
  secret = process.env.GRAPH_LLM_PROXY_SECRET
): boolean {
  if (!secret || secret.trim().length < MIN_SECRET_LEN) return false;
  const prefix = "Bearer ";
  if (!authorization || !authorization.startsWith(prefix)) return false;
  const presented = Buffer.from(authorization.slice(prefix.length).trim(), "utf8");
  const expected = Buffer.from(secret.trim(), "utf8");
  // `timingSafeEqual` throws on a length mismatch, which would itself leak length via a 500 —
  // compare lengths first and return the same false either way.
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/**
 * Which team's configured key the graph leg spends.
 *
 * Graphiti's completion calls carry no team context — the `group_id` rides on the episode, not the
 * chat request — so this cannot be per-request. AIOS is self-hosted per organization, so an
 * instance-level answer is right; what would NOT be right is "whichever team the query happened to
 * return first", which is why the ambiguous case refuses instead of guessing.
 */
export async function resolveGraphProxyTeamId(
  db: DbClient,
  slug = process.env.GRAPH_LLM_TEAM
): Promise<{ teamId: string } | ProxyRefusal> {
  const wanted = slug?.trim();
  if (wanted) {
    const { data } = await db.from("teams").select("id").eq("slug", wanted).maybeSingle();
    const id = (data as { id: string } | null)?.id;
    return id
      ? { teamId: id }
      : refuse(500, "graph_proxy_team_unknown", `GRAPH_LLM_TEAM is set to "${wanted}" but no team has that slug.`);
  }
  const { data } = await db.from("teams").select("id, slug").limit(2);
  const rows = (data ?? []) as { id: string; slug: string }[];
  if (rows.length === 1) return { teamId: rows[0].id };
  if (rows.length === 0) return refuse(500, "graph_proxy_no_team", "No team exists to resolve a provider key from.");
  return refuse(
    500,
    "graph_proxy_team_ambiguous",
    "More than one team exists — set GRAPH_LLM_TEAM to the slug whose configured model the graph should use."
  );
}

/**
 * Turn the console's resolved answering backend into an OpenAI-compatible chat target.
 *
 * REFUSES Anthropic. Its wire format is not OpenAI's, and Graphiti extracts via
 * `client.beta.chat.completions.parse` — an OpenAI structured-output call with a JSON schema.
 * Translating between the two shapes (and their different structured-output semantics) is a
 * meaningful piece of engineering that would silently degrade extraction quality if approximated, so
 * this refuses with an actionable message instead of half-doing it. The refusal is visible in the
 * graphiti logs and, via the extraction-health probe, on the admin card.
 */
export function graphChatTarget(backend: LlmBackend): ProxyTarget | ProxyRefusal {
  if (backend.kind === "anthropic") {
    return refuse(
      501,
      "graph_proxy_provider_unsupported",
      "The team's answering model is Anthropic, whose API is not OpenAI-compatible. Graph extraction " +
        "needs OpenRouter, OpenAI, or a local OpenAI-compatible endpoint — pick one in Admin → Integrations."
    );
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (backend.apiKey) headers.Authorization = `Bearer ${backend.apiKey}`;
  if (backend.kind === "openrouter") Object.assign(headers, backend.headers);
  return { url: `${backend.baseUrl.replace(/\/$/, "")}/chat/completions`, headers, model: backend.model };
}

/**
 * Turn the console's resolved embedding backend into an OpenAI-compatible embeddings target.
 *
 * PINNED TO 1536. Graphiti built its Neo4j vector index at the dimension of the embedder it started
 * with, and it has no migration path: swapping to a different width silently makes every stored
 * vector incomparable, and the damage is only visible later as bad search. The brain's own curated
 * embedding models are all 1536, so this agrees with the console today — the check exists for the
 * day someone points the env tier at a 768-dim local model and would otherwise corrupt the graph
 * without a single error.
 */
export function graphEmbeddingTarget(
  backend: Awaited<ReturnType<typeof resolveEmbeddingBackend>>
): ProxyTarget | ProxyRefusal {
  if (!backend) {
    return refuse(
      503,
      "graph_proxy_embeddings_unconfigured",
      "No embeddings backend is configured — set one in Admin → Integrations (Embeddings model)."
    );
  }
  if (backend.dim !== EMBEDDING_DIM) {
    return refuse(
      501,
      "graph_proxy_embedding_dim",
      `The configured embeddings model is ${backend.dim}-dimensional; the graph's vector index is ` +
        `${EMBEDDING_DIM}. Changing it would invalidate every vector already in Neo4j, so the graph ` +
        `leg refuses rather than corrupting it.`
    );
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${backend.apiKey}`,
  };
  return { url: `${backend.baseUrl.replace(/\/$/, "")}/embeddings`, headers, model: backend.model };
}

/**
 * The request body we forward: the client's, with `model` REPLACED (see the header) and streaming
 * refused. Graphiti's extraction call is non-streaming, so supporting SSE here would be untested
 * surface area on a path that never uses it — and a silently-ignored `stream: true` would hang a
 * client waiting for chunks that never come.
 */
export function forwardBody(body: Record<string, unknown>, model: string): Record<string, unknown> | ProxyRefusal {
  if (body.stream === true) {
    return refuse(400, "graph_proxy_no_stream", "This proxy does not support streaming; omit `stream`.");
  }
  return { ...body, model };
}

export const isRefusal = (v: unknown): v is ProxyRefusal =>
  typeof v === "object" && v !== null && "status" in v && "code" in v;

/** Resolve the chat target from the team's console settings. */
export async function resolveGraphChatTarget(db: DbClient, teamId: string): Promise<ProxyTarget | ProxyRefusal> {
  const keys = await resolveAnsweringKeys(db, teamId);
  return graphChatTarget(
    selectLlmBackend({ LLM_BASE_URL: process.env.LLM_BASE_URL, LLM_MODEL: process.env.LLM_MODEL }, keys)
  );
}

/** Resolve the embeddings target from the team's console settings. */
export async function resolveGraphEmbeddingTarget(
  db: DbClient,
  teamId: string
): Promise<ProxyTarget | ProxyRefusal> {
  return graphEmbeddingTarget(await resolveEmbeddingBackend(teamId, db));
}

/**
 * Forward one already-authorized, already-resolved request upstream and hand back the raw response.
 *
 * Deliberately transparent: the upstream status and JSON pass through untouched, so a 429
 * `insufficient_quota` reaches Graphiti's logs looking exactly like it would have from the provider
 * directly. Rewriting provider errors here would hide the one signal an operator needs.
 */
export async function forwardUpstream(
  target: ProxyTarget,
  body: Record<string, unknown>,
  timeoutMs = 120_000
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" },
    });
  } finally {
    clearTimeout(timer);
  }
}
