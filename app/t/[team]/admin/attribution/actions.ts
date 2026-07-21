"use server";

import { revalidatePath } from "next/cache";
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
    if (result.ok && result.updated > 0) revalidatePath(`/t/${teamSlug}/admin/attribution`);
    return result;
  } catch (e) {
    return { ok: false, updated: 0, target: "", error: e instanceof Error ? e.message : "apply failed" };
  }
}
