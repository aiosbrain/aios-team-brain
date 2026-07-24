import { NextRequest } from "next/server";
import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { getSessionUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/schemas";
import { getCachedWorkTimeline } from "@/lib/dashboard/timeline-cache";
import { getWorkTimeline, WINDOW_DAYS, MAX_WINDOW_DAYS } from "@/lib/dashboard/work-timeline";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Dashboard Timeline data for an ARBITRARY lookback — powers the "Show earlier days" expansion under the
 * Pulse Timeline. The default 7-day window is the cached, summary-attached ledger (`getCachedWorkTimeline`,
 * the same payload the SSR panel + CLI read); a larger window is built FRESH and uncached (an on-demand,
 * infrequent action) via `getWorkTimeline`, so older days carry counts, not the per-person LLM synopsis —
 * that fan-out is deliberately kept off this request path. `days` is clamped to [WINDOW_DAYS, MAX_WINDOW_DAYS].
 * Session-authed; tier decides visibility (`visibleItems`/`visibleTasks`, the sole enforcement — no RLS,
 * CLAUDE.md §5).
 */
export async function GET(req: NextRequest) {
  const rls = await serverClient();
  const user = await getSessionUser();
  if (!user) return errorResponse("unauthorized", "sign in required", 401);

  const url = new URL(req.url);
  const teamSlug = url.searchParams.get("team");
  if (!teamSlug) return errorResponse("invalid_payload", "team is required", 422);

  const requested = Number(url.searchParams.get("days"));
  const days = Number.isFinite(requested)
    ? Math.max(WINDOW_DAYS, Math.min(Math.floor(requested), MAX_WINDOW_DAYS))
    : WINDOW_DAYS;

  const { data: team } = await rls.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return errorResponse("forbidden", "not a member of this team", 403);
  const { data: me } = await rls
    .from("members")
    .select("tier")
    .eq("team_id", team.id)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!me) return errorResponse("forbidden", "not a member of this team", 403);

  const tier = (me as { tier: "team" | "external" }).tier;
  const timeline =
    days <= WINDOW_DAYS
      ? await getCachedWorkTimeline(adminClient(), team.id, tier)
      : await getWorkTimeline(adminClient(), team.id, tier, days);
  return Response.json({ days: timeline, window_days: days });
}
