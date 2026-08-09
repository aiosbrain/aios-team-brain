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
 * Admin-actor mutations audit through lib/api/audit per write; machine maintenance
 * (syncBuiltinMembership, singleton healing) audits one summary row per run that changed
 * anything. Best-effort, never blocks the write result — which is why the data-mechanics
 * tier asserts at least one audit row lands.
 */

export const EVERYONE_SLUG = "everyone";
export const EXTERNAL_SLUG = "external";

/** Slugs an ordinary group may not take: the two built-ins and the singleton namespace.
 *  Without this, a group created as "everyone" BEFORE ensureBuiltins first runs would be
 *  converted into a machine-synced builtin (the upsert flips is_builtin) and its existing
 *  project grants would become team-wide — the review-caught hijack. */
export function isReservedSlug(slug: string): boolean {
  return slug === EVERYONE_SLUG || slug === EXTERNAL_SLUG || slug.startsWith("person-");
}

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
    // Insert-if-absent, NEVER a blind upsert: an existing row with this slug that is not a
    // builtin is a hijack candidate, and flipping its is_builtin would convert a curated
    // group into a machine-synced one. Fail loudly instead.
    const { data: existing } = await db
      .from("groups")
      .select("id, is_builtin")
      .eq("team_id", teamId)
      .eq("slug", slug)
      .maybeSingle();
    if (existing && !(existing as { is_builtin: boolean }).is_builtin) {
      return { ok: false, error: `a non-builtin group already holds reserved slug '${slug}' — refusing to convert it` };
    }
    if (!existing) {
      const { error } = await db
        .from("groups")
        .insert({ team_id: teamId, slug, name, is_builtin: true });
      if (error) {
        // Race loser (unique team_id,slug): converge on the winner's row — but only if the
        // winner IS a builtin; a squatter that won the race is still a refusal.
        const { data: winner } = await db
          .from("groups")
          .select("is_builtin")
          .eq("team_id", teamId)
          .eq("slug", slug)
          .maybeSingle();
        if (!(winner as { is_builtin: boolean } | null)?.is_builtin) {
          return { ok: false, error: `ensure ${slug}: ${error.message}` };
        }
      }
    }
  }
  return syncBuiltinMembership(db, teamId);
}

/**
 * Recompute built-in membership from the members table: everyone = isBuiltinEligible ∧
 * tier='team'; external = isBuiltinEligible ∧ tier='external'. Inserts missing rows, deletes
 * rows that no longer qualify. Hook this on member activation/deactivation AND tier change.
 *
 * DEFERRED (review F3; premise updated by slice 3): this is a read-then-write diff with no
 * serialization — a per-team advisory lock needs a transaction surface the adapter does not
 * expose yet. Since slice 3, concurrent callers DO exist (login-path activation hooks, admin
 * member hooks, the scheduler tick), so interleavings can transiently re-add a just-disabled
 * member's row or drop-then-re-add; the oracle's read-side eligibility + builtin-tier checks
 * keep every such stale row access-inert (availability noise, never a leak), and the next
 * sync converges. Serialize when the adapter grows transactions.
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
    if (toAdd.length > 0 || toDrop.length > 0) {
      await auditWrite(db, teamId, null, "access.builtin_synced", groupId, { slug, added: toAdd, removed: toDrop });
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
  if (isReservedSlug(slug)) return { ok: false, error: `'${slug}' is a reserved slug` };
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
    if (error) {
      // Race loser: a concurrent call inserted first (groups_person_singleton_idx or the slug
      // unique). Converge on the winner's row instead of surfacing the duplicate-key error.
      const { data: winner } = await db
        .from("groups")
        .select("id")
        .eq("team_id", teamId)
        .eq("person_member_id", memberId)
        .maybeSingle();
      if (!winner) return { ok: false, error: error.message };
      groupId = (winner as { id: string }).id;
    } else if (data) {
      groupId = data.id as string;
      await auditWrite(db, teamId, actorMemberId, "access.singleton_created", groupId, { memberId });
    }
    if (!groupId) return { ok: false, error: "singleton create failed" };
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
  actorMemberId: string | null
): Promise<WriteResult> {
  // Select-first: audit ONLY on creation (the syncBuiltinMembership audit-on-change pattern).
  // The bootstrap re-runs this every scheduler tick; an unconditional upsert+audit minted 3
  // audit rows/team/tick forever and re-clobbered added_by — drowning the grant trail the
  // spec's accountability story depends on (slice-3 Fable High).
  // KNOWN BOUNDED RACE (deferred with F3): two concurrent CREATES of the same edge can both
  // miss the select and both audit (double provenance for one ms-apart creation — the trail
  // over-reports, never under-reports). The atomic form (INSERT … ON CONFLICT DO NOTHING
  // RETURNING) needs adapter support; take it with the transaction surface.
  const { data: existing } = await db
    .from("project_groups")
    .select("project_id")
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .eq("group_id", groupId)
    .maybeSingle();
  if (existing) return { ok: true };
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
