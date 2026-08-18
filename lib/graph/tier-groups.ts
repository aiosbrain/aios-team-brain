import "server-only";
import type { DbClient } from "@/lib/db/types";
import { episodeGroupId, type AccessTier } from "./group";
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
 * TIER SAFETY (CLAUDE.md §5 — `group_id` is the sole tier fence, no RLS backstop). The fence moves
 * from a STRING SUFFIX to PROJECT IDENTITY, which is strictly stronger: the query is scoped
 * `team_id = <this team>` and selects the built-in by SLUG (`general` → team, `external-shared` →
 * external), so an `external` principal resolves the external-shared project's pointer and nothing
 * else, and no team can ever resolve another team's pointer regardless of what a renamed slug
 * spells. The suffix-shaped id is now merely what the mint HAPPENS to produce, never what is
 * trusted. `lib/graph/project-pointer.ts`'s FOREIGN-HISTORY REFUSAL remains the guard on the write
 * side and is untouched.
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

/** The built-in project that OWNS a tier's graph: General holds `team`, external-shared holds `external`. */
const BUILTIN_FOR_ACCESS: Record<AccessTier, string> = {
  team: GENERAL_SLUG,
  external: EXTERNAL_SHARED_SLUG,
};

/**
 * The group_id one tier's content is written to and read from, pointer-first. This is the single
 * mapping `access tier → built-in project → its frozen partition`; nothing else may spell it.
 */
export async function builtinTierGroupId(
  db: DbClient,
  args: { teamId: string; teamSlug: string; access: AccessTier }
): Promise<string> {
  const pointers = await builtinPointers(db, args.teamId);
  return pointers.get(BUILTIN_FOR_ACCESS[args.access]) ?? episodeGroupId(args.teamSlug, args.access);
}

/**
 * The group_ids a viewer of `tier` may search — the pointer-resolving replacement for
 * `lib/graph/group.visibleGroupIds`. A `team` viewer sees both built-ins; an `external` viewer sees
 * ONLY the external-shared one. Never widen this without re-checking the tier-isolation invariant.
 */
export async function visibleTierGroupIds(
  db: DbClient,
  args: { teamId: string; teamSlug: string; tier: AccessTier }
): Promise<string[]> {
  const pointers = await builtinPointers(db, args.teamId);
  const wanted: AccessTier[] = args.tier === "team" ? ["team", "external"] : ["external"];
  const ids = wanted.map(
    (access) => pointers.get(BUILTIN_FOR_ACCESS[access]) ?? episodeGroupId(args.teamSlug, access)
  );
  // Dedupe defensively: two built-ins sharing a pointer would be corruption (the column carries a
  // unique index), but a duplicated group id in a `/search` call is pure waste either way.
  return [...new Set(ids)];
}
