import "server-only";
import type { DbClient } from "@/lib/db/types";
import { getProviderKey } from "@/lib/integrations/manage";
import { getOpportunity, getPlan, getVariant } from "@/lib/social/store";
import { addMediaAsset, getImageUsage, reserveImageSlot, releaseImageSlot, type MediaAssetMeta } from "./store";
import { generateOpenAiImage } from "./providers/openai-image";

/**
 * Image generation for a content variant — OPT-IN (never automatic) and cost-capped. Image models
 * cost real money, so this enforces a hard per-team daily cap (Chetan: 10/day) BEFORE calling the
 * provider, and records an estimated cost per asset. Tier is inherited from the variant. The
 * provider call is injectable so the data-mechanics tier can stub the model.
 */

const CAP_ENV = Number(process.env.SOCIAL_IMAGE_DAILY_CAP);
// Integer, positive; a garbage/fractional env value falls back to 10 rather than degrading the cap.
export const DAILY_IMAGE_CAP = Number.isFinite(CAP_ENV) && CAP_ENV > 0 ? Math.floor(CAP_ENV) : 10;
// Rough per-image estimate for gpt-image-1.5 at 1024² (token-billed; refine against the live meter).
const EST_COST_USD = 0.04;

export class ImageBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageBudgetError";
  }
}

export type ImageGenerator = (args: { prompt: string; apiKey: string }) => Promise<{ b64: string; model: string }>;

/** The image prompt derived from the opportunity. No text in the image (platforms overlay their own). */
export function buildImagePrompt(title: string): string {
  return (
    `Create a clean, modern, professional social-media graphic that illustrates: ${title}. ` +
    `Uncluttered and on-brand. Do NOT include any text, words, or letters in the image.`
  );
}

export interface GenerateImageOptions {
  actor?: { memberId?: string | null };
  generate?: ImageGenerator;
  now?: Date;
}

export interface ImageBudget {
  used: number;
  cap: number;
  remaining: number;
}

/** Today's image budget for a team (from the atomic reservation counter — the enforced source). */
export async function imageBudget(db: DbClient, teamId: string, now = new Date()): Promise<ImageBudget> {
  const used = await getImageUsage(db, teamId, now);
  return { used, cap: DAILY_IMAGE_CAP, remaining: Math.max(0, DAILY_IMAGE_CAP - used) };
}

/** Generate one image for a variant. Throws ImageBudgetError if the daily cap is reached. */
export async function generateVariantImage(
  db: DbClient,
  teamId: string,
  variantId: string,
  opts: GenerateImageOptions = {}
): Promise<MediaAssetMeta> {
  const now = opts.now ?? new Date();
  const variant = await getVariant(db, teamId, variantId);
  if (!variant) throw new Error(`generateVariantImage: variant ${variantId} not found for team`);
  const plan = await getPlan(db, teamId, variant.plan_id);
  if (!plan) throw new Error(`generateVariantImage: plan ${variant.plan_id} not found`);
  const opp = await getOpportunity(db, teamId, plan.opportunity_id);
  if (!opp) throw new Error(`generateVariantImage: opportunity ${plan.opportunity_id} not found`);

  // Cost guard — ATOMICALLY reserve a slot BEFORE any spend (audit #8). Check-then-act raced: two
  // concurrent requests could both pass a count() and both generate, over-running the cap.
  const reserved = await reserveImageSlot(db, teamId, DAILY_IMAGE_CAP, now);
  if (!reserved) {
    throw new ImageBudgetError(`daily image cap reached (${DAILY_IMAGE_CAP}/${DAILY_IMAGE_CAP}); try again tomorrow`);
  }

  // Once the provider has actually produced an image (money spent), a LATER failure (e.g. the DB
  // store) must NOT release the slot — releasing it would let another request spend, exceeding the
  // cap in real dollars. Only a PRE-spend failure (bad key, provider/moderation error) releases.
  let spent = false;
  try {
    const apiKey = await getProviderKey(db, teamId, "openai");
    if (!apiKey && !opts.generate) {
      throw new Error("no OpenAI key configured — add one in Admin → Integrations");
    }
    const generate = opts.generate ?? (async ({ prompt, apiKey: key }) => generateOpenAiImage({ prompt, apiKey: key }));

    const prompt = buildImagePrompt(opp.title);
    const { b64, model } = await generate({ prompt, apiKey: apiKey ?? "" });
    spent = true; // the provider was paid — the slot is legitimately consumed from here on

    return await addMediaAsset(
      db,
      teamId,
      {
        variantId,
        access: variant.access, // inherited — image is as restricted as its variant
        provider: "openai",
        model,
        prompt,
        dataBase64: b64,
        costUsd: EST_COST_USD,
      },
      opts.actor ?? {}
    );
  } catch (e) {
    if (!spent) {
      await releaseImageSlot(db, teamId, now).catch((err) => console.error("[media] releaseImageSlot failed:", err));
    }
    throw e;
  }
}
