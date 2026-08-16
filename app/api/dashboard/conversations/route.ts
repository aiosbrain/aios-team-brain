import { NextRequest, NextResponse } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { errorResponse } from "@/lib/api/schemas";
import { resolveChatOwner } from "@/lib/chat/session";
import { listConversations, searchConversations } from "@/lib/chat/store";
import { activeRun } from "@/lib/query/turn-runs";

export const runtime = "nodejs";

/**
 * GET /api/dashboard/conversations?team=<slug>[&q=<text>][&active_run=1] — the signed-in member's own
 * chat threads. With `q`, returns threads matching by title OR message content (owner-scoped FTS).
 *
 * `active_run=1` additionally reports the member's currently-streaming turn, if any (QBGSTREAM-1).
 * This is the SERVER-SIDE reattach trigger: `/query` mounts with no memory of what was running (its
 * state is client-only and it otherwise opens a fresh "new chat"), so it asks. Server-side rather than
 * localStorage so it also works on another device, and for a user who navigated away before the
 * conversation id ever reached client state. A run orphaned by a deploy is NOT reported active —
 * `activeRun` applies the staleness rule — so this can't auto-open a thread onto a dead spinner.
 */
export async function GET(req: NextRequest) {
  const teamSlug = req.nextUrl.searchParams.get("team") ?? "";
  if (!teamSlug) return errorResponse("invalid_payload", "team required", 422);
  const owner = await resolveChatOwner(teamSlug);
  if (!owner) return errorResponse("forbidden", "not a member of this team", 403);

  const db = adminClient();
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const conversations = q
    ? await searchConversations(db, owner, q)
    : await listConversations(db, owner);
  if (req.nextUrl.searchParams.get("active_run") !== "1") {
    return NextResponse.json({ conversations });
  }
  const run = await activeRun(db, owner);
  return NextResponse.json({
    conversations,
    active_run: run ? { id: run.id, conversation_id: run.conversation_id, question: run.question } : null,
  });
}
