import "server-only";
import type { DbClient } from "@/lib/db/types";
import { episodeGroupId, projectGroupId } from "./group";
import { GENERAL_SLUG, EXTERNAL_SHARED_SLUG } from "@/lib/access/bootstrap";

/**
 * THE writer of `projects.graph_group_id` — every project-creation path calls this, nothing else
 * writes the column (PCCC-4; spec `docs/specs/project-context-classification-v1.md` ~946-950:
 * pointers are STORED, not inferred).
 *
 * Value: the §11 built-ins grandfather the legacy tier ids (General → `<teamSlug>_team`,
 * external-shared → `<teamSlug>_external`) — the existing graphs become those projects' partitions
 * by pointer, nothing re-extracted; every other project mints `projectGroupId(teamId, projectId)`.
 *
 * The project's slug/kind are READ FROM THE ROW, never taken from the caller: a caller passing a
 * wrong kind would otherwise be able to trigger the adoption rewrite on an ordinary project —
 * caught by this slice's own immutability test before it shipped trusting args.
 *
 * IMMUTABLE once set, with exactly ONE sanctioned rewrite: a source project ADOPTED as a §11
 * built-in (the bootstrap's kind flip, which precedes this call) may go minted → legacy, because
 * an adopted General's content lives in the legacy team group and a minted pointer would name an
 * empty graph — the §2.0 silently-empty failure class. The predicates permit only that transition:
 * never legacy → anything, never a cross-project value. Adoption happens at bootstrap, before any
 * per-project fan-out exists, so no pushed episode is stranded by the rewrite (PCCC-5 must keep
 * it that way).
 */
export async function ensureProjectGraphPointer(
  db: DbClient,
  args: { teamId: string; projectId: string }
): Promise<{ ok: boolean; error?: string }> {
  const { data: rowData, error: rowErr } = await db
    .from("projects")
    .select("slug, kind, graph_group_id")
    .eq("id", args.projectId)
    .eq("team_id", args.teamId)
    .maybeSingle();
  const row = rowData as { slug: string; kind: string; graph_group_id: string | null } | null;
  if (rowErr || !row) {
    return { ok: false, error: `graph pointer: project ${args.projectId} unreadable: ${rowErr?.message ?? "no row"}` };
  }

  const minted = projectGroupId(args.teamId, args.projectId); // throws on non-UUID inputs — fail loud
  const isBuiltin = row.kind === "system" && (row.slug === GENERAL_SLUG || row.slug === EXTERNAL_SHARED_SLUG);

  // Steady-state fast path (review Low 7 — this runs per ingest): a pointer that is set and is NOT
  // this project's own minted id is final (a grandfathered legacy id, which never rewrites) — no
  // teams read, no writes. Only null (first point) and own-minted (adoption candidate) proceed.
  if (row.graph_group_id !== null && row.graph_group_id !== minted) return { ok: true };

  let value = minted;
  if (isBuiltin) {
    const { data: team, error: teamErr } = await db.from("teams").select("slug").eq("id", args.teamId).maybeSingle();
    const teamSlug = (team as { slug: string } | null)?.slug;
    if (teamErr || !teamSlug) {
      return { ok: false, error: `graph pointer: team ${args.teamId} unreadable: ${teamErr?.message ?? "no row"}` };
    }
    // episodeGroupId validates the charset the graph service accepts — reuse it, never format here.
    value = episodeGroupId(teamSlug, row.slug === GENERAL_SLUG ? "team" : "external");
  }

  if (row.graph_group_id === value) return { ok: true }; // converged — idempotent fast path

  // Immutability by predicate: only a NULL pointer is ever filled.
  const { error: fillErr } = await db
    .from("projects")
    .update({ graph_group_id: value })
    .eq("id", args.projectId)
    .eq("team_id", args.teamId)
    .is("graph_group_id", null);
  if (fillErr) {
    // Name the one known way this uniquely fails (review Medium 1): a team renamed away from a slug
    // whose legacy groups still hold another team's graph, then a NEW team created under that slug —
    // its built-in computes the same legacy id and the global partial unique refuses. Loud and
    // wedging by design (a silent skip would point two teams at one graph); the repair is manual
    // and named here so the operator isn't reverse-engineering an index name.
    if (fillErr.message.includes("projects_graph_group_id_key")) {
      return {
        ok: false,
        error:
          `graph pointer collision for project ${args.projectId}: the computed group id "${value}" is already ` +
          `another project's partition (slug reuse after a team rename). Manual repair required: rename one ` +
          `team's slug or repoint the older project before re-running bootstrap.`,
      };
    }
    return { ok: false, error: `graph pointer write failed for project ${args.projectId}: ${fillErr.message}` };
  }

  // The adoption rewrite: a built-in may replace ITS OWN minted id (and nothing else) with the
  // legacy id. A separate guarded update rather than an OR-predicate — the adapter has no or(),
  // and two no-op-when-inapplicable updates read plainer than one clever one.
  if (isBuiltin) {
    const { error: adoptErr } = await db
      .from("projects")
      .update({ graph_group_id: value })
      .eq("id", args.projectId)
      .eq("team_id", args.teamId)
      .eq("graph_group_id", minted);
    if (adoptErr) {
      return { ok: false, error: `graph pointer adoption rewrite failed for project ${args.projectId}: ${adoptErr.message}` };
    }
  }
  return { ok: true };
}
