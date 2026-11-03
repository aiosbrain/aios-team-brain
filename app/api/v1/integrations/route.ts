import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { audit } from "@/lib/api/audit";
import { listEnabledIntegrationSelections, listIntegrationSelections } from "@/lib/integrations/manage";
import { gdriveConnectionsBoundTo, projectSelectionsFor } from "@/lib/integrations/gdrive-selection-projection";

export const runtime = "nodejs";

/**
 * GET /api/v1/integrations — returns the authenticated team's ENABLED integration
 * **selections** (type + name + non-secret config) for an API-key caller. It NEVER returns
 * connector secrets or `secret_ciphertext`: the connector secret never crosses this HTTP
 * boundary, even to a valid key. The in-process ingestion runner reads decrypted secrets
 * directly (`lib/integrations/manage.getEnabledIntegrationsWithSecrets`), not over the API.
 * Admins manage integrations in the dashboard (Admin → Integrations). Every read is audited.
 *
 * A Drive row's account and selection metadata (account email/subject, scopes, selected ids,
 * audience projects, service-account identity) is returned ONLY to that connection's live bound
 * connector principal; every other key discovers the row with its Drive config reduced to
 * `authMode` (AIO-1167 R42 F5, `lib/integrations/gdrive-selection-projection`).
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:integrations:get`, 60))) {
    return errorResponse("rate_limited", "60/min per key", 429);
  }

  try {
    const includeDisabled = req.nextUrl.searchParams.get("include_disabled") === "1";
    const selections = includeDisabled
      ? await listIntegrationSelections(db, auth.teamId)
      : await listEnabledIntegrationSelections(db, auth.teamId);
    const bound = await gdriveConnectionsBoundTo(auth);
    const integrations = projectSelectionsFor(selections, bound);
    await audit(db, {
      team_id: auth.teamId,
      actor_kind: "api_key",
      member_id: auth.memberId,
      api_key_id: auth.apiKeyId,
      action: "integrations.read",
      meta: {
        count: integrations.length, types: integrations.map((i) => i.type), includeDisabled,
        driveConfigDisclosed: integrations.filter((i) => i.type === "gdrive" && bound.has(i.id)).map((i) => i.id),
      },
    });
    // Non-secret selections only — no token/secret/secret_ciphertext ever leaves here.
    return Response.json({ integrations });
  } catch (e) {
    return errorResponse("internal", e instanceof Error ? e.message : "failed", 500);
  }
}
