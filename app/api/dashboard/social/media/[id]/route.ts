import { NextResponse } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { currentMember } from "@/lib/auth/guard";

export const runtime = "nodejs";

/**
 * GET /api/dashboard/social/media/:id — serve a generated image's bytes. Session-authed and
 * admin-only (the Social surface is admin-gated); the image is served out-of-band so the admin
 * page never inlines multi-MB base64. Team is resolved from the asset, then the caller must be an
 * admin of that team.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const { data: asset } = await adminClient()
    .from("media_assets")
    .select("team_id, data_base64")
    .eq("id", id)
    .maybeSingle();
  if (!asset) return new NextResponse("not found", { status: 404 });

  const member = await currentMember((asset as { team_id: string }).team_id);
  if (!member || member.role !== "admin") return new NextResponse("forbidden", { status: 403 });

  const bytes = Buffer.from((asset as { data_base64: string }).data_base64, "base64");
  return new NextResponse(bytes, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" },
  });
}
