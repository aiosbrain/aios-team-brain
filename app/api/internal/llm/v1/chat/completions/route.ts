import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import {
  authorizeGraphProxy,
  forwardBody,
  forwardUpstream,
  isRefusal,
  resolveGraphChatTarget,
  resolveGraphProxyTeamId,
  graphProxyWithinRateLimit,
} from "@/lib/llm/graph-proxy";
import { classifyGraphCall } from "@/lib/llm/graph-call-kind";

export const runtime = "nodejs";
/** Graphiti's extraction calls are slow (structured output over a long episode, plus resolution
 *  context). 120 was too low and silently failed every job in prod — see `PROXY_TIMEOUT_MS`. */
export const maxDuration = 300;

/**
 * The OpenAI-compatible chat endpoint for the Graphiti service ONLY (its path is this file's
 * directory). Holds NO transport of its own — that lives in `lib/llm/graph-proxy`, the one module
 * allowlisted by `test/guards/llm-single-caller.test.ts`, so every backend decision still resolves
 * through `selectLlmBackend`. This handler only authorizes, resolves, and delegates.
 *
 * Graphiti sets `OPENAI_BASE_URL` to `<brain>/api/internal/llm/v1` and authenticates with the shared
 * secret in `GRAPH_LLM_PROXY_SECRET`; we resolve the real provider key from Admin → Integrations. See
 * `lib/llm/graph-proxy.ts` for why this exists and why `MODEL_NAME` on that service is ignored.
 *
 * NOT a member-facing route: no session, no API key, no tier. `proxy.ts` excludes all of `/api/*`
 * from middleware, and this app has a public domain — so this path IS reachable from the internet and
 * the shared secret is the only gate. That is why it fails closed when unset and why the authorized
 * path is rate limited.
 */
export async function POST(req: NextRequest) {
  if (!authorizeGraphProxy(req.headers.get("authorization"))) {
    // Deliberately terse and OpenAI-shaped: the caller is a library, not a person.
    return Response.json({ error: { message: "unauthorized", type: "invalid_request_error" } }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: { message: "invalid JSON body", type: "invalid_request_error" } }, { status: 400 });
  }

  const db = adminClient();
  // AFTER auth, so an anonymous flood can't consume the authorized budget — and bounded because this
  // path is publicly routable (see `lib/llm/graph-proxy`), so a leaked secret must not mean unmetered
  // spend on the team's provider account.
  if (!(await graphProxyWithinRateLimit(db))) {
    return Response.json({ error: { message: "rate limited", type: "rate_limit_error" } }, { status: 429 });
  }

  const team = await resolveGraphProxyTeamId(db);
  if (isRefusal(team)) return refusalResponse(team);

  const target = await resolveGraphChatTarget(db, team.teamId);
  if (isRefusal(target)) return refusalResponse(target);

  const forwarded = forwardBody(body, target.model, target.provider);
  if (isRefusal(forwarded)) return refusalResponse(forwarded);

  try {
    // Meter this extraction call into `llm_usage` (source `graph`) — the biggest LLM consumer, and
    // until now entirely unmetered. Best-effort inside `forwardUpstream`; never affects the response.
    return await forwardUpstream(target, forwarded, {
      // Classified HERE because this is the last place the REQUEST body is in scope — the meter
      // downstream only ever sees the response. Total by construction: `classifyGraphCall` cannot
      // throw and degrades to `unknown`, so labelling can never fail an extraction call.
      meter: { db, teamId: team.teamId, source: "graph", kind: "chat", callKind: classifyGraphCall(body) },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "upstream request failed";
    return Response.json({ error: { message, type: "api_error" } }, { status: 502 });
  }
}

function refusalResponse(r: { status: number; code: string; message: string }): Response {
  return Response.json({ error: { message: r.message, type: "invalid_request_error", code: r.code } }, { status: r.status });
}
