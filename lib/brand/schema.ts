import { z } from "zod";

/**
 * Brand Brain validation (Social Brain M1). The persistent per-team brand config in three
 * sections — voice, company knowledge, governance — each a `.strict()` object so an unknown key
 * is rejected (the same allowlist discipline `lib/api/schemas` uses for integration config) and
 * a bounded overall byte cap so a config blob can't bloat the row. Pure (no db, no server-only)
 * so it validates on the write path and the types are importable by the client editor.
 */

const line = (max = 400) => z.string().trim().max(max);
const text = (max = 4000) => z.string().max(max);
const list = (max = 100, itemMax = 400) => z.array(line(itemMax)).max(max);

export const brandVoiceSchema = z
  .object({
    vocabulary: list().optional(),
    sentenceLength: z.enum(["short", "medium", "long", "varied"]).optional(),
    humor: z.enum(["none", "dry", "playful", "bold"]).optional(),
    formality: z.enum(["casual", "neutral", "formal"]).optional(),
    punctuation: text(500).optional(),
    emojiUsage: z.enum(["none", "sparing", "liberal"]).optional(),
    ctas: list().optional(),
    formatting: text(1000).optional(),
    preferredPhrases: list().optional(),
    prohibitedPhrases: list().optional(),
  })
  .strict();

export const brandKnowledgeSchema = z
  .object({
    products: list().optional(),
    positioning: text().optional(),
    audiences: list().optional(),
    competitors: list().optional(),
    history: text().optional(),
    claimsAllowed: list().optional(),
    claimsNeedingVerification: list().optional(),
    roadmapVisibility: z.enum(["public", "hint", "private"]).optional(),
  })
  .strict();

export const brandGovernanceSchema = z
  .object({
    confidentialTopics: list().optional(),
    legalRestrictions: list().optional(),
    pricingRules: text(2000).optional(),
    disclosureRequirements: list().optional(),
    requiredMentions: list().optional(),
    approvalThresholds: text(1000).optional(),
    platformPolicies: text(2000).optional(),
  })
  .strict();

export const brandProfileSchema = z
  .object({
    voice: brandVoiceSchema.optional(),
    knowledge: brandKnowledgeSchema.optional(),
    governance: brandGovernanceSchema.optional(),
  })
  .strict();

export type BrandVoice = z.infer<typeof brandVoiceSchema>;
export type BrandKnowledge = z.infer<typeof brandKnowledgeSchema>;
export type BrandGovernance = z.infer<typeof brandGovernanceSchema>;
export type BrandProfileInput = z.infer<typeof brandProfileSchema>;

/** A brand asset: a reference URL, an image/logo asset link, or an example to emulate. */
export const brandAssetSchema = z
  .object({
    kind: z.enum(["url", "asset", "reference"]),
    label: z.string().trim().min(1).max(200),
    url: z.union([z.string().trim().url().max(2000), z.literal("")]).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.kind === "url" || v.kind === "asset") && !v.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a URL is required for this kind", path: ["url"] });
    }
  });

export type BrandAssetInput = z.infer<typeof brandAssetSchema>;

/** Validate an untrusted brand asset; throws BrandProfileError with a readable reason. */
export function validateBrandAsset(input: unknown): BrandAssetInput {
  const parsed = brandAssetSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first.path.join(".") || "(root)";
    throw new BrandProfileError(`invalid brand asset: ${path} — ${first.message}`);
  }
  return parsed.data;
}

/** Overall cap on the serialized profile (defense against an oversized config blob). */
export const MAX_BRAND_BYTES = 32 * 1024;

export class BrandProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandProfileError";
  }
}

/**
 * Validate + normalize an untrusted brand profile. Throws BrandProfileError with a
 * human-readable reason (byte cap → unknown-key/shape) so the admin action can surface it.
 */
export function validateBrandProfile(input: unknown): BrandProfileInput {
  const bytes = Buffer.byteLength(JSON.stringify(input ?? {}), "utf8");
  if (bytes > MAX_BRAND_BYTES) {
    throw new BrandProfileError(`brand profile too large (${bytes} > ${MAX_BRAND_BYTES} bytes)`);
  }
  const parsed = brandProfileSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first.path.join(".") || "(root)";
    throw new BrandProfileError(`invalid brand profile: ${path} — ${first.message}`);
  }
  return parsed.data;
}
