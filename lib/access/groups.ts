import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { isBuiltinEligible, isPrincipal } from "@/lib/access/eligibility";
import {
  EVERYONE_SLUG,
  EXTERNAL_SLUG,
  isProtectedProject,
  isSanctionedSystemEdge,
  type EdgeGroupIdentity,
  type ProjectIdentity,
  type UnsanctionedEdge,
} from "@/lib/access/system-projects";

/**
 * THE single writer for the access-chain edge tables — `groups`, `group_members`,
 * `project_groups` (spec §4). Nothing else may write them (build-enforced by
 * test/guards/access-single-writer.test.ts), which is what makes the invariants here real:
 *
 *  - built-ins ("everyone"/"external") hold EXPLICIT state (PRET-4): written from the
 *    invite-time default at member creation, edited thereafter only by deliberate membership
 *    actions here — the tier-derived recompute is retired. Builtin rows are the POSTURE
 *    source (lib/access/posture.ts); for non-humans they are grant-inert (the oracle's
 *    isBuiltinEligible check), and the deliberate-action door admits humans only (a
 *    human-editable agent-into-everyone door would reopen the round-3 Critical's posture
 *    half — PRET-4 cold-read H3);
 *  - a membership row for a member failing isPrincipal cannot be created (write-side half of
 *    eligibility; the oracle re-applies it read-side);
 *  - a singleton group (person_member_id set — a "direct person add") always contains exactly
 *    its person; ordinary membership edits against it are refused.
 *
 * Admin-actor mutations audit through lib/api/audit per write; machine maintenance
 * (the one-time PRET-4 materialization, singleton healing) audits one summary row per run
 * that changed anything. Best-effort, never blocks the write result — which is why the
 * data-mechanics tier asserts at least one audit row lands.
 */

/** The built-in group slugs. Their DEFINITION moved to lib/access/system-projects (AUDITFIX-3) so
 *  the sanctioned-edge table and this writer cannot drift apart, and so bootstrap — which already
 *  imports this module — can read them without a cycle. Re-exported: no call site moves. */
export { EVERYONE_SLUG, EXTERNAL_SLUG } from "@/lib/access/system-projects";
/** The one-time materialization's migration_markers name — single-sourced here (the writer);
 *  lib/access/posture re-exports it for the reader side (diff-review L3). */
export const PRET4_MATERIALIZE_MARKER = "pret4_builtin_materialize";

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

/** Create the per-team built-in groups if absent. Idempotent. MEMBERSHIP is not touched here
 *  (PRET-4): builtin rows are explicit state — written at member creation from the invite
 *  default, one-time-materialized by materializeBuiltinMembershipOnce, and edited only by the
 *  deliberate-action functions below. A membership recompute here would silently revert
 *  deliberate edits on every bootstrap tick (the enforce-the-adjacent-write-route class). */
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
  return { ok: true };
}

/**
 * Write a member's builtin-posture row from their invite-time default (PRET-4 §1c): internal
 * (`tier='team'`) → the `everyone` group, external → the `external` group. Called by
 * `createMember` for EVERY kind — humans, agents, connectors alike (cold-read H1: posture
 * parity; the rows are grant-inert for non-humans via the oracle's eligibility). `reconcile`
 * (an upsert whose tier CHANGED — a stated, deliberate posture move) first removes the member
 * from BOTH builtins; a plain create just adds the target row. Best-effort semantics belong
 * to the caller; this returns honest errors.
 */
export async function writeInviteDefaultMembership(
  db: DbClient,
  teamId: string,
  memberId: string,
  tier: string,
  opts: { reconcile?: boolean } = {}
): Promise<WriteResult> {
  const { data: groups, error: gErr } = await db
    .from("groups")
    .select("id, slug")
    .eq("team_id", teamId)
    .eq("is_builtin", true)
    .in("slug", [EVERYONE_SLUG, EXTERNAL_SLUG]);
  if (gErr) return { ok: false, error: gErr.message };
  const bySlug = new Map((groups ?? []).map((g: { id: string; slug: string }) => [g.slug, g.id]));
  const targetSlug = tier === "team" ? EVERYONE_SLUG : EXTERNAL_SLUG;
  const targetId = bySlug.get(targetSlug);
  if (!targetId) return { ok: false, error: `builtin ${targetSlug} missing — bootstrap has not run for this team` };

  if (opts.reconcile) {
    const allIds = [...bySlug.values()];
    const { error } = await db
      .from("group_members")
      .delete()
      .eq("team_id", teamId)
      .eq("member_id", memberId)
      .in("group_id", allIds);
    if (error) return { ok: false, error: error.message };
  }
  const { error } = await db
    .from("group_members")
    .upsert({ team_id: teamId, group_id: targetId, member_id: memberId }, { onConflict: "group_id,member_id" });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * PRET-4's ONE-TIME fleet materialization (spec §3.2): freeze the tier-derived builtin
 * membership as explicit state. Per team: ADD the rows the retired recompute's predicate
 * implies — for every member kind, per their pre-cutover tier (posture parity, cold-read H1;
 * invited members included, inert until active) — and DROP builtin rows the tier predicate
 * refutes (the LAST legal tier-derived delete, closing the stale-row class the oracle's
 * retiring conjunct kept inert). Marker discipline (SR14, deliberately NOT the PRET-3
 * claim-first pattern): the reconcile runs FIRST and the marker is written LAST, only after
 * every team succeeded — idempotent per team, so a crash retries in full and racing replicas
 * repeat converging statements; a permanently-suppressed half-materialization is impossible.
 */
export async function materializeBuiltinMembershipOnce(db: DbClient): Promise<WriteResult & { ran?: boolean }> {
  const { data: marker, error: mkErr } = await db
    .from("migration_markers")
    .select("name")
    .eq("name", PRET4_MATERIALIZE_MARKER)
    .maybeSingle();
  if (mkErr) return { ok: false, error: `marker read failed: ${mkErr.message}` };
  if (marker) return { ok: true, ran: false }; // already materialized (any replica, any boot)

  const { data: teams, error: tErr } = await db.from("teams").select("id");
  if (tErr) return { ok: false, error: `teams read failed: ${tErr.message}` };

  for (const t of (teams ?? []) as { id: string }[]) {
    const ensured = await ensureBuiltins(db, t.id);
    if (!ensured.ok) return { ok: false, error: `team ${t.id}: ${ensured.error}` };

    const { data: groups, error: gErr } = await db
      .from("groups")
      .select("id, slug")
      .eq("team_id", t.id)
      .eq("is_builtin", true)
      .in("slug", [EVERYONE_SLUG, EXTERNAL_SLUG]);
    if (gErr) return { ok: false, error: `team ${t.id}: ${gErr.message}` };
    const bySlug = new Map((groups ?? []).map((g: { id: string; slug: string }) => [g.slug, g.id]));

    const { data: members, error: memErr } = await db
      .from("members")
      .select("id, kind, is_connector, status, tier, display_name")
      .eq("team_id", t.id);
    if (memErr) return { ok: false, error: `team ${t.id}: ${memErr.message}` };

    for (const slug of [EVERYONE_SLUG, EXTERNAL_SLUG]) {
      const groupId = bySlug.get(slug);
      if (!groupId) return { ok: false, error: `team ${t.id}: builtin ${slug} missing after ensure` };
      const tier = slug === EVERYONE_SLUG ? "team" : "external";
      // EVERY member kind, per tier — the posture source. Grant-inertness for non-humans is
      // the oracle's read-side eligibility, unchanged and dm-pinned.
      const want = new Set(((members ?? []) as MemberRow[]).filter((m) => m.tier === tier).map((m) => m.id));
      const { data: current, error: cErr } = await db
        .from("group_members")
        .select("member_id")
        .eq("team_id", t.id)
        .eq("group_id", groupId);
      if (cErr) return { ok: false, error: `team ${t.id}: ${cErr.message}` };
      const have = new Set(((current ?? []) as { member_id: string }[]).map((r) => r.member_id));

      const toAdd = [...want].filter((id) => !have.has(id));
      if (toAdd.length > 0) {
        const { error } = await db
          .from("group_members")
          .upsert(toAdd.map((member_id) => ({ team_id: t.id, group_id: groupId, member_id })), { onConflict: "group_id,member_id" });
        if (error) return { ok: false, error: `team ${t.id}: ${error.message}` };
      }
      const toDrop = [...have].filter((id) => !want.has(id));
      if (toDrop.length > 0) {
        const { error } = await db
          .from("group_members")
          .delete()
          .eq("team_id", t.id)
          .eq("group_id", groupId)
          .in("member_id", toDrop);
        if (error) return { ok: false, error: `team ${t.id}: ${error.message}` };
      }
      if (toAdd.length > 0 || toDrop.length > 0) {
        await auditWrite(db, t.id, null, "access.builtin_materialized", groupId, { slug, added: toAdd, removed: toDrop });
      }
    }
  }

  // Marker LAST — only a fully-succeeded fleet reconcile claims it.
  const { error: stampErr } = await db
    .from("migration_markers")
    .upsert({ name: PRET4_MATERIALIZE_MARKER }, { onConflict: "name" });
  if (stampErr) return { ok: false, error: `marker write failed: ${stampErr.message}` };
  return { ok: true, ran: true };
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
 * PRET-4 §1c (cold-read M3): after a DELIBERATE builtin move, mirror the member's resulting
 * posture into `members.tier` — the invite-default record follows the move, so the token
 * layer (agent-tokens mint/verify) and Linear provisioning, which read the record live, can
 * never diverge from posture. Tier is a maintained mirror of builtin state, never an
 * independent access input.
 *
 * KNOWN BOUNDED RACE (Codex diff-review H2, deferred with the same reason as the adapter's
 * other unserialized read-then-write diffs): a concurrent createMember upsert writing tier
 * between this read and the update can be overwritten by the stale mirror. Requires two
 * concurrent deliberate admin actions on the SAME member (CLI upsert + a builtin move);
 * converges on the next of either (the upsert path add-only-repairs, the next move
 * re-mirrors); token/provisioning readers lag posture only inside that window. Serialize
 * when the adapter grows transactions.
 */
async function mirrorTierToPosture(db: DbClient, teamId: string, memberId: string): Promise<WriteResult> {
  const { data, error } = await db
    .from("group_members")
    .select("group_id, groups(slug, is_builtin)")
    .eq("team_id", teamId)
    .eq("member_id", memberId);
  if (error) return { ok: false, error: error.message };
  const rows = (data ?? []) as { groups: { slug: string; is_builtin: boolean } | null }[];
  const posture = rows.some((r) => r.groups?.is_builtin === true && r.groups.slug === EVERYONE_SLUG)
    ? "team"
    : "external";
  const { error: uErr } = await db.from("members").update({ tier: posture }).eq("team_id", teamId).eq("id", memberId);
  if (uErr) return { ok: false, error: uErr.message };
  return { ok: true };
}

/**
 * Add a member to a group. Refuses: members failing isPrincipal (offroster/connector/
 * inactive — the write-side eligibility gate), singleton groups (their membership is fixed by
 * definition), and — for BUILT-IN targets — non-humans (PRET-4 cold-read H3: builtin rows
 * carry posture, and a human-editable agent-into-everyone door would reopen the round-3
 * Critical; non-human posture is set only by the invite default at creation). A builtin add
 * is the deliberate posture move and mirrors `members.tier` (M3).
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
  if (group.person_member_id) return { ok: false, error: "a singleton group's membership is fixed to its person" };
  const member = await getMember(db, teamId, memberId);
  if (!member) return { ok: false, error: "member not found" };
  if (!isPrincipal(member)) {
    return { ok: false, error: `member is not a principal (kind=${member.kind}, connector=${member.is_connector}, status=${member.status})` };
  }
  if (group.is_builtin && !isBuiltinEligible(member)) {
    return { ok: false, error: "built-in groups admit humans only — non-human posture is set by the invite default at creation" };
  }
  const { error } = await db
    .from("group_members")
    .upsert({ team_id: teamId, group_id: groupId, member_id: memberId, added_by: actorMemberId }, { onConflict: "group_id,member_id" });
  if (error) return { ok: false, error: error.message };
  await auditWrite(db, teamId, actorMemberId, "access.member_added", groupId, { memberId });
  if (group.is_builtin) {
    const mirror = await mirrorTierToPosture(db, teamId, memberId);
    if (!mirror.ok) return { ok: false, error: `membership written but tier mirror failed: ${mirror.error}` };
  }
  return { ok: true };
}

/** Remove a member from a group (same singleton refusal as add; builtin removals are the
 *  deliberate posture move's other half — humans only, tier mirrored — PRET-4 §1c). */
export async function removeMemberFromGroup(
  db: DbClient,
  teamId: string,
  groupId: string,
  memberId: string,
  actorMemberId: string
): Promise<WriteResult> {
  const group = await getGroup(db, teamId, groupId);
  if (!group) return { ok: false, error: "group not found" };
  if (group.person_member_id) return { ok: false, error: "a singleton group's membership is fixed to its person" };
  if (group.is_builtin) {
    const member = await getMember(db, teamId, memberId);
    // Removal is narrowing: allow it for any HUMAN (including disabled/invited — an admin may
    // clear a stale row; diff-review L6), refuse only non-humans (their posture is set at
    // creation, same as the add gate).
    if (member && member.kind !== "human") {
      return { ok: false, error: "built-in groups admit humans only — non-human posture is set by the invite default at creation" };
    }
  }
  const { error } = await db
    .from("group_members")
    .delete()
    .eq("team_id", teamId)
    .eq("group_id", groupId)
    .eq("member_id", memberId);
  if (error) return { ok: false, error: error.message };
  await auditWrite(db, teamId, actorMemberId, "access.member_removed", groupId, { memberId });
  if (group.is_builtin) {
    const mirror = await mirrorTierToPosture(db, teamId, memberId);
    if (!mirror.ok) return { ok: false, error: `membership removed but tier mirror failed: ${mirror.error}` };
  }
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

/**
 * REVOKE-1: the writer-held admin predicate — the APP's real one (role AND active status AND
 * non-external POSTURE), not role alone: `role='admin', external-posture` is representable and
 * every app gate (`canAccessAdmin`, the admin layout, `requireTeamAdmin`) denies it, so the
 * access writer must too (design round 2 B2). Posture via the ONE resolver (dynamic import —
 * posture.ts imports EVERYONE_SLUG from this file, so a static import would cycle).
 */
async function activeAdminError(db: DbClient, teamId: string, memberId: string): Promise<string | null> {
  const { data } = await db
    .from("members")
    .select("role, status")
    .eq("team_id", teamId)
    .eq("id", memberId)
    .maybeSingle();
  const m = data as { role: string; status: string } | null;
  if (!m) return "principal is not a member of this team";
  if (m.role !== "admin" || m.status !== "active") return "principal must be an ACTIVE ADMIN of this team";
  const { resolveViewerPosture } = await import("@/lib/access/posture");
  if ((await resolveViewerPosture(db, teamId, memberId)) !== "team") {
    return "principal must hold unrestricted (team) posture — an external-posture admin is denied everywhere the app gates admin access";
  }
  return null;
}

export interface GrantResult extends WriteResult {
  /** false = the edge already existed → NOTHING was written (audit-on-change), incl. no
   *  authorizer meta. RACE-BOUNDED like the audit itself (the recorded F3 class): two
   *  concurrent missed-select creators can BOTH report created:true for one edge — an
   *  over-report of the same ms-apart act, never an under-report, and the no-op path never
   *  claims creation. The atomic INSERT…RETURNING form is the F3 transaction surface. */
  created?: boolean;
}

/**
 * AUDITFIX-3 §2b — the grant census that must pass before a `source` row is promoted to `system`.
 *
 * `ensureSystemProject` adopts a reserved-slug `source` row by flipping `kind`, and it never read
 * `project_groups` — so a grant made while the row was still ordinary SURVIVED the flip and became
 * a grant over the whole system corpus, with no operator doing anything wrong (spec §0b). The
 * writer guard now stops such an edge being created; this stops one that predates the guard, or
 * that was written out of band, being LAUNDERED into a system-project grant by adoption.
 *
 * ONE JOINED READ, deliberately. Deciding whether an edge is sanctioned needs the group's `slug`
 * and `is_builtin`, not just its id — and a two-read form can fail closed on `project_groups` and
 * still swallow the GROUP lookup, discard the unresolved edge, and promote (spec round 2 H3). The
 * embed compiles into a correlated subquery inside the same statement, so one error covers both.
 *
 * IT LIVES HERE, not in bootstrap, for the same reason placedMemberIds does: the access-chain
 * single-writer guard's coarse net refuses any other file that NAMES an edge table while containing
 * write verbs (the variable-table idiom defence), and bootstrap writes `projects`. A read in the
 * sanctioned file keeps that net tight instead of spending a READ_EXEMPT entry on it.
 *
 * FAILS CLOSED, and an unresolved group is UNSANCTIONED rather than absent: the obvious
 * implementation destructures `{ data }`, reads an error-derived `null` as "no grants", and flips a
 * row that IS granted to vendors, while every ordinary fixture still passes (spec round 1 B1).
 */
export async function censusUnsanctionedSystemEdges(
  db: DbClient,
  teamId: string,
  projectId: string,
  projectSlug: string
): Promise<WriteResult> {
  const { data, error } = await db
    .from("project_groups")
    .select("group_id, groups(slug, is_builtin)")
    .eq("team_id", teamId)
    .eq("project_id", projectId);
  if (error) {
    return { ok: false, error: `grant census failed, refusing to adopt '${projectSlug}': ${error.message}` };
  }
  const rows = (data ?? []) as { group_id: string; groups: EdgeGroupIdentity | null }[];
  const unsanctioned = rows.filter((r) => !isSanctionedSystemEdge(projectSlug, r.groups));
  if (unsanctioned.length > 0) {
    const named = unsanctioned.map((r) => r.groups?.slug ?? `unresolved group ${r.group_id}`).join(", ");
    return {
      ok: false,
      error:
        `refusing to adopt '${projectSlug}': it already carries unsanctioned grant(s) to ${named}. ` +
        `Promoting it would turn those into grants over the whole system corpus. The team stays ` +
        `un-bootstrapped until the edge is removed (repair: AUDITFIX-21).`,
    };
  }
  return { ok: true };
}

/**
 * AUDITFIX-23 — the TEAM-WIDE system-edge census: every edge on every `kind='system'` project that
 * `grantProjectToGroup` would refuse today.
 *
 * WHY IT EXISTS. AUDITFIX-3 closed the door on NEW forbidden edges; nothing looked for one that
 * already existed, and `revokeProjectFromGroup` refuses every system revocation — so such an edge was
 * invisible AND unrepairable. This makes it visible. It stays unrepairable until AUDITFIX-21.
 *
 * IT LIVES HERE, in the single-writer file, for the same reason `censusUnsanctionedSystemEdges` does:
 * the access-chain guard's coarse net refuses any other file that NAMES an edge table while containing
 * write verbs, and a read in the sanctioned file keeps that net tight.
 *
 * EDGE-DRIVEN, NOT PROJECT-DRIVEN, and that is forced rather than chosen: the reverse direction is
 * to-MANY, which this adapter compiles only as `(count)`. So the census reads the team's whole edge set
 * and embeds BOTH sides — the project to test `kind`/`slug`, the group to test the sanctioned pair —
 * in ONE statement, then filters to system projects client-side (the adapter cannot push a predicate
 * into an embed). Do not "optimise" that into a two-read form: swallowing the projects lookup is the
 * exact fail-open shape the per-project census documents above.
 *
 * ⚠️ THE SANCTIONED SET IS THREE PAIRS, NOT "BUILT-INS ARE FINE". `general -> external` is a built-in
 * target and is FORBIDDEN — it is the edge this whole program began with. An implementation that
 * treats any `is_builtin` group as an approved target passes a suite whose fixtures all use ordinary
 * groups while leaving that one invisible (spec round 3 BLOCKER 2).
 *
 * FAILS CLOSED: a read error is returned as an error, never as "no forbidden edges". An unresolved
 * embed on either side is UNSANCTIONED, never absent.
 */
export interface TeamSystemEdgeCensus extends WriteResult {
  /** Every unsanctioned edge found. Empty on a clean team; meaningless unless `ok`. */
  edges: UnsanctionedEdge[];
}

export async function censusTeamSystemEdges(db: DbClient, teamId: string): Promise<TeamSystemEdgeCensus> {
  const { data, error } = await db
    .from("project_groups")
    .select("project_id, group_id, projects(kind, slug), groups(slug, is_builtin)")
    .eq("team_id", teamId);
  if (error) {
    return { ok: false, error: `system-edge census failed: ${error.message}`, edges: [] };
  }
  const rows = (data ?? []) as {
    project_id: string;
    group_id: string;
    projects: { kind: string; slug: string } | null;
    groups: EdgeGroupIdentity | null;
  }[];
  const edges: UnsanctionedEdge[] = [];
  for (const r of rows) {
    // An UNRESOLVED project embed is a finding, not a clean row. The header promises "an unresolved
    // embed on either side is UNSANCTIONED, never absent", and skipping `{projects: null}` would have
    // quietly broken that half — a row whose project cannot be resolved cannot be shown to be
    // legitimate, which is the whole point of failing closed. Today the composite FKs make it
    // unreachable; the branch is what keeps the contract true if that ever changes (diff review).
    if (!r.projects) {
      edges.push({
        projectId: r.project_id,
        projectSlug: `unresolved project ${r.project_id}`,
        groupId: r.group_id,
        groupSlug: r.groups?.slug ?? `unresolved group ${r.group_id}`,
      });
      continue;
    }
    // Only system projects are this census's subject. A `source` project holding a reserved slug is
    // already covered: AUDITFIX-3's adoption guard refuses to promote it and the team wedges LOUDLY,
    // which AUDITFIX-22's per-team ledger reds. Reporting it here too would double-count one state.
    if (r.projects.kind !== "system") continue;
    if (isSanctionedSystemEdge(r.projects.slug, r.groups)) continue;
    edges.push({
      projectId: r.project_id,
      projectSlug: r.projects.slug,
      groupId: r.group_id,
      groupSlug: r.groups?.slug ?? `unresolved group ${r.group_id}`,
    });
  }
  return { ok: true, edges };
}

/**
 * AUDITFIX-3 §2a — refuse an unsanctioned edge on a project the access substrate owns.
 *
 * Returns a refusal, or `null` to let the grant proceed. THREE THINGS ABOUT THE SIGNATURE ARE THE
 * POINT, each traceable to a spec round that found an implementation passing the whole acceptance
 * suite while `admin.ts grant-project vendors general` still worked:
 *
 *  - it takes NO `actorMemberId` (round 3 B1 — a guard skipped for the operator's NULL actor),
 *  - it takes NO `opts` (round 4 B2 — a guard skipped when `--actor` was absent, which is the
 *    canonical exploit invocation), and
 *  - it never reads `person_member_id` (round 4 B1 — exempting person singletons, the exemption
 *    the repo itself teaches at app/actions/projects.ts:83).
 *
 * The invariant is a function of the PAIR and nothing else, so the bypasses are not expressible
 * here rather than merely untaken.
 *
 * It runs BEFORE the existence probe (round 4 M1): below it, a PRE-EXISTING forbidden edge returns
 * `{ok:true, created:false}` and the CLI prints "already granted … nothing written" — success-shaped
 * output an operator reads as sanction. Refusing first also makes the CLI the one place a forbidden
 * edge is NAMED until AUDITFIX-22's census ships.
 *
 * Both reads fail CLOSED, and their errors are ATTRIBUTED: a swallowed error yields `data = null`,
 * which takes the not-found branch and produces a byte-identical ok:false/no-edge observable — so a
 * criterion that asserted only "refused" would stay green under the mutant (round 4 H1).
 */
async function refuseUnsanctionedSystemEdge(
  db: DbClient,
  teamId: string,
  projectId: string,
  groupId: string
): Promise<GrantResult | null> {
  const { data: projRow, error: projErr } = await db
    .from("projects")
    .select("kind, slug")
    .eq("team_id", teamId)
    .eq("id", projectId)
    .maybeSingle();
  if (projErr) return { ok: false, error: `refusing the grant: project read failed — ${projErr.message}` };
  if (!projRow) return { ok: false, error: "project not found for team" };
  const project = projRow as { kind: string; slug: string };
  if (!isProtectedProject(project)) return null;

  const { data: groupRow, error: groupErr } = await db
    .from("groups")
    .select("slug, is_builtin")
    .eq("team_id", teamId)
    .eq("id", groupId)
    .maybeSingle();
  if (groupErr) return { ok: false, error: `refusing the grant: group read failed — ${groupErr.message}` };
  if (!groupRow) return { ok: false, error: "group not found for team" };
  if (isSanctionedSystemEdge(project.slug, groupRow as EdgeGroupIdentity)) return null;

  const g = groupRow as EdgeGroupIdentity;
  return {
    ok: false,
    error:
      `refusing to grant the system project '${project.slug}' to '${g.slug}' — a system project's grants ARE the ` +
      `access substrate and only the sanctioned edges may exist (general->everyone, external-shared->everyone, ` +
      `external-shared->external). Creating this edge is a one-way door: revocation through the sanctioned path ` +
      `is refused for system projects (AUDITFIX-21 adds the repair).`,
  };
}

/** Grant a group visibility into a project (THE access edge). REVOKE-1 (D1b): `opts.authorizedByMemberId`
 *  records a named ACTIVE-ADMIN authorizer in the audit META only — never in the actor field and never
 *  in `added_by` (either would attribute the operator's act to a human who merely approved it).
 *  `opts.via` is the CALLER's transport claim (Fable diff L2: the writer must not hardcode "cli" —
 *  a future non-CLI operator surface reusing the flag would mint false provenance by construction). */
export async function grantProjectToGroup(
  db: DbClient,
  teamId: string,
  projectId: string,
  groupId: string,
  actorMemberId: string | null,
  opts: { authorizedByMemberId?: string; via?: string } = {}
): Promise<GrantResult> {
  if (opts.authorizedByMemberId) {
    const bad = await activeAdminError(db, teamId, opts.authorizedByMemberId);
    if (bad) return { ok: false, error: `grant authorizer rejected: ${bad}` };
  }
  // Select-first: audit ONLY on creation (the audit-on-change pattern).
  // The bootstrap re-runs this every scheduler tick; an unconditional upsert+audit minted 3
  // audit rows/team/tick forever and re-clobbered added_by — drowning the grant trail the
  // spec's accountability story depends on (slice-3 Fable High).
  // KNOWN BOUNDED RACE (deferred with F3): two concurrent CREATES of the same edge can both
  // miss the select and both audit (double provenance for one ms-apart creation — the trail
  // over-reports, never under-reports). The atomic form (INSERT … ON CONFLICT DO NOTHING
  // RETURNING) needs adapter support; take it with the transaction surface.
  // AUDITFIX-3 §2a: FIRST, before the existence probe below. See refuseUnsanctionedSystemEdge.
  const refusal = await refuseUnsanctionedSystemEdge(db, teamId, projectId, groupId);
  if (refusal) return refusal;
  // AUDITFIX-10 (folded in): this probe SWALLOWED its error, so a read failure fell through to the
  // upsert, re-clobbering added_by and minting an audit row claiming created:true — the exact damage
  // the comment above says select-first prevents.
  const { data: existing, error: probeErr } = await db
    .from("project_groups")
    .select("project_id")
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .eq("group_id", groupId)
    .maybeSingle();
  if (probeErr) return { ok: false, error: `refusing the grant: existing-edge probe failed — ${probeErr.message}` };
  if (existing) return { ok: true, created: false };
  const { error } = await db
    .from("project_groups")
    .upsert({ team_id: teamId, project_id: projectId, group_id: groupId, added_by: actorMemberId }, { onConflict: "project_id,group_id" });
  if (error) return { ok: false, error: error.message };
  await auditWrite(db, teamId, actorMemberId, "access.project_granted", projectId, {
    groupId,
    ...(opts.authorizedByMemberId
      ? { authorizedByMemberId: opts.authorizedByMemberId, ...(opts.via ? { via: opts.via } : {}) }
      : {}),
  });
  return { ok: true, created: true };
}

/**
 * REVOKE-1 (D1): the revoke principal, discriminated so the audit can only ever tell the
 * truth — `member` is the member's OWN act (a future UI action; audits as that member);
 * `operator` is a CLI/operator act on a named active admin's authority (audits as `system`
 * with `meta.authorizedByMemberId` — the round-1 blocker was the draft writing the authorizer
 * into the actor field, recording an admin as having performed a destructive act the operator
 * ran).
 */
export type RevokeActor =
  | { kind: "member"; memberId: string }
  | { kind: "operator"; authorizedByMemberId: string; via: string };

export interface RevokeResult extends WriteResult {
  /** true = an edge was deleted (and audited); false = there was nothing to revoke (no audit). */
  revoked?: boolean;
}

/**
 * AUDITFIX-21 — the ONLY sanctioned way to delete a forbidden edge on a protected project.
 *
 * WHY A SECOND WRITER RATHER THAN RELAXING THE FIRST. The first design reversed
 * `revokeProjectFromGroup`'s absolute refusal so it could distinguish sanctioned from unsanctioned.
 * A spec review killed it: gate on `kind === 'system'` alone and the `source -> system` CAS flip
 * (lib/access/bootstrap.ts) can land between classifying an edge as revocable and deleting it, so the
 * row removed is the now-sanctioned `general -> everyone`. That is a substrate outage for every member
 * of the team. This writer instead does one narrow thing, and the general writer keeps its absolute
 * refusal — which also means both of that writer's shipped tests still pass untouched.
 *
 * ORDER, and every step is a refusal that leaves the edge intact:
 *   1. AUTHORITY. Nothing about the edge is read first, so an unauthorized caller learns nothing it
 *      could not already learn. The guarantee is the plain one: NO DELETE BEFORE AUTHORIZATION.
 *   2. IDENTITY, fail closed, with ATTRIBUTED errors — a swallowed read error yields `null`, takes the
 *      not-found branch, and produces an observable identical to a real refusal, so the two must be
 *      distinguishable or the fail-closed mutation cannot be caught.
 *   3. CLASSIFY: `isProtectedProject && !isSanctionedSystemEdge`. Both halves matter. Without the
 *      protection gate, an ordinary `kind='initiative'` project named "General" becomes unrevokable,
 *      breaking the creator grant AUDITFIX-3 kept deliberately legal. Without the pair test, this
 *      writer would delete the substrate.
 *   4. DELETE with RETURNING, and 5. AUDIT ONLY A ROW THAT CAME BACK — D3: a revoke that revoked
 *      nothing writes no trail. (The general writer still deletes blind and audits unconditionally,
 *      which can record a revocation that never happened under a concurrent delete. That is a real
 *      defect on a function this slice does not touch: AUDITFIX-26.)
 *
 * THIS IS A SNAPSHOT CONTRACT, NOT AN ATOMIC ONE. Steps 2-3 are reads and step 4 deletes by id, so
 * identity could in principle change in between. It is safe because classification is FLIP-INVARIANT:
 * `isProtectedProject` is true on both sides of the only live transition (`source -> system`) for a
 * reserved slug, and sanctioned-ness is a function of SLUGS the flip never touches. That rests on two
 * invariants nothing enforces — no code path updates `projects.slug`, and `is_builtin` never flips
 * false -> true (`ensureBuiltins` is insert-if-absent and refuses an existing non-builtin reserved
 * slug). A project-rename feature, or an `ensureBuiltins` that adopts squatters, reopens this window.
 */
export async function revokeUnsanctionedSystemEdge(
  db: DbClient,
  teamId: string,
  edge: { projectId: string; groupId: string },
  actor: RevokeActor
): Promise<RevokeResult> {
  // (1) Authority FIRST — before anything about the edge is read.
  const principalId = actor.kind === "member" ? actor.memberId : actor.authorizedByMemberId;
  const bad = await activeAdminError(db, teamId, principalId);
  if (bad) return { ok: false, error: `repair principal rejected: ${bad}` };

  // (2) Identity, fail closed, ATTRIBUTED.
  const { data: projRow, error: projErr } = await db
    .from("projects")
    .select("kind, slug")
    .eq("team_id", teamId)
    .eq("id", edge.projectId)
    .maybeSingle();
  if (projErr) return { ok: false, error: `refusing the repair: project read failed — ${projErr.message}` };
  if (!projRow) return { ok: false, error: "project not found for team" };
  const project = projRow as ProjectIdentity;

  const { data: groupRow, error: groupErr } = await db
    .from("groups")
    .select("slug, is_builtin")
    .eq("team_id", teamId)
    .eq("id", edge.groupId)
    .maybeSingle();
  if (groupErr) return { ok: false, error: `refusing the repair: group read failed — ${groupErr.message}` };
  if (!groupRow) return { ok: false, error: "group not found for team" };
  const group = groupRow as EdgeGroupIdentity;

  // (3) Classify. Two distinct refusals, deliberately distinguishable: a mutation that drops the
  // protection gate refuses this pair too, via the other branch, so identical wording would make the
  // two implementations observationally the same.
  if (!isProtectedProject(project)) {
    return {
      ok: false,
      error: `'${project.slug}' is not a protected project — this repair is only for a forbidden edge on the access substrate; use revoke-project`,
    };
  }
  if (isSanctionedSystemEdge(project.slug, group)) {
    return {
      ok: false,
      error: `refusing to remove '${project.slug}' -> '${group.slug}': it is one of the substrate's SANCTIONED edges, not a forbidden one`,
    };
  }

  // (4) Delete with RETURNING — the row is the evidence that anything happened.
  const { data: removed, error: delErr } = await db
    .from("project_groups")
    .delete()
    .eq("team_id", teamId)
    .eq("project_id", edge.projectId)
    .eq("group_id", edge.groupId)
    .select("project_id");
  if (delErr) return { ok: false, error: delErr.message };
  const deleted = ((removed ?? []) as unknown[]).length > 0;
  if (!deleted) return { ok: true, revoked: false };

  // (5) Audit only a real deletion (D3), with the same actor discipline as the general writer.
  if (actor.kind === "member") {
    await auditWrite(db, teamId, actor.memberId, "access.project_revoked", edge.projectId, {
      groupId: edge.groupId,
      repair: "unsanctioned_system_edge",
    });
  } else {
    await auditWrite(db, teamId, null, "access.project_revoked", edge.projectId, {
      groupId: edge.groupId,
      authorizedByMemberId: actor.authorizedByMemberId,
      via: actor.via,
      repair: "unsanctioned_system_edge",
    });
  }
  return { ok: true, revoked: true };
}

/**
 * Revoke a group's visibility into a project — the destructive half of THE access edge, so the
 * invariants live HERE, not in any caller (design round 1 H1/H2):
 *
 * CHECK ORDER IS CONTRACT (D2c — an unordered writer turns invalid principals into an
 * edge-existence oracle): (1) project resolution + the `kind='system'` refusal (severing
 * general/external-shared from the builtins is a substrate outage; bootstrap only ever
 * re-grants), (2) principal validation (the app's admin predicate — role AND status AND
 * posture), (3) the existence probe — so `{ revoked: false }` is reachable ONLY by an
 * authorized principal against a non-system project, (4) delete + audit.
 *
 * D3: no-op revokes do NOT audit (a trail recording revocations that revoked nothing
 * over-reports). The audit insert itself is best-effort by the repo-wide contract
 * (lib/api/audit — an audit outage must not break the act; stated in the spec as the same
 * act-over-trail direction every audited write here takes). Bounded probe/act race as on the
 * grant side: two concurrent revokes can both probe-hit and both audit the same ms-apart act
 * (over-report, never under-report; the F3 transaction surface owns the atomic form).
 */
export async function revokeProjectFromGroup(
  db: DbClient,
  teamId: string,
  projectId: string,
  groupId: string,
  actor: RevokeActor
): Promise<RevokeResult> {
  // (1) The substrate's wiring is unrevokable through this writer.
  //
  // ⚠️ AUDITFIX-21 WIDENED this refusal, and it was a LIVE hole. It read `kind` only and refused only
  // `kind === 'system'` — but `isProtectedProject` covers a `kind='source'` project holding a reserved
  // slug too. So `general@source -> everyone`, a SANCTIONED edge on a PROTECTED project, was NOT
  // refused here, and the CLI verb's preflight used the same kind-only test, so an authorized admin
  // could delete the substrate edge with no race required. Bootstrap re-grants it on the next tick,
  // so the outage was bounded — but every member of that team lost General visibility until then, and
  // a team whose bootstrap is wedged never got it back. The asymmetry came from AUDITFIX-3 giving the
  // GRANT side `isProtectedProject` and leaving this side on the older test.
  //
  // This refuses MORE than it did, never less, which is why both shipped revoke tests still pass: they
  // assert a `kind='system'` project is refused, and it still is.
  const { data: proj } = await db
    .from("projects")
    .select("kind, slug")
    .eq("team_id", teamId)
    .eq("id", projectId)
    .maybeSingle();
  if (!proj) return { ok: false, error: "project not found for team" };
  if (isProtectedProject(proj as ProjectIdentity)) {
    return { ok: false, error: "refusing to revoke a substrate grant — the general/external-shared wiring is the access substrate. An UNSANCTIONED edge on such a project is repairable with `repair-system-edge` (AUDITFIX-21); everything else here is deliberate raw-SQL territory" };
  }

  // (2) The principal — whichever kind — must pass the app's admin predicate.
  const principalId = actor.kind === "member" ? actor.memberId : actor.authorizedByMemberId;
  const bad = await activeAdminError(db, teamId, principalId);
  if (bad) return { ok: false, error: `revoke principal rejected: ${bad}` };

  // (3) Probe — only an authorized principal learns whether there was anything to revoke.
  const { data: existing, error: probeErr } = await db
    .from("project_groups")
    .select("project_id")
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .eq("group_id", groupId)
    .maybeSingle();
  if (probeErr) return { ok: false, error: probeErr.message };
  if (!existing) return { ok: true, revoked: false };

  // (4) Delete + audit (audit only a real deletion — D3).
  const { error } = await db
    .from("project_groups")
    .delete()
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .eq("group_id", groupId);
  if (error) return { ok: false, error: error.message };
  if (actor.kind === "member") {
    await auditWrite(db, teamId, actor.memberId, "access.project_revoked", projectId, { groupId });
  } else {
    // `via` comes from the ACTOR — the caller declares its own transport (Fable diff L2:
    // hardcoding "cli" here would mint false provenance for any future operator surface).
    await auditWrite(db, teamId, null, "access.project_revoked", projectId, {
      groupId,
      authorizedByMemberId: actor.authorizedByMemberId,
      via: actor.via,
    });
  }
  return { ok: true, revoked: true };
}

/**
 * READ helper for PRET-2's cheap warning scan (lib/admin/access-enforcement): which of these
 * members hold at least one group membership. Lives HERE because the access-chain single-writer
 * guard rightly refuses any other file that names the edge tables while containing write verbs
 * (the variable-table idiom defense) — a read in the sanctioned file keeps the coarse net tight.
 */
/**
 * READ helper for PRET-4's re-expressed readiness floor (lib/admin/access-enforcement): each
 * builtin's member-id set, one bulk read. Lives here for the same single-writer-guard reason
 * as placedMemberIds.
 */
export async function builtinMembershipBySlug(
  db: DbClient,
  teamId: string
): Promise<{ everyone: Set<string>; external: Set<string> }> {
  const { data, error } = await db
    .from("group_members")
    .select("member_id, groups(slug, is_builtin)")
    .eq("team_id", teamId);
  if (error) throw new Error(`group_members read failed: ${error.message}`);
  const rows = (data ?? []) as { member_id: string; groups: { slug: string; is_builtin: boolean } | null }[];
  return {
    everyone: new Set(rows.filter((r) => r.groups?.is_builtin && r.groups.slug === EVERYONE_SLUG).map((r) => r.member_id)),
    external: new Set(rows.filter((r) => r.groups?.is_builtin && r.groups.slug === EXTERNAL_SLUG).map((r) => r.member_id)),
  };
}

export async function placedMemberIds(
  db: DbClient,
  teamId: string,
  memberIds: readonly string[]
): Promise<Set<string>> {
  if (memberIds.length === 0) return new Set();
  const { data, error } = await db
    .from("group_members")
    .select("member_id, groups(is_builtin)")
    .eq("team_id", teamId)
    .in("member_id", [...memberIds]);
  if (error) throw new Error(`group_members read failed: ${error.message}`);
  // Builtin rows do NOT count as placement (PRET-4 cold-read M4): the callers ask "would the
  // oracle grant this non-human anything?", and materialized builtin rows are posture-only —
  // grant-inert. Counting them silences the cheap agent warning while the full assessment
  // still refuses, burning a full drain per tick forever on a never-flippable team.
  const rows = (data ?? []) as { member_id: string; groups: { is_builtin: boolean } | null }[];
  return new Set(rows.filter((r) => r.groups?.is_builtin !== true).map((r) => r.member_id));
}
