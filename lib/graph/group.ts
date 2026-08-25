/**
 * Tier-scoped Graphiti group_ids. Graphiti has NO tier awareness — `/search` returns everything
 * in a group_id — so we encode team + access tier into the group_id and only ever search the
 * groups a viewer's tier may see. This is the SOLE tier enforcement for the graph (no RLS
 * backstop), mirroring CLAUDE.md §5. Pure functions — unit-tested.
 */

export type AccessTier = "team" | "external";

/**
 * Graphiti's `validate_group_id` permits ONLY `[A-Za-z0-9_-]` — a `:` separator raises
 * GroupIdValidationError, which propagates out of the graph service's ingest worker (it catches
 * only CancelledError) and silently kills it for the whole process. So we join team + tier with
 * `_` (team slugs are `[a-z0-9-]`, never `_`, so this stays collision-free and reversible-by-eye)
 * and assert the result is valid — failing loud here beats a stalled worker. Verified live 2026-06-24.
 */
export const VALID_GROUP_ID = /^[A-Za-z0-9_-]+$/;

/** The group_id an episode is written to, from the source row's team + access tier. */
export function episodeGroupId(teamSlug: string, access: AccessTier): string {
  const id = `${teamSlug}_${access}`;
  if (!VALID_GROUP_ID.test(id)) {
    throw new Error(`invalid Graphiti group_id "${id}" — team slug must match [A-Za-z0-9_-]`);
  }
  return id;
}

/**
 * Is this the EXTERNAL group? Used to make tier-cleanup side effects DIRECTION-AWARE: only a move OUT
 * of the external group can have leaked, so only that one justifies hard-purging the external caches
 * (purging on a widening would force a cold LLM re-synthesis for no isolation gain). The suffix test is
 * exact because a team slug is `[a-z0-9-]` and never contains `_` — see `episodeGroupId`. Pure.
 */
export function isExternalGroupId(groupId: string): boolean {
  return groupId.endsWith("_external");
}

// `visibleGroupIds(teamSlug, tier)` USED TO LIVE HERE and is deliberately GONE. It recomputed the
// tier-visible read set from the LIVE team slug, while the projector writes to the built-ins'
// IMMUTABLE `projects.graph_group_id` pointer — so after a team slug rename the writer and the
// reader named different groups and every graph-backed surface went silently empty (found
// 2026-08-18 on a real rename; no error, no banner, while the team-wide episode count stayed
// positive). The read set is now resolved from the pointers by
// `lib/graph/tier-groups.visibleTierGroupIds`.
//
// It is DELETED rather than deprecated so the fix is structural: there is no symbol left for a
// future read leg to import, and tsc refuses the mistake instead of a guard noticing it later.
// `episodeGroupId` stays — it is the MINT (what a pointer is minted FROM, and the projector's
// documented quiet fallback for an unbootstrapped team), not a read authority.

// ── Per-project graph partitions (Phase C, spec §6) ──────────────────────────────────────────────
//
// Phase C replaces the tier suffix above with a PER-PROJECT partition: an episode is written to the
// graph of each project its item is tagged into, and a principal searches only the graphs of the
// projects the ORACLE says they can see (so the graph inherits the same partition model as the item
// store — the External group + project edges express what `_external` did). This module is the SINGLE
// AUTHORITY for that partition key; the projector (writer) and the read legs (arcs/retrieve) both go
// through it, so the scheme can never drift between who writes a partition and who searches it.
//
// ADDITIVE for now: `episodeGroupId` above is UNCHANGED and still mints today's
// tier-scoped graph. The projector fan-out, the read-leg migration, and the one-time re-projection of
// the existing graph are LATER Phase C slices (each touches schema + LLM extraction cost, so each gets
// its own design doc). This slice just establishes the key scheme + the oracle→group-id mapping.

/** Canonical UUID (8-4-4-4-12). Validated on INPUT, BEFORE stripping hyphens — a hyphen-stripped
 *  32-hex check is a SUPERSET of UUIDs (a team slug is `[a-z0-9-]`, and `"a".repeat(32)` is valid
 *  32-hex, so a 32-hex-shaped slug would slip through), which reopens the exact slug footgun. The
 *  canonical form's hyphen POSITIONS are what a slug can't fake (Codex review). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Graphiti group_id for one project's graph partition: `g_<teamId-hex>_p_<projectId-hex>`, both
 * UUIDs with hyphens stripped (kept compact at 69 chars — there is no known Graphiti group-id length
 * limit, `validate_group_id` is charset-only, and 69 is comfortably conservative). The `g_`/`_p_`
 * separators use `_` for the same reason `episodeGroupId` does — a `:` kills the ingest worker
 * (validate_group_id gotcha, verified 2026-06-24).
 *
 * INJECTIVITY is enforced, not assumed: the `_p_` boundary is unambiguous ONLY because both blocks
 * are fixed-width 32-hex, so each input is asserted to be a CANONICAL UUID (before stripping). Without
 * this, a team SLUG passed where a team ID is expected — the adjacent tier scheme `episodeGroupId`
 * takes a slug, this takes an id — would mint a charset-valid but WRONG key: the projector writes one
 * partition namespace and the read leg searches another, a silently-empty graph with no error. Fail
 * LOUD here so that mixup throws instead of producing invisible data. Pure.
 *
 * AUTHORITY (amended by PCCC-4): this is the MINT default, not the read authority. The STORED
 * pointer `projects.graph_group_id` is what the read cutover (PCCC-6) and the pointer-resolving
 * projector (PCCC-5) WILL resolve — today the column is write-only groundwork, no runtime reads
 * it yet. The §11 built-ins grandfather the legacy tier ids (`<teamSlug>_team`/`<teamSlug>_external`),
 * so recomputing this scheme at read time would name an empty partition for exactly the two
 * largest ones. Sole pointer writer: lib/graph/project-pointer.ensureProjectGraphPointer.
 */
export function projectGroupId(teamId: string, projectId: string): string {
  if (!UUID_RE.test(teamId) || !UUID_RE.test(projectId)) {
    throw new Error(`invalid per-project Graphiti group_id — teamId/projectId must be canonical UUIDs (got team="${teamId}", project="${projectId}")`);
  }
  // Lowercased BEFORE stripping (PCCC-4 review Low 4): UUID_RE is case-insensitive while the SQL
  // backfill mints from pg's always-lowercase uuid::text — a mixed-case caller would otherwise
  // silently split one project into two partitions differing only by case.
  const id = `g_${teamId.toLowerCase().replace(/-/g, "")}_p_${projectId.toLowerCase().replace(/-/g, "")}`;
  // Belt-and-braces: a hyphen-stripped-UUID id is charset-valid by construction, but keep the
  // assertion so a future edit to the format can't silently mint an id the graph service rejects.
  if (!VALID_GROUP_ID.test(id)) {
    throw new Error(`invalid per-project Graphiti group_id "${id}"`);
  }
  return id;
}

/**
 * The per-project graph group_ids a principal may SEARCH: their oracle-visible project set mapped
 * through `projectGroupId`. The caller resolves the visible set from the SAME oracle the enforced
 * item reads use (`lib/access/oracle.visibleProjects`) and passes the project ids here — so the graph
 * read can never widen beyond the item read. Deduped; an EMPTY visible set → `[]`. That `[]` is
 * fail-closed at the consumer: `lib/graph/graphiti-client` guards `groupIds.length === 0 → []` before
 * the wire (an empty array Python-side would read as no-filter = search EVERYTHING), and a bolt
 * `group_id IN []` matches nothing — so a future direct-`/search` consumer must keep that guard.
 * Pure — no DB; the DB read is the caller's oracle call.
 */
export function graphGroupIdsForVisibleProjects(teamId: string, projectIds: Iterable<string>): string[] {
  return [...new Set(projectIds)].map((p) => projectGroupId(teamId, p));
}
