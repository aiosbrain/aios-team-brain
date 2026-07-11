"use server";

import { revalidatePath } from "next/cache";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import { saveBrandProfile } from "@/lib/brand/manage";
import { addBrandAsset, removeBrandAsset } from "@/lib/brand/assets";
import type { BrandProfileInput, BrandAssetInput } from "@/lib/brand/schema";

/** Save the team's brand profile (admins only). Validation lives in the single-writer lib. */
export async function saveBrand(
  teamSlug: string,
  input: BrandProfileInput
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await saveBrandProfile(adminClient(), ctx.teamId, input, { memberId: ctx.memberId });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not save brand profile" };
  }
  revalidatePath(`/t/${teamSlug}/admin/brand`);
  return { ok: true };
}

/** Add a brand asset (admins only). */
export async function addAsset(
  teamSlug: string,
  input: BrandAssetInput
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await addBrandAsset(adminClient(), ctx.teamId, input, { memberId: ctx.memberId });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not add asset" };
  }
  revalidatePath(`/t/${teamSlug}/admin/brand`);
  return { ok: true };
}

/** Remove a brand asset (admins only). */
export async function removeAsset(teamSlug: string, id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await removeBrandAsset(adminClient(), ctx.teamId, id, { memberId: ctx.memberId });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not remove asset" };
  }
  revalidatePath(`/t/${teamSlug}/admin/brand`);
  return { ok: true };
}
