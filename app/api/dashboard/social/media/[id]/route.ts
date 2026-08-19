import { NextResponse } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { currentMember } from "@/lib/auth/guard";

export const runtime = "nodejs";

/**
 * GET /api/dashboard/social/media/:id — serve a generated image's bytes out-of-band (the admin
 * page never inlines multi-MB base64).
 *
 * ENFB-4 D3 (design round 1 HIGH 5): image bytes are DERIVED CONTENT (generated from the
 * opportunity's title), so this route takes the full stack the rest of the social surface
 * carries — `canAccessAdmin` (this was the ONE social surface checking bare role: an
 * external-posture admin was blocked from the page but could fetch bytes), the asset's chain
 * inherited to the opportunity's EVERY-visible evidence, and unknown ≡ denied (uniform 404 —
 * the old 404/403 split was an existence oracle).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const notFound = () => new NextResponse("not found", { status: 404 });

  const { data: asset } = await adminClient()
    .from("media_assets")
    .select("team_id, variant_id, data_base64")
    .eq("id", id)
    .maybeSingle();
  if (!asset) return notFound();
  const teamId = (asset as { team_id: string }).team_id;

  const member = await currentMember(teamId);
  const { canAccessAdmin } = await import("@/lib/auth/admin-access");
  if (!member || !canAccessAdmin(member)) return notFound();

  const { visibleItemIds } = await import("@/lib/access/enforce");
  const { actorSeesChain } = await import("@/lib/social/store");
  const vis = await visibleItemIds(adminClient(), { teamId, memberId: member.id });
  if (vis.error) return notFound(); // fail closed on substrate error
  if (!(await actorSeesChain(adminClient(), teamId, { variantId: (asset as { variant_id: string }).variant_id }, vis.ids))) {
    return notFound();
  }

  const bytes = Buffer.from((asset as { data_base64: string }).data_base64, "base64");
  return new NextResponse(bytes, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" },
  });
}
