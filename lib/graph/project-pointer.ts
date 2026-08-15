import "server-only";
import type { DbClient } from "@/lib/db/types";
import { episodeGroupId, projectGroupId, VALID_GROUP_ID } from "./group";
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
 *
 * A SET pointer is verified, not blindly blessed (Codex review Medium 2): an ordinary project's
 * pointer must BE its mint — anything else is corruption and returns loudly (immutability forbids
 * healing; silence would let PCCC-6 read a wrong partition forever). A built-in's set pointer can
 * be a legitimately FROZEN legacy id under an old team slug (the rename doctrine), which no
 * current input can recompute — so only its SHAPE is checkable: charset-valid and either
 * legacy-shaped (`<slug>_team|_external`) or the project's own mint. The shape check catches
 * typos and cross-namespace garbage; a plausible-but-wrong legacy id is undetectable without
 * rename history, and that residual is named in the design's rename doctrine.
 */
const LEGACY_SHAPE = /^[A-Za-z0-9_-]+_(team|external)$/;

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
  const rawRow = rowData as { slug: string; kind: string; graph_group_id?: string | null } | null;
  // Normalize undefined → null at the boundary: Postgres returns null for an unset column, but an
  // in-memory double returns undefined for a column its insert never carried — same meaning here.
  const row = rawRow ? { ...rawRow, graph_group_id: rawRow.graph_group_id ?? null } : null;
  if (rowErr || !row) {
    return { ok: false, error: `graph pointer: project ${args.projectId} unreadable: ${rowErr?.message ?? "no row"}` };
  }

  const minted = projectGroupId(args.teamId, args.projectId); // throws on non-UUID inputs — fail loud
  const isBuiltin = row.kind === "system" && (row.slug === GENERAL_SLUG || row.slug === EXTERNAL_SHARED_SLUG);

  // Steady-state fast path (review Low 7 — this runs per ingest), now VERIFYING, not just skipping:
  if (row.graph_group_id !== null && row.graph_group_id !== minted) {
    if (!isBuiltin) {
      // An ordinary project's pointer has exactly one legal value. Loud, never healed (immutable).
      return {
        ok: false,
        error:
          `graph pointer corrupt for project ${args.projectId}: holds "${row.graph_group_id}", ` +
          `expected its mint "${minted}" — manual repair required (the pointer is immutable by design).`,
      };
    }
    if (!VALID_GROUP_ID.test(row.graph_group_id) || !LEGACY_SHAPE.test(row.graph_group_id)) {
      return {
        ok: false,
        error:
          `graph pointer corrupt for built-in ${row.slug} (${args.projectId}): "${row.graph_group_id}" is ` +
          `neither its mint nor a legacy tier id — manual repair required.`,
      };
    }
    return { ok: true }; // a frozen legacy id (possibly under an old slug — the rename doctrine); final
  }

  let value = minted;
  if (isBuiltin) {
    const { data: team, error: teamErr } = await db.from("teams").select("slug").eq("id", args.teamId).maybeSingle();
    const teamSlug = (team as { slug: string } | null)?.slug;
    if (teamErr || !teamSlug) {
      return { ok: false, error: `graph pointer: team ${args.teamId} unreadable: ${teamErr?.message ?? "no row"}` };
    }
    // episodeGroupId validates the charset the graph service accepts — reuse it, never format here.
    value = episodeGroupId(teamSlug, row.slug === GENERAL_SLUG ? "team" : "external");

    // FOREIGN-HISTORY REFUSAL (Codex review High 1): the partial unique only wedges when the other
    // team's PROJECT points at the group — but a team that renamed away BEFORE Deploy B's backfill
    // has its pointer under its NEW slug, leaving its historical episodes under the old slug's
    // group with nothing claiming it. A new team taking that slug would silently inherit the old
    // team's graph. The ledger knows: any graph_episodes row for this group under ANOTHER team id
    // means the group is someone's history — refuse loudly, same manual repair as the collision.
    const { data: foreign, error: foreignErr } = await db
      .from("graph_episodes")
      .select("team_id")
      .eq("group_id", value)
      .neq("team_id", args.teamId)
      .limit(1);
    if (foreignErr) {
      return { ok: false, error: `graph pointer: foreign-history check failed for "${value}": ${foreignErr.message}` };
    }
    if (((foreign as unknown[]) ?? []).length > 0) {
      return {
        ok: false,
        error:
          `graph pointer refused for built-in ${row.slug} (${args.projectId}): legacy group "${value}" holds ` +
          `another team's historical episodes (slug reuse after a team rename). Manual repair required: rename ` +
          `this team's slug, or purge/repoint the old team's history before re-running bootstrap.`,
      };
    }
  }

  if (row.graph_group_id === value) return { ok: true }; // converged — idempotent fast path

  // Immutability by predicate: only a NULL pointer is ever filled.
  const { error: fillErr } = await db
    .from("projects")
    .update({ graph_group_id: value })
    .eq("id", args.projectId)
    .eq("team_id", args.teamId)
    .is("graph_group_id", null);
  if (fillErr) return { ok: false, error: pointerWriteError(args.projectId, value, fillErr.message) };

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
    if (adoptErr) return { ok: false, error: pointerWriteError(args.projectId, value, adoptErr.message) };
  }
  return { ok: true };
}

/** One diagnosis for BOTH write paths (Codex review Low 5 — the adoption rewrite hits the same
 *  unique): name the slug-reuse collision so the operator isn't reverse-engineering an index name. */
function pointerWriteError(projectId: string, value: string, message: string): string {
  if (message.includes("projects_graph_group_id_key")) {
    return (
      `graph pointer collision for project ${projectId}: the computed group id "${value}" is already ` +
      `another project's partition (slug reuse after a team rename). Manual repair required: rename one ` +
      `team's slug or repoint the older project before re-running bootstrap.`
    );
  }
  return `graph pointer write failed for project ${projectId}: ${message}`;
}
