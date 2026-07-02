import "server-only";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { recentFacts } from "./learning";
import { GraphitiClient } from "./graphiti-client";
import { episodeGroupId, type AccessTier } from "./group";

/**
 * Layer 3 — narrative arcs. Gathers the recent graph substrate (facts, last 7d, tier-scoped),
 * asks the team's LLM to synthesize 3–5 ongoing storylines, and caches them for 10 min. Human edits
 * are fed back on recompute (both into the prompt AND written to Graphiti as correction episodes, so
 * they persist and inform future synthesis). See docs/design/brain-learning-panel.md.
 *
 * LLM provider mirrors the Q&A path: OpenAI-compatible (`LLM_BASE_URL`) when set, else Anthropic.
 */

export interface NarrativeArc {
  id: string;
  title: string;
  confidence: "high" | "medium" | "low";
  summary: string;
  participants: string[];
  supporting_sources: string[];
  derived_at: string;
}

export interface ArcCorrection {
  arc_id: string;
  corrected_text: string;
}

export interface ProviderKeys {
  openaiKey?: string | null;
  anthropicKey?: string | null;
}

const LLM_BASE_URL = process.env.LLM_BASE_URL;
const LLM_MODEL = process.env.LLM_MODEL ?? "gpt-4o";
const ANTHROPIC_MODEL = process.env.ARCS_ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
const WINDOW_DAYS = 7;
const MAX_FACTS = 200;
const CACHE_TTL_MS = 10 * 60_000;

const SYSTEM_PROMPT =
  "You are analyzing a team knowledge graph. Identify 3-5 active narrative arcs — ongoing storylines " +
  "about what this team is working through. Return ONLY a JSON object of the form " +
  '{"arcs":[{"title":"short","confidence":"high|medium|low","summary":"2-3 sentences, present tense, ' +
  'specific","participants":["names"],"supporting_sources":["short source refs"]}]}. No prose.';

function stableId(title: string): string {
  return "arc-" + createHash("sha256").update(title.trim().toLowerCase()).digest("hex").slice(0, 10);
}

/**
 * Parse + normalize the LLM's JSON into safe arcs: caps at 5, coerces confidence, defaults missing
 * fields, assigns a stable id from the title, stamps `derived_at`. Returns [] on malformed input.
 * Pure + exported so the fragile parsing is unit-tested without an LLM.
 */
export function parseArcsJson(raw: string | null, now = new Date().toISOString()): NarrativeArc[] {
  if (!raw) return [];
  try {
    const obj = JSON.parse(raw) as { arcs?: Partial<NarrativeArc>[] };
    if (!Array.isArray(obj.arcs)) return [];
    return obj.arcs.slice(0, 5).map((a) => ({
      id: stableId(a.title ?? ""),
      title: (a.title ?? "Untitled").toString(),
      confidence: (["high", "medium", "low"] as const).includes(a.confidence as "high")
        ? (a.confidence as NarrativeArc["confidence"])
        : "low",
      summary: (a.summary ?? "").toString(),
      participants: Array.isArray(a.participants) ? a.participants.map(String) : [],
      supporting_sources: Array.isArray(a.supporting_sources) ? a.supporting_sources.map(String) : [],
      derived_at: now,
    }));
  } catch {
    return [];
  }
}

/** Ask the configured LLM for arcs as JSON; returns [] on any parse/transport failure (best-effort). */
async function callLLM(userContent: string, keys: ProviderKeys): Promise<NarrativeArc[]> {
  const raw = LLM_BASE_URL
    ? await callOpenAICompatible(userContent, keys.openaiKey)
    : await callAnthropic(userContent, keys.anthropicKey);
  return parseArcsJson(raw);
}

async function callOpenAICompatible(userContent: string, apiKey?: string | null): Promise<string | null> {
  const res = await fetch(`${LLM_BASE_URL!.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey ?? process.env.OPENAI_API_KEY ?? "local"}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? null;
}

async function callAnthropic(userContent: string, apiKey?: string | null): Promise<string | null> {
  const client = new Anthropic(apiKey ? { apiKey } : undefined);
  const msg = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `${userContent}\n\nReturn ONLY the JSON object.` }],
  });
  const block = msg.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text : null;
}

/** Build the user prompt from the recent facts substrate (+ any human corrections to incorporate). */
function buildPrompt(facts: string[], corrections: string[]): string {
  const lines = ["Recent facts from the team knowledge graph (most recent first):", ...facts.map((f) => `- ${f}`)];
  if (corrections.length) {
    lines.push("", "Human corrections to incorporate:", ...corrections.map((c) => `- ${c}`));
  }
  return lines.join("\n");
}

// In-memory cache (single-instance app). Keyed by the tier-visible group set.
const cache = new Map<string, { arcs: NarrativeArc[]; at: number }>();

/** Synthesize (or return cached) arcs for a team+tier. Empty when the graph/LLM is unavailable. */
export async function getArcs(teamSlug: string, tier: AccessTier, groups: string[], keys: ProviderKeys): Promise<NarrativeArc[]> {
  if (groups.length === 0) return [];
  const key = groups.slice().sort().join(",");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.arcs;

  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const facts = await recentFacts(groups, since, MAX_FACTS);
  if (facts.length === 0) return [];
  const arcs = await callLLM(buildPrompt(facts.map((f) => f.fact), []), keys);
  cache.set(key, { arcs, at: Date.now() });
  return arcs;
}

/**
 * Recompute arcs with human corrections: re-derive (corrections in the prompt), refresh the cache,
 * AND persist each correction to Graphiti as a `correction:<arc_id>` episode (team-tier group) so it
 * informs future synthesis. Writeback is best-effort — a Graphiti hiccup doesn't fail the recompute.
 */
export async function recomputeArcs(
  teamSlug: string,
  tier: AccessTier,
  groups: string[],
  corrections: ArcCorrection[],
  keys: ProviderKeys
): Promise<NarrativeArc[]> {
  if (groups.length === 0) return [];
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const facts = await recentFacts(groups, since, MAX_FACTS);
  const arcs = await callLLM(
    buildPrompt(facts.map((f) => f.fact), corrections.map((c) => c.corrected_text)),
    keys
  );
  cache.set(groups.slice().sort().join(","), { arcs, at: Date.now() });

  // Persist corrections as first-class episodes (team-tier group; corrections are internal).
  const client = new GraphitiClient();
  if (client.configured && corrections.length) {
    const now = new Date().toISOString();
    try {
      await client.addEpisodes(
        episodeGroupId(teamSlug, "team"),
        corrections.map((c) => ({
          content: c.corrected_text,
          timestamp: now,
          sourceDescription: "human correction to a narrative arc",
          name: `correction:${c.arc_id}`,
        }))
      );
    } catch {
      // writeback is best-effort — the recompute still returns fresh arcs
    }
  }
  return arcs;
}
