import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { isBuiltinEligible, isPrincipal } from "@/lib/access/eligibility";

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

export const EVERYONE_SLUG = "everyone";
/** The one-time materialization's migration_markers name — single-sourced here (the writer);
 *  lib/access/posture re-exports it for the reader side (diff-review L3). */
export const PRET4_MATERIALIZE_MARKER = "pret4_builtin_materialize";
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
  const { data: existing } = await db
    .from("project_groups")
    .select("project_id")
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .eq("group_id", groupId)
    .maybeSingle();
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
  // (1) The system wiring is unrevokable through this writer.
  const { data: proj } = await db
    .from("projects")
    .select("kind")
    .eq("team_id", teamId)
    .eq("id", projectId)
    .maybeSingle();
  if (!proj) return { ok: false, error: "project not found for team" };
  if ((proj as { kind: string }).kind === "system") {
    return { ok: false, error: "refusing to revoke a system project's grant — the general/external-shared wiring is the access substrate (raw SQL is the deliberate barrier)" };
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
