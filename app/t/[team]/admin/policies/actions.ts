"use server";

import { revalidatePath } from "next/cache";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import { createPolicy, updatePolicy, setPolicyEnabled, deletePolicy, type PolicyInput } from "@/lib/policy/manage";

export type PolicyForm = PolicyInput & { id?: string };

/** Create (no id) or update (id) a policy rule (admins only). */
export async function savePolicy(teamSlug: string, form: PolicyForm): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const actor = { memberId: ctx.memberId };
  try {
    if (form.id) await updatePolicy(adminClient(), ctx.teamId, form.id, form, actor);
    else await createPolicy(adminClient(), ctx.teamId, form, actor);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not save policy" };
  }
  revalidatePath(`/t/${teamSlug}/admin/policies`);
  return { ok: true };
}

export async function togglePolicy(teamSlug: string, id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await setPolicyEnabled(adminClient(), ctx.teamId, id, enabled, { memberId: ctx.memberId });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not toggle" };
  }
  revalidatePath(`/t/${teamSlug}/admin/policies`);
  return { ok: true };
}

export async function removePolicy(teamSlug: string, id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await deletePolicy(adminClient(), ctx.teamId, id, { memberId: ctx.memberId });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not delete" };
  }
  revalidatePath(`/t/${teamSlug}/admin/policies`);
  return { ok: true };
}
