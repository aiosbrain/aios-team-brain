"use server";

import { revalidatePath } from "next/cache";

import { serverClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth/session";
import { resolveIntegrationsAdmin } from "@/lib/integrations/read";
import { audit } from "@/lib/api/audit";
import { projectAllTasks, type ProjectionReport } from "@/lib/pm-sync";

async function requireAdmin(teamSlug: string) {
  const supabase = await serverClient();
  const user = await getSessionUser();
  if (!user) return null;
  const ctx = await resolveIntegrationsAdmin(supabase, teamSlug, user.id);
  if (!ctx) return null;
  return { teamId: ctx.teamId, myMemberId: ctx.memberId };
}

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

  if (!provider && reason) return { ok: false, error: reason };

  const counts: Record<string, number> = {};
  for (const r of reports) counts[r.status] = (counts[r.status] ?? 0) + 1;

  await audit(db, {
    team_id: ctx.teamId,
    actor_kind: "member",
    member_id: ctx.myMemberId,
    action: "team.project_board",
    target_type: "team",
    target_id: ctx.teamId,
    meta: { provider, counts },
  });

  revalidatePath(`/t/${teamSlug}/admin/pm-sync`);
  return { ok: true, provider, counts, reports };
}
