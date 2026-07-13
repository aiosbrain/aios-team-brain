import "server-only";
import type { DbClient } from "@/lib/db/types";
import { getBrandProfile } from "@/lib/brand/manage";
import { addVariant, createPlan, getOpportunity, getPlan, listVariants, setOpportunityStatus } from "./store";
import type { PlanRow, SocialActor, VariantRow } from "./types";

/**
 * Content planning (Social Brain): turn a discovered opportunity into a plan + platform-specific
 * variants. This is the DETERMINISTIC first cut — brand-aware but rule-based, no LLM: it reads the
 * Brand Brain for tone/audience and emits a fixed V1 variant set (text posts for X + LinkedIn).
 * The variant BODIES are left empty for the generation milestone to fill. Product-steerable: the
 * platform/format matrix and objective logic are meant to be tuned (or replaced with LLM planning).
 *
 * Tier safety is inherited: createPlan copies the opportunity's `access`, addVariant copies the
 * plan's — the caller never sets a child tier (store invariant).
 */

// V1 is text-only (avatar/scene video deferred). One text variant per launch platform.
const DEFAULT_VARIANTS: { platform: string; format: string }[] = [
  { platform: "x", format: "text" },
  { platform: "linkedin", format: "text" },
];

const TONE_BY_FORMALITY: Record<string, string> = {
  casual: "conversational",
  neutral: "neutral",
  formal: "authoritative",
};

export interface PlanSpec {
  objective: string;
  audience: string;
  tone: string;
  variants: { platform: string; format: string }[];
}

/** Derive the plan shape from the team's Brand Brain (pure, so it's unit-testable). */
export function buildPlanSpec(brand: { voice?: Record<string, unknown>; knowledge?: Record<string, unknown> } | null): PlanSpec {
  const voice = brand?.voice ?? {};
  const knowledge = brand?.knowledge ?? {};
  const formality = typeof voice.formality === "string" ? voice.formality : "neutral";
  const audiences = Array.isArray(knowledge.audiences) ? knowledge.audiences.filter((a): a is string => typeof a === "string") : [];
  return {
    objective: "awareness",
    audience: audiences[0] ?? "",
    tone: TONE_BY_FORMALITY[formality] ?? "neutral",
    variants: DEFAULT_VARIANTS,
  };
}

export interface PlanResult {
  plan: PlanRow;
  variants: VariantRow[];
  /** false when an existing plan was reused (idempotent). */
  created: boolean;
}

/**
 * Plan an opportunity. Idempotent: if the opportunity already has a plan, returns it unchanged.
 * Otherwise creates the plan + variants (brand-aware, tier-inherited) and advances the
 * opportunity to `planned`.
 */
export async function planOpportunity(
  db: DbClient,
  teamId: string,
  opportunityId: string,
  actor: SocialActor = {}
): Promise<PlanResult> {
  const opp = await getOpportunity(db, teamId, opportunityId);
  if (!opp) throw new Error(`planOpportunity: opportunity ${opportunityId} not found for team`);

  // Idempotent — reuse an existing plan rather than spawning a second.
  const { data: existing } = await db
    .from("content_plans")
    .select("id")
    .eq("team_id", teamId)
    .eq("opportunity_id", opportunityId)
    .limit(1);
  if (existing && existing.length) {
    const plan = (await getPlan(db, teamId, existing[0].id))!;
    const variants = await listVariants(db, teamId, plan.id, "team");
    return { plan, variants, created: false };
  }

  const spec = buildPlanSpec(await getBrandProfile(db, teamId));
  const plan = await createPlan(
    db,
    teamId,
    opportunityId,
    { objective: spec.objective, audience: spec.audience },
    actor
  );

  const variants: VariantRow[] = [];
  for (const v of spec.variants) {
    variants.push(await addVariant(db, teamId, plan.id, { platform: v.platform, format: v.format, tone: spec.tone }));
  }

  await setOpportunityStatus(db, teamId, opportunityId, "planned");
  return { plan, variants, created: true };
}
