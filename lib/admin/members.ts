import "server-only";
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

export async function createMember(
  admin: DbClient,
  teamId: string,
  input: MemberInput,
  opts: { upsert?: boolean; actor?: ActorContext } = {}
): Promise<{ id: string; status: string }> {
  const email = input.email.trim().toLowerCase();
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
  if (error || !data) throw new Error(`create member failed: ${error?.message}`);

  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "member.created",
    target_type: "member",
    target_id: data.id,
    meta: { email, role: input.role, upsert: Boolean(opts.upsert) },
  });
  return { id: data.id, status: data.status };
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
  return { deleted: true, mode: opts.hard ? "hard" : "soft", id: member.id };
}
