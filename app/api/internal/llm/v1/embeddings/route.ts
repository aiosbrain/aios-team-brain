import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import {
  authorizeGraphProxy,
  forwardBody,
  forwardUpstream,
  isRefusal,
  resolveGraphEmbeddingTarget,
  resolveGraphProxyTeamId,
} from "@/lib/llm/graph-proxy";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The OpenAI-compatible embeddings endpoint for the Graphiti service ONLY — the other half of the
 * base URL. Graphiti embeds as well as extracts, so proxying only the chat half would still leave a
 * second provider key on that service, which is the whole thing this removes. Transport lives in
 * `lib/llm/graph-proxy`; this handler only authorizes, resolves, and delegates.
 *
 * The target is pinned to the graph's vector width; see `graphEmbeddingTarget`.
 */
export async function POST(req: NextRequest) {
  if (!authorizeGraphProxy(req.headers.get("authorization"))) {
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

  const target = await resolveGraphEmbeddingTarget(db, team.teamId);
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
