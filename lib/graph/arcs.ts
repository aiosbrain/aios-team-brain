import "server-only";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { recentFacts, resolveEpisodeItems, type AtomicFact } from "./learning";
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

/** One piece of verifiable evidence behind an arc: the real graph fact + a link to its source item. */
export interface ArcEvidence {
  fact: string; // the actual fact text extracted from the graph (not an LLM paraphrase)
  at?: string; // ISO timestamp of the fact
  itemId?: string; // brain item id (from the source episode `items:<id>`) → /library/<id> link
  source?: string; // slack / github / linear … when resolvable
}

export interface NarrativeArc {
  id: string;
  title: string;
  confidence: "high" | "medium" | "low";
  summary: string;
  participants: string[];
  /** Legacy free-text refs (kept for back-compat); `evidence` is the linkable, verifiable version. */
  supporting_sources: string[];
  evidence: ArcEvidence[];
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
const ANTHROPIC_MODEL = process.env.ARCS_ANTHROPIC_MODEL ?? "claude-sonnet-5";
const WINDOW_DAYS = 7;
const MAX_FACTS = 200;
const CACHE_TTL_MS = 10 * 60_000;

const SYSTEM_PROMPT =
  "You are analyzing a team knowledge graph. Identify 3-5 active narrative arcs — ongoing storylines " +
  "about what this team is working through. Each fact below is numbered [F1], [F2], … — for every arc, " +
  "cite the 2-5 fact numbers that support it in `supporting_facts`. Return ONLY a JSON object of the form " +
  '{"arcs":[{"title":"short","confidence":"high|medium|low","summary":"2-3 sentences, present tense, ' +
  'specific","participants":["names"],"supporting_facts":[1,2,3]}]}. Use only fact numbers that appear ' +
  "below. No prose, no markdown code fences — the raw JSON object only.";

function stableId(title: string): string {
  return "arc-" + createHash("sha256").update(title.trim().toLowerCase()).digest("hex").slice(0, 10);
}

/**
 * Strip issue/task keys (Linear/Jira-style `AIO-138`, optionally bracketed) from arc text. The graph
 * facts carry these keys, so the LLM tends to echo them into titles/summaries — but they're noise in
 * a human-facing narrative. Removes the key and tidies the leftover brackets/spacing/punctuation.
 * Pure + exported so it's unit-tested.
 */
export function stripTaskKeys(text: string): string {
  return (text ?? "")
    .replace(/[([]\s*[A-Z][A-Z0-9]+-\d+\s*[)\]]/g, "") // (AIO-138) / [AIO-138]
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, "") // bare AIO-138
    .replace(/\s+([.,;:)])/g, "$1") // space before punctuation
    .replace(/\(\s*\)/g, "") // empty parens left behind
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Options for `parseArcsJson`: the numbered facts + episode→item map used to resolve cited evidence. */
export interface ParseArcsOptions {
  facts?: AtomicFact[];
  epToItem?: Map<string, { itemId?: string; source?: string }>;
  now?: string;
}

/**
 * Map an arc's cited `supporting_facts` (1-based indices into the numbered facts) back to the REAL
 * facts, resolving each one's source item via its episodes. Out-of-range / duplicate indices are
 * dropped; capped at 8. Pure — this is what makes each arc's evidence verifiable + linkable.
 */
function buildEvidence(
  indices: unknown,
  facts: AtomicFact[],
  epToItem: Map<string, { itemId?: string; source?: string }>
): ArcEvidence[] {
  if (!Array.isArray(indices)) return [];
  const out: ArcEvidence[] = [];
  const seen = new Set<string>();
  for (const rawIdx of indices) {
    const i = typeof rawIdx === "number" ? rawIdx : parseInt(String(rawIdx), 10);
    if (!Number.isInteger(i) || i < 1 || i > facts.length) continue;
    const f = facts[i - 1];
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    let itemId: string | undefined;
    let source: string | undefined;
    for (const uuid of f.episodeUuids) {
      const hit = epToItem.get(uuid);
      if (hit?.source && !source) source = hit.source;
      if (hit?.itemId) {
        itemId = hit.itemId;
        source = hit.source ?? source;
        break;
      }
    }
    out.push({ fact: f.fact, at: f.at, itemId, source });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Parse + normalize the LLM's JSON into safe arcs: caps at 5, coerces confidence, defaults missing
 * fields, assigns a stable id from the title, stamps `derived_at`, and resolves cited `supporting_facts`
 * indices → verifiable `evidence` (falls back to any free-text `supporting_sources` as unlinked
 * evidence). Returns [] on malformed input. Pure + exported so the fragile parsing is unit-tested.
 */
export function parseArcsJson(raw: string | null, opts: ParseArcsOptions = {}): NarrativeArc[] {
  const { facts = [], epToItem = new Map(), now = new Date().toISOString() } = opts;
  if (!raw) return [];
  try {
    const obj = JSON.parse(extractJsonObject(raw)) as {
      arcs?: (Partial<NarrativeArc> & { supporting_facts?: unknown })[];
    };
    if (!Array.isArray(obj.arcs)) return [];
    return obj.arcs.slice(0, 5).map((a) => {
      const supporting_sources = Array.isArray(a.supporting_sources) ? a.supporting_sources.map(String) : [];
      const cited = buildEvidence(a.supporting_facts, facts, epToItem);
      // Fall back to free-text sources (unlinked) if the model didn't cite fact numbers.
      const evidence = cited.length ? cited : supporting_sources.map((s) => ({ fact: s }));
      return {
        id: stableId(a.title ?? ""),
        title: stripTaskKeys((a.title ?? "Untitled").toString()) || "Untitled",
        confidence: (["high", "medium", "low"] as const).includes(a.confidence as "high")
          ? (a.confidence as NarrativeArc["confidence"])
          : "low",
        summary: stripTaskKeys((a.summary ?? "").toString()),
        participants: Array.isArray(a.participants) ? a.participants.map(String) : [],
        supporting_sources,
        evidence,
        derived_at: now,
      };
    });
  } catch (err) {
    // The prompt asks for "ONLY JSON", but Claude/GPT often ignore that and wrap the object in a
    // markdown fence or a leading sentence anyway — extractJsonObject handles the common cases, so
    // landing here means the model returned something genuinely unparseable. Log it (never thrown
    // further — arcs are best-effort) so a silent "no arcs" isn't a silent, undiagnosable one too.
    console.error(
      "[arcs] LLM response wasn't parseable JSON:",
      err instanceof Error ? err.message : err,
      "— raw (first 300 chars):",
      raw.slice(0, 300)
    );
    return [];
  }
}

/**
 * Best-effort unwrap of a JSON object the model wrapped in a markdown code fence (```json ... ```
 * or ``` ... ```) or padded with leading/trailing prose despite being told not to. Falls back to the
 * original string when no fence/wrapping is detected, so a clean response is untouched.
 */
function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start !== -1 && end !== -1 && end > start ? body.slice(start, end + 1) : body;
}

/** Ask the configured LLM for the raw arcs JSON; null on any transport failure (best-effort — an LLM
 *  outage or a stale model id must degrade to "no arcs" instead of failing the whole request). */
async function callLLMRaw(userContent: string, keys: ProviderKeys): Promise<string | null> {
  try {
    return LLM_BASE_URL
      ? await callOpenAICompatible(userContent, keys.openaiKey)
      : await callAnthropic(userContent, keys.anthropicKey);
  } catch (err) {
    console.error("[arcs] LLM call failed:", err instanceof Error ? err.message : err);
    return null;
  }
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
  if (!res.ok) {
    // Silent before this fix: a down/misconfigured LLM_BASE_URL endpoint (Ollama/local model —
    // a first-class deployment option, see docs/PROVIDERS.md) degraded to "no arcs" with NO trace
    // anywhere, indistinguishable from every other empty-arcs cause. Log the actual HTTP status +
    // body so this is diagnosable instead of silent.
    const body = await res.text().catch(() => "");
    console.error(
      `[arcs] LLM_BASE_URL call failed: ${res.status} ${res.statusText} —`,
      body.slice(0, 300)
    );
    return null;
  }
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

/**
 * Build the user prompt from the recent facts substrate (+ any human corrections). Facts are NUMBERED
 * `[F1] … [F2] …` so the model can cite them in `supporting_facts` — we map those numbers back to the
 * real facts (and their source items) to build verifiable evidence.
 */
function buildPrompt(facts: AtomicFact[], corrections: string[]): string {
  const lines = [
    "Recent facts from the team knowledge graph (most recent first), each numbered for citation:",
    ...facts.map((f, i) => `[F${i + 1}] ${f.fact}`),
  ];
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
  const [raw, epToItem] = await Promise.all([
    callLLMRaw(buildPrompt(facts, []), keys),
    resolveEpisodeItems(groups, facts.flatMap((f) => f.episodeUuids)),
  ]);
  const arcs = parseArcsJson(raw, { facts, epToItem });
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
  const [raw, epToItem] = await Promise.all([
    callLLMRaw(buildPrompt(facts, corrections.map((c) => c.corrected_text)), keys),
    resolveEpisodeItems(groups, facts.flatMap((f) => f.episodeUuids)),
  ]);
  const arcs = parseArcsJson(raw, { facts, epToItem });
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
