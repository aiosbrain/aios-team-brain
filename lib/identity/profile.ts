import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/api/audit";
import {
  WEEKDAYS,
  CHANNEL_KINDS,
  TIME_OFF_KINDS,
  GOAL_KINDS,
  GOAL_STATUSES,
  GOAL_SOURCES,
  type Weekday,
  type WorkingHours,
  type ChannelKind,
  type TimeOffKind,
  type GoalKind,
  type GoalStatus,
  type GoalSource,
} from "@/lib/identity/profile-constants";

// Re-export the client-safe constants/types so server callers keep a single import site.
export {
  WEEKDAYS,
  CHANNEL_KINDS,
  TIME_OFF_KINDS,
  GOAL_KINDS,
  GOAL_STATUSES,
  GOAL_SOURCES,
  type Weekday,
  type WorkingHours,
  type ChannelKind,
  type TimeOffKind,
  type GoalKind,
  type GoalStatus,
  type GoalSource,
};

/**
 * Single writer for the identity CONTEXT layer — `member_profiles`, `member_time_off`,
 * and `member_goals` (CLAUDE.md §2). These are the MANUAL, curated fields a member or admin
 * edits (timezone, working hours, preferred channels, time off, OKRs/goals), distinct from the
 * machine-reconciled identity tables (member_emails / member_identities). Every mutation goes
 * through here so validation (tz / working-hours shape / channel allowlist / date sanity) and
 * the audit trail are structural, not per-call-site discipline. Reads live in lib/identity/context.
 *
 * Guarded by test/guards/single-writer-profile.test.ts: no other file may insert/update/upsert/
 * delete these three tables.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProfileInput {
  timezone?: string;
  workingHours?: WorkingHours;
  preferredChannels?: string[];
  location?: string;
  bio?: string;
}

export interface TimeOffInput {
  startsOn: string; // YYYY-MM-DD
  endsOn: string; // YYYY-MM-DD
  kind?: TimeOffKind;
  note?: string;
}

export interface GoalInput {
  /** present → update that goal (team-scoped); absent → create */
  id?: string;
  kind?: GoalKind;
  title: string;
  detail?: string;
  status?: GoalStatus;
  targetDate?: string | null; // YYYY-MM-DD or null
  /** non-'manual' source + externalId enables idempotent import upsert (dedup key) */
  source?: GoalSource;
  externalId?: string;
}

export interface ProfileActor {
  kind?: "member" | "system" | "api_key";
  memberId?: string | null;
}

// ── Validation ───────────────────────────────────────────────────────────────

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for an IANA zone Postgres/JS both accept (empty string = "unset", allowed). */
function isValidTimezone(tz: string): boolean {
  if (!tz) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validate + normalize working hours: known weekdays, "HH:MM" times, start < end. */
export function normalizeWorkingHours(input: WorkingHours | undefined): WorkingHours {
  if (!input) return {};
  const out: WorkingHours = {};
  for (const day of WEEKDAYS) {
    const span = input[day];
    if (!span) continue;
    const [start, end] = span;
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
      throw new Error(`working_hours.${day} must be ["HH:MM","HH:MM"], got ${JSON.stringify(span)}`);
    }
    if (start >= end) {
      throw new Error(`working_hours.${day} start (${start}) must be before end (${end})`);
    }
    out[day] = [start, end];
  }
  return out;
}

/** Lowercase, allowlist, and de-duplicate channels while preserving priority order. */
export function normalizeChannels(input: string[] | undefined): ChannelKind[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: ChannelKind[] = [];
  for (const raw of input) {
    const c = raw.trim().toLowerCase();
    if (!c || seen.has(c)) continue;
    if (!(CHANNEL_KINDS as readonly string[]).includes(c)) {
      throw new Error(`unknown preferred channel "${raw}"; allowed: ${CHANNEL_KINDS.join(", ")}`);
    }
    seen.add(c);
    out.push(c as ChannelKind);
  }
  return out;
}

function assertDate(label: string, value: string): void {
  if (!DATE_RE.test(value)) throw new Error(`${label} must be YYYY-MM-DD, got "${value}"`);
}

// ── Writers ──────────────────────────────────────────────────────────────────

/**
 * Upsert the 1:1 profile row for a member. Only provided fields are written (an undefined
 * field is left untouched on an existing row); validation runs before any DB write.
 */
export async function setMemberProfile(
  admin: SupabaseClient,
  teamId: string,
  memberId: string,
  input: ProfileInput,
  opts: { actor?: ProfileActor } = {}
): Promise<void> {
  if (input.timezone !== undefined && !isValidTimezone(input.timezone.trim())) {
    throw new Error(`invalid IANA timezone "${input.timezone}"`);
  }

  const row: Record<string, unknown> = {
    member_id: memberId,
    team_id: teamId,
    updated_at: new Date().toISOString(),
    updated_by: opts.actor?.memberId ?? null,
  };
  if (input.timezone !== undefined) row.timezone = input.timezone.trim();
  if (input.workingHours !== undefined) row.working_hours = normalizeWorkingHours(input.workingHours);
  if (input.preferredChannels !== undefined) row.preferred_channels = normalizeChannels(input.preferredChannels);
  if (input.location !== undefined) row.location = input.location.trim();
  if (input.bio !== undefined) row.bio = input.bio.trim();

  const { error } = await admin.from("member_profiles").upsert(row, { onConflict: "member_id" });
  if (error) throw new Error(`profile upsert failed: ${error.message}`);

  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "profile.set",
    target_type: "member",
    target_id: memberId,
    meta: { fields: Object.keys(input) },
  });
}

/** Add a time-off range for a member. Returns the new row id. */
export async function addTimeOff(
  admin: SupabaseClient,
  teamId: string,
  memberId: string,
  input: TimeOffInput,
  opts: { actor?: ProfileActor } = {}
): Promise<string> {
  assertDate("startsOn", input.startsOn);
  assertDate("endsOn", input.endsOn);
  if (input.endsOn < input.startsOn) {
    throw new Error(`endsOn (${input.endsOn}) must be on/after startsOn (${input.startsOn})`);
  }
  const kind = input.kind ?? "pto";
  if (!(TIME_OFF_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`unknown time-off kind "${kind}"; allowed: ${TIME_OFF_KINDS.join(", ")}`);
  }

  const { data, error } = await admin
    .from("member_time_off")
    .insert({
      team_id: teamId,
      member_id: memberId,
      starts_on: input.startsOn,
      ends_on: input.endsOn,
      kind,
      note: (input.note ?? "").trim(),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`time-off insert failed: ${error?.message}`);

  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "timeoff.add",
    target_type: "member",
    target_id: memberId,
    meta: { id: (data as { id: string }).id, kind, starts_on: input.startsOn, ends_on: input.endsOn },
  });
  return (data as { id: string }).id;
}

/** Remove a time-off row (team-scoped so an id can't be deleted across teams). */
export async function removeTimeOff(
  admin: SupabaseClient,
  teamId: string,
  id: string,
  opts: { actor?: ProfileActor } = {}
): Promise<void> {
  const { error } = await admin.from("member_time_off").delete().eq("team_id", teamId).eq("id", id);
  if (error) throw new Error(`time-off delete failed: ${error.message}`);
  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "timeoff.remove",
    target_type: "member",
    target_id: id,
  });
}

/**
 * Create or update a goal/OKR. `id` updates that row (team-scoped). For imported goals
 * (source ≠ 'manual' with an externalId) the write is idempotent: an existing row with the
 * same (team, source, external_id) is updated in place, so re-running an importer never
 * duplicates. Returns the goal id.
 */
export async function setMemberGoal(
  admin: SupabaseClient,
  teamId: string,
  memberId: string,
  input: GoalInput,
  opts: { actor?: ProfileActor } = {}
): Promise<string> {
  const title = input.title.trim();
  if (!title) throw new Error("goal title is required");
  const kind = input.kind ?? "goal";
  if (!(GOAL_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`unknown goal kind "${kind}"; allowed: ${GOAL_KINDS.join(", ")}`);
  }
  const status = input.status ?? "on_track";
  if (!(GOAL_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`unknown goal status "${status}"; allowed: ${GOAL_STATUSES.join(", ")}`);
  }
  const source = input.source ?? "manual";
  if (!(GOAL_SOURCES as readonly string[]).includes(source)) {
    throw new Error(`unknown goal source "${source}"; allowed: ${GOAL_SOURCES.join(", ")}`);
  }
  const externalId = (input.externalId ?? "").trim();
  if (input.targetDate != null && input.targetDate !== "") assertDate("targetDate", input.targetDate);
  const targetDate = input.targetDate ? input.targetDate : null;

  const fields = {
    kind,
    title,
    detail: (input.detail ?? "").trim(),
    status,
    target_date: targetDate,
    source,
    external_id: externalId,
    updated_at: new Date().toISOString(),
  };

  // Resolve the target row: explicit id → that row; else an imported dedup match; else insert.
  let existingId = input.id ?? null;
  if (!existingId && source !== "manual" && externalId) {
    const { data: dup } = await admin
      .from("member_goals")
      .select("id")
      .eq("team_id", teamId)
      .eq("source", source)
      .eq("external_id", externalId)
      .maybeSingle();
    existingId = (dup as { id: string } | null)?.id ?? null;
  }

  let goalId: string;
  if (existingId) {
    const { error } = await admin
      .from("member_goals")
      .update({ member_id: memberId, ...fields })
      .eq("team_id", teamId)
      .eq("id", existingId);
    if (error) throw new Error(`goal update failed: ${error.message}`);
    goalId = existingId;
  } else {
    const { data, error } = await admin
      .from("member_goals")
      .insert({ team_id: teamId, member_id: memberId, ...fields })
      .select("id")
      .single();
    if (error || !data) throw new Error(`goal insert failed: ${error?.message}`);
    goalId = (data as { id: string }).id;
  }

  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "goal.set",
    target_type: "member",
    target_id: memberId,
    meta: { id: goalId, kind, source, external_id: externalId },
  });
  return goalId;
}

/** Remove a goal (team-scoped). */
export async function removeMemberGoal(
  admin: SupabaseClient,
  teamId: string,
  id: string,
  opts: { actor?: ProfileActor } = {}
): Promise<void> {
  const { error } = await admin.from("member_goals").delete().eq("team_id", teamId).eq("id", id);
  if (error) throw new Error(`goal delete failed: ${error.message}`);
  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "goal.remove",
    target_type: "member",
    target_id: id,
  });
}
