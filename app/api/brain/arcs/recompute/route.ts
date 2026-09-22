import { NextRequest } from "next/server";
import { z } from "zod";
import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { getSessionUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/schemas";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import { modelFeatureVerdict } from "@/lib/staging/model-features";
import { isExternalGroupId } from "@/lib/graph/group";
import { recomputeArcs } from "@/lib/graph/arcs";
import { resolveArcScope } from "@/lib/graph/partition-read";
import { freshnessWire, computedNow } from "@/lib/freshness";
import { memberEnforcement } from "@/lib/access/enforce";
import { filterArcsByVisibleItems } from "@/lib/graph/arc-visibility";
import { readArcCache } from "@/lib/graph/arc-cache";
import { authorizationEpoch, withLockedAuthorizationEpoch } from "@/lib/access/authorization-epoch";
import {
  ArcInputAuthorizationUnavailableError,
  ArcSynthesisAuthorizationChangedError,
} from "@/lib/graph/arc-input-authorization";

export const runtime = "nodejs";
export const maxDuration = 120; // arc synthesis (LLM) inline path can take up to ~110s on a cold cache

const schema = z.object({
  team: z.string().min(1).max(120),
  // PPARC-3 write-gate ruling, universal since PRET-3: ONE partition per POST, REQUIRED from
  // every caller (the fused panel annotates each arc with sourceGroup; a group-less POST is a
  // stale pre-unification client and 422s until the panel reloads). Optional in the SCHEMA only
  // so the 422 can carry its explanatory message instead of a bare parse error.
  sourceGroup: z.string().min(1).max(200).optional(),
  corrections: z
    .array(
      z.object({
        arc_id: z.string().min(1).max(64),
        // Optional so an older client keeps working; stored so the correction stays diagnosable once
        // `arc_id` (sha of the title) churns on the next recompute.
        arc_title: z.string().max(300).optional(),
        corrected_text: z.string().min(1).max(4000),
      })
    )
    .max(10),
});

/**
 * Re-derive narrative arcs incorporating human corrections. The correction is written to Postgres FIRST
 * (`arc_corrections`, the record) and only then projected into Graphiti as an episode — it used to exist
 * solely as that episode, so a graph rollback erased it and a failed write silently reverted the user's
 * edit within one cache TTL (H13). A failed SAVE now surfaces as an error rather than a lie.
 * Session-authed + tier-scoped; team-tier only, since correcting an arc is an internal editorial act.
 */
export async function POST(req: NextRequest) {
  const rls = await serverClient();
  const user = await getSessionUser();
  if (!user) return errorResponse("unauthorized", "sign in required", 401);

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse("invalid_payload", "team + corrections required", 422);
  const { team: teamSlug, corrections, sourceGroup } = parsed.data;

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
  const memberId = (me as { id: string }).id;

  const admin = adminClient();
  const { resolveViewerPosture } = await import("@/lib/access/posture");
  // PRET-3: every recompute runs in ONE partition — the fused panel annotates each arc with its
  // sourceGroup, so every client can name one. Absent = a stale pre-unification client (spec
  // M5: a NEW 422 class, stated in the slice spec; the panel self-heals on next load).
  if (sourceGroup == null) {
    return errorResponse("invalid_payload", "sourceGroup is required — correct one partition at a time (refresh the arcs panel if yours predates the unification)", 422);
  }
  const groups = [sourceGroup];
  const scopeKey = `g:${sourceGroup}`;

  // Resolve posture, visibility and the exact partition from scratch on each attempt. The correction
  // gate, synthesis, cache publication and response are all tied to the same durable epoch. A
  // revocation during model work retries the whole authority resolution once; it never reuses the
  // superseded groups or visible-item set.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const epoch = await withLockedAuthorizationEpoch(team.id, (current) => current);
    let tier: Awaited<ReturnType<typeof resolveViewerPosture>>;
    let enforce: import("@/lib/access/enforce").TimelineEnforcement;
    let scope: import("@/lib/graph/partition-read").ArcScope;
    try {
      tier = await resolveViewerPosture(admin, team.id, memberId);
      enforce = await memberEnforcement(admin, { teamId: team.id, memberId });
      scope = await resolveArcScope(admin, { teamId: team.id, teamSlug, memberId, tier, enforcement: enforce });
    } catch {
      return errorResponse("internal", "enforcement check failed", 500);
    }
    if (await authorizationEpoch(admin, team.id) !== epoch) continue;
    if (tier !== "team") return errorResponse("forbidden", "corrections are team-posture only", 403);
    if (!scope.groups.includes(sourceGroup)) {
      return errorResponse("forbidden", "the claimed partition is outside your visible scope", 403);
    }
    // Client-facing prose is corrections-free. Persisting a correction there would create a durable
    // input that the corresponding synthesis deliberately never loads.
    if (isExternalGroupId(sourceGroup)) {
      return errorResponse(
        "invalid_payload",
        "corrections cannot target the external-shared partition — its synthesis is corrections-free (client-facing prose carries no internal editorial text)",
        422
      );
    }

    // Validate every correction against the exact cached partition the member saw. A cold or stale-id
    // request fails closed; arbitrary arc ids can never become synthesis inputs.
    let cached: Awaited<ReturnType<typeof readArcCache>>;
    try {
      cached = await readArcCache(admin, team.id, scopeKey);
    } catch {
      return errorResponse("internal", "arc visibility check failed", 500);
    }
    const visibleArcs = filterArcsByVisibleItems(cached?.arcs ?? [], enforce.visibleItemIds);
    const visibleById = new Map(visibleArcs.map((arc) => [arc.id, arc]));
    const visibleIds = new Set(visibleById.keys());
    if (corrections.some((c) => !visibleIds.has(c.arc_id))) {
      return errorResponse(
        "forbidden",
        "a correction targets an arc outside your visibility, or your arc view is stale — refresh the arcs and retry",
        403
      );
    }
    if (await authorizationEpoch(admin, team.id) !== epoch) continue;

    // M9: unlike the arcs READ, a recompute has no non-model reading to fall back to — synthesis IS
    // the operation. So the honest outcome is a named refusal, placed after authentication,
    // membership, posture and the correction-visibility gate above (so it discloses nothing to a
    // caller who would not have been allowed to recompute anyway) and before the eager key
    // resolution, which would otherwise throw `copied-staging-no-spend` as a generic 500.
    const answering = modelFeatureVerdict();
    if (!answering.enabled) {
      return errorResponse(answering.code ?? "answering_disabled", answering.message ?? "model-backed answering is disabled", 503);
    }
    const keys = await resolveAnsweringKeys(admin, team.id);
    // The wire carries only the human edit. Source dependencies come from the exact authorized arc
    // row the server just gated, including every item behind every cited source fact. Legacy arcs
    // without complete server provenance still preserve the edit, but it remains synthesis-ineligible.
    const serverCorrections = corrections.map((correction) => ({
      ...correction,
      source_provenance: visibleById.get(correction.arc_id)?.source_provenance ?? {
        state: "incomplete" as const,
        item_ids: [],
      },
      captured_authorization_epoch: epoch,
    }));

    try {
      const { arcs: allArcs, freshness } = await recomputeArcs(
        admin,
        team.id,
        teamSlug,
        tier,
        groups,
        serverCorrections,
        keys,
        memberId,
        { scopeKey, expectedAuthorizationEpoch: epoch }
      );
      const served = await withLockedAuthorizationEpoch(team.id, (current) => {
        if (current !== epoch) return null;
        return {
          arcs: filterArcsByVisibleItems(allArcs, enforce.visibleItemIds),
          freshness,
        };
      });
      if (!served) continue;
      const wire = freshnessWire(served.freshness);
      return Response.json(
        served.arcs.length === 0
          ? { arcs: served.arcs, ...freshnessWire(computedNow()) }
          : { arcs: served.arcs, ...wire }
      );
    } catch (error) {
      if (error instanceof ArcSynthesisAuthorizationChangedError) continue;
      if (error instanceof ArcInputAuthorizationUnavailableError) {
        return errorResponse("temporarily_unavailable", "arc authorization unavailable; retry the request", 503);
      }
      throw error;
    }
  }
  return errorResponse("temporarily_unavailable", "arc authorization changed; retry the request", 503);
}
