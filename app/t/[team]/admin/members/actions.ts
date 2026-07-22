"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { reconcileAttribution, bustTeamLearningCaches } from "@/lib/ingest/reconcile-attribution";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import { linkGithub } from "@/lib/codebases/github";
import { setMemberIdentity, removeMemberIdentity } from "@/lib/identity/member-identities";
import { addAuthorAlias, removeAuthorAlias } from "@/lib/admin/aliases";
import { reattributeItems } from "@/lib/ingest/reattribute";
import { adminSetPassword } from "@/lib/auth/pg-login";
import { isPasswordStrongEnough, randomPassword, MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { audit } from "@/lib/api/audit";
import { updateMemberRole, deleteMember, updateMemberManager, type UpdateManagerResult } from "@/lib/admin/members";
import { syncMemberActor } from "@/lib/graph/company-actors";
import { runProvisioning } from "@/lib/provisioning/run";
import type { ProvisioningResult, ProvisioningTool } from "@/lib/provisioning/types";

// Providers whose identity is a stable user id in member_identities (GitHub uses its own login flow).
const PROVIDERS = new Set(["slack", "linear", "plane"]);

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
 * Map a roster member to a provider user id (admins only) — the manual path / correction when
 * auto-reconciliation missed or mismapped (e.g. a person uses a different email on that platform).
 * Writes a `member_identities` row so future ingestion attributes that provider's content to this
 * member. Admin-set → forces over any prior mapping. Provider ∈ {slack, linear, plane} (GitHub has
 * its own login flow via `linkMemberGithub`).
 */
export async function linkMemberIdentity(
  teamSlug: string,
  memberId: string,
  provider: string,
  externalId: string,
  handle?: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const p = provider.trim().toLowerCase();
  if (!PROVIDERS.has(p)) return { ok: false, error: `unsupported provider "${provider}"` };
  const ext = externalId.trim();
  if (!ext) return { ok: false, error: `${p} user id is required` };
  try {
    await setMemberIdentity(
      adminClient(),
      ctx.teamId,
      memberId,
      { provider: p, externalId: ext, handle: (handle ?? "").trim() },
      { force: true, actor: { kind: "member", memberId: ctx.memberId } }
    );
    revalidatePath(`/t/${teamSlug}/admin/members`);
    after(() => reconcileAttribution(adminClient(), ctx.teamId, teamSlug));
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
  externalId: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await removeMemberIdentity(
      adminClient(),
      ctx.teamId,
      { provider: provider.trim().toLowerCase(), externalId: externalId.trim() },
      { actor: { kind: "member", memberId: ctx.memberId } }
    );
    revalidatePath(`/t/${teamSlug}/admin/members`);
    // Unlink is conservative — reattribute never un-attributes, so this only re-points items that now
    // resolve to a DIFFERENT member (it won't clear attribution). Refreshes arcs either way.
    after(() => reconcileAttribution(adminClient(), ctx.teamId, teamSlug));
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
    const s = await reattributeItems(adminClient(), ctx.teamId);
    await bustTeamLearningCaches(adminClient(), ctx.teamId, teamSlug);
    revalidatePath(`/t/${teamSlug}/admin/members`);
    return {
      ok: true,
      message: `Re-attributed ${s.updated} of ${s.scanned} item(s)${s.versionsUpdated ? ` + ${s.versionsUpdated} version(s)` : ""} to current identity mappings.`,
    };
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
