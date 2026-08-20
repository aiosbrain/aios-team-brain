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
  | "manual"
  // EXCLSHADOW-1: the repair include written when reconcile closes an AUTOMATIC exclude
  // found in the item's target SYSTEM project (the table is its own audit trail — this value
  // is how a repair stays legible). CHECK-widened by migration 20260820150000.
  | "exclude_shadow_repair";

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

  // EXCLSHADOW-1 D1b: the probe is UNFILTERED (the partial unique index guarantees ≤1
  // current row per pair) and BRANCHES — an exclude is never returned as convergence. The
  // hot path (include found / nothing found) costs exactly what it did before; only the
  // rare exclude branch pays the extra reads.
  const { data: existing } = await db
    .from("project_context_memberships")
    .select("id, decision, mode")
    .eq("team_id", teamId)
    .eq("project_id", args.projectId)
    .eq("context_unit_id", args.contextUnitId)
    .is("valid_to", null)
    .maybeSingle();
  const current = existing as { id: string; decision: string; mode: string } | null;
  if (current) {
    if (current.decision === "include") return { ok: true, created: false };
    return repairExcludeShadow(db, teamId, args, current);
  }

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
      .select("id, decision")
      .eq("team_id", teamId)
      .eq("project_id", args.projectId)
      .eq("context_unit_id", args.contextUnitId)
      .is("valid_to", null)
      .maybeSingle();
    // EXCLSHADOW-1 D1c: the race-loser takes the SAME branch discipline — converged ONLY on
    // a current INCLUDE. An unfiltered "any current row = converged" here would resurrect
    // the silent exclude masquerade through the back door for exactly the states the repair
    // is scoped out of (explicit/force excludes, non-system projects).
    const w = winner as { decision?: string } | null;
    if (w && w.decision === "include") return { ok: true, created: false };
    if (w) return { ok: false, error: "current membership is a non-include row (exclude) — not converged" };
    return { ok: false, error: error.message };
  }
  return { ok: true, created: true };
}

/**
 * EXCLSHADOW-1: repair an AUTOMATIC exclude found in the target SYSTEM project — the state
 * that made an item invisible to every enforced read (`enforce` serves only includes) while
 * reading as `created:false` convergence. THE SCOPE IS THE RULING (spec D1, from
 * classification invariant 3): an explicit (any non-auto mode) exclude is an operator's
 * recorded decision and is NEVER auto-repaired; a non-system project is a curation surface
 * this repair must not touch. Both conditions live HERE, in the writer — not in any caller.
 * Close-first is index-forced: the partial unique index refuses a second current row, so the
 * exclude's `valid_to` must be stamped before the include can exist.
 */
async function repairExcludeShadow(
  db: DbClient,
  teamId: string,
  args: EnsureIncludeArgs,
  row: { id: string; mode: string }
): Promise<WriteResult> {
  if (row.mode !== "auto") {
    return { ok: false, error: "current membership is an explicit exclude — never auto-repaired (classification invariant 3)" };
  }
  const { data: proj } = await db
    .from("projects")
    .select("kind")
    .eq("team_id", teamId)
    .eq("id", args.projectId)
    .maybeSingle();
  if (!proj || (proj as { kind: string }).kind !== "system") {
    return { ok: false, error: "current membership is an exclude in a non-system project — not repaired (a curation surface, not the substrate)" };
  }
  const { error: closeErr } = await db
    .from("project_context_memberships")
    .update({ valid_to: new Date().toISOString() })
    .eq("team_id", teamId)
    .eq("id", row.id)
    .is("valid_to", null);
  if (closeErr) return { ok: false, error: `exclude-shadow close failed: ${closeErr.message}` };
  const { error } = await db.from("project_context_memberships").insert({
    team_id: teamId,
    project_id: args.projectId,
    context_unit_id: args.contextUnitId,
    decision: "include",
    mode: "auto",
    method: "exclude_shadow_repair",
    decided_by: args.decidedBy ?? null,
  });
  if (error) {
    // Half-repair fail direction (spec §2): the exclude is closed and the include absent —
    // the item is now a plain no-current-include candidate, completed by the next pass.
    return { ok: false, error: `exclude-shadow repair: close succeeded, include insert failed (${error.message}) — next pass completes` };
  }
  return { ok: true, created: true };
}

/**
 * Close the CURRENT membership of a unit into ONE specific project (`projectId`), setting
 * `valid_to`. The "close old" half of a tier-flip MOVE: reconcile re-routes the unit to the
 * correct system project and closes the OPPOSITE system project's membership (external→team must
 * stop being served through external-shared — slice-4 Codex H2).
 *
 * Scoped to a single named project ON PURPOSE (slice-5 Codex HIGH): an earlier "close every
 * membership except the target" would, once the Part II curation UI lets a unit belong to
 * initiatives too, silently delete those legitimate initiative assignments on every reconcile.
 * The move only ever swaps between the two system projects, so it closes exactly the other one.
 */
export async function closeMembershipInto(
  db: DbClient,
  teamId: string,
  contextUnitId: string,
  projectId: string
): Promise<{ ok: boolean; error?: string; closed: number }> {
  const { data: current } = await db
    .from("project_context_memberships")
    .select("id")
    .eq("team_id", teamId)
    .eq("context_unit_id", contextUnitId)
    .eq("project_id", projectId)
    .is("valid_to", null);
  const rows = (current ?? []) as { id: string }[];
  if (rows.length === 0) return { ok: true, closed: 0 };
  const { error } = await db
    .from("project_context_memberships")
    .update({ valid_to: new Date().toISOString() })
    .eq("team_id", teamId)
    .in("id", rows.map((m) => m.id));
  if (error) return { ok: false, error: error.message, closed: 0 };
  return { ok: true, closed: rows.length };
}
