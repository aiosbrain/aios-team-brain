import "server-only";
import type { DbClient } from "@/lib/db/types";
import { addContentImage, countImagesSince, listImageIdsByVariant } from "./store";
import { getImageDailyCap, startOfUtcDay } from "./settings";
import { generateImage, type GeneratedImage } from "./image-provider";
import type { OpportunityRow, VariantRow } from "./types";

/**
 * Image generation orchestration (Social Brain slice 3). Generates one image per post variant via
 * the provider seam (Gemini Nano Banana), enforcing the per-team **daily cap**
 * (`teams.social_image_daily_cap`, default 10). Images are ON by default — every generated post gets
 * one — until the day's cap is hit, after which posts are drafted without an image. Tier is inherited
 * from the variant by the store (a team-tier post's image stays team-tier). Best-effort: a provider
 * failure (or no key) simply leaves the post image-less; text is unaffected.
 */

const PLATFORM_STYLE: Record<string, string> = {
  x: "square (1:1), bold and scroll-stopping",
  linkedin: "landscape (1.91:1), clean and professional",
};

/** Build the image prompt for a post. Pure, so it's unit-testable. No text baked into the image. */
export function buildImagePrompt(opp: Pick<OpportunityRow, "title" | "summary">, platform: string): string {
  const style = PLATFORM_STYLE[platform] ?? "clean and professional";
  return [
    `A modern, on-brand social media image for a ${platform} post. Style: ${style}.`,
    `The post is about: ${opp.title}.`,
    opp.summary ? `Context: ${opp.summary}` : "",
    "Photographic or illustrative, high quality, visually striking. Do NOT render any words, letters, or UI text in the image.",
  ]
    .filter(Boolean)
    .join(" ");
}

export interface GenerateImagesOptions {
  now?: Date;
  apiKey?: string | null;
  /** Re-generate images for variants that already have one (default: skip those). */
  force?: boolean;
  /** Inject the provider (tests avoid a real Gemini call). */
  generate?: (prompt: string) => Promise<GeneratedImage | null>;
}

export interface GenerateImagesSummary {
  created: number;
  skipped: number;
  /** How many variants were left image-less because the daily cap was already reached. */
  capped: number;
}

/**
 * Generate images for a set of a single opportunity's variants, cap-aware. Counts the team's images
 * for the current UTC day and stops creating once the cap is reached (remaining posts are `capped`).
 */
export async function generateImagesForOpportunity(
  db: DbClient,
  teamId: string,
  opp: OpportunityRow,
  variants: VariantRow[],
  opts: GenerateImagesOptions = {}
): Promise<GenerateImagesSummary> {
  const now = opts.now ?? new Date();
  const summary: GenerateImagesSummary = { created: 0, skipped: 0, capped: 0 };
  if (variants.length === 0) return summary;

  const cap = await getImageDailyCap(db, teamId);
  let used = await countImagesSince(db, teamId, startOfUtcDay(now));
  const existing = opts.force
    ? new Map<string, string>()
    : await listImageIdsByVariant(db, teamId, variants.map((v) => v.id), "team");
  const gen = opts.generate ?? ((prompt: string) => generateImage(prompt, opts.apiKey));

  for (const v of variants) {
    if (!opts.force && existing.has(v.id)) {
      summary.skipped++;
      continue;
    }
    if (used >= cap) {
      summary.capped++;
      continue;
    }
    const img = await gen(buildImagePrompt(opp, v.platform));
    if (!img) {
      summary.skipped++; // no key / provider failure — post stays image-less
      continue;
    }
    await addContentImage(db, teamId, v.id, { mime: img.mime, dataBase64: img.dataBase64, prompt: buildImagePrompt(opp, v.platform) });
    used++;
    summary.created++;
  }
  return summary;
}
