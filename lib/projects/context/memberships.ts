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
