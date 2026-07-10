"use server";

import { revalidatePath } from "next/cache";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import { discoverOpportunities } from "@/lib/social/discover";
import { planOpportunity } from "@/lib/social/plan";

/** Run content discovery over recent brain knowledge (admins only). */
export async function discoverNow(
  teamSlug: string
): Promise<{ ok: boolean; created?: number; skipped?: number; scanned?: number; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    const s = await discoverOpportunities(adminClient(), ctx.teamId, { actor: { memberId: ctx.memberId } });
    revalidatePath(`/t/${teamSlug}/admin/social`);
    return { ok: true, created: s.created, skipped: s.skipped, scanned: s.scanned };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "discovery failed" };
  }
}

/** Plan an opportunity into platform variants (admins only). Idempotent. */
export async function planNow(
  teamSlug: string,
  opportunityId: string
): Promise<{ ok: boolean; variants?: number; created?: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    const r = await planOpportunity(adminClient(), ctx.teamId, opportunityId, { memberId: ctx.memberId });
    revalidatePath(`/t/${teamSlug}/admin/social`);
    return { ok: true, variants: r.variants.length, created: r.created };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "planning failed" };
  }
}
