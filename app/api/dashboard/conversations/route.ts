import { NextRequest, NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase/admin";
import { errorResponse } from "@/lib/api/schemas";
import { resolveChatOwner } from "@/lib/chat/session";
import { listConversations } from "@/lib/chat/store";

export const runtime = "nodejs";

/** GET /api/dashboard/conversations?team=<slug> — the signed-in member's own chat threads. */
export async function GET(req: NextRequest) {
  const teamSlug = req.nextUrl.searchParams.get("team") ?? "";
  if (!teamSlug) return errorResponse("invalid_payload", "team required", 422);
  const owner = await resolveChatOwner(teamSlug);
  if (!owner) return errorResponse("forbidden", "not a member of this team", 403);

  const conversations = await listConversations(adminClient(), owner);
  return NextResponse.json({ conversations });
}
