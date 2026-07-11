import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { DbClient } from "@/lib/db/types";
import type { ProviderKeys } from "@/lib/query/claude";
import { selectLlmBackend } from "@/lib/query/llm-backend";
import { getBrandProfile } from "@/lib/brand/manage";
import { planOpportunity } from "./plan";
import { getOpportunity, setVariantContent } from "./store";
import type { OpportunityRow, SocialActor, VariantRow } from "./types";

/**
 * Content generation (Social Brain, slice 2): draft the actual post text for each planned variant,
 * in the team's Brand voice. Planning (`plan.ts`) creates the X + LinkedIn variants with EMPTY
 * bodies; this fills them and advances them to `awaiting_approval` (nothing auto-publishes — v1 is
 * draft-for-copy-paste). The LLM call mirrors `lib/chat/title.ts` — same provider seam (OpenRouter →
 * `LLM_BASE_URL` → Anthropic), so drafts use whatever answering provider the team configured.
 *
 * Tier safety is inherited: we only ever fill bodies of variants that planning already created under
 * the opportunity's tier — no tier decision is made here.
 */

const LLM_BASE_URL = process.env.LLM_BASE_URL;
const LLM_MODEL = process.env.LLM_MODEL ?? "llama3.1-8b-64k:latest";
const DRAFT_MODEL = "claude-sonnet-5"; // Anthropic fallback when no OpenAI-compatible backend is set

/** Per-platform shape guidance folded into the prompt. */
const PLATFORM_GUIDANCE: Record<string, string> = {
  x: "Platform: X (Twitter). One post, at most 280 characters. Punchy and specific. At most 1–2 hashtags, only if they add reach. No link placeholders.",
  linkedin:
    "Platform: LinkedIn. One post of 2–4 short paragraphs (roughly 60–200 words). Professional but human; lead with the hook. A single soft call-to-action at the end is fine.",
};

const X_MAX = 280;

interface VoiceConstraints {
  formality?: string;
  humor?: string;
  emojiUsage?: string;
  ctas?: string[];
  preferredPhrases?: string[];
  prohibitedPhrases?: string[];
}

/** Pull the known voice fields out of the (loosely-typed) brand voice config. */
export function readVoice(voice: Record<string, unknown> | undefined): VoiceConstraints {
  const v = voice ?? {};
  const str = (k: string): string | undefined => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  const arr = (k: string): string[] | undefined =>
    Array.isArray(v[k]) ? (v[k] as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
  return {
    formality: str("formality"),
    humor: str("humor"),
    emojiUsage: str("emojiUsage"),
    ctas: arr("ctas"),
    preferredPhrases: arr("preferredPhrases"),
    prohibitedPhrases: arr("prohibitedPhrases"),
  };
}

/**
 * Build the (system, user) prompt for one platform draft. Pure, so it's unit-testable — the voice
 * constraints and platform guidance are deterministic; only the model call is not.
 */
export function buildPostPrompt(
  opp: Pick<OpportunityRow, "title" | "summary">,
  voice: VoiceConstraints,
  platform: string,
  tone: string
): { system: string; user: string } {
  const lines = [
    "You are a social media writer for a company. Write ONE social post about the update below, in the brand's voice.",
    PLATFORM_GUIDANCE[platform] ?? `Platform: ${platform}. Write one concise post.`,
    tone ? `Tone: ${tone}.` : "",
    voice.formality ? `Formality: ${voice.formality}.` : "",
    voice.humor ? `Humor: ${voice.humor}.` : "",
    voice.emojiUsage ? `Emoji usage: ${voice.emojiUsage}.` : "",
    voice.preferredPhrases?.length ? `Prefer phrasing like: ${voice.preferredPhrases.join("; ")}.` : "",
    voice.prohibitedPhrases?.length ? `NEVER use these phrases: ${voice.prohibitedPhrases.join("; ")}.` : "",
    voice.ctas?.length ? `If a call-to-action fits, use one of: ${voice.ctas.join("; ")}.` : "",
    "Output ONLY the post text — no preamble, no quotes, no markdown, no explanation.",
  ].filter(Boolean);
  const user = `Update to communicate:\nTitle: ${opp.title}\n${opp.summary ? `Summary: ${opp.summary}` : ""}`.trim();
  return { system: lines.join("\n"), user };
}

/** Normalize a model's post output: strip reasoning spans / surrounding quotes / fences; hard-cap X. */
export function cleanPostBody(raw: string, platform: string): string {
  let t = String(raw ?? "").replace(/<think>[\s\S]*?<\/think>/g, "");
  t = t.replace(/```[a-z]*\n?|```/gi, "").trim();
  t = t.replace(/^["'`\s]+|["'`\s]+$/g, "").trim(); // surrounding quotes/backticks
  if (platform === "x" && t.length > X_MAX) t = t.slice(0, X_MAX).trimEnd();
  return t;
}

/** Draft one platform's post via the configured LLM backend. Null on any failure (best-effort). */
export async function generatePostBody(
  opp: Pick<OpportunityRow, "title" | "summary">,
  voice: VoiceConstraints,
  platform: string,
  tone: string,
  keys: ProviderKeys = {}
): Promise<string | null> {
  const { system, user } = buildPostPrompt(opp, voice, platform, tone);
  try {
    const backend = selectLlmBackend({ LLM_BASE_URL, LLM_MODEL }, keys);
    if (backend.kind !== "anthropic") {
      const apiKey = backend.apiKey ?? process.env.OPENAI_API_KEY ?? "local";
      const res = await fetch(`${backend.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(backend.kind === "openrouter" ? backend.headers : {}),
        },
        body: JSON.stringify({
          model: backend.model,
          max_tokens: 512,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const body = cleanPostBody(j.choices?.[0]?.message?.content ?? "", platform);
      return body || null;
    }
    const client = new Anthropic(keys.anthropicKey ? { apiKey: keys.anthropicKey } : undefined);
    const msg = await client.messages.create(
      { model: DRAFT_MODEL, max_tokens: 512, system, messages: [{ role: "user", content: user }] },
      { timeout: 20_000, maxRetries: 1 }
    );
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return cleanPostBody(text, platform) || null;
  } catch {
    return null;
  }
}

export interface GenerateOptions {
  actor?: SocialActor;
  /** Inject the drafter (tests avoid a real LLM call). Returns the drafted body, or null to skip. */
  draft?: (variant: VariantRow) => Promise<string | null>;
  /** Re-draft variants that already have a body (default: only fill empty ones). */
  force?: boolean;
}

export interface GenerateSummary {
  planned: boolean;
  generated: number;
  skipped: number;
  variants: VariantRow[];
}

/**
 * Ensure an opportunity is planned, then draft the post body for each of its variants (X + LinkedIn),
 * advancing filled variants to `awaiting_approval`. One button → ready-to-copy drafts. Idempotent by
 * default (only fills empty bodies); `force` re-drafts everything.
 */
export async function generateForOpportunity(
  db: DbClient,
  teamId: string,
  opportunityId: string,
  keys: ProviderKeys = {},
  opts: GenerateOptions = {}
): Promise<GenerateSummary> {
  const opp = await getOpportunity(db, teamId, opportunityId);
  if (!opp) throw new Error(`generateForOpportunity: opportunity ${opportunityId} not found for team`);

  const planResult = await planOpportunity(db, teamId, opportunityId, opts.actor);
  const brand = await getBrandProfile(db, teamId);
  const voice = readVoice(brand?.voice);

  const draft =
    opts.draft ?? ((v: VariantRow) => generatePostBody(opp, voice, v.platform, v.tone, keys));

  const out: GenerateSummary = { planned: planResult.created, generated: 0, skipped: 0, variants: [] };
  for (const v of planResult.variants) {
    if (v.body.trim() && !opts.force) {
      out.skipped++;
      out.variants.push(v);
      continue;
    }
    const body = await draft(v);
    if (!body) {
      out.skipped++;
      out.variants.push(v);
      continue;
    }
    await setVariantContent(db, teamId, v.id, body, "awaiting_approval");
    out.generated++;
    out.variants.push({ ...v, body, status: "awaiting_approval" });
  }
  return out;
}
