import { NextRequest } from "next/server";
import { z } from "zod";
import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { getSessionUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/schemas";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import { isExternalGroupId } from "@/lib/graph/group";
import { recomputeArcs } from "@/lib/graph/arcs";
import { resolveArcScope } from "@/lib/graph/partition-read";
import { freshnessWire, computedNow } from "@/lib/freshness";
import { memberEnforcement } from "@/lib/access/enforce";
import { filterArcsByVisibleItems } from "@/lib/graph/arc-visibility";
import { readArcCache } from "@/lib/graph/arc-cache";

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
  // PRET-4 §1a: posture, not the record — the correction-write gate keys on team posture.
  const { resolveViewerPosture } = await import("@/lib/access/posture");
  const tier = await resolveViewerPosture(admin, team.id, memberId);
  if (tier !== "team") return errorResponse("forbidden", "corrections are team-posture only", 403);

  // Access enforcement (Phase B slice 5, spec §5.8). Resolve the member's visibility ONCE, fail
  // closed on a substrate error (→ 500), and use it for the scope + BOTH gates below.
  // PCCC6B-1: an ENFORCED member's recompute runs in their partition scope — the same scope their
  // GET serves — so the correction is recorded under that scope key and can never feed another
  // scope's synthesis. Permissive keeps the tier path byte-identical.
  let enforce: import("@/lib/access/enforce").TimelineEnforcement | null;
  let scope: import("@/lib/graph/partition-read").ArcScope;
  try {
    enforce = await memberEnforcement(admin, { teamId: team.id, memberId });
    // PRET-3: the SAME mode-keyed resolution as the GET — the gate below must consult the row
    // the member was actually served, so the two resolutions must agree (Fable 6b Medium 3's
    // uncapped rule lives inside resolveArcScope now).
    scope = await resolveArcScope(admin, { teamId: team.id, teamSlug, memberId, tier, enforcement: enforce });
  } catch {
    return errorResponse("internal", "enforcement check failed", 500);
  }
  // PRET-3: every recompute runs in ONE partition — the fused panel annotates each arc with its
  // sourceGroup, so every client can name one. Absent = a stale pre-unification client (spec
  // M5: a NEW 422 class, stated in the slice spec; the panel self-heals on next load).
  if (sourceGroup == null) {
    return errorResponse("invalid_payload", "sourceGroup is required — correct one partition at a time (refresh the arcs panel if yours predates the unification)", 422);
  }
  if (!scope.groups.includes(sourceGroup)) {
    return errorResponse("forbidden", "the claimed partition is outside your visible scope", 403);
  }
  // PRET-3 H1 write-side corollary: the external-shared partition's synthesis is
  // CORRECTIONS-FREE (client-facing prose carries no internal editorial text), so accepting a
  // correction scoped to it would store prose the read side never loads — the H13
  // dead-correction shape. Refuse loudly instead.
  if (isExternalGroupId(sourceGroup)) {
    return errorResponse(
      "invalid_payload",
      "corrections cannot target the external-shared partition — its synthesis is corrections-free (client-facing prose carries no internal editorial text)",
      422
    );
  }
  const groups = [sourceGroup];
  const scopeKey = `g:${sourceGroup}`;

  // WRITE gate (Codex B5 High — correction poisoning): recomputeArcs WRITES each correction to
  // `arc_corrections` AND projects it into a Graphiti group, then feeds every future same-scope
  // synthesis. The schema accepts ANY `arc_id`, so without this an attenuated member could
  // inject arbitrary/invisible corrections and poison the SHARED synthesis (not a replay-only edge as
  // an earlier fold wrongly claimed). Under enforcing, a member may only correct an arc they can
  // currently SEE: validate every target against the VISIBLE cached arc set BEFORE the write — read
  // the cache (no synthesis; a cold cache has nothing to correct → reject). An `arc_id` that churned
  // since their GET no longer matches → rejected, they re-fetch (fail closed beats poisonable).
  // PCCC6B-1: the cache row consulted is the member's OWN scope row — the arcs they were actually
  // looking at — not the tier row their GET no longer reads.
  if (enforce) {
    const cached = await readArcCache(admin, team.id, scopeKey);
    const visibleIds = new Set(filterArcsByVisibleItems(cached?.arcs ?? [], enforce.visibleItemIds).map((a) => a.id));
    if (corrections.some((c) => !visibleIds.has(c.arc_id))) {
      // Fable 6b Medium 5: scope-key drift (a latch flip or General's debt toggling between the
      // member's GET and this POST) reads a different row than the arcs they saw — fail closed,
      // but the message must not accuse them of a visibility violation for cache churn.
      return errorResponse(
        "forbidden",
        "a correction targets an arc outside your visibility, or your arc view is stale — refresh the arcs and retry",
        403
      );
    }
  }

  const keys = await resolveAnsweringKeys(admin, team.id);
  const { arcs: allArcs, freshness } = await recomputeArcs(
    admin,
    team.id,
    teamSlug,
    tier,
    groups,
    corrections,
    keys,
    memberId,
    { scopeKey } // PRET-3: every recompute is partition-scoped — the g: key always
  );

  // READ gate: drop arcs the member can't see — this route returns the recomputed TIER set, so
  // without the filter it is an unfiltered bypass of the enforced arc read (Fable B5 High).
  const arcs = filterArcsByVisibleItems(allArcs, enforce?.visibleItemIds ?? null);

  // WAS `new Date()`. A recompute can legitimately return arcs it did NOT compute: `canReuseArcs` skips
  // the model when facts are unchanged, and a degraded synthesis is refused in favour of the prior (H11).
  // Stamping "now" told the user their correction had landed in a fresh set when it may not have.
  // §5.7: when an enforcing member's result is EMPTY, neutralize the freshness envelope — the tier
  // cache's `as_of`/`stale`/`degraded` would otherwise leak hidden-corpus refresh/failure activity
  // (Codex B5 Medium), letting them distinguish "team has nothing" from "everything is invisible".
  const wire = freshnessWire(freshness);
  const enforcingEmpty = enforce != null && arcs.length === 0;
  // Neutral envelope via `computedNow` on enforcing-empty (§5.7) — not an inline `new Date()`.
  return Response.json(enforcingEmpty ? { arcs, ...freshnessWire(computedNow()) } : { arcs, ...wire });
}
