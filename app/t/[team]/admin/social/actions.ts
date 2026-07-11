"use server";

import { revalidatePath } from "next/cache";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import { getProviderKey } from "@/lib/integrations/manage";
import { visibleGroupIds } from "@/lib/graph/group";
import { discoverOpportunities } from "@/lib/social/discover";
import { discoverOpportunitiesFromArcs } from "@/lib/social/discover-arcs";
import { planOpportunity } from "@/lib/social/plan";
import { generatePlanDrafts } from "@/lib/social/generate";

type DiscoverResult = { ok: boolean; created?: number; skipped?: number; scanned?: number; error?: string };

/** Run content discovery over recent brain knowledge (admins only). */
export async function discoverNow(teamSlug: string): Promise<DiscoverResult> {
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

/**
 * Discover opportunities from the team's narrative arcs (admins only). Sources from the team-tier
 * arc set; each opportunity is created at its tier-safe access (an arc built from internal evidence
 * stays `team` and can't become a public post). Idempotent by `arc:<id>`.
 */
export async function discoverFromArcsNow(teamSlug: string): Promise<DiscoverResult> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    const db = adminClient();
    const [openaiKey, anthropicKey] = await Promise.all([
      getProviderKey(db, ctx.teamId, "openai"),
      getProviderKey(db, ctx.teamId, "anthropic"),
    ]);
    const groups = visibleGroupIds(teamSlug, "team");
    const s = await discoverOpportunitiesFromArcs(db, ctx.teamId, teamSlug, "team", groups, { openaiKey, anthropicKey }, {
      actor: { memberId: ctx.memberId },
    });
    revalidatePath(`/t/${teamSlug}/admin/social`);
    return { ok: true, created: s.created, skipped: s.skipped, scanned: s.scanned };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "arc discovery failed" };
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

/** Generate drafts for an opportunity's variants, in-brand + governance-gated (admins only). */
export async function generateDrafts(
  teamSlug: string,
  opportunityId: string
): Promise<{ ok: boolean; generated?: number; blocked?: number; failed?: number; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    const s = await generatePlanDrafts(adminClient(), ctx.teamId, opportunityId);
    revalidatePath(`/t/${teamSlug}/admin/social`);
    return { ok: true, generated: s.generated, blocked: s.blocked, failed: s.failed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "generation failed" };
  }
}
