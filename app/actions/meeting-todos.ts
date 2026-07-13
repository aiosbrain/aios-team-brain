"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminClient } from "@/lib/db/admin";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { projectAllTasks, recordProjectionRun } from "@/lib/pm-sync";
import {
  createMeetingTodoTasks,
  MEETING_TODO_PROJECT_SLUG,
  scanMeetingTodosForTeam,
  type ExtractedTodoRow,
} from "@/lib/meetings/extract-todos";

const scanSchema = z.object({
  teamSlug: z.string().min(1),
  sourceProject: z.string().trim().optional(),
  pathPrefix: z.string().trim().optional(),
  since: z.string().trim().optional(),
  limit: z.number().int().positive().max(5000).optional(),
});

const candidateSchema = z.object({
  rowKey: z.string().min(1),
  sourceItemId: z.string().min(1),
  sourcePath: z.string().min(1),
  sourceText: z.string(),
  line: z.number().int().positive(),
  title: z.string().trim().min(1).max(1000),
  assignee: z.string().trim().max(200),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  audience: z.enum(["team", "external"]),
});

const createSchema = z.object({
  teamSlug: z.string().min(1),
  rows: z.array(candidateSchema).min(1).max(500),
  projectToLinear: z.boolean().optional().default(false),
});

export interface MeetingTodoCandidate extends ExtractedTodoRow {
  existingTaskId: string | null;
}

async function resolveTeam(teamSlug: string) {
  const db = await serverClient();
  const { data: team } = await db
    .from("teams")
    .select("id, slug")
    .eq("slug", teamSlug)
    .maybeSingle();
  return (team as { id: string; slug: string } | null) ?? null;
}

async function authorizeTeamMember(teamId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await currentMember(teamId);
  if (!me) return { ok: false, error: "not a member of this team" };
  if (me.tier !== "team") return { ok: false, error: "team-tier membership required" };
  return { ok: true };
}

export async function scanMeetingTodosAction(input: z.input<typeof scanSchema>): Promise<{
  ok: boolean;
  error?: string;
  scanned?: number;
  candidates?: MeetingTodoCandidate[];
}> {
  const parsed = scanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid scan" };

  const team = await resolveTeam(parsed.data.teamSlug);
  if (!team) return { ok: false, error: "team not found" };
  const auth = await authorizeTeamMember(team.id);
  if (!auth.ok) return auth;

  const db = await serverClient();
  const scan = await scanMeetingTodosForTeam(db, team.id, {
    sourceProject: parsed.data.sourceProject || undefined,
    pathPrefix: parsed.data.pathPrefix || undefined,
    since: parsed.data.since || undefined,
    limit: parsed.data.limit,
  });

  const { data: project } = await db
    .from("projects")
    .select("id")
    .eq("team_id", team.id)
    .eq("slug", MEETING_TODO_PROJECT_SLUG)
    .maybeSingle();
  const projectId = (project as { id: string } | null)?.id;
  const existing = new Map<string, string>();
  if (projectId && scan.rows.length) {
    const { data: tasks } = await db
      .from("tasks")
      .select("id, row_key")
      .eq("team_id", team.id)
      .eq("project_id", projectId)
      .in("row_key", scan.rows.map((r) => r.rowKey));
    for (const task of (tasks ?? []) as { id: string; row_key: string }[]) {
      existing.set(task.row_key, task.id);
    }
  }

  return {
    ok: true,
    scanned: scan.scanned,
    candidates: scan.rows.map((row) => ({ ...row, existingTaskId: existing.get(row.rowKey) ?? null })),
  };
}

export async function createMeetingTodosAction(input: z.input<typeof createSchema>): Promise<{
  ok: boolean;
  error?: string;
  upserted?: number;
  projected?: Record<string, number>;
}> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid selection" };

  const team = await resolveTeam(parsed.data.teamSlug);
  if (!team) return { ok: false, error: "team not found" };
  const auth = await authorizeTeamMember(team.id);
  if (!auth.ok) return auth;

  const db = adminClient();
  const created = await createMeetingTodoTasks(db, team.id, parsed.data.rows);
  const projected: Record<string, number> = {};
  if (parsed.data.projectToLinear) {
    const startedAt = Date.now();
    const { provider, reports, reason } = await projectAllTasks(db, team.id, created.projectId);
    // AIO-357: record this run regardless of outcome, including the no-provider-configured case.
    await recordProjectionRun(db, { teamId: team.id, provider: provider ?? null, trigger: "manual", reports, reason, startedAt });
    if (reason) return { ok: false, error: `created tasks, but Linear projection skipped: ${reason}` };
    for (const report of reports) projected[report.status] = (projected[report.status] ?? 0) + 1;
  }

  revalidatePath(`/t/${team.slug}/tasks`);
  revalidatePath(`/t/${team.slug}/tasks/extract`);
  return { ok: true, upserted: created.upserted, projected };
}
