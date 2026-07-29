import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import { rateLimit } from "@/lib/api/rate-limit";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import { selectLlmBackend, type LlmBackend } from "@/lib/query/llm-backend";
import { resolveEmbeddingBackend } from "@/lib/query/embedding-key";
import { EMBEDDING_DIM } from "@/lib/api/schemas";
import { recordLlmUsage, type LlmUsageSource } from "@/lib/costs/llm-usage";
import { meterFromOpenAiResponse } from "@/lib/llm/cost";

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
 * EXPOSURE — do not soften this. Graphiti reaches these routes over the platform's private network,
 * but they are NOT private: `proxy.ts` excludes all of `/api/*` from middleware ("routes do their own
 * auth"), and the app has a public domain, so this path is reachable from the internet. The shared
 * secret is the ONLY thing between an anonymous caller and the team's LLM budget. Hence: fails closed,
 * constant-time compare, a length floor, and a rate limit on the authorized path so a leaked secret
 * is bounded rather than unlimited. Brute force is not the threat at 32+ random chars; leakage is.
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

/** `__refusal` is a real discriminant, not decoration: `forwardBody` returns a SPREAD of the
 *  caller's body, so a structural check on `status`+`code` would classify an authenticated caller
 *  who happens to send those top-level fields as a refusal — and then `Response.json(…, { status })`
 *  with their value throws a 500. */
export type ProxyRefusal = { __refusal: true; status: number; code: string; message: string };
/** `provider` (openrouter/openai/local/env) rides along ONLY so the meter can tag the ledger row — it
 *  never affects transport, which is fully determined by `url`/`headers`/`model`. */
export type ProxyTarget = { url: string; headers: Record<string, string>; model: string; provider: string };

const refuse = (status: number, code: string, message: string): ProxyRefusal => ({ __refusal: true, status, code, message });

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
  return { url: `${backend.baseUrl.replace(/\/$/, "")}/chat/completions`, headers, model: backend.model, provider: backend.provider };
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
  return { url: `${backend.baseUrl.replace(/\/$/, "")}/embeddings`, headers, model: backend.model, provider: backend.provider };
}

/**
 * The request body we forward: the client's, with `model` REPLACED (see the header) and streaming
 * refused. Graphiti's extraction call is non-streaming, so supporting SSE here would be untested
 * surface area on a path that never uses it — and a silently-ignored `stream: true` would hang a
 * client waiting for chunks that never come.
 */
export function forwardBody(
  body: Record<string, unknown>,
  model: string,
  provider?: string
): Record<string, unknown> | ProxyRefusal {
  if (body.stream === true) {
    return refuse(400, "graph_proxy_no_stream", "This proxy does not support streaming; omit `stream`.");
  }
  const forwarded: Record<string, unknown> = { ...body, model };
  // Ask OpenRouter to include the real `usage.cost` on the response, so the `source=graph`/`embeddings`
  // meter records the actual charge rather than falling back to tokens-only. This mirrors every other
  // sanctioned transport (`lib/llm/complete`, `lib/chat/title`, `lib/query/claude`): today's model
  // returns cost regardless, but a different OpenRouter model can omit it unless asked, so we don't
  // leave graph metering — the largest consumer — depending on that quirk. Harmless elsewhere.
  if (provider === "openrouter") forwarded.usage = { include: true };
  return forwarded;
}

export const isRefusal = (v: unknown): v is ProxyRefusal =>
  typeof v === "object" && v !== null && (v as { __refusal?: unknown }).__refusal === true;

/**
 * Ceiling on authorized proxy calls per minute.
 *
 * Not for Graphiti's benefit — its extraction is serial at ~10-20s per episode, so it will never come
 * close. This bounds the damage if the shared secret ever leaks: without it, one credential turns into
 * unmetered spend on the team's provider account. Sized well above any legitimate burst (a queue
 * drain plus the embedding calls that accompany it) so it can never be the thing that wedges the
 * graph — the failure this whole module exists to stop.
 */
const PROXY_CALLS_PER_MINUTE = 120;

/** Shared bucket for both halves of the proxy: one credential, one budget. */
export async function graphProxyWithinRateLimit(db: DbClient): Promise<boolean> {
  return rateLimit(db, "graph-llm-proxy", PROXY_CALLS_PER_MINUTE);
}

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
 * The context the proxy needs to meter one forwarded call into `llm_usage`. `kind` selects the cost
 * shape (chat has `completion_tokens`; an embedding has only `total_tokens`), `source` is the ledger
 * slice — `graph` for extraction, `embeddings` for the graph's embedding half. All graph spend is
 * system-initiated, so `member_id` is always null.
 */
export interface GraphMeterCtx {
  db: DbClient;
  teamId: string;
  source: Extract<LlmUsageSource, "graph" | "embeddings">;
  kind: "chat" | "embedding";
}

/**
 * Meter one already-received upstream body. BEST-EFFORT and total: the graph leg is the thing this
 * whole module exists to keep alive, so a metering failure must never affect the response — every
 * error is swallowed. A non-JSON or usage-less body (a provider error, a stream, an odd shape) simply
 * records nothing. Before this, ALL Graphiti extraction + embedding spend was invisible to the ledger,
 * which is why the costs page read near-zero while the biggest LLM consumer ran unmetered.
 */
async function meterGraphCall(text: string, status: number, target: ProxyTarget, meter: GraphMeterCtx): Promise<void> {
  try {
    if (status < 200 || status >= 300) return; // only a successful call spent tokens
    const c = meterFromOpenAiResponse(text, target.provider, target.model, meter.kind);
    if (!c) return;
    await recordLlmUsage(meter.db, {
      teamId: meter.teamId,
      memberId: null,
      source: meter.source,
      provider: target.provider,
      model: target.model,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      costUsd: c.costUsd,
      estimated: c.estimated,
    });
  } catch {
    // Never let metering touch the proxy path.
  }
}

/**
 * Forward one already-authorized, already-resolved request upstream and hand back the raw response.
 *
 * Deliberately transparent: the upstream status and JSON pass through untouched, so a 429
 * `insufficient_quota` reaches Graphiti's logs looking exactly like it would have from the provider
 * directly. Rewriting provider errors here would hide the one signal an operator needs.
 *
 * When `opts.meter` is set, a successful call's `usage` is recorded to `llm_usage` (best-effort, after
 * the body is read) — the one capture point both proxy halves share.
 */
export async function forwardUpstream(
  target: ProxyTarget,
  body: Record<string, unknown>,
  opts: { timeoutMs?: number; meter?: GraphMeterCtx } = {}
): Promise<Response> {
  const { timeoutMs = 120_000, meter } = opts;
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
    if (meter) await meterGraphCall(text, res.status, target, meter);
    const headers: Record<string, string> = {
      "Content-Type": res.headers.get("content-type") ?? "application/json",
    };
    // Pass the provider's OWN backoff through. Without it a 429 reaches Graphiti's SDK stripped of
    // `retry-after`, so it falls back to blind exponential retry against a provider that just told us
    // exactly how long to wait — needless load on the way out of the failure this module exists for.
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) headers["Retry-After"] = retryAfter;
    return new Response(text, { status: res.status, headers });
  } finally {
    clearTimeout(timer);
  }
}
