import "server-only";
import { z } from "zod";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";

/**
 * Shared admin primitive: create (or upsert) a member. Used by the admin server
 * action (UI) and the admin CLI so there's one audited write path. Authorization
 * is the caller's responsibility (the action gates via requireAdmin; the CLI is a
 * service-role/system actor). Always runs on the service-role client.
 */
export interface MemberInput {
  email: string;
  displayName: string;
  actorHandle: string;
  role: "admin" | "lead" | "member";
  tier?: "team" | "external";
}

export interface ActorContext {
  kind?: "member" | "system";
  memberId?: string | null;
}

/** Thrown by `createMember` when the team already has a member with this email or actor
 * handle (the `members_team_id_email_key` / `members_team_id_actor_handle_key` unique
 * constraints) — a friendly, dedicated error instead of leaking the raw pg constraint-violation
 * text to callers (the admin UI, the CLI). */
export class MemberExistsError extends Error {
  constructor() {
    super("a member with this email or handle already exists");
    this.name = "MemberExistsError";
  }
}

/** Pure detector, extracted so the constraint-name matching is unit-testable without a DB: does
 * this pg error message indicate the `members` table's team+email or team+actor_handle unique
 * constraint was violated? */
export function isMemberUniqueConstraintViolation(pgErrorMessage: string): boolean {
  return /members_team_id_email_key|members_team_id_actor_handle_key/.test(pgErrorMessage);
}

/** Pure validator, extracted so it's unit-testable without a session/DB: is this a well-formed
 * email address? `inviteMember` (`app/t/[team]/admin/actions.ts`) runs this on the
 * trimmed/lowercased email BEFORE calling `createMember`, so a malformed address never reaches
 * the DB or mints a member row. */
export function isValidInviteEmail(email: string): boolean {
  return z.string().email().safeParse(email).success;
}

export async function createMember(
  admin: DbClient,
  teamId: string,
  input: MemberInput,
  opts: { upsert?: boolean; actor?: ActorContext } = {}
): Promise<{ id: string; status: string }> {
  const email = input.email.trim().toLowerCase();
  // PRET-4 §1c: on the upsert path, read the existing tier BEFORE writing — a tier that
  // CHANGES in an upsert is a deliberate posture move and reconciles the builtin row; an
  // unchanged upsert must never clobber a deliberate cross-enrollment.
  let priorTier: string | null = null;
  if (opts.upsert) {
    const { data: prior, error: priorErr } = await admin
      .from("members")
      .select("tier")
      .eq("team_id", teamId)
      .eq("email", email)
      .maybeSingle();
    // Diff-review M2: a swallowed read error here reads as "no prior member" → a
    // tier-CHANGING upsert would add the new builtin row without reconciling the old one —
    // posture stuck at "team" while the record says "external", durably. Fail the create
    // loudly instead; the caller retries.
    if (priorErr) throw new Error(`create member failed: prior-tier read errored (${priorErr.message})`);
    priorTier = (prior as { tier: string } | null)?.tier ?? null;
  }
  // `status` is intentionally omitted so the column default ('invited') applies on
  // insert while an existing member's status is preserved on upsert-conflict.
  const row = {
    team_id: teamId,
    email,
    display_name: input.displayName.trim(),
    actor_handle: input.actorHandle.trim().toLowerCase(),
    role: input.role,
    tier: input.tier ?? "team",
  };

  const builder = opts.upsert
    ? admin.from("members").upsert(row, { onConflict: "team_id,email" })
    : admin.from("members").insert({ ...row, status: "invited" });

  const { data, error } = await builder.select("id, status").single();
  if (error || !data) {
    if (error && isMemberUniqueConstraintViolation(error.message)) {
      throw new MemberExistsError();
    }
    throw new Error(`create member failed: ${error?.message}`);
  }

  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "member.created",
    target_type: "member",
    target_id: data.id,
    meta: { email, role: input.role, upsert: Boolean(opts.upsert) },
  });
  // PRET-4 §1c: the invite-time default writes EXPLICIT builtin state — every kind, per tier
  // (posture parity; grant-inert for non-humans via the oracle's eligibility). New member →
  // write the target row; upsert whose tier CHANGED → reconcile (a deliberate posture move);
  // unchanged upsert → leave rows alone (a cross-enrollment survives). Best-effort: access
  // maintenance must never fail member creation — but a failure is AUDITED, not just warned
  // (diff-review M1: the one-time sweep is NOT a backstop after its marker stamps; a member
  // missed here stays external-posture until an admin heals them via add-group-member, so the
  // failure must be findable).
  try {
    const effectiveTier = input.tier ?? "team";
    const tierChanged = priorTier !== null && priorTier !== effectiveTier;
    if (priorTier === null || tierChanged) {
      const { writeInviteDefaultMembership } = await import("@/lib/access/groups");
      const w = await writeInviteDefaultMembership(admin, teamId, data.id, effectiveTier, { reconcile: tierChanged });
      if (!w.ok) {
        console.error(`[access] invite-default membership write failed: ${w.error}`);
        await audit(admin, {
          team_id: teamId,
          actor_kind: "system",
          action: "access.invite_default_write_failed",
          target_type: "member",
          target_id: data.id,
          meta: { tier: effectiveTier, error: w.error ?? "unknown" },
        }).catch(() => {});
      }
    }
  } catch {
    // never fail member creation on access maintenance
  }
  return { id: data.id, status: data.status };
}

/**
 * Compensating action for a failed invite: hard-deletes a just-created member row and audits the
 * rollback (`member.deleted`, `meta.reason = "invite-rollback"`) — distinct from `deleteMember`'s
 * own hard-delete path (which is an intentional admin removal, has a different audit meta shape,
 * and enforces the last-admin guard, which doesn't apply here: this member was never active).
 *
 * Exists because `inviteMember` (`app/t/[team]/admin/actions.ts`) can't wrap `createMember` and
 * `adminSetPassword` in one SQL transaction — `createMember` writes through the `DbClient` adapter
 * while `adminSetPassword` writes `auth_users` via raw `runSql` (`lib/db/pg/pool`), different
 * connections/paths. If the password write fails after the member row already landed, this is the
 * explicit, auditable undo instead of leaving an orphaned 'invited' member with no way to sign in.
 */
export async function rollbackMemberCreation(
  admin: DbClient,
  teamId: string,
  memberId: string,
  opts: { actor?: ActorContext } = {}
): Promise<void> {
  await admin.from("members").delete().eq("id", memberId);
  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "member.deleted",
    target_type: "member",
    target_id: memberId,
    meta: { reason: "invite-rollback" },
  });
}

export interface UpdateRoleResult {
  updated: boolean;
  reason?: "absent" | "last-admin" | "unchanged";
  role?: "admin" | "lead" | "member";
}

/**
 * Change an existing member's role (admins only — the caller gates via requireAdmin).
 * Mirrors deleteMember's last-admin guard: refuses to demote the LAST non-disabled
 * admin, so a team can never lock itself out of its own admin panel.
 */
export async function updateMemberRole(
  admin: DbClient,
  teamId: string,
  memberId: string,
  role: "admin" | "lead" | "member",
  opts: { actor?: ActorContext } = {}
): Promise<UpdateRoleResult> {
  const { data: m } = await admin
    .from("members")
    .select("id, role, status")
    .eq("team_id", teamId)
    .eq("id", memberId)
    .maybeSingle();
  const member = m as { id: string; role: "admin" | "lead" | "member"; status: string } | null;
  if (!member) return { updated: false, reason: "absent" };
  if (member.role === role) return { updated: false, reason: "unchanged", role };

  // Refuse to demote the last non-disabled admin (counts active AND invited admins,
  // matching deleteMember — a disabled admin can't administer either way).
  if (member.role === "admin" && member.status !== "disabled") {
    const { data: admins } = await admin
      .from("members")
      .select("id")
      .eq("team_id", teamId)
      .eq("role", "admin")
      .neq("status", "disabled");
    if ((admins ?? []).length <= 1) return { updated: false, reason: "last-admin" };
  }

  const { error } = await admin.from("members").update({ role }).eq("id", member.id);
  if (error) throw new Error(`update member role failed: ${error.message}`);

  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "member.role_changed",
    target_type: "member",
    target_id: member.id,
    meta: { from: member.role, to: role },
  });
  return { updated: true, role };
}

export interface UpdateManagerResult {
  updated: boolean;
  reason?: "absent" | "self" | "manager-not-found" | "manager-disabled" | "manager-is-connector";
  managerMemberId?: string | null;
}

/**
 * Set (or clear) an existing member's manager — the org-chart source synced into the company
 * graph (`lib/graph/company-actors.syncMemberActor`/`syncReportsTo`). Rejects self-management, a
 * manager outside the caller's own team, a disabled manager, and a connector "manager" — none of
 * those make sense as a reporting line. No multi-hop cycle detection (A→B→C→A remains possible) —
 * out of scope at this team's scale.
 */
export async function updateMemberManager(
  admin: DbClient,
  teamId: string,
  memberId: string,
  managerMemberId: string | null
): Promise<UpdateManagerResult> {
  const { data: m } = await admin
    .from("members")
    .select("id")
    .eq("team_id", teamId)
    .eq("id", memberId)
    .maybeSingle();
  if (!m) return { updated: false, reason: "absent" };
  if (managerMemberId === memberId) return { updated: false, reason: "self" };

  if (managerMemberId) {
    const { data: mgr } = await admin
      .from("members")
      .select("team_id, status, is_connector")
      .eq("id", managerMemberId)
      .maybeSingle();
    const manager = mgr as { team_id: string; status: string; is_connector: boolean } | null;
    if (!manager || manager.team_id !== teamId) return { updated: false, reason: "manager-not-found" };
    if (manager.status === "disabled") return { updated: false, reason: "manager-disabled" };
    if (manager.is_connector) return { updated: false, reason: "manager-is-connector" };
  }

  const { error } = await admin
    .from("members")
    .update({ manager_member_id: managerMemberId })
    .eq("id", memberId)
    .eq("team_id", teamId);
  if (error) throw new Error(`update member manager failed: ${error.message}`);

  return { updated: true, managerMemberId };
}

export interface DeleteResult {
  deleted: boolean;
  reason?: "absent" | "last-admin";
  mode?: "soft" | "hard";
  id?: string;
}

/**
 * Remove a member. Default is a **soft** delete (status='disabled', auth_user_id
 * cleared) — auditable + reversible, and excluded from active-member checks. `hard`
 * permanently deletes the row (cascades api_keys/member_emails; SET-NULLs content
 * refs like code_contributions.member_id). Idempotent + safe:
 *   • absent member → no-op
 *   • refuses to remove the LAST active admin
 */
export async function deleteMember(
  admin: DbClient,
  teamId: string,
  email: string,
  opts: { hard?: boolean; actor?: ActorContext } = {}
): Promise<DeleteResult> {
  const e = email.trim().toLowerCase();
  const { data: m } = await admin
    .from("members")
    .select("id, role, status")
    .eq("team_id", teamId)
    .eq("email", e)
    .maybeSingle();
  const member = m as { id: string; role: string; status: string } | null;
  if (!member) return { deleted: false, reason: "absent" };

  // Refuse if this is the last non-disabled admin (avoid locking the team out —
  // counts active AND invited admins; a disabled admin can't administer).
  if (member.role === "admin" && member.status !== "disabled") {
    const { data: admins } = await admin
      .from("members")
      .select("id")
      .eq("team_id", teamId)
      .eq("role", "admin")
      .neq("status", "disabled");
    if ((admins ?? []).length <= 1) return { deleted: false, reason: "last-admin" };
  }

  if (opts.hard) {
    const { error } = await admin.from("members").delete().eq("id", member.id);
    if (error) throw new Error(`delete member failed: ${error.message}`);
  } else {
    const { error } = await admin
      .from("members")
      .update({ status: "disabled", auth_user_id: null })
      .eq("id", member.id);
    if (error) throw new Error(`disable member failed: ${error.message}`);
  }

  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: opts.hard ? "member.deleted" : "member.disabled",
    target_type: "member",
    target_id: member.id,
    meta: { email: e },
  });
  // PRET-4 §1c: no membership recompute on lifecycle. A disabled member's builtin rows stay
  // in place and are access-inert read-side (the oracle's isPrincipal; auth refuses disabled
  // principals before posture). A hard delete cascades via the composite FK
  // (postgres/schema.sql group_members → members on delete cascade).
  return { deleted: true, mode: opts.hard ? "hard" : "soft", id: member.id };
}
