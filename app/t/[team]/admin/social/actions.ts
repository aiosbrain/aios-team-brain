"use server";

import { revalidatePath } from "next/cache";
import { adminClient } from "@/lib/db/admin";
import type { DbClient } from "@/lib/db/types";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import { getProviderKey, getOpenrouterSettings } from "@/lib/integrations/manage";
import { visibleGroupIds } from "@/lib/graph/group";
import type { ProviderKeys } from "@/lib/query/claude";
import { discoverOpportunities } from "@/lib/social/discover";
import { discoverOpportunitiesFromArcs } from "@/lib/social/discover-arcs";
import { generateForOpportunity } from "@/lib/social/generate";
import { generateImagesForOpportunity } from "@/lib/social/images";
import { getOpportunity } from "@/lib/social/store";
import { getImageDailyCap, setImageDailyCap } from "@/lib/social/settings";

type DiscoverResult = { ok: boolean; created?: number; skipped?: number; scanned?: number; error?: string };

/** The team's full answering-provider key set (OpenRouter → OpenAI-compatible → Anthropic), same as
 *  the Q&A path — so social drafts use whatever provider the team configured. */
async function resolveProviderKeys(db: DbClient, teamId: string): Promise<ProviderKeys> {
  const [anthropicKey, openaiKey, openrouter] = await Promise.all([
    getProviderKey(db, teamId, "anthropic"),
    getProviderKey(db, teamId, "openai"),
    getOpenrouterSettings(db, teamId),
  ]);
  return { anthropicKey, openaiKey, openrouterKey: openrouter.key, openrouterModel: openrouter.model };
}

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

/**
 * Draft the post text for an opportunity's variants (admins only): plans it if needed, then fills
 * each X + LinkedIn body in the Brand voice and moves them to `awaiting_approval`. One click →
 * ready-to-copy drafts. Idempotent (only fills empty bodies unless the model returns nothing).
 */
export async function generateNow(
  teamSlug: string,
  opportunityId: string
): Promise<{ ok: boolean; generated?: number; skipped?: number; images?: number; capped?: number; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    const db = adminClient();
    const keys = await resolveProviderKeys(db, ctx.teamId);
    const s = await generateForOpportunity(db, ctx.teamId, opportunityId, keys, { actor: { memberId: ctx.memberId } });
    // Images are ON by default — generate one per variant, cap-aware (Gemini key from env for now).
    const opp = await getOpportunity(db, ctx.teamId, opportunityId);
    const img = opp
      ? await generateImagesForOpportunity(db, ctx.teamId, opp, s.variants)
      : { created: 0, skipped: 0, capped: 0 };
    revalidatePath(`/t/${teamSlug}/admin/social`);
    return { ok: true, generated: s.generated, skipped: s.skipped, images: img.created, capped: img.capped };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "generation failed" };
  }
}

/** Read the team's daily image cap (admins only). */
export async function getImageCap(teamSlug: string): Promise<{ ok: boolean; cap?: number; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  return { ok: true, cap: await getImageDailyCap(adminClient(), ctx.teamId) };
}

/** Set the team's daily image cap (admins only). 0 disables image generation. */
export async function setImageCap(
  teamSlug: string,
  cap: number
): Promise<{ ok: boolean; cap?: number; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    const saved = await setImageDailyCap(adminClient(), ctx.teamId, cap);
    revalidatePath(`/t/${teamSlug}/admin/social`);
    return { ok: true, cap: saved };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "failed to save" };
  }
}
