import { NextRequest, NextResponse } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { errorResponse } from "@/lib/api/schemas";
import { resolveChatOwner } from "@/lib/chat/session";
import { latestRun, effectiveRunStatus, isRunStale, STALE_RUN_MESSAGE } from "@/lib/query/turn-runs";

export const runtime = "nodejs";

/**
 * GET /api/dashboard/conversations/:id/run?team=<slug>
 *
 * The reattach poll (QBGSTREAM-1): the in-flight state of this thread's most recent answer turn, so a
 * tab that navigated away mid-answer can show progress on return instead of a blank composer.
 *
 * Deliberately LIGHT — status + partial text only, not the whole message thread like the sibling
 * `GET /api/dashboard/conversations/:id`, because this is polled every second or so while a turn runs.
 *
 * Owner-scoped through `resolveChatOwner` + `latestRun`'s `(team_id, member_id)` filter: there is no
 * RLS backstop, so a member can only ever read their own run.
 *
 * A run orphaned by a deploy is reported as `error` (not `streaming`) via `effectiveRunStatus`, so the
 * client renders a failure rather than polling a spinner forever.
 */
/** Reject a non-uuid id before it reaches Postgres: the cast error would be swallowed to `null` by the
 *  reader (which ignores `error`) and answer 200 while logging a `[pg]` error on every poll tick. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const owner = await resolveChatOwner(req.nextUrl.searchParams.get("team") ?? "");
  if (!owner) return errorResponse("forbidden", "not a member of this team", 403);
  if (!UUID_RE.test(id)) return errorResponse("invalid_payload", "conversation id must be a uuid", 422);

  const run = await latestRun(adminClient(), owner, id);
  if (!run) return NextResponse.json({ run: null });

  const status = effectiveRunStatus(run);
  return NextResponse.json({
    run: {
      id: run.id,
      conversation_id: run.conversation_id,
      question: run.question,
      status,
      // A finished answer lives in chat_messages (fetch the thread for it); `partial` is only the
      // in-progress text, so it is omitted once the turn has settled.
      partial: status === "streaming" ? run.partial_text : "",
      // A stale run never recorded an error of its own — say what actually happened.
      error: status === "error" ? run.error_message ?? (isRunStale(run) ? STALE_RUN_MESSAGE : null) : null,
      final_message_id: run.final_message_id,
      updated_at: run.updated_at,
    },
  });
}
