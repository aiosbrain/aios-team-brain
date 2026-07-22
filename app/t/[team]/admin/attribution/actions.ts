"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { bustTeamLearningCaches } from "@/lib/ingest/reconcile-attribution";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin } from "@/lib/auth/guard";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import {
  buildCorrectionContext,
  parseCorrectionPlan,
  previewCorrection,
  correctionPlanSchema,
  type CorrectionPreview,
} from "@/lib/attribution/correction";
import { getMemberItems, type MemberItem } from "@/lib/attribution/health";
import { applyAttributionCorrection, type CorrectionResult } from "@/lib/ingest/attribution-correction";

/**
 * Admin → Attribution: the natural-language correction box. `preview` parses the instruction with the
 * team's LLM into a structured plan and returns the read-only blast radius; `apply` re-validates the
 * plan and applies it through the audited single-writer. Both admin-gated via `requireTeamAdmin` (the
 * page's own gate; no reliance on the layout).
 */

export async function previewAttributionCorrectionAction(
  teamSlug: string,
  instruction: string
): Promise<{ ok: true; preview: CorrectionPreview } | { ok: false; error: string }> {
  const ctx = await requireTeamAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const trimmed = instruction.trim();
  if (!trimmed) return { ok: false, error: "describe the correction" };

  try {
    const db = adminClient();
    const [context, keys] = await Promise.all([
      buildCorrectionContext(ctx.teamId),
      resolveAnsweringKeys(db, ctx.teamId),
    ]);
    const plan = await parseCorrectionPlan(trimmed, context, keys);
    if (!plan) return { ok: false, error: "couldn't turn that into a scoped correction — try naming a source, a path, or a person (e.g. \"the linear docs are Fatma's\")." };

    const preview = await previewCorrection(ctx.teamId, plan);
    return { ok: true, preview };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "preview failed" };
  }
}

/** The drill-down expand: the actual items behind a per-person (or the unattributed) count. `memberId`
 *  is a member UUID or null (the unattributed bucket); `source` optionally filters to one source chip.
 *  Admin-gated ITSELF (a server action is a globally-invokable endpoint — the import-location guard on
 *  `lib/attribution/health` does NOT gate it; `requireTeamAdmin` is the real gate). Inputs zod-validated. */
const memberItemsInput = z.object({
  memberId: z.string().uuid().nullable(),
  source: z.string().max(60).optional(),
});

export async function getMemberItemsAction(
  teamSlug: string,
  memberId: string | null,
  source?: string
): Promise<{ ok: true; items: MemberItem[] } | { ok: false; error: string }> {
  const ctx = await requireTeamAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const parsed = memberItemsInput.safeParse({ memberId, source });
  if (!parsed.success) return { ok: false, error: "invalid request" };
  try {
    const items = await getMemberItems(ctx.teamId, parsed.data.memberId, { source: parsed.data.source });
    return { ok: true, items };
  } catch (e) {
    // getMemberItems THROWS by design (a "14" chip whose expand silently returned [] would contradict
    // the dashboard) — surface it rather than render an empty, lying list.
    return { ok: false, error: e instanceof Error ? e.message : "failed to load items" };
  }
}

/** Preview a plan the CLIENT built directly (the drill-down "correct this one" affordance — an exact
 *  `itemId` match, no LLM parse). Re-validates the closed schema server-side, then runs the SAME
 *  `previewCorrection` the NL box uses — so it inherits the resolve/blast-radius/TOCTOU path before apply. */
export async function previewCorrectionPlanAction(
  teamSlug: string,
  planInput: unknown
): Promise<{ ok: true; preview: CorrectionPreview } | { ok: false; error: string }> {
  const ctx = await requireTeamAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const parsed = correctionPlanSchema.safeParse(planInput);
  if (!parsed.success) return { ok: false, error: "invalid correction plan" };
  try {
    const preview = await previewCorrection(ctx.teamId, parsed.data);
    return { ok: true, preview };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "preview failed" };
  }
}

export async function applyAttributionCorrectionAction(
  teamSlug: string,
  planInput: unknown,
  expectedCount: number
): Promise<CorrectionResult> {
  const ctx = await requireTeamAdmin(teamSlug);
  if (!ctx) return { ok: false, updated: 0, target: "", error: "admins only" };
  // NEVER trust the client-supplied plan — re-validate the closed schema before applying.
  const parsed = correctionPlanSchema.safeParse(planInput);
  if (!parsed.success) return { ok: false, updated: 0, target: "", error: "invalid correction plan" };

  try {
    const result = await applyAttributionCorrection(adminClient(), ctx.teamId, parsed.data, { memberId: ctx.memberId }, expectedCount);
    if (result.ok && result.updated > 0) {
      revalidatePath(`/t/${teamSlug}/admin/attribution`);
      // The correction already re-pointed member_id (+ locked it) — just refresh arcs so the change
      // shows without the 10-min TTL. No reattribute here (it would fight the correction).
      after(() => bustTeamLearningCaches(adminClient(), ctx.teamId, teamSlug));
    }
    return result;
  } catch (e) {
    return { ok: false, updated: 0, target: "", error: e instanceof Error ? e.message : "apply failed" };
  }
}
