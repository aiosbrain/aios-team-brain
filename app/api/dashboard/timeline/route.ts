import { NextRequest } from "next/server";
import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { getSessionUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/schemas";
import { getCachedWorkTimeline, TimelineAuthorizationChangedError } from "@/lib/dashboard/timeline-cache";
import { getWorkTimeline, WINDOW_DAYS, MAX_WINDOW_DAYS } from "@/lib/dashboard/work-timeline";
import { contentTimelineEnforcement } from "@/lib/access/admission";
import {
  AttributionRepairPendingError,
  authorizationEpoch,
  withLockedAuthorizationEpoch,
} from "@/lib/access/authorization-epoch";
import type { ViewerTier } from "@/lib/auth/visibility";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The fresh-build (`days > 7`) arm under the same barrier the cached arm gets from
 * `getCachedWorkTimeline` (AIO-1167). Its payload credits work by `items.member_id`, so it must not be
 * served while an attribution repair is pending — that column is being rewritten — nor when the
 * authorization epoch moved during the build. The GATED epoch is read before the build (a pending
 * repair throws there) and again at a locked publication point after it (a repair that went pending
 * mid-read throws there; a remap, unlink, repair completion or revocation shows as a different
 * epoch). A changed epoch rebuilds once from a fresh admission; a second change is the cache's own
 * retryable `TimelineAuthorizationChangedError`. Nothing here is cached.
 */
async function freshWorkTimeline(teamId: string, tier: ViewerTier, days: number, memberId: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const epoch = await authorizationEpoch(adminClient(), teamId);
    const built = await getWorkTimeline(
      adminClient(),
      teamId,
      tier,
      days,
      await contentTimelineEnforcement(adminClient(), teamId, memberId),
    );
    if (await withLockedAuthorizationEpoch(teamId, (current) => current === epoch)) return built;
  }
  throw new TimelineAuthorizationChangedError();
}

/**
 * Dashboard Timeline data for an ARBITRARY lookback — powers the "Show earlier days" expansion under the
 * Pulse Timeline. The default 7-day window is the cached, summary-attached ledger (`getCachedWorkTimeline`,
 * the same payload the SSR panel + CLI read); a larger window is built FRESH and uncached (an on-demand,
 * infrequent action) via `getWorkTimeline`, so older days carry counts, not the per-person LLM synopsis —
 * that fan-out is deliberately kept off this request path. `days` is clamped to [WINDOW_DAYS, MAX_WINDOW_DAYS].
 * Session-authed. Access (TIERRET-1, CLAUDE.md §5 — no RLS): both windows resolve the member through the
 * ONE admission resolver (`lib/access/admission.ts`) — the cached window via `getCachedWorkTimeline`'s
 * `adm:` variant, the expansion via `contentTimelineEnforcement` — so an admitted member reads exactly its
 * membership (oracle-visible evidence/meetings, sourced tasks by source item, hand-entered tasks by
 * Everyone-or-grants) at either posture. Posture (`tier`) remains only a cache-key segment and the legacy
 * arm's rule; it is not a member read ceiling.
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
    .select("id")
    .eq("team_id", team.id)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!me) return errorResponse("forbidden", "not a member of this team", 403);

  // PRET-4 §1a: posture, not the record.
  const { resolveViewerPosture } = await import("@/lib/access/posture");
  const tier = await resolveViewerPosture(adminClient(), team.id, (me as { id: string }).id);
  const memberId = (me as { id: string }).id;
  // Both branches must yield a bare `TimelineDay[]`: the cached one now returns `{ days, freshness }`, and
  // the two arms only have to AGREE for `Response.json` (typed `any`) to accept a nested shape silently.
  // Note `Number(null) === 0`, so a request with no `days` param clamps to 7 and takes the cached arm —
  // i.e. the default request is the one that would have broken.
  // §5.8: BOTH arms carry the member's enforcement — the fresh-build arm resolves it explicitly
  // (it bypasses the cache layer, so the cache layer's resolution can't cover it). TIERRET-1: that
  // enforcement includes the READER from the one admission resolver, exactly like the cached arm.
  // AIO-1167: both arms are also bound to the attribution-repair gate and the authorization epoch.
  let timeline: Awaited<ReturnType<typeof getWorkTimeline>>;
  try {
    timeline =
      days <= WINDOW_DAYS
        ? (await getCachedWorkTimeline(adminClient(), team.id, tier, memberId)).days
        : await freshWorkTimeline(team.id, tier, days, memberId);
  } catch (error) {
    // Person attribution is mid-repair: neither the old ledger nor a partial rebuild may be served.
    if (error instanceof AttributionRepairPendingError) {
      return errorResponse("temporarily_unavailable", "attribution repair is in progress; retry shortly", 503);
    }
    // Authorization moved under both attempts of the read: retryable, never a raw 500.
    if (error instanceof TimelineAuthorizationChangedError) {
      return errorResponse("temporarily_unavailable", "timeline authorization changed; retry the request", 503);
    }
    throw error;
  }
  return Response.json({ days: timeline, window_days: days });
}
