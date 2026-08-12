import { NextRequest } from "next/server";
import { z } from "zod";
import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { getSessionUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/schemas";
import { canAccessAdmin } from "@/lib/auth/admin-access";
import { explainItemVisibility, auditVisibilityAgainstItemIds } from "@/lib/access/inspect";

export const runtime = "nodejs";

/**
 * The permission inspector (spec §15.6) — "why can ⟨member⟩ see ⟨item⟩?" + the runtime cache-leak
 * check (§5.8). ADMIN-ONLY: it renders another principal's visibility chain (who is in which group,
 * who granted what) — internal access-topology detail no ordinary/external member may read. Gated by
 * `canAccessAdmin` (admin role AND unrestricted tier, fail closed — the same gate as the /admin
 * subtree; no RLS backstop, CLAUDE.md §5).
 *
 *   GET  ?team=<slug>&item=<itemId>&member=<memberId>   → explainItemVisibility
 *   POST { team, member, itemIds: [] }                  → auditVisibilityAgainstItemIds (leak subset)
 *
 * The `member`/`itemIds` inputs are validated to belong to the caller's team before use (a
 * cross-team id must resolve to nothing, never another org's topology). Read-only; writes nothing.
 */

async function resolveAdminTeam(req: NextRequest, teamSlug: string | null) {
  const rls = await serverClient();
  const user = await getSessionUser();
  if (!user) return { error: errorResponse("unauthorized", "sign in required", 401) };
  if (!teamSlug) return { error: errorResponse("invalid_payload", "team is required", 422) };
  const { data: team } = await rls.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return { error: errorResponse("forbidden", "not a member of this team", 403) };
  const { data: me } = await rls
    .from("members")
    .select("role, tier")
    .eq("team_id", team.id)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!me) return { error: errorResponse("forbidden", "not a member of this team", 403) };
  if (!canAccessAdmin(me as { role?: string | null; tier?: string | null })) {
    return { error: errorResponse("forbidden", "admin only", 403) };
  }
  return { teamId: (team as { id: string }).id };
}

/** A target member must belong to the admin's team — never resolve a cross-team/other-org member. */
async function memberInTeam(teamId: string, memberId: string): Promise<boolean> {
  const { data } = await adminClient().from("members").select("id").eq("team_id", teamId).eq("id", memberId).maybeSingle();
  return !!data;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const gate = await resolveAdminTeam(req, url.searchParams.get("team"));
  if ("error" in gate) return gate.error;
  const { teamId } = gate;

  const itemId = url.searchParams.get("item");
  const memberId = url.searchParams.get("member");
  if (!itemId || !memberId) return errorResponse("invalid_payload", "item and member are required", 422);
  if (!(await memberInTeam(teamId, memberId))) return errorResponse("invalid_payload", "unknown member", 422);

  const result = await explainItemVisibility(adminClient(), { teamId, memberId, itemId });
  return Response.json(result);
}

const auditSchema = z.object({
  team: z.string().min(1).max(120),
  member: z.string().uuid(),
  itemIds: z.array(z.string().uuid()).max(1000),
});

export async function POST(req: NextRequest) {
  const parsed = auditSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse("invalid_payload", "team, member, itemIds required", 422);
  const { team: teamSlug, member: memberId, itemIds } = parsed.data;

  const gate = await resolveAdminTeam(req, teamSlug);
  if ("error" in gate) return gate.error;
  const { teamId } = gate;
  if (!(await memberInTeam(teamId, memberId))) return errorResponse("invalid_payload", "unknown member", 422);

  const leaks = await auditVisibilityAgainstItemIds(adminClient(), { teamId, memberId }, itemIds);
  return Response.json({ leaks });
}
