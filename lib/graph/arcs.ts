import "server-only";
import { createHash } from "node:crypto";
import { completeTextOrNull } from "@/lib/llm/complete";
import type { LlmBackendKeys } from "@/lib/query/llm-backend";
import type { DbClient } from "@/lib/db/types";
import { adminClient } from "@/lib/db/admin";
import { recentFacts, resolveEpisodeItems, type AtomicFact } from "./learning";
import { GraphitiClient } from "./graphiti-client";
import { episodeGroupId, type AccessTier } from "./group";
import { attributeParticipants, attributedFactTexts } from "./arc-attribution";
import { resolveHumanActorsByItem } from "./human-actors";
import { readArcCache, writeArcCache } from "./arc-cache";

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

/** Full backend keys — resolve via `lib/query/answering.resolveAnsweringKeys` at the call site. */
export type ProviderKeys = LlmBackendKeys;

const MAX_FACTS = 200;
const MAX_ARCS = 8;
// Fetch a much deeper pool than we feed the model, so lower-volume contributors' facts are reachable
// for balancing (a high-volume person's recent burst can otherwise push everyone else past MAX_FACTS).
const FACT_POOL = MAX_FACTS * 6;
const CACHE_TTL_MS = 10 * 60_000;
// How long the empty-clobber guard keeps trusting a prior non-empty arc set. Within this window an
// empty synthesis is treated as a transient failure (keep the prior); beyond it, a persistently-empty
// result is accepted as genuine so the panel can't be pinned to ancient arcs forever (Fable review).
const EMPTY_CLOBBER_MAX_AGE_MS = (() => {
  // Guard the parse: a garbage/empty env yields NaN/0, and `ageMs < NaN` is always false → EVERY empty
  // synthesis would clobber, silently reverting the incident fix. Fall back unless it's finite and >0.
  const n = Number(process.env.ARCS_EMPTY_CLOBBER_MAX_AGE_MS);
  return Number.isFinite(n) && n > 0 ? n : 48 * 60 * 60_000;
})();

const SYSTEM_PROMPT =
  `You are analyzing a team knowledge graph. Identify ${MAX_ARCS} active narrative arcs — ongoing ` +
  "storylines about what this team is working through. Favor RECENT activity and give every active " +
  "contributor visible representation — don't let one person's arcs crowd out others who've been " +
  "working. Each fact below is numbered [F1], [F2], … — for every arc, cite the 2-5 fact numbers that " +
  "support it in `supporting_facts`. Return ONLY a JSON object of the form " +
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

/**
 * Balance a fact pool ACROSS its contributors so synthesis input represents everyone active — not just
 * whoever pushed the most recent volume. Without this, arc synthesis fed the globally-newest MAX_FACTS
 * facts, so a high-volume contributor's recent burst crowded every lower-volume person out of the
 * prompt entirely (their work then never appeared in Learning even though it's in the graph). We group
 * the pool by the human behind each fact and round-robin one-per-contributor per round (each person's
 * facts consumed newest-first) until `budget` is filled. Unattributed facts ("") are their own bucket.
 * Pure + unit-tested; `humanOf` is injected so the DB/Neo4j resolution stays in the caller.
 */
export function balanceFactsByContributor<T>(facts: T[], humanOf: (f: T) => string, budget: number): T[] {
  const buckets = new Map<string, T[]>();
  for (const f of facts) {
    const key = humanOf(f);
    const arr = buckets.get(key);
    if (arr) arr.push(f);
    else buckets.set(key, [f]);
  }
  const lists = [...buckets.values()]; // insertion order ≈ first-seen recency, newest bucket first
  const out: T[] = [];
  for (let round = 0; out.length < budget; round++) {
    let progressed = false;
    for (const list of lists) {
      if (out.length >= budget) break;
      if (round < list.length) {
        out.push(list[round]);
        progressed = true;
      }
    }
    if (!progressed) break; // every bucket exhausted
  }
  return out;
}

const CONFIDENCE_WEIGHT: Record<NarrativeArc["confidence"], number> = { high: 3, medium: 2, low: 1 };

/** The newest dated evidence timestamp in an arc (ms), or -Infinity if it cites no dated evidence.
 *  This is the arc's "recency" — how recently the work it describes actually happened. Pure. */
export function newestEvidenceAt(arc: NarrativeArc): number {
  let max = -Infinity;
  for (const e of arc.evidence) {
    if (!e.at) continue;
    const t = Date.parse(e.at);
    if (!Number.isNaN(t) && t > max) max = t;
  }
  return max;
}

/**
 * Order arcs for display by RECENCY then RELEVANCE, so a contributor's recent work surfaces above
 * stale storylines instead of being buried under whoever was loudest weeks ago:
 *   1. newest cited evidence first (recency — arcs with no dated evidence sort last),
 *   2. then confidence high→low (relevance),
 *   3. then more supporting evidence first (depth),
 *   4. stable on the model's original order as the final tiebreak.
 * Pure + unit-tested.
 */
export function rankArcs(arcs: NarrativeArc[]): NarrativeArc[] {
  return arcs
    .map((arc, i) => ({ arc, i }))
    .sort((a, b) => {
      const ra = newestEvidenceAt(a.arc);
      const rb = newestEvidenceAt(b.arc);
      if (rb !== ra) return rb - ra; // recency desc
      const ca = CONFIDENCE_WEIGHT[a.arc.confidence];
      const cb = CONFIDENCE_WEIGHT[b.arc.confidence];
      if (cb !== ca) return cb - ca; // confidence desc
      if (b.arc.evidence.length !== a.arc.evidence.length) return b.arc.evidence.length - a.arc.evidence.length;
      return a.i - b.i; // stable
    })
    .map((x) => x.arc);
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
    return obj.arcs.slice(0, MAX_ARCS).map((a) => {
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
 *  outage or a stale model id must degrade to "no arcs" instead of failing the whole request). Routes
 *  through the shared settings-aware primitive, so arcs honor the team's answering-provider (incl.
 *  OpenRouter) exactly like the Query box. */
async function callLLMRaw(
  userContent: string,
  keys: ProviderKeys,
  record?: { db: DbClient; teamId: string }
): Promise<string | null> {
  return completeTextOrNull(
    { system: SYSTEM_PROMPT, prompt: userContent },
    {
      keys,
      jsonObject: true,
      // Arc synthesis reasons over ~200 facts to find storylines — the one task that genuinely
      // benefits from a reasoning model. Route it to the team's reasoning model (falls back to the
      // query model when unset), with reasoning left ON and extra headroom for it.
      role: "reasoning",
      maxTokens: 4096,
      // A reasoning model reasoning over ~200 facts routinely needs far more than completeText's 30s
      // default — at 30s the call was aborted (timeout) and arcs came back empty. 110s covers the
      // observed latency while staying under the route's 120s maxDuration; the fire-and-forget
      // background refresh (SWR) isn't route-bound, so it can use the full window.
      timeoutMs: 110_000,
      // Record the outcome so a broken answering model (e.g. a reasoning model returning empty) shows
      // as "degraded" on the dashboard instead of silently blanking the Learning page.
      record: record ? { db: record.db, teamId: record.teamId, task: "arcs" } : undefined,
    }
  );
}

/**
 * Build the user prompt from the recent facts' (already-attributed, see `attributedFactTexts`) text
 * + any human corrections. Facts are NUMBERED `[F1] … [F2] …` so the model can cite them in
 * `supporting_facts` — we map those numbers back to the real facts (and their source items) to build
 * verifiable evidence.
 */
function buildPrompt(factTexts: string[], corrections: string[]): string {
  const lines = [
    "Recent facts from the team knowledge graph (most recent first), each numbered for citation:",
    ...factTexts.map((t, i) => `[F${i + 1}] ${t}`),
  ];
  if (corrections.length) {
    lines.push("", "Human corrections to incorporate:", ...corrections.map((c) => `- ${c}`));
  }
  return lines.join("\n");
}

/** Distinct humans behind a set of item ids, looked up in an already-resolved `humanByItem` map
 *  (no DB access) — shared by the per-arc `participants` rewrite below. */
function humansForItems(itemIds: (string | undefined)[], humanByItem: Map<string, string>): string[] {
  return [
    ...new Set(
      itemIds.filter((id): id is string => !!id).map((id) => humanByItem.get(id)).filter((h): h is string => !!h)
    ),
  ];
}

/** Rewrite each arc's `participants` to tag recognized AI-agent names with the human(s) behind that
 *  arc's own evidence items (never cross-arc — an arc's attribution must trace to ITS OWN work).
 *  Pure over an already-resolved `humanByItem` map — no DB access here. */
function attributeArcs(arcs: NarrativeArc[], humanByItem: Map<string, string>): NarrativeArc[] {
  return arcs.map((arc) => ({
    ...arc,
    participants: attributeParticipants(
      arc.participants,
      humansForItems(arc.evidence.map((e) => e.itemId), humanByItem)
    ),
  }));
}

/**
 * Core synthesis pipeline (no caching): recent facts → attributed prompt → LLM → attributed arcs.
 * `correctionTexts` is empty for a normal derive, populated for the human-correction recompute.
 * Sequential, not Promise.all-able: the PROMPT needs each fact's human attribution baked in
 * (attributedFactTexts), so item/human resolution must finish before the LLM call starts — a real
 * latency cost, traded for a synthesis input grounded in a human from the start rather than patched
 * after the fact.
 */
async function synthesizeArcs(
  db: DbClient,
  teamId: string,
  groups: string[],
  correctionTexts: string[],
  keys: ProviderKeys
): Promise<NarrativeArc[]> {
  // Arcs are NOT time-boxed — synthesize from the most-recent facts regardless of age (a quiet week,
  // or a stalled projector, must not blank the panel). `null` = no window. Fetch a DEEP pool (not just
  // MAX_FACTS), so we can balance it across contributors — otherwise the globally-newest MAX_FACTS are
  // dominated by whoever pushed the most volume and everyone else's work is invisible in Learning.
  const pool = await recentFacts(groups, null, FACT_POOL);
  // No facts and nothing to correct → nothing to synthesize. (A correction with no facts still runs
  // the LLM, preserving the pre-cache recompute behavior.)
  if (pool.length === 0 && correctionTexts.length === 0) return [];
  // Resolve attribution for the WHOLE pool (higher uuid cap to match) so balancing sees each fact's
  // human. epToItem/humanByItem stay supersets of the balanced set — safe for evidence + attribution.
  const epToItem = await resolveEpisodeItems(groups, pool.flatMap((f) => f.episodeUuids), FACT_POOL * 3);
  const allItemIds = [...new Set([...epToItem.values()].map((v) => v.itemId).filter((id): id is string => !!id))];
  const humanByItem = await resolveHumanActorsByItem(db, teamId, allItemIds);
  // The human behind a fact = the first resolvable human among its source episodes' items ("" if none).
  const humanOfFact = (f: AtomicFact): string => {
    for (const u of f.episodeUuids) {
      const itemId = epToItem.get(u)?.itemId;
      const h = itemId ? humanByItem.get(itemId) : undefined;
      if (h) return h;
    }
    return "";
  };
  // Balance the deep pool → a representative MAX_FACTS so every active contributor is in the prompt.
  const facts = balanceFactsByContributor(pool, humanOfFact, MAX_FACTS);
  const raw = await callLLMRaw(
    buildPrompt(attributedFactTexts(facts, epToItem, humanByItem), correctionTexts),
    keys,
    { db, teamId }
  );
  // Rank by recency → relevance so recent contributors' arcs lead, then attribute AI-agent names to
  // the humans behind each arc's own evidence.
  return rankArcs(attributeArcs(parseArcsJson(raw, { facts, epToItem }), humanByItem));
}

// In-memory cache (per process). Keyed by the tier-visible group set. Fronts the Postgres `arc_cache`
// (lib/graph/arc-cache) — the persistent, cross-instance layer that survives restarts.
const cache = new Map<string, { arcs: NarrativeArc[]; at: number }>();
// Group keys currently being recomputed in the background, so concurrent stale reads fire ONE
// recompute (and thus one LLM call), not N.
const refreshing = new Set<string>();

/**
 * Persist a freshly-synthesized arc set to both caches — but NEVER let an EMPTY result clobber a
 * non-empty one. An empty synthesis is almost always a transient upstream failure (LLM outage, a
 * reasoning model starving its own output, a graph blip), and a stale-but-real arc set beats a blank
 * panel. On that case we keep the prior value and DON'T refresh its timestamp, so the next view
 * retries until synthesis recovers. This is the guard that stops one bad LLM call from pinning the
 * Learning page empty for hours (2026-07 incident). Returns what's now authoritative for the key.
 */
export async function commitArcs(
  db: DbClient,
  teamId: string,
  key: string,
  next: NarrativeArc[]
): Promise<NarrativeArc[]> {
  if (next.length === 0) {
    const mem = cache.get(key);
    const prior =
      mem ??
      (await readArcCache(db, teamId, key).then((r) => (r ? { arcs: r.arcs, at: r.computedAt } : null)));
    if (prior && prior.arcs.length > 0) {
      const ageMs = Date.now() - prior.at;
      if (ageMs < EMPTY_CLOBBER_MAX_AGE_MS) {
        // Recent prior → an empty synthesis is almost always a transient upstream failure (LLM outage,
        // a reasoning model starving its output, a graph blip). Keep the stale-but-real set and DON'T
        // refresh the timestamp, so the next view retries until synthesis recovers.
        console.warn(
          `[arcs] synthesis returned 0 arcs for ${key}; keeping ${prior.arcs.length} cached (${Math.round(ageMs / 3_600_000)}h old; likely transient)`
        );
        return prior.arcs;
      }
      // Prior is too old to keep trusting as "transient-failure cover": a persistently-empty synthesis
      // over this long is more likely GENUINE (quiet team, content deleted, graph reset, or the model
      // correctly concluding "no active arcs"). Let the empty through so the panel reflects reality
      // instead of pinning ancient arcs — and re-arming the background refresh loop — forever.
      console.warn(
        `[arcs] synthesis returned 0 arcs for ${key}; prior ${prior.arcs.length} arcs are ${Math.round(ageMs / 3_600_000)}h old (> cap) — accepting empty`
      );
    }
  }
  cache.set(key, { arcs: next, at: Date.now() });
  await writeArcCache(db, teamId, key, next);
  return next;
}

/** Fire-and-forget background recompute for a stale cache key (serve-stale-while-revalidate). Uses
 *  its own adminClient so it doesn't depend on the request's client lifecycle. Deduped via
 *  `refreshing`; errors are logged, never thrown (nothing awaits this). */
function refreshArcsInBackground(teamId: string, key: string, groups: string[], keys: ProviderKeys): void {
  if (refreshing.has(key)) return;
  refreshing.add(key);
  void (async () => {
    const bg = adminClient();
    try {
      const arcs = await synthesizeArcs(bg, teamId, groups, [], keys);
      await commitArcs(bg, teamId, key, arcs);
    } catch (err) {
      console.error("[arcs] background refresh failed:", err instanceof Error ? err.message : err);
    } finally {
      refreshing.delete(key);
    }
  })();
}

/**
 * Return arcs for a team+tier, serve-stale-while-revalidate:
 *   1. fresh in-memory (this process) → return instantly;
 *   2. Postgres `arc_cache` — fresh → return; stale → return stale NOW + refresh in the background;
 *   3. cold miss → compute inline, then persist to both caches.
 * Empty when the graph/LLM is unavailable. Chose SWR over a global timer-driven refresh so LLM calls
 * only happen for teams actually being viewed (not every team on a timer). See docs/design/brain-learning-panel.md.
 */
export async function getArcs(
  db: DbClient,
  teamId: string,
  teamSlug: string,
  tier: AccessTier,
  groups: string[],
  keys: ProviderKeys
): Promise<NarrativeArc[]> {
  if (groups.length === 0) return [];
  const key = groups.slice().sort().join(",");
  const now = Date.now();

  // 1. In-memory (fastest, same process).
  const mem = cache.get(key);
  if (mem && now - mem.at < CACHE_TTL_MS) return mem.arcs;

  // 2. Persistent cache (survives restart, shared across instances).
  const persisted = await readArcCache(db, teamId, key);
  if (persisted) {
    cache.set(key, { arcs: persisted.arcs, at: persisted.computedAt });
    if (now - persisted.computedAt < CACHE_TTL_MS) return persisted.arcs;
    // Stale — hand back the stale arcs immediately and refresh behind the request.
    refreshArcsInBackground(teamId, key, groups, keys);
    return persisted.arcs;
  }

  // 3. Cold miss — first-ever load for this key. Compute inline so the user gets a real answer.
  const arcs = await synthesizeArcs(db, teamId, groups, [], keys);
  return commitArcs(db, teamId, key, arcs);
}

/**
 * Recompute arcs with human corrections: re-derive (corrections in the prompt), refresh both caches,
 * AND persist each correction to Graphiti as a `correction:<arc_id>` episode (team-tier group) so it
 * informs future synthesis. Writeback is best-effort — a Graphiti hiccup doesn't fail the recompute.
 */
export async function recomputeArcs(
  db: DbClient,
  teamId: string,
  teamSlug: string,
  tier: AccessTier,
  groups: string[],
  corrections: ArcCorrection[],
  keys: ProviderKeys
): Promise<NarrativeArc[]> {
  if (groups.length === 0) return [];
  const key = groups.slice().sort().join(",");
  const synthesized = await synthesizeArcs(db, teamId, groups, corrections.map((c) => c.corrected_text), keys);
  const arcs = await commitArcs(db, teamId, key, synthesized);

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
