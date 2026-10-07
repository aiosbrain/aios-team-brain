"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { reconcileAttribution, repairAttributionNow } from "@/lib/ingest/reconcile-attribution";
import { describeManualRepair, reportRepairHandover } from "@/lib/ingest/attribution-repair-report";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import { linkGithub } from "@/lib/codebases/github";
import { setMemberIdentity, removeMemberIdentity } from "@/lib/identity/member-identities";
import { withIdentityMutationBoundary } from "@/lib/identity/authority";
import { addAuthorAlias, removeAuthorAlias } from "@/lib/admin/aliases";
import { adminSetPassword } from "@/lib/auth/pg-login";
import { isPasswordStrongEnough, randomPassword, MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { audit } from "@/lib/api/audit";
import { updateMemberRole, deleteMember, updateMemberManager, type UpdateManagerResult } from "@/lib/admin/members";
import { syncMemberActor } from "@/lib/graph/company-actors";
import { runProvisioning } from "@/lib/provisioning/run";
import type { ProvisioningResult, ProvisioningTool } from "@/lib/provisioning/types";

// Providers whose identity is a stable user id in member_identities (GitHub uses its own login flow).
const PROVIDERS = new Set(["slack", "linear", "plane", "gdrive"]);

function scheduleIdentityEffects(db: ReturnType<typeof adminClient>, teamId: string, teamSlug: string, provider: string) {
  if (provider === "gdrive") {
    after(async () => {
      const { drainIdentityRepairs } = await import("@/lib/ingest/identity-repair");
      await drainIdentityRepairs(db, { maxObligations: 4 });
      // The provider obligation repairs retained Drive evidence; the team-wide obligation is the
      // common authority for items, versions, code contributions, and cache publication. A Drive
      // mapping is not healthy-complete until both converge at the same current revision.
      //
      // This only accelerates. The mapping change already made both repairs durable; a budget that
      // ends `continuing` (or a turn another owner holds) is carried on by the repair scheduler —
      // where one runs. The log line says which: on a copied-staging runtime nothing continues in
      // the background, and an admin has to run the manual repair.
      const outcome = await repairAttributionNow(db, teamId, teamSlug, { maxBatches: 20 });
      reportRepairHandover(teamId, outcome);
    });
    return;
  }
  after(() => reconcileAttribution(db, teamId, teamSlug));
}

/**
 * Link a roster member to a GitHub login (admins only). Reuses `linkGithub`, which writes
 * `members.github_login` + `avatar_url` and backfills the member's git-author aliases (incl. the
 * privacy-preserving noreply forms) so their existing contributions attribute correctly. The
 * GitHub token comes from the server's GITHUB_TOKEN env — never the client, never logged.
 */
export async function linkMemberGithub(
  teamSlug: string,
  memberId: string,
  login: string
): Promise<{ ok: boolean; error?: string; login?: string; backfilled?: number }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const handle = login.trim().replace(/^@/, "");
  if (!handle) return { ok: false, error: "github login is required" };
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { ok: false, error: "GITHUB_TOKEN is not configured on the server" };
  try {
    const res = await linkGithub(adminClient(), ctx.teamId, memberId, token, handle, {
      actor: { kind: "member", memberId: ctx.memberId },
    });
    revalidatePath(`/t/${teamSlug}/admin/members`);
    // Percolate: re-attribute already-ingested items to this new mapping + refresh arcs, in the
    // background (snappy action). Idempotent + coalesced; manual "Re-attribute content" stays the fallback.
    after(() => reconcileAttribution(adminClient(), ctx.teamId, teamSlug));
    return { ok: true, login: res.login, backfilled: res.backfilled };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not link github" };
  }
}

/**
 * What the Admin control had on screen when the admin acted. It is an OBSERVATION of the identity
 * that row displayed — never of the id being requested, which may be a different one.
 */
interface IdentityLinkObservation {
  /** The identity the row displayed and that id's mapping revision; null for a blank "Link" row. */
  original: { externalId: string; revision: number } | null;
  /** Sent only to confirm a remap this action reported: the revision the admin was shown for the
   * REQUESTED id while it was linked to someone else. */
  remap?: { revision: number };
}

/** The remap this action will not make until the admin has seen it and asked for it. */
interface IdentityRemapOffer {
  externalId: string;
  revision: number;
  linkedTo: string;
}

/** What the fenced decision came to: the write committed, or a refusal / offer that wrote nothing. */
type IdentityLinkDecision = { ok: true } | { ok: false; error: string; remap?: IdentityRemapOffer };

const STALE_IDENTITY = "identity mapping changed concurrently; refresh and retry";

const isRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function isLinkObservation(value: unknown): value is IdentityLinkObservation {
  if (!value || typeof value !== "object") return false;
  const { original, remap } = value as { original?: unknown; remap?: unknown };
  if (original !== null) {
    if (!original || typeof original !== "object") return false;
    const shown = original as { externalId?: unknown; revision?: unknown };
    if (typeof shown.externalId !== "string" || !shown.externalId.trim() || !isRevision(shown.revision)) return false;
  }
  if (remap === undefined) return true;
  return Boolean(remap) && typeof remap === "object" && isRevision((remap as { revision?: unknown }).revision);
}

/**
 * Who holds ONE provider id now, and that id's mapping revision (0 when it has never had one —
 * the same reading the writer makes). `linked` is true when a member holds it or its mapping state
 * says so. Either read failing fails the action: an observation that could not be made is not an
 * observation of "absent".
 *
 * CALLED ONLY INSIDE `withIdentityMutationBoundary`. The holder and the revision live in two
 * tables; read without the team's identity authority, a remap committing between the two reads
 * pairs one member with another's revision. Under the authority no identity writer can commit, so
 * the two reads — made on the boundary's own transaction — are one observation.
 */
async function observeIdentity(
  db: ReturnType<typeof adminClient>,
  teamId: string,
  provider: string,
  externalId: string,
): Promise<{ memberId: string | null; revision: number; linked: boolean }> {
  const link = await db.from("member_identities").select("member_id")
    .eq("team_id", teamId).eq("provider", provider).eq("external_id", externalId).maybeSingle();
  if (link.error) throw new Error(`${provider} identity link read failed: ${link.error.message}`);
  const state = await db.from("member_identity_mapping_state").select("revision,state")
    .eq("team_id", teamId).eq("provider", provider).eq("external_id", externalId).maybeSingle();
  if (state.error) throw new Error(`${provider} identity authority read failed: ${state.error.message}`);
  const stored = state.data as { revision: string | number; state: string } | null;
  const revision = Number(stored?.revision ?? 0);
  if (!isRevision(revision)) throw new Error(`${provider} identity authority read failed: unreadable revision`);
  const memberId = (link.data as { member_id: string } | null)?.member_id ?? null;
  return { memberId, revision, linked: memberId !== null || stored?.state === "linked" };
}

/**
 * Map a roster member to a provider user id (admins only) — the manual path / correction when
 * auto-reconciliation missed or mismapped (e.g. a person uses a different email on that platform).
 * Writes a `member_identities` row so future ingestion attributes that provider's content to this
 * member. Provider ∈ {slack, linear, plane, gdrive} (GitHub has its own login flow via
 * `linkMemberGithub`).
 *
 * `observed` is what the Admin row displayed, and it is kept apart from the id being requested.
 * The writer's `expectedRevision` is a compare-and-set on the REQUESTED id, so it is only ever
 * given a revision observed for that id:
 *   - the requested id IS the displayed one → the displayed revision;
 *   - a different id (a change, or a blank row) → that id's own state, read here: never linked
 *     (0), an unlinked tombstone (its revision, so a deliberate re-link is possible), or already
 *     this member's;
 *   - a different id that ANOTHER member holds → nothing is written. The holder and the revision
 *     are returned as a remap offer; the admin's confirmation sends that revision back, and only
 *     then is the mapping forced. A remap is never the side effect of a link.
 * The displayed identity, when the request is for a different id, must itself still be what the
 * admin saw — still this member's, at the displayed revision — or the action refuses as stale.
 *
 * ONE BOUNDARY. The whole fenced decision — validating the displayed identity, observing the
 * requested one, refusing / offering / writing — runs inside the team's identity mutation boundary,
 * the same one the writer takes (it joins this transaction; no row is locked before the team
 * authority). So the holder and revision of the requested id are one observation, and the displayed
 * identity cannot be unlinked or remapped between its validation and the requested id's write. An
 * offer returns and RELEASES the boundary: nothing is held while the admin decides, and the
 * confirmation enters a fresh boundary, validates the displayed identity again and hands the writer
 * the revision the admin was shown — never one re-read for them. Two fenced calls for one team are
 * therefore serial: the second observes what the first committed. An error leaves the boundary
 * uncaught, so nothing partial commits; revalidation and repair acceleration follow the commit.
 *
 * GOOGLE ADD PROTECTION. A blank "Add Google account" row that names an id already linked — to
 * anyone — is refused outright: no remap is offered and none can be confirmed from it. Remapping a
 * Google identity is a Change, made from a row that displays one of the member's own identities;
 * re-linking an unlinked tombstone from the blank row stays possible.
 *
 * Without `observed` (a programmatic caller, `linkMemberSlack`) this is the unfenced admin write
 * it has always been: it forces over any prior mapping.
 */
export async function linkMemberIdentity(
  teamSlug: string,
  memberId: string,
  provider: string,
  externalId: string,
  handle?: string,
  observed?: IdentityLinkObservation,
): Promise<{ ok: boolean; error?: string; remap?: IdentityRemapOffer }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const p = provider.trim().toLowerCase();
  if (!PROVIDERS.has(p)) return { ok: false, error: `unsupported provider "${provider}"` };
  const ext = externalId.trim();
  if (!ext) return { ok: false, error: `${p} user id is required` };
  // A fenced call whose observation cannot be read is refused, never downgraded to an unfenced one.
  if (observed !== undefined && !isLinkObservation(observed)) return { ok: false, error: STALE_IDENTITY };
  try {
    const identityDb = adminClient();
    const identity = { provider: p, externalId: ext, handle: (handle ?? "").trim() };
    const actor = { kind: "member" as const, memberId: ctx.memberId };
    let decision: IdentityLinkDecision;
    if (!observed) {
      await setMemberIdentity(identityDb, ctx.teamId, memberId, identity, { force: true, actor });
      decision = { ok: true };
    } else {
      const { original: displayed, remap: confirmed } = observed;
      // Nothing in here is caught: a failed read or a refused write must leave the boundary as an
      // error, so its transaction rolls back rather than committing whatever came before it.
      decision = await withIdentityMutationBoundary(ctx.teamId, async (): Promise<IdentityLinkDecision> => {
        let force = false;
        let expectedRevision: number;
        const shown = displayed ? { externalId: displayed.externalId.trim(), revision: displayed.revision } : null;
        if (shown && shown.externalId === ext) {
          // The requested id is the one on screen: its displayed revision is the observation.
          if (confirmed) return { ok: false, error: STALE_IDENTITY };
          expectedRevision = shown.revision;
        } else {
          if (shown) {
            const original = await observeIdentity(identityDb, ctx.teamId, p, shown.externalId);
            if (original.memberId !== memberId || original.revision !== shown.revision) {
              return { ok: false, error: STALE_IDENTITY };
            }
          }
          const target = await observeIdentity(identityDb, ctx.teamId, p, ext);
          // A blank "Add Google account" row starts from nothing observed. It may claim a new id or
          // re-link a tombstone, but it never turns into a remap — offered or confirmed.
          if (p === "gdrive" && !shown && target.linked) {
            return { ok: false, error: "this Google identity is already linked; refresh and use Change" };
          }
          if (target.memberId && target.memberId !== memberId) {
            if (!confirmed) {
              const { data: holder, error } = await identityDb.from("members").select("display_name")
                .eq("team_id", ctx.teamId).eq("id", target.memberId).maybeSingle();
              if (error) throw new Error(`${p} identity holder read failed: ${error.message}`);
              const linkedTo = (holder as { display_name: string | null } | null)?.display_name || "another member";
              return {
                ok: false,
                error: `this ${p} identity is linked to ${linkedTo}; confirm to remap it`,
                remap: { externalId: ext, revision: target.revision, linkedTo },
              };
            }
            // The revision the admin was SHOWN, never the one just read: an id that moved after
            // the offer is refused by the writer's compare-and-set, not quietly re-observed.
            expectedRevision = confirmed.revision;
            force = true;
          } else {
            // Confirming a remap of an id nobody else holds any more is acting on a stale offer.
            if (confirmed) return { ok: false, error: STALE_IDENTITY };
            expectedRevision = target.revision;
          }
        }
        // The writer enters the same boundary and joins this transaction: the displayed identity
        // validated above is still what it was when the requested id is written.
        const res = await setMemberIdentity(identityDb, ctx.teamId, memberId, identity, { force, expectedRevision, actor });
        // Unforced, the writer reports — and does not write — an id another member holds.
        return res.conflict ? { ok: false, error: STALE_IDENTITY } : { ok: true };
      });
    }
    // Only a committed mapping is revalidated or repaired; a refusal or an offer wrote nothing.
    if (!decision.ok) return decision;
    revalidatePath(`/t/${teamSlug}/admin/members`);
    scheduleIdentityEffects(adminClient(), ctx.teamId, teamSlug, p);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not link identity" };
  }
}

/** Back-compat wrapper for the Slack-specific call site. */
export async function linkMemberSlack(
  teamSlug: string,
  memberId: string,
  slackUserId: string,
  handle?: string
): Promise<{ ok: boolean; error?: string }> {
  return linkMemberIdentity(teamSlug, memberId, "slack", slackUserId, handle);
}

/** Remove a provider identity mapping (admins clearing/correcting a link). */
export async function unlinkMemberIdentity(
  teamSlug: string,
  provider: string,
  externalId: string,
  expectedRevision?: number,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await removeMemberIdentity(
      adminClient(),
      ctx.teamId,
      { provider: provider.trim().toLowerCase(), externalId: externalId.trim() },
      { expectedRevision, actor: { kind: "member", memberId: ctx.memberId } }
    );
    revalidatePath(`/t/${teamSlug}/admin/members`);
    scheduleIdentityEffects(adminClient(), ctx.teamId, teamSlug, provider.trim().toLowerCase());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not unlink identity" };
  }
}

/**
 * Add an email alias to a member (admins only) — the fix for "different email on a platform": once
 * the alternate email is an alias, every connector keying on it reconciles to this person. Reuses
 * `addAuthorAlias`, which also back-fills existing git contributions. `force` re-points an alias
 * currently on another member.
 */
export async function addMemberEmail(
  teamSlug: string,
  memberId: string,
  email: string,
  force?: boolean
): Promise<{ ok: boolean; error?: string; note?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const e = email.trim();
  if (!e || !e.includes("@")) return { ok: false, error: "a valid email is required" };
  try {
    const res = await addAuthorAlias(adminClient(), ctx.teamId, memberId, e, {
      force,
      actor: { kind: "member", memberId: ctx.memberId },
    });
    revalidatePath(`/t/${teamSlug}/admin/members`);
    if (res.collisions && !force) return { ok: false, error: res.note };
    after(() => reconcileAttribution(adminClient(), ctx.teamId, teamSlug));
    return { ok: true, note: res.note };
  } catch (e2) {
    return { ok: false, error: e2 instanceof Error ? e2.message : "could not add email" };
  }
}

/**
 * Re-attribute existing content to the CURRENT identity mappings (admins only). Run this after
 * linking/correcting identities so already-ingested items (which were attributed at ingest time)
 * pick up the new mapping. Conservative — never un-attributes. See `lib/ingest/reattribute`.
 */
export async function reattributeIdentitiesNow(
  teamSlug: string
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    // Inline (returns a summary the button shows). Bust arcs too so this recovery path ALSO clears the
    // 10-min arc lag — matching the auto-reconcile hooks (the correction lock protects it from the same
    // TOCTOU race a concurrent auto-reconcile might hit).
    // `request`: this button asks for the repair. It is not following a mutation that enqueued one,
    // so a revision already marked complete is durably reopened and scanned again from the start.
    const s = await repairAttributionNow(adminClient(), ctx.teamId, teamSlug, { maxBatches: 100, request: true });
    revalidatePath(`/t/${teamSlug}/admin/members`);
    // A spent budget or a turn another worker holds is not an error: the repair is durable and
    // resumes from where this left it. The message says so rather than reporting a completion or a
    // failure — and says truthfully what resumes it: the background scheduler, or, where every
    // in-process scheduler is suppressed (a copied-staging runtime), an admin running this again.
    return { ok: true, message: describeManualRepair(s) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "re-attribution failed" };
  }
}

/**
 * Reset a member's sign-in password (admins only) — audit M1/M2b. Sets a NEW password directly (no
 * current-password check, unlike self-service change), scoped to a member of THIS team so an admin
 * can't reach across teams via a raw memberId. Returns the plaintext password ONCE (shown-once UI,
 * same pattern as API key issuance) for the admin to hand to the person out-of-band — never emailed,
 * never logged.
 */
export async function resetMemberPassword(
  teamSlug: string,
  memberId: string,
  password?: string
): Promise<{ ok: boolean; password?: string; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };

  const newPassword = password?.trim() || randomPassword();
  if (!isPasswordStrongEnough(newPassword)) {
    return { ok: false, error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }

  const db = adminClient();
  const { data: member } = await db
    .from("members")
    .select("id, email")
    .eq("id", memberId)
    .eq("team_id", ctx.teamId)
    .maybeSingle();
  if (!member) return { ok: false, error: "member not found on this team" };

  await adminSetPassword((member as { email: string }).email, newPassword);
  await audit(db, {
    team_id: ctx.teamId,
    actor_kind: "member",
    member_id: ctx.memberId,
    action: "member.password_reset",
    target_type: "member",
    target_id: memberId,
    meta: {},
  });
  revalidatePath(`/t/${teamSlug}/admin/members`);
  return { ok: true, password: newPassword };
}

/**
 * Change an existing member's role (admins only). Refuses to demote the LAST active/invited
 * admin, so a team can't lock itself out of its own admin panel — surfaced to the caller as an
 * error rather than a silent no-op.
 */
export async function setMemberRole(
  teamSlug: string,
  memberId: string,
  role: "admin" | "lead" | "member"
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const db = adminClient();
  try {
    const res = await updateMemberRole(db, ctx.teamId, memberId, role, {
      actor: { kind: "member", memberId: ctx.memberId },
    });
    if (!res.updated && res.reason === "last-admin") {
      return { ok: false, error: "can't demote the last admin — promote someone else first" };
    }
    if (!res.updated && res.reason === "absent") {
      return { ok: false, error: "member not found" };
    }
    if (res.updated) {
      try {
        await syncMemberActor(db, ctx.teamId, memberId);
      } catch (e) {
        console.error("[company-graph] actor sync failed on role change:", e instanceof Error ? e.message : e);
      }
    }
    revalidatePath(`/t/${teamSlug}/admin/members`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not change role" };
  }
}

const MANAGER_ERROR: Record<NonNullable<UpdateManagerResult["reason"]>, string> = {
  absent: "member not found",
  self: "a member can't manage themselves",
  "manager-not-found": "manager not found on this team",
  "manager-disabled": "can't assign a disabled member as manager",
  "manager-is-connector": "can't assign a connector as manager",
};

/**
 * Set (or clear) an existing member's manager (admins only) — the org-chart source synced into
 * the company graph (`syncMemberActor` re-reads the row and calls `syncReportsTo`, which writes
 * both the REPORTS_TO relationship edge `retrieve.ts`'s prompt reads and `attrs.reports_to` on the
 * entity `GET /api/v1/company-graph` reads). Validation itself lives in `updateMemberManager`
 * (self/cross-team/disabled/connector rejection) — this is a thin session-gated wrapper.
 */
export async function setMemberManager(
  teamSlug: string,
  memberId: string,
  managerMemberId: string | null
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };

  const db = adminClient();
  const res = await updateMemberManager(db, ctx.teamId, memberId, managerMemberId);
  if (!res.updated) return { ok: false, error: MANAGER_ERROR[res.reason!] };

  try {
    await syncMemberActor(db, ctx.teamId, memberId);
  } catch (e) {
    console.error("[company-graph] reports-to sync failed:", e instanceof Error ? e.message : e);
  }
  revalidatePath(`/t/${teamSlug}/admin/members`);
  return { ok: true };
}

/**
 * Remove a member from the team (admins only). Soft-disables (`status='disabled'`) rather
 * than hard-deleting — reversible, excluded from the active roster and `/api/v1/members`,
 * and consistent with `deleteMember`'s default. A permanent hard delete stays a CLI-only
 * operation (`scripts/admin.ts delete-member <email> --hard`) since it cascades away
 * api_keys/aliases and isn't something a misclick in the dashboard should be able to do.
 * Refuses to remove the LAST active admin, same guard as `setMemberRole`.
 */
export async function removeMember(
  teamSlug: string,
  memberId: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const db = adminClient();
  const { data: member } = await db
    .from("members")
    .select("email")
    .eq("id", memberId)
    .eq("team_id", ctx.teamId)
    .maybeSingle();
  if (!member) return { ok: false, error: "member not found on this team" };
  try {
    const res = await deleteMember(db, ctx.teamId, (member as { email: string }).email, {
      actor: { kind: "member", memberId: ctx.memberId },
    });
    if (!res.deleted && res.reason === "last-admin") {
      return { ok: false, error: "can't remove the last admin — promote someone else first" };
    }
    if (res.deleted) {
      try {
        // Soft-disable (this action's only mode) keeps the actor entity for history — just
        // refreshes attrs.status so it drops out of retrieve.ts/company-graph's live context.
        await syncMemberActor(db, ctx.teamId, memberId);
      } catch (e) {
        console.error("[company-graph] actor sync failed on remove:", e instanceof Error ? e.message : e);
      }
    }
    revalidatePath(`/t/${teamSlug}/admin/members`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not remove member" };
  }
}

/**
 * Re-run the provisioning cascade for ONE tool for a member (admins only) — the retry behind a
 * `failed` badge on the members table. Looks up the member row on THIS team (so a raw memberId can't
 * reach across teams), rebuilds the `ProvisioningMember` shape, and runs the single-writer
 * `runProvisioning` for just that tool. `runProvisioning` never throws; it upserts the member's row
 * for that tool in place, so the badge reflects the fresh outcome after `revalidatePath`.
 */
export async function retryProvisioning(
  teamSlug: string,
  memberId: string,
  tool: ProvisioningTool
): Promise<{ ok: boolean; error?: string; result?: ProvisioningResult }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };

  const db = adminClient();
  const { data: member } = await db
    .from("members")
    .select("id, email, display_name, role, tier")
    .eq("id", memberId)
    .eq("team_id", ctx.teamId)
    .maybeSingle();
  if (!member) return { ok: false, error: "member not found on this team" };

  const m = member as {
    id: string;
    email: string;
    display_name: string;
    role: "admin" | "lead" | "member";
    tier: "team" | "external";
  };
  const [result] = await runProvisioning(
    db,
    ctx.teamId,
    { id: m.id, email: m.email, displayName: m.display_name, role: m.role, tier: m.tier },
    [tool]
  );
  revalidatePath(`/t/${teamSlug}/admin/members`);
  return { ok: true, result };
}

/** Remove an email alias from a member (admins only). */
export async function removeMemberEmail(
  teamSlug: string,
  email: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await removeAuthorAlias(adminClient(), ctx.teamId, email, {
      actor: { kind: "member", memberId: ctx.memberId },
    });
    revalidatePath(`/t/${teamSlug}/admin/members`);
    after(() => reconcileAttribution(adminClient(), ctx.teamId, teamSlug));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not remove email" };
  }
}
