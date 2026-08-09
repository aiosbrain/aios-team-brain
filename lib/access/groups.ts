import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { isBuiltinEligible, isPrincipal } from "@/lib/access/eligibility";

/**
 * THE single writer for the access-chain edge tables — `groups`, `group_members`,
 * `project_groups` (spec §4). Nothing else may write them (build-enforced by
 * test/guards/access-single-writer.test.ts), which is what makes the invariants here real:
 *
 *  - built-ins ("everyone"/"external") are machine-maintained from isBuiltinEligible + tier,
 *    never hand-edited, and auto-admit HUMANS ONLY — agents/connectors/off-roster never;
 *  - a membership row for a member failing isPrincipal cannot be created (write-side half of
 *    eligibility; the oracle re-applies it read-side);
 *  - a singleton group (person_member_id set — a "direct person add") always contains exactly
 *    its person; ordinary membership edits against it are refused.
 *
 * Every mutation audits through lib/api/audit (best-effort, never blocks the write result).
 */

export const EVERYONE_SLUG = "everyone";
export const EXTERNAL_SLUG = "external";

export interface WriteResult {
  ok: boolean;
  error?: string;
}
export interface GroupResult extends WriteResult {
  groupId?: string;
}

type MemberRow = { id: string; kind: string; is_connector: boolean; status: string; tier: string; display_name: string };
type GroupRow = { id: string; slug: string; is_builtin: boolean; person_member_id: string | null };

async function getMember(db: DbClient, teamId: string, memberId: string): Promise<MemberRow | null> {
  const { data } = await db
    .from("members")
    .select("id, kind, is_connector, status, tier, display_name")
    .eq("team_id", teamId)
    .eq("id", memberId)
    .maybeSingle();
  return (data as MemberRow) ?? null;
}

async function getGroup(db: DbClient, teamId: string, groupId: string): Promise<GroupRow | null> {
  const { data } = await db
    .from("groups")
    .select("id, slug, is_builtin, person_member_id")
    .eq("team_id", teamId)
    .eq("id", groupId)
    .maybeSingle();
  return (data as GroupRow) ?? null;
}

function auditWrite(
  db: DbClient,
  teamId: string,
  actorMemberId: string | null,
  action: string,
  targetId: string | null,
  meta: Record<string, unknown>
): Promise<void> {
  return audit(db, {
    team_id: teamId,
    actor_kind: actorMemberId ? "member" : "system",
    member_id: actorMemberId,
    action,
    target_type: "access",
    target_id: targetId,
    meta,
  });
}

/** Create the per-team built-in groups if absent, then sync their membership. Idempotent. */
export async function ensureBuiltins(db: DbClient, teamId: string): Promise<WriteResult> {
  for (const [slug, name] of [
    [EVERYONE_SLUG, "Everyone"],
    [EXTERNAL_SLUG, "External"],
  ] as const) {
    const { error } = await db
      .from("groups")
      .upsert({ team_id: teamId, slug, name, is_builtin: true }, { onConflict: "team_id,slug" });
    if (error) return { ok: false, error: `ensure ${slug}: ${error.message}` };
  }
  return syncBuiltinMembership(db, teamId);
}

/**
 * Recompute built-in membership from the members table: everyone = isBuiltinEligible ∧
 * tier='team'; external = isBuiltinEligible ∧ tier='external'. Inserts missing rows, deletes
 * rows that no longer qualify. Hook this on member activation/deactivation AND tier change.
 */
export async function syncBuiltinMembership(db: DbClient, teamId: string): Promise<WriteResult> {
  const { data: groups, error: gErr } = await db
    .from("groups")
    .select("id, slug")
    .eq("team_id", teamId)
    .eq("is_builtin", true)
    .in("slug", [EVERYONE_SLUG, EXTERNAL_SLUG]);
  if (gErr) return { ok: false, error: gErr.message };
  const bySlug = new Map((groups ?? []).map((g: { id: string; slug: string }) => [g.slug, g.id]));

  const { data: members, error: mErr } = await db
    .from("members")
    .select("id, kind, is_connector, status, tier, display_name")
    .eq("team_id", teamId);
  if (mErr) return { ok: false, error: mErr.message };

  for (const slug of [EVERYONE_SLUG, EXTERNAL_SLUG]) {
    const groupId = bySlug.get(slug);
    if (!groupId) return { ok: false, error: `builtin ${slug} missing after ensure` };
    const tier = slug === EVERYONE_SLUG ? "team" : "external";
    const want = new Set(
      ((members ?? []) as MemberRow[]).filter((m) => isBuiltinEligible(m) && m.tier === tier).map((m) => m.id)
    );
    const { data: current, error: cErr } = await db
      .from("group_members")
      .select("member_id")
      .eq("team_id", teamId)
      .eq("group_id", groupId);
    if (cErr) return { ok: false, error: cErr.message };
    const have = new Set(((current ?? []) as { member_id: string }[]).map((r) => r.member_id));

    const toAdd = [...want].filter((id) => !have.has(id));
    if (toAdd.length > 0) {
      const { error } = await db
        .from("group_members")
        .upsert(toAdd.map((member_id) => ({ team_id: teamId, group_id: groupId, member_id })), { onConflict: "group_id,member_id" });
      if (error) return { ok: false, error: error.message };
    }
    const toDrop = [...have].filter((id) => !want.has(id));
    if (toDrop.length > 0) {
      const { error } = await db
        .from("group_members")
        .delete()
        .eq("team_id", teamId)
        .eq("group_id", groupId)
        .in("member_id", toDrop);
      if (error) return { ok: false, error: error.message };
    }
  }
  return { ok: true };
}

/** Create an ordinary (non-builtin, non-singleton) group. */
export async function createGroup(
  db: DbClient,
  teamId: string,
  slug: string,
  name: string,
  actorMemberId: string
): Promise<GroupResult> {
  const { data, error } = await db
    .from("groups")
    .insert({ team_id: teamId, slug, name })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" };
  await auditWrite(db, teamId, actorMemberId, "access.group_created", data.id, { slug });
  return { ok: true, groupId: data.id };
}

/**
 * Add a member to an ordinary group. Refuses: members failing isPrincipal (offroster/connector/
 * inactive — the write-side eligibility gate), built-in groups (machine-maintained), and
 * singleton groups (their membership is fixed by definition).
 */
export async function addMemberToGroup(
  db: DbClient,
  teamId: string,
  groupId: string,
  memberId: string,
  actorMemberId: string
): Promise<WriteResult> {
  const group = await getGroup(db, teamId, groupId);
  if (!group) return { ok: false, error: "group not found" };
  if (group.is_builtin) return { ok: false, error: "built-in membership is machine-maintained, not editable" };
  if (group.person_member_id) return { ok: false, error: "a singleton group's membership is fixed to its person" };
  const member = await getMember(db, teamId, memberId);
  if (!member) return { ok: false, error: "member not found" };
  if (!isPrincipal(member)) {
    return { ok: false, error: `member is not a principal (kind=${member.kind}, connector=${member.is_connector}, status=${member.status})` };
  }
  const { error } = await db
    .from("group_members")
    .upsert({ team_id: teamId, group_id: groupId, member_id: memberId, added_by: actorMemberId }, { onConflict: "group_id,member_id" });
  if (error) return { ok: false, error: error.message };
  await auditWrite(db, teamId, actorMemberId, "access.member_added", groupId, { memberId });
  return { ok: true };
}

/** Remove a member from an ordinary group (same built-in/singleton refusals as add). */
export async function removeMemberFromGroup(
  db: DbClient,
  teamId: string,
  groupId: string,
  memberId: string,
  actorMemberId: string
): Promise<WriteResult> {
  const group = await getGroup(db, teamId, groupId);
  if (!group) return { ok: false, error: "group not found" };
  if (group.is_builtin) return { ok: false, error: "built-in membership is machine-maintained, not editable" };
  if (group.person_member_id) return { ok: false, error: "a singleton group's membership is fixed to its person" };
  const { error } = await db
    .from("group_members")
    .delete()
    .eq("team_id", teamId)
    .eq("group_id", groupId)
    .eq("member_id", memberId);
  if (error) return { ok: false, error: error.message };
  await auditWrite(db, teamId, actorMemberId, "access.member_removed", groupId, { memberId });
  return { ok: true };
}

/**
 * "Direct person add" support: get-or-create the hidden singleton group for a member (spec §4).
 * The singleton's membership is exactly its person — enforced here, the only legal writer.
 */
export async function ensurePersonSingleton(
  db: DbClient,
  teamId: string,
  memberId: string,
  actorMemberId: string
): Promise<GroupResult> {
  const member = await getMember(db, teamId, memberId);
  if (!member) return { ok: false, error: "member not found" };
  if (!isPrincipal(member)) {
    return { ok: false, error: `member is not a principal (kind=${member.kind}, connector=${member.is_connector}, status=${member.status})` };
  }
  const { data: existing } = await db
    .from("groups")
    .select("id")
    .eq("team_id", teamId)
    .eq("person_member_id", memberId)
    .maybeSingle();
  let groupId = (existing as { id: string } | null)?.id;
  if (!groupId) {
    const { data, error } = await db
      .from("groups")
      .insert({
        team_id: teamId,
        slug: `person-${memberId}`,
        name: member.display_name,
        person_member_id: memberId,
      })
      .select("id")
      .single();
    if (error || !data) return { ok: false, error: error?.message ?? "insert failed" };
    groupId = data.id as string;
    await auditWrite(db, teamId, actorMemberId, "access.singleton_created", groupId, { memberId });
  }
  // Invariant: membership = exactly the person. Upsert theirs; drop anything else.
  const { error: upErr } = await db
    .from("group_members")
    .upsert({ team_id: teamId, group_id: groupId, member_id: memberId, added_by: actorMemberId }, { onConflict: "group_id,member_id" });
  if (upErr) return { ok: false, error: upErr.message };
  const { error: prErr } = await db
    .from("group_members")
    .delete()
    .eq("team_id", teamId)
    .eq("group_id", groupId)
    .neq("member_id", memberId);
  if (prErr) return { ok: false, error: prErr.message };
  return { ok: true, groupId };
}

/** Grant a group visibility into a project (THE access edge). */
export async function grantProjectToGroup(
  db: DbClient,
  teamId: string,
  projectId: string,
  groupId: string,
  actorMemberId: string
): Promise<WriteResult> {
  const { error } = await db
    .from("project_groups")
    .upsert({ team_id: teamId, project_id: projectId, group_id: groupId, added_by: actorMemberId }, { onConflict: "project_id,group_id" });
  if (error) return { ok: false, error: error.message };
  await auditWrite(db, teamId, actorMemberId, "access.project_granted", projectId, { groupId });
  return { ok: true };
}

/** Revoke a group's visibility into a project. */
export async function revokeProjectFromGroup(
  db: DbClient,
  teamId: string,
  projectId: string,
  groupId: string,
  actorMemberId: string
): Promise<WriteResult> {
  const { error } = await db
    .from("project_groups")
    .delete()
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .eq("group_id", groupId);
  if (error) return { ok: false, error: error.message };
  await auditWrite(db, teamId, actorMemberId, "access.project_revoked", projectId, { groupId });
  return { ok: true };
}
