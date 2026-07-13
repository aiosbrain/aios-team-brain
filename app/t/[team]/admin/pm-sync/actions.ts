"use server";

import { revalidatePath } from "next/cache";

import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import { audit } from "@/lib/api/audit";
import { projectAllTasks, recordProjectionRun, type ProjectionReport } from "@/lib/pm-sync";
import { reconcileProviderState, type DivergenceRow } from "@/lib/pm-sync/reconcile";

export interface ProjectBoardResult {
  ok: boolean;
  error?: string;
  provider?: string | null;
  counts?: Record<string, number>;
  reports?: ProjectionReport[];
}

/**
 * "Project board now" — full projection of the team's tasks into its primary PM tool (brain-api
 * v1.2). Admins only; audited. Runs `projectAllTasks` for every project the team owns and reports
 * per-row outcomes. Idempotent: a second run reports all `skipped` (zero provider writes).
 */
export async function projectBoardAction(teamSlug: string): Promise<ProjectBoardResult> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };

  const db = adminClient();
  const startedAt = Date.now();
  const { data: projects, error: projErr } = await db.from("projects").select("id").eq("team_id", ctx.teamId);
  if (projErr) return { ok: false, error: projErr.message };

  const reports: ProjectionReport[] = [];
  let provider: string | null = null;
  let reason: string | undefined;
  for (const p of projects ?? []) {
    const res = await projectAllTasks(db, ctx.teamId, (p as { id: string }).id);
    provider = res.provider;
    if (res.reason) reason = res.reason;
    reports.push(...res.reports);
  }

  // AIO-357: record this run (last-run timestamp + result) so Admin → PM sync can surface
  // "when did projection last run, and did it work" instead of that being undiagnosable.
  await recordProjectionRun(db, {
    teamId: ctx.teamId,
    provider: (provider as ProjectionReport["provider"]) ?? null,
    trigger: "manual",
    reports,
    reason: provider ? undefined : reason,
    startedAt,
  });

  if (!provider && reason) return { ok: false, error: reason };

  const counts: Record<string, number> = {};
  for (const r of reports) counts[r.status] = (counts[r.status] ?? 0) + 1;

  await audit(db, {
    team_id: ctx.teamId,
    actor_kind: "member",
    member_id: ctx.memberId,
    action: "team.project_board",
    target_type: "team",
    target_id: ctx.teamId,
    meta: { provider, counts },
  });

  revalidatePath(`/t/${teamSlug}/admin/pm-sync`);
  return { ok: true, provider, counts, reports };
}

export interface ReconcileResultDto {
  ok: boolean;
  error?: string;
  provider?: string | null;
  seenUpdated?: number;
  divergences?: DivergenceRow[];
}

/**
 * "Check for divergence" — inbound reconcile pass (brain-api v1.2 Phase 5). Admins only; audited.
 * Reads the primary PM tool's CURRENT state for each linked task, records `provider_seen_status`,
 * and surfaces items whose provider state has drifted from the brain's `last_projected_status`.
 * SURFACE-ONLY: brain wins — it never writes back to the brain or the board.
 */
export async function reconcileDivergenceAction(teamSlug: string): Promise<ReconcileResultDto> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };

  const db = adminClient();
  const result = await reconcileProviderState(db, ctx.teamId);
  if (result.provider === null) return { ok: false, error: result.reason ?? "no primary PM provider configured" };

  await audit(db, {
    team_id: ctx.teamId,
    actor_kind: "member",
    member_id: ctx.memberId,
    action: "team.reconcile_divergence",
    target_type: "team",
    target_id: ctx.teamId,
    meta: { provider: result.provider, seenUpdated: result.seenUpdated, divergences: result.divergences.length },
  });

  revalidatePath(`/t/${teamSlug}/admin/pm-sync`);
  return { ok: true, provider: result.provider, seenUpdated: result.seenUpdated, divergences: result.divergences };
}
