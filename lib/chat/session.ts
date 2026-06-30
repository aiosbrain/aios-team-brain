import "server-only";
import { serverClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";

/**
 * Resolve the signed-in user → their `(teamId, memberId)` for the team, under RLS — returns null
 * unless they are an active member. The chat store filters every read/write by this owner pair, so
 * a member only ever touches their own conversations. Shared by all dashboard conversation routes.
 */
export async function resolveChatOwner(
  teamSlug: string
): Promise<{ teamId: string; memberId: string } | null> {
  const rls = await serverClient();
  const user = await getSessionUser();
  if (!user) return null;
  const { data: team } = await rls.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;
  const { data: me } = await rls
    .from("members")
    .select("id")
    .eq("team_id", team.id)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!me) return null;
  return { teamId: team.id as string, memberId: me.id as string };
}
