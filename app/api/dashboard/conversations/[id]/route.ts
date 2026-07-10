import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { adminClient } from "@/lib/db/admin";
import { errorResponse } from "@/lib/api/schemas";
import { resolveChatOwner } from "@/lib/chat/session";
import { getConversation, renameConversation, archiveConversation } from "@/lib/chat/store";

export const runtime = "nodejs";

const teamParam = (req: NextRequest) => req.nextUrl.searchParams.get("team") ?? "";

/** GET /api/dashboard/conversations/:id?team=<slug> — a thread's full messages (owner-only). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const owner = await resolveChatOwner(teamParam(req));
  if (!owner) return errorResponse("forbidden", "not a member of this team", 403);
  const convo = await getConversation(adminClient(), owner, id);
  if (!convo) return errorResponse("not_found", "conversation not found", 404);
  return NextResponse.json(convo);
}

const patchSchema = z.object({ team: z.string().min(1), title: z.string().min(1).max(200) });

/** PATCH /api/dashboard/conversations/:id — rename (owner-only). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return errorResponse("invalid_payload", "team and title required", 422);
  const owner = await resolveChatOwner(parsed.data.team);
  if (!owner) return errorResponse("forbidden", "not a member of this team", 403);
  const ok = await renameConversation(adminClient(), owner, id, parsed.data.title);
  if (!ok) return errorResponse("not_found", "conversation not found", 404);
  return NextResponse.json({ ok: true });
}

/** DELETE /api/dashboard/conversations/:id?team=<slug> — soft-archive (owner-only). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const owner = await resolveChatOwner(teamParam(req));
  if (!owner) return errorResponse("forbidden", "not a member of this team", 403);
  const ok = await archiveConversation(adminClient(), owner, id);
  if (!ok) return errorResponse("not_found", "conversation not found", 404);
  return NextResponse.json({ ok: true });
}
