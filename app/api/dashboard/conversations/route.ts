import { NextRequest, NextResponse } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { errorResponse } from "@/lib/api/schemas";
import { resolveChatOwner } from "@/lib/chat/session";
import { listConversations, searchConversations } from "@/lib/chat/store";

export const runtime = "nodejs";

/**
 * GET /api/dashboard/conversations?team=<slug>[&q=<text>] — the signed-in member's own chat threads.
 * With `q`, returns threads matching by title OR message content (owner-scoped FTS).
 */
export async function GET(req: NextRequest) {
  const teamSlug = req.nextUrl.searchParams.get("team") ?? "";
  if (!teamSlug) return errorResponse("invalid_payload", "team required", 422);
  const owner = await resolveChatOwner(teamSlug);
  if (!owner) return errorResponse("forbidden", "not a member of this team", 403);

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const conversations = q
    ? await searchConversations(adminClient(), owner, q)
    : await listConversations(adminClient(), owner);
  return NextResponse.json({ conversations });
}
