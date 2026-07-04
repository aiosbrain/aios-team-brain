import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { audit } from "@/lib/api/audit";
import { listEnabledIntegrationSelections } from "@/lib/integrations/manage";

export const runtime = "nodejs";

/**
 * GET /api/v1/integrations — returns the authenticated team's ENABLED integration
 * **selections** (type + name + non-secret config) for an API-key caller. It NEVER returns
 * connector secrets or `secret_ciphertext`: the connector secret never crosses this HTTP
 * boundary, even to a valid key. The in-process ingestion runner reads decrypted secrets
 * directly (`lib/integrations/manage.getEnabledIntegrationsWithSecrets`), not over the API.
 * Admins manage integrations in the dashboard (Admin → Integrations). Every read is audited.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const supabase = adminClient();
  if (!(await rateLimit(supabase, `${auth.apiKeyId}:integrations:get`, 60))) {
    return errorResponse("rate_limited", "60/min per key", 429);
  }

  try {
    const integrations = await listEnabledIntegrationSelections(supabase, auth.teamId);
    await audit(supabase, {
      team_id: auth.teamId,
      actor_kind: "api_key",
      member_id: auth.memberId,
      api_key_id: auth.apiKeyId,
      action: "integrations.read",
      meta: { count: integrations.length, types: integrations.map((i) => i.type) },
    });
    // Non-secret selections only — no token/secret/secret_ciphertext ever leaves here.
    return Response.json({ integrations });
  } catch (e) {
    return errorResponse("internal", e instanceof Error ? e.message : "failed", 500);
  }
}
