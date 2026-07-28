import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import {
  authorizeGraphProxy,
  forwardBody,
  forwardUpstream,
  isRefusal,
  resolveGraphChatTarget,
  resolveGraphProxyTeamId,
} from "@/lib/llm/graph-proxy";

export const runtime = "nodejs";
/** Graphiti's extraction calls are slow (structured output over a long episode). */
export const maxDuration = 120;

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
 * NOT a member-facing route: no session, no API key, no tier. It is machine-to-machine on the
 * platform's private network, gated solely on the shared secret — which is why the secret fails
 * closed when unset rather than defaulting to open.
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
  const team = await resolveGraphProxyTeamId(db);
  if (isRefusal(team)) return refusalResponse(team);

  const target = await resolveGraphChatTarget(db, team.teamId);
  if (isRefusal(target)) return refusalResponse(target);

  const forwarded = forwardBody(body, target.model);
  if (isRefusal(forwarded)) return refusalResponse(forwarded);

  try {
    return await forwardUpstream(target, forwarded);
  } catch (err) {
    const message = err instanceof Error ? err.message : "upstream request failed";
    return Response.json({ error: { message, type: "api_error" } }, { status: 502 });
  }
}

function refusalResponse(r: { status: number; code: string; message: string }): Response {
  return Response.json({ error: { message: r.message, type: "invalid_request_error", code: r.code } }, { status: r.status });
}
