import { NextRequest, NextResponse } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { errorResponse } from "@/lib/api/schemas";
import { getConversation } from "@/lib/chat/store";

export const runtime = "nodejs";

/**
 * GET /api/v1/conversations/:id — a thread's full message history (owner-only). Lets a CLI / Hermes
 * client resume by re-hydrating a conversation it owns. 404 if not owned or absent.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);
  const { id } = await params;
  const convo = await getConversation(adminClient(), { teamId: auth.teamId, memberId: auth.memberId }, id);
  if (!convo) return errorResponse("not_found", "conversation not found", 404);
  return NextResponse.json(convo);
}
