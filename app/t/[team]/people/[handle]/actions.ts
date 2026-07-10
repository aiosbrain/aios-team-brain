"use server";

import { revalidatePath } from "next/cache";
import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { currentMember } from "@/lib/auth/guard";
import { canEditMemberContext } from "@/lib/identity/context";
import {
  setMemberProfile,
  addTimeOff,
  removeTimeOff,
  setMemberGoal,
  removeMemberGoal,
  type ProfileInput,
  type TimeOffInput,
  type GoalInput,
} from "@/lib/identity/profile";
import { issueApiKey, revokeOwnApiKey } from "@/lib/admin/keys";

/**
 * Server actions for the per-member identity context editor. The security boundary is
 * `gate()`: a caller may edit a member's context only if they ARE that member or an admin —
 * so no one can edit a teammate's profile/goals. Writes go through the single writer
 * (lib/identity/profile), which validates + audits; the actor is the signed-in member.
 */

interface Gate {
  teamId: string;
  actorMemberId: string;
}

async function gate(teamSlug: string, targetMemberId: string): Promise<Gate | null> {
  const db = await serverClient();
  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;
  const me = await currentMember((team as { id: string }).id);
  if (!me) return null;
  if (!canEditMemberContext(me, targetMemberId)) return null;
  return { teamId: (team as { id: string }).id, actorMemberId: me.id };
}

type Result = { ok: boolean; error?: string; id?: string };

function fail(e: unknown): Result {
  return { ok: false, error: e instanceof Error ? e.message : "could not save" };
}

export async function saveProfile(
  teamSlug: string,
  memberId: string,
  input: ProfileInput
): Promise<Result> {
  const ctx = await gate(teamSlug, memberId);
  if (!ctx) return { ok: false, error: "not allowed" };
  try {
    await setMemberProfile(adminClient(), ctx.teamId, memberId, input, {
      actor: { kind: "member", memberId: ctx.actorMemberId },
    });
    revalidatePath(`/t/${teamSlug}/people/${memberId}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function addMemberTimeOff(
  teamSlug: string,
  memberId: string,
  input: TimeOffInput
): Promise<Result> {
  const ctx = await gate(teamSlug, memberId);
  if (!ctx) return { ok: false, error: "not allowed" };
  try {
    const id = await addTimeOff(adminClient(), ctx.teamId, memberId, input, {
      actor: { kind: "member", memberId: ctx.actorMemberId },
    });
    revalidatePath(`/t/${teamSlug}/people/${memberId}`);
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteMemberTimeOff(
  teamSlug: string,
  memberId: string,
  id: string
): Promise<Result> {
  const ctx = await gate(teamSlug, memberId);
  if (!ctx) return { ok: false, error: "not allowed" };
  try {
    await removeTimeOff(adminClient(), ctx.teamId, id, {
      actor: { kind: "member", memberId: ctx.actorMemberId },
    });
    revalidatePath(`/t/${teamSlug}/people/${memberId}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function saveMemberGoal(
  teamSlug: string,
  memberId: string,
  input: GoalInput
): Promise<Result> {
  const ctx = await gate(teamSlug, memberId);
  if (!ctx) return { ok: false, error: "not allowed" };
  try {
    const id = await setMemberGoal(adminClient(), ctx.teamId, memberId, input, {
      actor: { kind: "member", memberId: ctx.actorMemberId },
    });
    revalidatePath(`/t/${teamSlug}/people/${memberId}`);
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteMemberGoal(
  teamSlug: string,
  memberId: string,
  id: string
): Promise<Result> {
  const ctx = await gate(teamSlug, memberId);
  if (!ctx) return { ok: false, error: "not allowed" };
  try {
    await removeMemberGoal(adminClient(), ctx.teamId, id, {
      actor: { kind: "member", memberId: ctx.actorMemberId },
    });
    revalidatePath(`/t/${teamSlug}/people/${memberId}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Self-only gate for API keys — deliberately stricter than `gate()`: a member may issue or
 * revoke ONLY their own key here, never a teammate's, even as an admin. An admin generating a
 * secret on someone else's behalf has no safe way to hand it over (that's the whole gap this
 * closes); admins keep member-picker issuance for exceptional cases via /admin/keys.
 */
async function selfGate(teamSlug: string): Promise<Gate | null> {
  const db = await serverClient();
  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;
  const me = await currentMember((team as { id: string }).id);
  if (!me) return null;
  return { teamId: (team as { id: string }).id, actorMemberId: me.id };
}

type KeyResult = { ok: boolean; error?: string; key?: string };

export async function issueMyApiKey(teamSlug: string, name: string): Promise<KeyResult> {
  const ctx = await selfGate(teamSlug);
  if (!ctx) return { ok: false, error: "not signed in" };
  try {
    const { key } = await issueApiKey(adminClient(), ctx.teamId, ctx.actorMemberId, name, {
      actor: { kind: "member", memberId: ctx.actorMemberId },
    });
    revalidatePath(`/t/${teamSlug}/people/${ctx.actorMemberId}`);
    return { ok: true, key };
  } catch (e) {
    return fail(e);
  }
}

export async function revokeMyApiKey(teamSlug: string, apiKeyId: string): Promise<KeyResult> {
  const ctx = await selfGate(teamSlug);
  if (!ctx) return { ok: false, error: "not signed in" };
  try {
    const { revoked } = await revokeOwnApiKey(adminClient(), ctx.teamId, ctx.actorMemberId, apiKeyId, {
      actor: { kind: "member", memberId: ctx.actorMemberId },
    });
    if (!revoked) return { ok: false, error: "not allowed" };
    revalidatePath(`/t/${teamSlug}/people/${ctx.actorMemberId}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
