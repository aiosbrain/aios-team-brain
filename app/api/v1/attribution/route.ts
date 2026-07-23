import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { getAttributionHealth, getMemberItems } from "@/lib/attribution/health";

export const runtime = "nodejs";

/**
 * Attribution health over HTTP (brain-api v1.13) — "is each data stream landing on the right person?",
 * the SAME derived read the Admin → Attribution page renders (`lib/attribution/health`), so the CLI and
 * other machines get it without a web view. Two levels, mirroring the page:
 *   • no `member` param → the summary: `{ bySource, byMember, lowAttributionSources }`.
 *   • `?member=<uuid>` (or `?member=unattributed` for the null bucket) [+ `?source=`, `?limit=`] → the
 *     per-person drill-down: `{ member, items }` (each item's provenance — signal/method/resolvesTo/mismatch).
 *
 * ⚠️ ADMIN-ONLY, ALL TIERS (CLAUDE §5). The health read spans every access tier — it exposes member
 * names + per-source counts of team/admin content — and there is NO RLS backstop. So this route gates
 * to a **team-tier ADMIN** key and never runs the read otherwise; an `external` or non-admin principal
 * gets 403. This gate is the sole reason the `attribution-health-admin-only` guard allowlists this file
 * (it asserts the gate string is present), so do NOT relax it.
 *
 * ERROR SEMANTICS: the summary path is best-effort (inherits `getAttributionHealth` — a DB error yields
 * a 200 with empty arrays, matching the web banner so a page never breaks; a machine consumer thus can't
 * distinguish "healthy but quiet" from "read failed"). The drill-down path THROWS → 500 (a chip that
 * says "14" must not silently expand to []). Documented so a CLI/agent treats an empty summary as "quiet".
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);
  // Team-tier ADMIN only — attribution health spans all tiers with no RLS backstop (see header).
  if (auth.memberTier !== "team" || auth.memberRole !== "admin") {
    return errorResponse("forbidden", "attribution health is team-admin only", 403);
  }

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:attribution:get`, 60))) {
    return errorResponse("rate_limited", "60 reads/min per key", 429);
  }

  const params = new URL(req.url).searchParams;
  const memberParam = params.get("member");

  try {
    // Drill-down: the actual items attributed to one member (or the unattributed bucket).
    if (memberParam !== null) {
      const memberId = memberParam === "unattributed" ? null : memberParam;
      if (memberId !== null && !UUID_RE.test(memberId)) {
        return errorResponse("bad_request", "member must be a UUID or 'unattributed'", 400);
      }
      const source = params.get("source") ?? undefined;
      const limitRaw = Math.floor(Number(params.get("limit")));
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
      const items = await getMemberItems(auth.teamId, memberId, { source, limit });
      return Response.json({ member: memberParam, items });
    }

    // Summary: the per-source + per-person breakdowns + the low-attribution alert list.
    const health = await getAttributionHealth(auth.teamId);
    return Response.json(health);
  } catch (err) {
    return errorResponse("internal", err instanceof Error ? err.message : "attribution read failed", 500);
  }
}
