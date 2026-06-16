import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/api/auth";
import { errorResponse } from "@/lib/api/schemas";

export const runtime = "nodejs";

// GET /api/v1/me — the authenticated member's identity + role + tier (no secrets).
// Lets a client (e.g. the cockpit) tailor the UI — e.g. only leads/admins see the
// team-blueprint publish surface.
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);
  return Response.json({
    actor: auth.actorHandle,
    role: auth.memberRole,
    tier: auth.memberTier,
    team: auth.teamId,
  });
}
