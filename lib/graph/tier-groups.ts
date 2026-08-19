import "server-only";
import type { DbClient } from "@/lib/db/types";
import { episodeGroupId, isExternalGroupId, type AccessTier } from "./group";
import { GENERAL_SLUG, EXTERNAL_SHARED_SLUG } from "@/lib/access/bootstrap";

/**
 * THE tier-visible graph read set, resolved from the STORED pointers — the reader half of the
 * rename doctrine.
 *
 * WHY THIS MODULE EXISTS. `projects.graph_group_id` is IMMUTABLE for the §11 built-ins
 * (`lib/graph/project-pointer.ts`), which explicitly tolerates "a frozen legacy id (possibly under
 * an old slug — the rename doctrine)". The projector honours that: `lib/graph/project.ts` writes to
 * the pointer's home. Every remaining read leg, though, RECOMPUTED the id from the LIVE slug via
 * `visibleGroupIds(teamSlug, tier)` — so after a team slug rename the projector kept writing
 * `<old-slug>_team` while the readers searched `<new-slug>_team`, a group nothing has ever written
 * to. Writer and reader disagreed about what a group id is, and the disagreement is SILENT: no
 * error, no empty-graph banner (`graphHasFacts` counts episodes team-wide and correctly reports
 * facts exist), just permanently empty results. Found 2026-08-18 on a real rename.
 *
 * The fix is the smaller of the two candidates: the reader stops deriving the id independently and
 * follows the pointer. No data migration, no re-extraction (which is an LLM bill), history stays
 * reachable. This module is the ONE place that resolution happens, so writer and reader now agree
 * BY CONSTRUCTION rather than by convention — `test/guards/graph-group-pointer-read.test.ts` pins
 * that no production read leg re-derives from a slug.
 *
 * TIER SAFETY (CLAUDE.md §5 — `group_id` is the sole tier fence, no RLS backstop). For a POINTED
 * team the fence moves from a STRING SUFFIX to PROJECT IDENTITY, which is strictly stronger: the
 * query is scoped `team_id = <this team>` and selects the built-in by SLUG (`general` → team,
 * `external-shared` → external), so an `external` principal resolves the external-shared project's
 * pointer and nothing else, and the suffix-shaped id is merely what the mint HAPPENS to produce
 * rather than what is trusted.
 *
 * THE FALLBACK IS THE EXCEPTION, AND IT IS FENCED (review High 1). A team with NO pointer is back
 * on a slug-derived id, and there is a real state that reaches it: team A renames off `acme`, team
 * B is created ON `acme`, and B's bootstrap hits `project-pointer.ts`'s FOREIGN-HISTORY REFUSAL —
 * which returns before filling, so B's built-ins keep `graph_group_id = NULL` permanently
 * (`lib/admin/teams.ts` swallows the bootstrap result and every scheduler tick re-refuses). B's
 * readers would then resolve `acme_team`: team A's live partition, served to B's members with no
 * error anywhere. That predates this module — the deleted `visibleGroupIds` resolved the same
 * group — but this module is now the read authority, so it MIRRORS the writer's refusal:
 * `assertNoForeignHistory` refuses any fallback id whose `graph_episodes` history belongs to
 * another team. `project-pointer.ts`'s refusal is untouched and remains the write-side guard.
 *
 * DIRECTION CHECK (review Medium 1). `project-pointer.ts` verifies a set built-in pointer's SHAPE
 * only (`LEGACY_SHAPE`), so an external-shared pointer holding a `_team`-suffixed id would pass
 * verification; before this module that corruption was inert on reads, and now it would not be.
 * The external resolution therefore refuses an unmistakably team-suffixed id. Deliberately narrow —
 * it does NOT require an `_external` suffix, because a built-in transiently holding its `g_…_p_…`
 * mint is legitimate and must not throw.
 *
 * UNBOOTSTRAPPED FALLBACK. A team with no pointer rows falls back to `episodeGroupId(teamSlug, …)`
 * — deliberately the SAME quiet fallback the projector already takes (`lib/graph/project.ts`, and
 * its "an unbootstrapped team (no pointers) keeps today's episodeGroupId behavior" test). Reader
 * and writer therefore agree in BOTH states; the fallback preserves today's behaviour exactly for
 * a team that has never bootstrapped, and can only be reached when there is no pointer to disagree
 * with. (The arcs leg is deliberately different — `resolveArcScope` returns `[]` and logs, per the
 * SR15 ruling in its own spec. That leg is already pointer-resolved and is not changed here.)
 *
 * ERRORS THROW. A swallowed pointer read that fell back to the slug-derived id would silently
 * reinstate the exact defect this module closes. Callers that can degrade (the query blend, the
 * best-effort panels) catch and degrade honestly; the rest surface the failure.
 */

/** The built-in project pointers for a team, keyed by project slug. Empty map = unbootstrapped. */
async function builtinPointers(db: DbClient, teamId: string): Promise<Map<string, string>> {
  const { data, error } = await db
    .from("projects")
    .select("slug, graph_group_id")
    .eq("team_id", teamId)
    .eq("kind", "system")
    .not("graph_group_id", "is", null);
  if (error) throw new Error(`graph tier groups: built-in pointer read failed for team ${teamId}: ${error.message}`);
  const rows = (data ?? []) as { slug: string; graph_group_id: string }[];
  return new Map(rows.map((r) => [r.slug, r.graph_group_id]));
}

/**
 * Refuse a SLUG-DERIVED id whose episode history belongs to ANOTHER team — the read-side mirror of
 * `project-pointer.ts`'s foreign-history refusal, for the one state that actually reaches it (see
 * the module header: team created on a freed slug, bootstrap refused, pointers permanently null).
 * Only called on the fallback path, so a pointed team pays nothing for it. `graph_episodes` is the
 * same ledger the writer's refusal consults, so both sides answer "whose group is this?" from one
 * source.
 */
async function assertNoForeignHistory(db: DbClient, teamId: string, groupIds: string[]): Promise<void> {
  if (groupIds.length === 0) return;
  const { data, error } = await db
    .from("graph_episodes")
    .select("group_id")
    .in("group_id", groupIds)
    .neq("team_id", teamId)
    .limit(1);
  if (error) {
    throw new Error(`graph tier groups: foreign-history check failed for team ${teamId}: ${error.message}`);
  }
  const hit = ((data ?? []) as { group_id: string }[])[0];
  if (hit) {
    // Loud and fatal, never a quiet empty: this is the cross-team read the tier fence exists to
    // stop, and the repair is an operator action (bootstrap this team's pointers, or purge/repoint
    // the old team's history) — exactly the repair the writer's refusal already names.
    throw new Error(
      `graph tier groups: team ${teamId} has no graph pointer and its slug-derived group ` +
        `"${hit.group_id}" holds ANOTHER team's episode history (slug reuse after a rename). ` +
        `Refusing to read it. Manual repair required: bootstrap this team's graph pointers, or ` +
        `purge/repoint the old team's history — the same repair lib/graph/project-pointer.ts names.`
    );
  }
}

/** The built-in project that OWNS a tier's graph: General holds `team`, external-shared holds `external`. */
const BUILTIN_FOR_ACCESS: Record<AccessTier, string> = {
  team: GENERAL_SLUG,
  external: EXTERNAL_SHARED_SLUG,
};

/**
 * The DIRECTION check (header): an `external` resolution must never yield an unmistakably
 * team-suffixed id. Narrow by design — it does not demand an `_external` suffix, because a
 * built-in legitimately holding its `g_…_p_…` mint must not throw.
 */
function assertDirection(access: AccessTier, groupId: string): string {
  if (access === "external" && !isExternalGroupId(groupId) && /_team$/.test(groupId)) {
    throw new Error(
      `graph tier groups: the external-shared partition resolved to "${groupId}", a TEAM group. ` +
        `Refusing to serve it to external principals — group_id is the sole tier fence (CLAUDE.md §5).`
    );
  }
  return groupId;
}

/**
 * The group_id one tier's content is written to and read from, pointer-first. This is the single
 * mapping `access tier → built-in project → its frozen partition`; nothing else may spell it.
 */
export async function builtinTierGroupId(
  db: DbClient,
  args: { teamId: string; teamSlug: string; access: AccessTier }
): Promise<string> {
  const pointers = await builtinPointers(db, args.teamId);
  const pointed = pointers.get(BUILTIN_FOR_ACCESS[args.access]);
  if (pointed) return assertDirection(args.access, pointed);
  const fallback = episodeGroupId(args.teamSlug, args.access);
  await assertNoForeignHistory(db, args.teamId, [fallback]);
  return assertDirection(args.access, fallback);
}

/**
 * The group_ids a viewer of `tier` may search — the pointer-resolving replacement for the deleted
 * `lib/graph/group.visibleGroupIds`. A `team` viewer sees both built-ins; an `external` viewer sees
 * ONLY the external-shared one. Never widen this without re-checking the tier-isolation invariant.
 */
export async function visibleTierGroupIds(
  db: DbClient,
  args: { teamId: string; teamSlug: string; tier: AccessTier }
): Promise<string[]> {
  const pointers = await builtinPointers(db, args.teamId);
  const wanted: AccessTier[] = args.tier === "team" ? ["team", "external"] : ["external"];

  const fellBack: string[] = [];
  const ids = wanted.map((access) => {
    const pointed = pointers.get(BUILTIN_FOR_ACCESS[access]);
    if (pointed) return assertDirection(access, pointed);
    const fallback = episodeGroupId(args.teamSlug, access);
    fellBack.push(fallback);
    return assertDirection(access, fallback);
  });

  // One check for the whole fallback set, and only when something actually fell back.
  await assertNoForeignHistory(db, args.teamId, fellBack);

  // Dedupe defensively: two built-ins sharing a pointer would be corruption (the column carries a
  // unique index), but a duplicated group id in a `/search` call is pure waste either way.
  return [...new Set(ids)];
}
