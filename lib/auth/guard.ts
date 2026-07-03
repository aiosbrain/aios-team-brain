import "server-only";
import { serverClient } from "@/lib/db/server";
import { getSessionUser } from "./session";

export interface CurrentMember {
  id: string;
  role: "admin" | "lead" | "member";
  tier: "team" | "external";
  userId: string;
}

/**
 * Resolve the signed-in user's active membership in a team, or null. This is
 * the app-level access check that replaces RLS in postgres mode (and is a
 * defense-in-depth check in supabase mode). Use in server actions that mutate
 * team data initiated from the browser.
 */
export async function currentMember(teamId: string): Promise<CurrentMember | null> {
  const user = await getSessionUser();
  if (!user) return null;
  const supabase = await serverClient();
  const { data } = await supabase
    .from("members")
    .select("id, role, tier")
    .eq("team_id", teamId)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!data) return null;
  const m = data as { id: string; role: CurrentMember["role"]; tier: CurrentMember["tier"] };
  return { id: m.id, role: m.role, tier: m.tier, userId: user.id };
}
