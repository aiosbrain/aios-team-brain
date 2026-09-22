import { NextRequest } from "next/server";
import { z } from "zod";

import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { adminClient } from "@/lib/db/admin";
import { brokerGoogleAccessToken, GdriveAuthorityError } from "@/lib/integrations/gdrive-authority";

export const runtime = "nodejs";

const schema = z.object({
  integration_id: z.string().uuid(), owner: z.string().uuid(),
  generation: z.number().int().positive(), fence: z.number().int().positive(),
}).strict();

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store, private");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}

export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return noStore(errorResponse("unauthorized", "invalid API key or team", 401));
  if (!(await rateLimit(adminClient(), `${auth.apiKeyId}:gdrive:token`, 20))) {
    return noStore(errorResponse("rate_limited", "20 access-token grants/min per connector", 429));
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return noStore(errorResponse("invalid_payload", parsed.error.issues[0]?.message ?? "invalid", 422));
  try {
    const grant = await brokerGoogleAccessToken(auth, {
      integrationId: parsed.data.integration_id, owner: parsed.data.owner,
      generation: parsed.data.generation, fence: parsed.data.fence,
    });
    return Response.json({
      access_token: grant.accessToken, expires_at: grant.expiresAt,
      scopes: grant.scopes, account: grant.account,
    }, { headers: { "Cache-Control": "no-store, private", Pragma: "no-cache", Expires: "0" } });
  } catch (error) {
    if (error instanceof GdriveAuthorityError) return noStore(errorResponse(error.code, error.message, error.status));
    return noStore(errorResponse("internal", "Google access-token broker unavailable", 500));
  }
}
