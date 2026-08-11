import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * THE single writer for `project_context_memberships` (spec §"project_context_memberships";
 * guarded by test/guards/access-single-writer.test.ts). The membership is the content→project
 * edge the oracle reads to answer canSee. Invariant: at most one CURRENT row (`valid_to is
 * null`) per (team, project, unit). Moving closes the old row and opens the new; this slice
 * only needs idempotent include-ensure for the §11 backfill — force/exclude/move arrive with
 * the curation UI (Phase D).
 */

export type MembershipMethod =
  | "ingestion_project"
  | "explicit_ref"
  | "rule"
  | "embedding"
  | "llm"
  | "manual";

export interface EnsureIncludeArgs {
  projectId: string;
  contextUnitId: string;
  method?: MembershipMethod;
  decidedBy?: string | null;
}

export interface WriteResult {
  ok: boolean;
  error?: string;
  created?: boolean;
  /** Set when a write was refused by the no-widening gate (distinct from a DB error). */
  refused?: boolean;
}

/** Does the target project grant visibility to the built-in `external` group? */
async function projectIsExternalVisible(db: DbClient, teamId: string, projectId: string): Promise<boolean> {
  const { data } = await db
    .from("project_groups")
    .select("groups(slug)")
    .eq("team_id", teamId)
    .eq("project_id", projectId);
  const rows = (data ?? []) as { groups: { slug: string } | null }[];
  return rows.some((r) => r.groups?.slug === "external");
}

/**
 * Ensure a CURRENT include membership of a unit into a project. Idempotent: if a current row
 * already exists for the pair it is a no-op (never a second row — the partial unique on
 * `valid_to is null` also backstops a race). Auto-mode by default; the §11 backfill uses
 * method `ingestion_project`.
 */
export async function ensureIncludeMembership(
  db: DbClient,
  teamId: string,
  args: EnsureIncludeArgs
): Promise<WriteResult> {
  // No-widening gate (tier dimension): a team-audience unit must never enter an external-visible
  // project. Read the unit's inherited audience and refuse the widening placement outright.
  const { data: unitRow } = await db
    .from("project_context_units")
    .select("audience")
    .eq("team_id", teamId)
    .eq("id", args.contextUnitId)
    .maybeSingle();
  if (!unitRow) return { ok: false, error: "context unit not found" };
  if ((unitRow as { audience: string }).audience === "team" && (await projectIsExternalVisible(db, teamId, args.projectId))) {
    return { ok: false, refused: true, error: "no-widening: a team-audience unit cannot enter an external-visible project" };
  }

  const { data: existing } = await db
    .from("project_context_memberships")
    .select("id")
    .eq("team_id", teamId)
    .eq("project_id", args.projectId)
    .eq("context_unit_id", args.contextUnitId)
    .is("valid_to", null)
    .maybeSingle();
  if (existing) return { ok: true, created: false };

  const { error } = await db.from("project_context_memberships").insert({
    team_id: teamId,
    project_id: args.projectId,
    context_unit_id: args.contextUnitId,
    decision: "include",
    mode: "auto",
    method: args.method ?? "ingestion_project",
    decided_by: args.decidedBy ?? null,
  });
  if (error) {
    // Race loser on pcm_current_idx: another writer created the current row first — converge.
    const { data: winner } = await db
      .from("project_context_memberships")
      .select("id")
      .eq("team_id", teamId)
      .eq("project_id", args.projectId)
      .eq("context_unit_id", args.contextUnitId)
      .is("valid_to", null)
      .maybeSingle();
    if (winner) return { ok: true, created: false };
    return { ok: false, error: error.message };
  }
  return { ok: true, created: true };
}

/**
 * Close every CURRENT membership of a unit into projects OTHER than `keepProjectId` (sets
 * `valid_to`). The "close old" half of a move: after a tier flip the backfill re-routes the
 * unit to the correct system project and closes the stale one, so an external→team item stops
 * being served through external-shared (slice-4 Codex H2). Returns how many rows it closed.
 */
export async function closeOtherMemberships(
  db: DbClient,
  teamId: string,
  contextUnitId: string,
  keepProjectId: string
): Promise<{ ok: boolean; error?: string; closed: number }> {
  const { data: current } = await db
    .from("project_context_memberships")
    .select("id, project_id")
    .eq("team_id", teamId)
    .eq("context_unit_id", contextUnitId)
    .is("valid_to", null);
  const stale = ((current ?? []) as { id: string; project_id: string }[]).filter((m) => m.project_id !== keepProjectId);
  if (stale.length === 0) return { ok: true, closed: 0 };
  const { error } = await db
    .from("project_context_memberships")
    .update({ valid_to: new Date().toISOString() })
    .eq("team_id", teamId)
    .in("id", stale.map((m) => m.id));
  if (error) return { ok: false, error: error.message, closed: 0 };
  return { ok: true, closed: stale.length };
}
