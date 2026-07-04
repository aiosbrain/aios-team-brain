import { NextRequest, NextResponse } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { errorResponse } from "@/lib/api/schemas";
import { listConversations } from "@/lib/chat/store";

export const runtime = "nodejs";

/**
 * GET /api/v1/conversations — the API key's member's own chat threads (owner-scoped). The machine
 * twin of the session-authed dashboard list, so the CLI / Telegram-via-Hermes can list + resume the
 * same conversations they created via POST /api/v1/query.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);
  const conversations = await listConversations(adminClient(), {
    teamId: auth.teamId,
    memberId: auth.memberId,
  });
  return NextResponse.json({ conversations });
}
