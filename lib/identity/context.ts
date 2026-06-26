import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ViewerTier } from "@/lib/auth/visibility";
import type { WorkingHours } from "@/lib/identity/profile";

/**
 * Read side of the identity CONTEXT layer (Phase 2). Folds a member's curated profile,
 * time-off, goals/OKRs, and DERIVED project participation into one view for the People page.
 *
 * Tier gate: this is internal team context (working hours, OKRs, time off) with NO `access`
 * column and NO RLS backstop on the postgres target, so `external`-tier viewers get null —
 * the SOLE enforcement (CLAUDE.md §5), mirroring `canSeeCodebases`. Every dashboard read goes
 * through here (guarded by test/guards/member-context-tier-filter.test.ts) so the gate can't be
 * skipped per-page. Writes live in lib/identity/profile (the single writer).
 */

export interface MemberProfileView {
  timezone: string;
  workingHours: WorkingHours;
  preferredChannels: string[];
  location: string;
  bio: string;
}

export interface TimeOffView {
  id: string;
  startsOn: string;
  endsOn: string;
  kind: string;
  note: string;
}

export interface GoalView {
  id: string;
  kind: string;
  title: string;
  detail: string;
  status: string;
  targetDate: string | null;
  source: string;
}

/** A project the member participates in, derived from task assignment. */
export interface ProjectView {
  slug: string;
  name: string;
  open: number;
  total: number;
}

export interface MemberContext {
  profile: MemberProfileView | null;
  timeOff: TimeOffView[];
  goals: GoalView[];
  projects: ProjectView[];
}

/** Identity context is team-tier only — external collaborators never see it. */
export function canSeeMemberContext(tier: ViewerTier): boolean {
  return tier === "team";
}

/**
 * Authorization predicate for EDITING a member's context: only the member themselves or an
 * admin may write it — a teammate (non-admin) cannot edit someone else's profile/goals/time-off.
 * Pure + exported so the security boundary is spec-tested (test/identity-can-edit-context.test.ts)
 * independent of the server-action plumbing.
 */
export function canEditMemberContext(
  actor: { id: string; role: "admin" | "lead" | "member" },
  targetMemberId: string
): boolean {
  return actor.id === targetMemberId || actor.role === "admin";
}

/**
 * Normalize a Postgres `date` to a stable "YYYY-MM-DD" string. The pg driver returns bare
 * `date` columns as a Date at LOCAL midnight, so `toISOString()` would shift the calendar day
 * across the UTC boundary — read the local Y/M/D components (the same tz the driver used).
 */
function toDateStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v);
}

/** True if the task's free-text assignee names this member (display name or handle). */
function assigneeMatches(assignee: string, names: string[]): boolean {
  const a = assignee.toLowerCase();
  return names.some((n) => n.length > 0 && a.includes(n));
}

/**
 * Fold profile + time-off + goals + derived projects for one member. Returns null for an
 * external viewer (tier gate). `memberId` is the already-resolved roster id (the People page
 * resolves handle→member via getMemberProfile, so resolution isn't duplicated here).
 */
export async function getMemberContext(
  supabase: SupabaseClient,
  teamId: string,
  memberId: string,
  tier: ViewerTier
): Promise<MemberContext | null> {
  if (!canSeeMemberContext(tier)) return null;

  // Member name/handle drive the derived-projects match against tasks.assignee (free text).
  const { data: member } = await supabase
    .from("members")
    .select("display_name, actor_handle")
    .eq("team_id", teamId)
    .eq("id", memberId)
    .maybeSingle();
  if (!member) return null;
  const m = member as { display_name: string | null; actor_handle: string | null };
  const names = [m.display_name, m.actor_handle]
    .filter((n): n is string => !!n)
    .map((n) => n.toLowerCase());

  const [profileRes, timeOffRes, goalsRes] = await Promise.all([
    supabase
      .from("member_profiles")
      .select("timezone, working_hours, preferred_channels, location, bio")
      .eq("team_id", teamId)
      .eq("member_id", memberId)
      .maybeSingle(),
    supabase
      .from("member_time_off")
      .select("id, starts_on, ends_on, kind, note")
      .eq("team_id", teamId)
      .eq("member_id", memberId)
      .order("starts_on", { ascending: true }),
    supabase
      .from("member_goals")
      .select("id, kind, title, detail, status, target_date, source")
      .eq("team_id", teamId)
      .eq("member_id", memberId)
      .order("created_at", { ascending: true }),
  ]);

  const pr = profileRes.data as {
    timezone: string;
    working_hours: WorkingHours;
    preferred_channels: string[];
    location: string;
    bio: string;
  } | null;
  const profile: MemberProfileView | null = pr
    ? {
        timezone: pr.timezone ?? "",
        workingHours: pr.working_hours ?? {},
        preferredChannels: pr.preferred_channels ?? [],
        location: pr.location ?? "",
        bio: pr.bio ?? "",
      }
    : null;

  const timeOff: TimeOffView[] = ((timeOffRes.data ?? []) as Array<{
    id: string;
    starts_on: string;
    ends_on: string;
    kind: string;
    note: string;
  }>).map((r) => ({
    id: r.id,
    startsOn: toDateStr(r.starts_on),
    endsOn: toDateStr(r.ends_on),
    kind: r.kind,
    note: r.note,
  }));

  const goals: GoalView[] = ((goalsRes.data ?? []) as Array<{
    id: string;
    kind: string;
    title: string;
    detail: string;
    status: string;
    target_date: string | null;
    source: string;
  }>).map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    detail: r.detail,
    status: r.status,
    targetDate: r.target_date ? toDateStr(r.target_date) : null,
    source: r.source,
  }));

  const projects = await deriveProjects(supabase, teamId, names);

  return { profile, timeOff, goals, projects };
}

/** Distinct projects this member is assigned tasks in, with open/total counts. */
async function deriveProjects(
  supabase: SupabaseClient,
  teamId: string,
  names: string[]
): Promise<ProjectView[]> {
  if (!names.length) return [];
  const { data: tasks } = await supabase
    .from("tasks")
    .select("project_id, assignee, status")
    .eq("team_id", teamId);
  const rows = (tasks ?? []) as Array<{ project_id: string; assignee: string; status: string }>;

  const byProject = new Map<string, { open: number; total: number }>();
  for (const t of rows) {
    if (!t.assignee || !assigneeMatches(t.assignee, names)) continue;
    const agg = byProject.get(t.project_id) ?? { open: 0, total: 0 };
    agg.total += 1;
    if (t.status !== "done") agg.open += 1;
    byProject.set(t.project_id, agg);
  }
  if (!byProject.size) return [];

  const { data: projects } = await supabase
    .from("projects")
    .select("id, slug, name")
    .eq("team_id", teamId)
    .in("id", [...byProject.keys()]);
  const meta = new Map(
    ((projects ?? []) as Array<{ id: string; slug: string; name: string }>).map((p) => [p.id, p])
  );

  return [...byProject.entries()]
    .map(([projectId, agg]) => {
      const p = meta.get(projectId);
      return { slug: p?.slug ?? projectId, name: p?.name || p?.slug || projectId, open: agg.open, total: agg.total };
    })
    .sort((a, b) => b.total - a.total);
}
