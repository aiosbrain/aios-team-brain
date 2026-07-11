import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { getSessionUser } from "@/lib/auth/session";
import { getContentImage } from "@/lib/social/store";

export const runtime = "nodejs";

/**
 * Serve a generated post image's bytes. Admin-gated (the whole Social surface is): the requester must
 * be an active **admin** of the image's team. Tier-checked via `getContentImage("team")` — admins see
 * team-tier content; no external principal reaches this route. The image is stored base64 in
 * `content_images`; we decode and stream it with its mime type. IDs are unguessable uuids, but auth
 * is still enforced (never rely on the id alone).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const db = adminClient();
  // Resolve the image's team first, then confirm the caller is an admin of that team.
  const { data: meta } = await db.from("content_images").select("team_id").eq("id", id).maybeSingle();
  const teamId = (meta as { team_id: string } | null)?.team_id;
  if (!teamId) return new Response("not found", { status: 404 });

  const { data: me } = await db
    .from("members")
    .select("role")
    .eq("team_id", teamId)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if ((me as { role?: string } | null)?.role !== "admin") return new Response("forbidden", { status: 403 });

  const img = await getContentImage(db, teamId, id, "team");
  if (!img) return new Response("not found", { status: 404 });

  const bytes = Buffer.from(img.data_base64, "base64");
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": img.mime || "image/png",
      "Cache-Control": "private, max-age=86400",
      "Content-Length": String(bytes.length),
    },
  });
}
