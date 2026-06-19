import { NextRequest } from "next/server";
import { adminClient } from "@/lib/supabase/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { audit } from "@/lib/api/audit";
import { getEnabledIntegrationsWithSecrets } from "@/lib/integrations/manage";

export const runtime = "nodejs";

/**
 * GET /api/v1/integrations — the ingestion sidecar pulls its team's enabled integrations
 * (config + DECRYPTED secret) authenticated by its connector API key. The only path that
 * emits plaintext connector secrets; every fetch is audited (`integrations.read`). Admins
 * manage integrations in the dashboard (Admin → Integrations).
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const supabase = adminClient();
  if (!(await rateLimit(supabase, `${auth.apiKeyId}:integrations:get`, 60))) {
    return errorResponse("rate_limited", "60/min per key", 429);
  }

  try {
    const integrations = await getEnabledIntegrationsWithSecrets(supabase, auth.teamId);
    await audit(supabase, {
      team_id: auth.teamId,
      actor_kind: "api_key",
      member_id: auth.memberId,
      api_key_id: auth.apiKeyId,
      action: "integrations.read",
      meta: { count: integrations.length, types: integrations.map((i) => i.type) },
    });
    // Never echo the connector key; secrets are returned to the authenticated sidecar only.
    return Response.json({ integrations });
  } catch (e) {
    return errorResponse("internal", e instanceof Error ? e.message : "failed", 500);
  }
}
