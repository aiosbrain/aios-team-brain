import { NextRequest } from "next/server";
import { adminClient } from "@/lib/supabase/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { audit } from "@/lib/api/audit";
import { getEnabledConnectionsWithSecrets } from "@/lib/connections";

export const runtime = "nodejs";

/**
 * GET /api/v1/connections — the ingestion sidecar pulls its enabled connections (with
 * DECRYPTED secrets) for its team, authenticated by its connector API key. This is the only
 * path that emits plaintext connector secrets; every fetch is audited (`connections.read`).
 * Admins manage the connections in the dashboard (Admin → Integrations).
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const supabase = adminClient();
  if (!(await rateLimit(supabase, `${auth.apiKeyId}:connections:get`, 60))) {
    return errorResponse("rate_limited", "60/min per key", 429);
  }

  try {
    const connections = await getEnabledConnectionsWithSecrets(supabase, auth.teamId);
    await audit(supabase, {
      team_id: auth.teamId,
      actor_kind: "api_key",
      member_id: auth.memberId,
      api_key_id: auth.apiKeyId,
      action: "connections.read",
      meta: { count: connections.length, sources: connections.map((c) => c.source) },
    });
    return Response.json({ connections });
  } catch (e) {
    return errorResponse("internal", e instanceof Error ? e.message : "failed", 500);
  }
}
