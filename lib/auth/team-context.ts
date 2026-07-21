import "server-only";
import { cache } from "react";
import { serverClient } from "@/lib/db/server";
import { getSessionUser } from "@/lib/auth/session";

export interface TeamContext {
  team: { id: string; slug: string; name: string };
  me: {
    id: string;
    role: "admin" | "lead" | "member";
    tier: "team" | "external";
    displayName: string;
    status: string;
  };
  userId: string;
}

type MemberWithTeam = {
  id: string;
  role: TeamContext["me"]["role"];
  display_name: string;
  tier: TeamContext["me"]["tier"];
  status: string;
  teams: TeamContext["team"] | null;
};

/**
 * Request-scoped auth+team resolution shared by the team layout AND every page under it. One
 * collapsed query — the caller's membership for this team, with the team embedded — memoized per
 * `teamSlug` for the request (React `cache()`), so the layout and the page it wraps resolve auth
 * ONCE instead of each running their own team + member lookups. The session user is fixed within a
 * request, so keying on the slug alone is correct.
 *
 * Returns null when the caller isn't a non-disabled member of the slug's team. `me.status` may be
 * `invited` (the layout activates it on first visit); pages should trust the id/role/tier and not
 * re-gate on `active` — the layout is the access gate.
 */
export const resolveTeamContext = cache(async (teamSlug: string): Promise<TeamContext | null> => {
  const user = await getSessionUser();
  if (!user) return null;

  const db = await serverClient();
  const { data } = await db
    .from("members")
    .select("id, role, tier, display_name, status, teams(id, slug, name)")
    .eq("auth_user_id", user.id)
    .neq("status", "disabled");

  const m = ((data ?? []) as MemberWithTeam[]).find((r) => r.teams?.slug === teamSlug);
  if (!m?.teams) return null;

  return {
    team: m.teams,
    me: { id: m.id, role: m.role, tier: m.tier, displayName: m.display_name, status: m.status },
    userId: user.id,
  };
});
