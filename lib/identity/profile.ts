import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { isUniqueViolation } from "@/lib/ids";
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

/**
 * WHO a goal write is bound to — deliberately separate from `GoalInput` (browser-supplied) and
 * from the audit actor, so neither can select it. There is no default: a caller must say which.
 *
 *   browser_member — the positional `memberId` is the server-authorized target. An explicit id or
 *     an imported dedup match is honored only for a goal that member already owns, and the owner
 *     is a predicate of the final write, never a written value (no reassignment).
 *   system_import  — a trusted non-browser importer. Keeps the team-wide (team, source,
 *     external_id) convergence: an explicit id or a dedup match is team-bound and MAY move the
 *     goal to `memberId`. Authenticates nobody; never reachable from browser input.
 */
export type GoalWriteScope = { mode: "browser_member" } | { mode: "system_import" };

/**
 * The write was refused because the row it names is not owned by the (team, member) scope the
 * caller is bound to — a peer's / foreign / absent child id, a contradictory legacy profile
 * tuple, or an ownership race that never resolved in scope. Distinct from a validation error and
 * from an infrastructure fault; the People actions map it to their fixed "not allowed". The
 * message is fixed so nothing about the unowned row rides along.
 */
export class ProfileScopeRefusal extends Error {
  readonly code = "profile_scope_refused";
  constructor() {
    super("profile scope refused");
    this.name = "ProfileScopeRefusal";
  }
}

// A lost race is re-read in scope at most this many times before the write is refused.
const MAX_SCOPE_CONFLICT_RETRIES = 2;

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
 * Persist profile columns for exactly the (team, member) tuple. `member_profiles` is keyed on
 * `member_id` alone with an independent `team_id`, so a `member_id` upsert would re-home another
 * team's row (the builder's upsert writes `team_id` from EXCLUDED and cannot express a conflict
 * WHERE). Instead: update the scoped row and check it matched; if absent, insert. An insert that
 * loses the primary-key race is re-read IN SCOPE and updated there; a row that holds this member
 * under a different team never matches, so the write is refused — never repaired or re-homed.
 */
async function persistProfileFields(
  admin: DbClient,
  teamId: string,
  memberId: string,
  fields: Record<string, unknown>,
  label: "profile" | "avatar"
): Promise<void> {
  const updateScoped = async (): Promise<boolean> => {
    const { data, error } = await admin
      .from("member_profiles")
      .update(fields)
      .eq("team_id", teamId)
      .eq("member_id", memberId)
      .select("member_id");
    if (error) throw new Error(`${label} update failed: ${error.message}`);
    return (data ?? []).length > 0;
  };

  if (await updateScoped()) return;
  for (let conflicts = 0; ; conflicts++) {
    const { data, error } = await admin
      .from("member_profiles")
      .insert({ member_id: memberId, team_id: teamId, ...fields })
      .select("member_id");
    if (!error) {
      if ((data ?? []).length !== 1) throw new Error(`${label} insert failed: no row returned`);
      return;
    }
    if (!isUniqueViolation(error.message)) throw new Error(`${label} insert failed: ${error.message}`);

    // Some row already holds this member id. Only OUR tenant's row may be written.
    const reread = await admin
      .from("member_profiles")
      .select("member_id")
      .eq("team_id", teamId)
      .eq("member_id", memberId)
      .maybeSingle();
    if (reread.error) throw new Error(`${label} reread failed: ${reread.error.message}`);
    if (reread.data && (await updateScoped())) return;
    if (conflicts >= MAX_SCOPE_CONFLICT_RETRIES) throw new ProfileScopeRefusal();
  }
}

/**
 * Write the 1:1 profile row for a member, bound to (team, member). Only provided fields are
 * written (an undefined field is left untouched on an existing row); validation runs before any
 * DB write. Throws ProfileScopeRefusal when the member's row belongs to a different team.
 */
export async function setMemberProfile(
  admin: DbClient,
  teamId: string,
  memberId: string,
  input: ProfileInput,
  opts: { actor?: ProfileActor } = {}
): Promise<void> {
  if (input.timezone !== undefined && !isValidTimezone(input.timezone.trim())) {
    throw new Error(`invalid IANA timezone "${input.timezone}"`);
  }

  const fields: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: opts.actor?.memberId ?? null,
  };
  if (input.timezone !== undefined) fields.timezone = input.timezone.trim();
  if (input.workingHours !== undefined) fields.working_hours = normalizeWorkingHours(input.workingHours);
  if (input.preferredChannels !== undefined) fields.preferred_channels = normalizeChannels(input.preferredChannels);
  if (input.location !== undefined) fields.location = input.location.trim();
  if (input.bio !== undefined) fields.bio = input.bio.trim();

  await persistProfileFields(admin, teamId, memberId, fields, "profile");

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
  admin: DbClient,
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

// A resized/compressed avatar (client-side canvas, ~256px) comfortably fits well under this; the
// cap exists to stop a large or unresized image from bloating a `text` column indefinitely.
const MAX_AVATAR_DATA_URL_LEN = 400_000;
const AVATAR_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

/**
 * Set (or clear, with `dataUrl: null`) a member's self-uploaded profile picture. Stored as a
 * `data:` URL — no object storage in this codebase (self-host-portable, no extra infra); the
 * caller (client-side canvas) is responsible for resizing/compressing before calling this.
 */
export async function setMemberAvatar(
  admin: DbClient,
  teamId: string,
  memberId: string,
  dataUrl: string | null,
  opts: { actor?: ProfileActor } = {}
): Promise<void> {
  if (dataUrl !== null) {
    if (dataUrl.length > MAX_AVATAR_DATA_URL_LEN) {
      throw new Error(`avatar image too large (${dataUrl.length} chars, max ${MAX_AVATAR_DATA_URL_LEN})`);
    }
    if (!AVATAR_DATA_URL_RE.test(dataUrl)) {
      throw new Error("avatar must be a base64 data: URL (image/png, image/jpeg, or image/webp)");
    }
  }

  await persistProfileFields(
    admin,
    teamId,
    memberId,
    {
      avatar_data_url: dataUrl,
      updated_at: new Date().toISOString(),
      updated_by: opts.actor?.memberId ?? null,
    },
    "avatar"
  );

  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: dataUrl ? "profile.avatar_set" : "profile.avatar_removed",
    target_type: "member",
    target_id: memberId,
  });
}

/**
 * Read one member's uploaded avatar (or null). Deliberately NOT tier-gated (unlike the rest of
 * this module's profile fields) — a photo is the same visibility class as the GitHub avatar it
 * complements, used wherever a person is named across the dashboard. Routing every page's read
 * through this single-writer file (rather than an inline `.from("member_profiles")`) keeps
 * `test/guards/member-context-tier-filter` passing, which requires the table read from nowhere
 * but this module.
 */
export async function getMemberAvatar(db: DbClient, memberId: string): Promise<string | null> {
  const { data } = await db
    .from("member_profiles")
    .select("avatar_data_url")
    .eq("member_id", memberId)
    .maybeSingle();
  return (data as { avatar_data_url: string | null } | null)?.avatar_data_url ?? null;
}

/**
 * Remove one of `memberId`'s time-off rows. The delete is bound to (team, member, id) in one
 * statement, so an id can't be deleted across teams or out from under a teammate; a statement
 * that matched nothing throws ProfileScopeRefusal and is never audited as a removal.
 */
export async function removeTimeOff(
  admin: DbClient,
  teamId: string,
  memberId: string,
  id: string,
  opts: { actor?: ProfileActor } = {}
): Promise<void> {
  // An untyped caller still on the old (team, id) shape must not reach the table.
  if (typeof memberId !== "string" || !memberId || typeof id !== "string" || !id) {
    throw new ProfileScopeRefusal();
  }
  const { data, error } = await admin
    .from("member_time_off")
    .delete()
    .eq("team_id", teamId)
    .eq("member_id", memberId)
    .eq("id", id)
    .select("id");
  if (error) throw new Error(`time-off delete failed: ${error.message}`);
  if ((data ?? []).length === 0) throw new ProfileScopeRefusal();
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
 *
 * `scope` is required and decides ownership (see GoalWriteScope): under `browser_member` an
 * existing row is written only while `memberId` owns it; under `system_import` the team-wide
 * match may be reassigned to `memberId`. Either way an update that matched no row — or that
 * collides with the team-wide import key — throws ProfileScopeRefusal and is never audited.
 */
export async function setMemberGoal(
  admin: DbClient,
  teamId: string,
  memberId: string,
  input: GoalInput,
  scope: GoalWriteScope,
  opts: { actor?: ProfileActor } = {}
): Promise<string> {
  // Checked at runtime, before anything else: an untyped caller that omits the mode (or still
  // passes the actor options in this position) must not fall through to either behavior.
  const mode = (scope as { mode?: unknown } | null | undefined)?.mode;
  if (mode !== "browser_member" && mode !== "system_import") {
    throw new Error("goal write scope is required: browser_member or system_import");
  }
  const memberBound = mode === "browser_member";

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

  // Update one existing row and report whether it matched. Member-bound: the owner is part of the
  // predicate and is not written, so an owner that changed since any earlier read cannot be
  // overwritten. Trusted import: team-bound, and the row is (re)assigned to `memberId`.
  const updateGoal = async (id: string): Promise<boolean> => {
    const teamBound = admin
      .from("member_goals")
      .update(memberBound ? fields : { member_id: memberId, ...fields })
      .eq("team_id", teamId)
      .eq("id", id);
    const { data, error } = await (memberBound ? teamBound.eq("member_id", memberId) : teamBound).select("id");
    if (error) {
      // Taking another row's (team, source, external_id) key is an ownership collision.
      if (isUniqueViolation(error.message)) throw new ProfileScopeRefusal();
      throw new Error(`goal update failed: ${error.message}`);
    }
    return (data ?? []).length > 0;
  };

  // Insert a new row for `memberId`; null means the team-wide import key was taken first.
  const insertGoal = async (): Promise<string | null> => {
    const { data, error } = await admin
      .from("member_goals")
      .insert({ team_id: teamId, member_id: memberId, ...fields })
      .select("id")
      .single();
    if (error || !data) {
      if (isUniqueViolation(error?.message)) return null;
      throw new Error(`goal insert failed: ${error?.message}`);
    }
    return (data as { id: string }).id;
  };

  // Imported dedup: find the team-wide key's row and write it in place, else insert. The key's
  // owner is read explicitly — a peer's match is a refusal, never "no match" (that would insert
  // into the unique index) and never a silent move. A lost insert race or an owner that changed
  // before the scoped update re-reads the owner, a bounded number of times.
  const convergeImportedGoal = async (): Promise<string> => {
    for (let conflicts = 0; ; conflicts++) {
      const { data, error } = await admin
        .from("member_goals")
        .select("id, member_id")
        .eq("team_id", teamId)
        .eq("source", source)
        .eq("external_id", externalId)
        .maybeSingle();
      if (error) throw new Error(`goal lookup failed: ${error.message}`);
      const dup = data as { id: string; member_id: string } | null;
      if (dup) {
        if (memberBound && dup.member_id !== memberId) throw new ProfileScopeRefusal();
        if (await updateGoal(dup.id)) return dup.id;
      } else {
        const inserted = await insertGoal();
        if (inserted) return inserted;
      }
      if (conflicts >= MAX_SCOPE_CONFLICT_RETRIES) throw new ProfileScopeRefusal();
    }
  };

  // Resolve the target row: explicit id → that row; else an imported dedup match; else insert.
  let goalId: string;
  if (input.id) {
    if (!(await updateGoal(input.id))) throw new ProfileScopeRefusal();
    goalId = input.id;
  } else if (source !== "manual" && externalId) {
    goalId = await convergeImportedGoal();
  } else {
    const inserted = await insertGoal();
    if (!inserted) throw new ProfileScopeRefusal();
    goalId = inserted;
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

/**
 * Remove one of `memberId`'s goals, bound to (team, member, id) exactly as `removeTimeOff`: a
 * statement that matched nothing throws ProfileScopeRefusal and is never audited as a removal.
 */
export async function removeMemberGoal(
  admin: DbClient,
  teamId: string,
  memberId: string,
  id: string,
  opts: { actor?: ProfileActor } = {}
): Promise<void> {
  if (typeof memberId !== "string" || !memberId || typeof id !== "string" || !id) {
    throw new ProfileScopeRefusal();
  }
  const { data, error } = await admin
    .from("member_goals")
    .delete()
    .eq("team_id", teamId)
    .eq("member_id", memberId)
    .eq("id", id)
    .select("id");
  if (error) throw new Error(`goal delete failed: ${error.message}`);
  if ((data ?? []).length === 0) throw new ProfileScopeRefusal();
  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "goal.remove",
    target_type: "member",
    target_id: id,
  });
}
