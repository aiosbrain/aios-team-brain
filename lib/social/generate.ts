import "server-only";
import type { DbClient } from "@/lib/db/types";
import { getBrandProfile } from "@/lib/brand/manage";
import { listBrandAssets } from "@/lib/brand/assets";
import { visibleByAccess } from "@/lib/auth/visibility";
import { completeText, resolveProviderKeys, type CompleteArgs } from "./llm";
import { governanceFromBrand, validateContent, type ContentFinding } from "./validate";
import { getOpportunity, getPlan, getVariant, listVariants, setVariantGeneration, setVariantStatus } from "./store";
import type { BrandProfileRecord } from "@/lib/brand/manage";
import type { AccessTier, ContentStatus, Evidence, VariantRow } from "./types";

// A variant may (re)generate only from these statuses. Anything further along — generated,
// awaiting_approval, approved, scheduled, publishing, published — must NOT be overwritten: doing so
// let a governance-REJECTED regenerated body replace an already-approved one that could still fire
// (2026-07-16 audit #3). First generation is from `planned`; `failed`/`rejected` may be retried.
const REGENERATABLE_STATUSES: ReadonlySet<ContentStatus> = new Set(["planned", "failed", "rejected"]);

/**
 * Text generation (Social Brain). Fills a planned variant's body with a draft written IN the brand
 * voice, GROUNDED strictly in the opportunity's evidence, then runs the governance gate
 * (lib/social/validate) before advancing it. Prohibited-phrase / confidential-topic hits BLOCK
 * (variant → `rejected` with the reasons stored); unverified-claim hits WARN (still `generated`).
 * The LLM call is injectable (`complete`) so the data-mechanics tier can stub the model.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PLATFORM: Record<string, { norm: string; maxTokens: number }> = {
  x: { norm: "Platform: X (Twitter). At most 280 characters, punchy, no more than 2 hashtags.", maxTokens: 200 },
  linkedin: { norm: "Platform: LinkedIn. 1–3 short paragraphs, professional, minimal hashtags.", maxTokens: 500 },
};

export type Completer = (args: CompleteArgs) => Promise<string>;

export interface GenerateResult {
  status: "generated" | "rejected" | "failed";
  body: string;
  violations: ContentFinding[];
  warnings: ContentFinding[];
}

interface PromptContext {
  platform: string;
  tone: string;
  objective: string;
  audience: string;
  title: string;
  summary: string;
  evidence: string[];
  assets: { label: string; url: string | null }[];
  brand: BrandProfileRecord | null;
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];

/** Build the (system, user) prompt. Kept pure so the prompt shape is inspectable/testable. */
export function buildGenerationPrompt(ctx: PromptContext): CompleteArgs {
  const voice = ctx.brand?.voice ?? {};
  const platform = PLATFORM[ctx.platform] ?? { norm: `Platform: ${ctx.platform}.`, maxTokens: 400 };
  const preferred = asStrings(voice.preferredPhrases);
  const prohibited = asStrings(voice.prohibitedPhrases);

  const systemLines = [
    `You are a social media writer for the brand${ctx.audience ? `, writing for ${ctx.audience}` : ""}.`,
    `Write a single post. ${platform.norm}`,
    ctx.tone ? `Tone: ${ctx.tone}.` : "",
    typeof voice.formality === "string" ? `Formality: ${voice.formality}.` : "",
    preferred.length ? `Prefer these phrases where natural: ${preferred.join("; ")}.` : "",
    prohibited.length ? `Never use these phrases: ${prohibited.join("; ")}.` : "",
    "Ground every claim ONLY in the provided evidence — never invent facts, metrics, names, quotes, or links.",
    "Output ONLY the post text: no preamble, no surrounding quotes, no explanation.",
  ].filter(Boolean);

  const userLines = [
    `TOPIC: ${ctx.title}`,
    ctx.summary ? `SUMMARY: ${ctx.summary}` : "",
    "",
    "EVIDENCE (ground in this only):",
    ...(ctx.evidence.length ? ctx.evidence.map((e, i) => `[${i + 1}] ${e}`) : ["(no evidence provided)"]),
    "",
    ctx.assets.length ? `BRAND REFERENCE:\n${ctx.assets.map((a) => `- ${a.label}${a.url ? ` (${a.url})` : ""}`).join("\n")}` : "",
    "",
    ctx.objective ? `OBJECTIVE: ${ctx.objective}` : "",
    `Write the ${ctx.platform} post now.`,
  ].filter(Boolean);

  return { system: systemLines.join(" "), prompt: userLines.join("\n") };
}

/**
 * Load the evidence item bodies for a draft — re-asserting the tier ceiling at generation time
 * (2026-07-16 audit #7). The evidence→tier invariant is enforced when the opportunity is created,
 * but bodies are re-read HERE, later, so an item narrowed `external→team` (or edited to add
 * sensitive content) after that point would otherwise leak into an `external` draft. Filtering the
 * lookup through `visibleByAccess(access)` means an external variant only ever sees external
 * evidence — the same choke-point the dashboard reads use.
 */
async function loadEvidenceBodies(
  db: DbClient,
  teamId: string,
  access: AccessTier,
  evidence: Evidence[]
): Promise<string[]> {
  const ids = [...new Set(evidence.map((e) => e.itemId).filter((id): id is string => !!id && UUID_RE.test(id)))];
  if (ids.length === 0) return [];
  const { data } = await visibleByAccess(
    db.from("items").select("id, body, access").eq("team_id", teamId).in("id", ids),
    access
  );
  return ((data ?? []) as { body: string }[]).map((r) => (r.body ?? "").replace(/\s+/g, " ").trim().slice(0, 800)).filter(Boolean);
}

export interface GenerateOptions {
  complete?: Completer;
  brand?: BrandProfileRecord | null;
}

/** Generate + gate one variant's draft. Advances the variant status and persists the result. */
export async function generateVariantText(
  db: DbClient,
  teamId: string,
  variantId: string,
  opts: GenerateOptions = {}
): Promise<GenerateResult> {
  const variant = await getVariant(db, teamId, variantId);
  if (!variant) throw new Error(`generateVariantText: variant ${variantId} not found for team`);
  // Guard at the writer, not just the caller loop (CLAUDE.md §2): never overwrite a variant that has
  // advanced past drafting — a regenerated, possibly gate-rejected body must not replace one that can
  // still fire (audit #3). First generation is from `planned`; `failed`/`rejected` may be retried.
  if (!REGENERATABLE_STATUSES.has(variant.status)) {
    throw new Error(
      `generateVariantText: variant is '${variant.status}'; only ${[...REGENERATABLE_STATUSES].join("/")} may (re)generate`
    );
  }
  const plan = await getPlan(db, teamId, variant.plan_id);
  if (!plan) throw new Error(`generateVariantText: plan ${variant.plan_id} not found`);
  const opp = await getOpportunity(db, teamId, plan.opportunity_id);
  if (!opp) throw new Error(`generateVariantText: opportunity ${plan.opportunity_id} not found`);

  const brand = opts.brand !== undefined ? opts.brand : await getBrandProfile(db, teamId);
  const assets = await listBrandAssets(db, teamId);
  const evidence = await loadEvidenceBodies(db, teamId, variant.access, opp.evidence);

  const args = buildGenerationPrompt({
    platform: variant.platform,
    tone: variant.tone,
    objective: plan.objective,
    audience: plan.audience,
    title: opp.title,
    summary: opp.summary,
    evidence,
    assets: assets.map((a) => ({ label: a.label, url: a.url })),
    brand,
  });

  await setVariantStatus(db, teamId, variantId, "generating");

  const platform = PLATFORM[variant.platform];
  const complete: Completer =
    opts.complete ??
    (async (a) =>
      completeText(a, {
        keys: await resolveProviderKeys(db, teamId),
        maxTokens: platform?.maxTokens ?? 400,
        meter: { db, teamId, source: "social" },
      }));

  let body: string;
  try {
    body = await complete(args);
  } catch (e) {
    await setVariantStatus(db, teamId, variantId, "failed");
    throw new Error(`generation failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const result = validateContent(body, governanceFromBrand(brand));
  const status: GenerateResult["status"] = result.ok ? "generated" : "rejected";
  await setVariantGeneration(db, teamId, variantId, {
    body,
    status,
    validation: { violations: result.violations, warnings: result.warnings },
  });
  return { status, body, violations: result.violations, warnings: result.warnings };
}

export interface PlanDraftsSummary {
  generated: number;
  blocked: number;
  failed: number;
  variants: VariantRow[];
}

/** Generate drafts for every not-yet-generated variant of an opportunity's plan. */
export async function generatePlanDrafts(
  db: DbClient,
  teamId: string,
  opportunityId: string,
  opts: GenerateOptions = {}
): Promise<PlanDraftsSummary> {
  const { data: planRows } = await db
    .from("content_plans")
    .select("id")
    .eq("team_id", teamId)
    .eq("opportunity_id", opportunityId)
    .limit(1);
  if (!planRows || planRows.length === 0) throw new Error("generatePlanDrafts: opportunity has no plan");
  const planId = (planRows[0] as { id: string }).id;

  const variants = await listVariants(db, teamId, planId, "team");
  const summary: PlanDraftsSummary = { generated: 0, blocked: 0, failed: 0, variants: [] };

  for (const v of variants) {
    // Only (re)generate from a safe status. Skipping approved/scheduled/published (and generated)
    // prevents a regenerated, possibly gate-rejected body from replacing content that can fire (#3).
    if (!REGENERATABLE_STATUSES.has(v.status)) continue;
    try {
      const r = await generateVariantText(db, teamId, v.id, opts);
      if (r.status === "generated") summary.generated++;
      else summary.blocked++;
    } catch {
      summary.failed++;
    }
  }
  summary.variants = await listVariants(db, teamId, planId, "team");
  return summary;
}
