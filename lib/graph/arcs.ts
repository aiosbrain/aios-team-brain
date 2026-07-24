import "server-only";
import { createHash } from "node:crypto";
import { completeTextOrNull } from "@/lib/llm/complete";
import type { LlmBackendKeys } from "@/lib/query/llm-backend";
import type { DbClient } from "@/lib/db/types";
import { adminClient } from "@/lib/db/admin";
import { recentFacts, resolveEpisodeItems, type AtomicFact } from "./learning";
import { GraphitiClient } from "./graphiti-client";
import { episodeGroupId, type AccessTier } from "./group";
import { attributedFactTexts, groundParticipants } from "./arc-attribution";
import { resolveItemCredit } from "@/lib/attribution/contributor-credit";
import { readArcCache, writeArcCache, ARC_CACHE_TTL_MS as CACHE_TTL_MS } from "./arc-cache";
import { arcIneligibleItemIds } from "./arc-eligibility";

/**
 * Layer 3 — narrative arcs. Gathers the recent graph substrate (facts, last 7d, tier-scoped),
 * asks the team's LLM to synthesize 3–5 ongoing storylines, and caches them for 4h. Human edits
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
// HARD ceiling on arcs parsed from the model. The count actually REQUESTED is derived per-synthesis
// from the number of distinct contributors (see `arcsRequested`), so a varied team isn't pinned to a
// flat 8 — one person working six distinct threads can get six arcs instead of one merged blob.
const MAX_ARCS = 12;
// Fetch a MUCH deeper pool than we feed the model, so a lower-volume contributor's facts are reachable
// for balancing. Measured too shallow at MAX_FACTS*6 (1200): one high-volume contributor held 84% of
// the newest-1200 and everyone below the cut fell off the cliff BEFORE balancing could run. A deeper
// pool + a per-item cap keeps the whole active team reachable.
const FACT_POOL = MAX_FACTS * 20;
// Cap the facts any ONE source item contributes to a person's balanced share, BEFORE balancing — so a
// single huge document (a 257k-char ARCHITECTURE.md extracted into 159 facts) can't BE its author's
// entire representation and bury their actual varied work.
const PER_ITEM_CAP = 20;
// Arc SWR window (4h) lives in ./arc-cache (ARC_CACHE_TTL_MS) so `staleArcCache` shares it — imported above.
// LLM timeout for arc synthesis, split by call path. A reasoning model over ~200 facts is genuinely
// slow, so a single tight timeout either (a) blocks the /arcs route to its 120s maxDuration or (b)
// aborts the healthy-but-slow model and records a bogus "timeout" on the answering-model health leg.
// So the INLINE cold-miss path (route-bound) stays under 120s, while the fire-and-forget BACKGROUND
// refresh — served-stale-while-revalidate, NOT route-bound — gets a much wider window. Env-overridable.
const INLINE_ARC_TIMEOUT_MS = Math.max(1_000, Number(process.env.ARC_INLINE_TIMEOUT_MS) || 110_000);
const BG_ARC_TIMEOUT_MS = Math.max(INLINE_ARC_TIMEOUT_MS, Number(process.env.ARC_BG_TIMEOUT_MS) || 280_000);
// How long the empty-clobber guard keeps trusting a prior non-empty arc set. Within this window an
// empty synthesis is treated as a transient failure (keep the prior); beyond it, a persistently-empty
// result is accepted as genuine so the panel can't be pinned to ancient arcs forever (Fable review).
const EMPTY_CLOBBER_MAX_AGE_MS = (() => {
  // Guard the parse: a garbage/empty env yields NaN/0, and `ageMs < NaN` is always false → EVERY empty
  // synthesis would clobber, silently reverting the incident fix. Fall back unless it's finite and >0.
  const n = Number(process.env.ARCS_EMPTY_CLOBBER_MAX_AGE_MS);
  const parsed = Number.isFinite(n) && n > 0 ? n : 48 * 60 * 60_000;
  // CLAMP to ≫ the SWR TTL: `staleArcCache` forces a re-attribution's prior to age `TTL+1min`, so a cap
  // at/below the TTL (a plausible ops value like "2h") would make that forced-stale prior clobber-eligible
  // — one transient empty synthesis would then blank real arcs (the 2026-07 incident). Never let that invert.
  return Math.max(parsed, CACHE_TTL_MS + 2 * 60_000);
})();

/** Requested arc count for one synthesis: scale with the number of distinct contributors in the
 *  balanced facts (≈2 arcs each) so a varied, multi-person team isn't pinned to a flat number —
 *  floored at 6, capped at MAX_ARCS. Pure + unit-tested. */
export function arcsRequested(contributorCount: number): number {
  return Math.min(MAX_ARCS, Math.max(6, 2 * contributorCount));
}

/** The synthesis system prompt, parameterized by how many arcs to request. Explicitly instructs the
 *  model to split ONE contributor's distinct workstreams into separate arcs (the fix for a person's
 *  varied work collapsing into a single arc) rather than merging them. */
function buildSystemPrompt(requested: number): string {
  return (
    `You are analyzing a team knowledge graph. Identify up to ${requested} active narrative arcs — ongoing ` +
    "storylines about what this team is working through. Favor RECENT activity and give every active " +
    "contributor visible representation — don't let one person's arcs crowd out others who've been " +
    "working. If ONE contributor's facts span multiple DISTINCT workstreams (e.g. social vs security vs " +
    "meetings vs graph vs performance), produce a SEPARATE arc per workstream — never merge one person's " +
    "unrelated efforts into a single arc. Each fact below is numbered [F1], [F2], … — for every arc, cite " +
    "the 2-5 fact numbers that support it in `supporting_facts`. A parenthesized name at the START of a " +
    'fact — e.g. "(Chetan) …" — is the human RESPONSIBLE for that work (it may not appear in the fact ' +
    "text itself): include those humans in `participants` for every arc citing their facts. Never invent " +
    "names not present in the facts or their attributions. Return ONLY a JSON object of the form " +
    '{"arcs":[{"title":"short","confidence":"high|medium|low","summary":"2-3 sentences, present tense, ' +
    'specific","participants":["names"],"supporting_facts":[1,2,3]}]}. Use only fact numbers that appear ' +
    "below. No prose, no markdown code fences — the raw JSON object only."
  );
}

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

/** Group items by a string key, preserving first-seen order of both the keys and each key's members.
 *  Pure — the shared primitive under both balancing levels. */
function groupByKey<T>(items: T[], key: (t: T) => string): T[][] {
  const buckets = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = buckets.get(k);
    if (arr) arr.push(it);
    else buckets.set(k, [it]);
  }
  return [...buckets.values()];
}

/** Interleave a set of buckets one-per-bucket-per-round until `budget` is filled or all exhaust,
 *  preserving each bucket's internal order. Pure. */
function roundRobin<T>(buckets: T[][], budget: number): T[] {
  const out: T[] = [];
  for (let round = 0; out.length < budget; round++) {
    let progressed = false;
    for (const b of buckets) {
      if (out.length >= budget) break;
      if (round < b.length) {
        out.push(b[round]);
        progressed = true;
      }
    }
    if (!progressed) break; // every bucket exhausted
  }
  return out;
}

/**
 * Balance a fact pool ACROSS its contributors so synthesis input represents everyone active — not just
 * whoever pushed the most recent volume (the #303 fix). Group by the human behind each fact and
 * round-robin one-per-contributor per round (each person's facts newest-first) until `budget` is
 * filled. Unattributed facts ("") are their own bucket. Pure; `humanOf` injected so DB/Neo4j resolution
 * stays in the caller. Superseded by `balanceFacts` in the synthesis path (kept for direct callers/tests).
 */
export function balanceFactsByContributor<T>(facts: T[], humanOf: (f: T) => string, budget: number): T[] {
  return roundRobin(groupByKey(facts, humanOf), budget);
}

/**
 * Two-level balance — contributor → item. Round-robining by contributor alone is blind to a person
 * whose facts are dominated by ONE giant document: a 257k-char ARCHITECTURE.md extracted into 159 facts
 * would fill that author's entire balanced share and bury their actual varied work. So within each
 * contributor we FIRST cap every source item at `perItemCap` and interleave the person's facts ACROSS
 * their items, THEN round-robin across contributors. The result: each person's slice is a diverse spread
 * of their real items, and no single doc can be someone's whole story. Pure; `itemOf` returns a stable
 * per-item key ("" when unresolved — those share one bucket, matching the unattributed convention).
 */
export function balanceFacts<T>(
  facts: T[],
  humanOf: (f: T) => string,
  itemOf: (f: T) => string,
  budget: number,
  perItemCap = Infinity
): T[] {
  const perContributor = groupByKey(facts, humanOf).map((hb) => {
    const items = groupByKey(hb, itemOf).map((ib) =>
      perItemCap === Infinity ? ib : ib.slice(0, perItemCap)
    );
    // Reorder this contributor's (capped) facts interleaved by item, so item diversity leads.
    return roundRobin(items, Number.POSITIVE_INFINITY);
  });
  return roundRobin(perContributor, budget);
}

/**
 * Drop facts that add no signal before they're numbered into the prompt: (1) self-referential noise
 * where subject === object (Graphiti's "user is a duplicate of user" bookkeeping — a defense-in-depth
 * backstop even though `recentFacts` already filters `IS_DUPLICATE_OF` at the query), and (2) exact
 * repeats of an already-seen fact text (keep the first = newest WORK, since the pool is work-time-first). Each
 * duplicate would otherwise consume a numbered slot and hand the model redundant input. Pure + tested.
 */
export function dedupeFacts(facts: AtomicFact[]): AtomicFact[] {
  const byKey = new Map<string, { fact: AtomicFact; eps: Set<string> }>();
  const order: string[] = [];
  for (const f of facts) {
    const subj = (f.subject ?? "").trim().toLowerCase();
    const obj = (f.object ?? "").trim().toLowerCase();
    if (subj && subj === obj) continue; // self-referential noise
    const key = (f.fact ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!key) continue;
    const kept = byKey.get(key);
    if (kept) {
      // Same fact text from another source → keep the first (newest) but UNION its source episodes, so
      // downstream (arc eligibility, evidence) sees ALL of the fact's sources, not just the first copy's
      // (e.g. a fact cited by both a Done Linear ticket AND a meeting must retain the meeting episode).
      for (const u of f.episodeUuids) kept.eps.add(u);
      continue;
    }
    byKey.set(key, { fact: f, eps: new Set(f.episodeUuids) });
    order.push(key);
  }
  // New objects (immutability) with the unioned episode set.
  return order.map((k) => {
    const e = byKey.get(k)!;
    return { ...e.fact, episodeUuids: [...e.eps] };
  });
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
 * Parse + normalize the LLM's JSON into safe arcs: caps at MAX_ARCS, coerces confidence, defaults missing
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
  system: string,
  userContent: string,
  keys: ProviderKeys,
  record?: { db: DbClient; teamId: string },
  timeoutMs: number = INLINE_ARC_TIMEOUT_MS
): Promise<string | null> {
  return completeTextOrNull(
    { system, prompt: userContent },
    {
      keys,
      jsonObject: true,
      // Arc synthesis reasons over ~200 facts to find storylines — the one task that genuinely
      // benefits from a reasoning model. Route it to the team's reasoning model (falls back to the
      // query model when unset), with reasoning left ON and extra headroom for it.
      role: "reasoning",
      maxTokens: 4096,
      // A reasoning model reasoning over ~200 facts routinely needs far more than completeText's 30s
      // default — at 30s the call was aborted (timeout) and arcs came back empty. The INLINE cold-miss
      // path must stay under the route's 120s maxDuration, but the fire-and-forget background refresh
      // (SWR) isn't route-bound, so it gets a much longer window (BG_ARC_TIMEOUT_MS) — otherwise a
      // slow-but-healthy reasoning model records a "timeout" on the answering-model leg and fires the
      // loud pipeline banner even though the panel is served fine from cache.
      timeoutMs,
      // Record the outcome so a broken answering model (e.g. a reasoning model returning empty) shows
      // as "degraded" on the dashboard instead of silently blanking the Learning page.
      record: record ? { db: record.db, teamId: record.teamId, task: "arcs" } : undefined,
      // Meter the (often reasoning-model, ~200-fact) spend into llm_usage — arcs are a system task
      // with no human initiator, so memberId stays null.
      meter: record ? { db: record.db, teamId: record.teamId, source: "arcs" } : undefined,
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

/** Distinct contributors behind a set of item ids, looked up in an already-resolved per-item CONTRIBUTOR
 *  SET map (no DB access) — shared by the per-arc `participants` rewrite below. The set is evidence-gated
 *  (everyone who did work on the item, not just its current owner), so a prior contributor whose item was
 *  later reassigned still shows on the arc chip. */
function humansForItems(itemIds: (string | undefined)[], contributorsByItem: Map<string, string[]>): string[] {
  return [
    ...new Set(
      itemIds.filter((id): id is string => !!id).flatMap((id) => contributorsByItem.get(id) ?? [])
    ),
  ];
}

/** Attribute each arc's `participants` from its OWN evidence (never cross-arc — an arc's attribution
 *  must trace to ITS OWN work): the participants are the humans who AUTHORED the arc's cited evidence
 *  (`evidenceHumans` — the version-author set, so a reassigned-away contributor stays visible). Names the
 *  model merely echoed from fact prose but that authored none of the cited evidence are DROPPED — a
 *  participant did work the arc cites, not just got mentioned (the misattribution fix). See
 *  `groundParticipants`. Pure over an already-resolved per-item CONTRIBUTOR SET map. */
function attributeArcs(arcs: NarrativeArc[], contributorsByItem: Map<string, string[]>): NarrativeArc[] {
  return arcs.map((arc) => {
    const evidenceHumans = humansForItems(arc.evidence.map((e) => e.itemId), contributorsByItem);
    return { ...arc, participants: groundParticipants(arc.participants, evidenceHumans) };
  });
}

/**
 * Core synthesis pipeline (no caching): recent facts → attributed prompt → LLM → attributed arcs.
 * `correctionTexts` is empty for a normal derive, populated for the human-correction recompute.
 * Sequential, not Promise.all-able: the PROMPT needs each fact's human attribution baked in
 * (attributedFactTexts), so item/human resolution must finish before the LLM call starts — a real
 * latency cost, traded for a synthesis input grounded in a human from the start rather than patched
 * after the fact.
 */
/** The synthesis result: the arcs + a hash of the exact LLM input, so the caller can persist the hash
 *  and the next background refresh can skip an unchanged re-synthesis. */
export interface SynthesisResult {
  arcs: NarrativeArc[];
  factsHash: string | null;
}

/** Pure: may the background refresh REUSE the prior arcs instead of re-running the (non-deterministic)
 *  LLM? Only when the exact LLM input is byte-identical (`factsHash` match), there's no human correction
 *  to apply, and the prior actually had arcs. This is the stability guard — arcs then change only when the
 *  underlying work does, not on every recompute. A null/empty prior hash never reuses. */
export function canReuseArcs(
  prior: { factsHash: string | null; arcCount: number } | null,
  factsHash: string,
  hasCorrections: boolean
): boolean {
  return !hasCorrections && !!prior && !!prior.factsHash && prior.factsHash === factsHash && prior.arcCount > 0;
}

async function synthesizeArcs(
  db: DbClient,
  teamId: string,
  groups: string[],
  correctionTexts: string[],
  keys: ProviderKeys,
  // Route-bound cold-miss callers keep the default (under the 120s route budget); the non-route-bound
  // background refresh passes BG_ARC_TIMEOUT_MS so a slow reasoning model doesn't false-alarm as a timeout.
  llmTimeoutMs: number = INLINE_ARC_TIMEOUT_MS,
  // The prior cached arcs + their fact hash (background refresh only). When the freshly-built prompt hashes
  // identically AND there's no correction, we KEEP the prior arcs and skip the LLM (the stability guard).
  prior?: { arcs: NarrativeArc[]; factsHash: string | null } | null
): Promise<SynthesisResult> {
  // Arcs are NOT time-boxed — synthesize from the most-recent facts regardless of age (a quiet week,
  // or a stalled projector, must not blank the panel). `null` = no window. Fetch a DEEP pool (not just
  // MAX_FACTS), so we can balance it across contributors — otherwise the globally-newest MAX_FACTS are
  // dominated by whoever pushed the most volume and everyone else's work is invisible in Learning.
  // Dedupe the raw pool up front — drops exact-repeat fact texts and self-referential noise so neither
  // balancing counts nor prompt slots are wasted on redundant/garbage facts.
  const pool = dedupeFacts(await recentFacts(groups, null, FACT_POOL));
  // No facts and nothing to correct → nothing to synthesize. (A correction with no facts still runs
  // the LLM, preserving the pre-cache recompute behavior.)
  if (pool.length === 0 && correctionTexts.length === 0) return { arcs: [], factsHash: null };
  // Resolve attribution for the WHOLE pool (higher uuid cap to match) so balancing sees each fact's
  // human. epToItem/creditByItem stay supersets of the balanced set — safe for evidence + attribution.
  const epToItem = await resolveEpisodeItems(groups, pool.flatMap((f) => f.episodeUuids), FACT_POOL * 3);
  const allItemIds = [...new Set([...epToItem.values()].map((v) => v.itemId).filter((id): id is string => !!id))];
  // Evidence-gated credit per item (one query pass): the `primary` WORKER drives balancing + the fact
  // prompt (one fact needs one representative — a reassigned-away worker's facts now balance under THEM,
  // not the non-working new owner), and the `contributors` SET drives arc `participants` (so a prior
  // contributor is still on the chip). Both come from `item_versions` (the work ledger), not the current
  // owner alone.
  const creditByItem = await resolveItemCredit(db, teamId, allItemIds);
  const primaryByItem = new Map<string, string>();
  const contributorsByItem = new Map<string, string[]>();
  for (const [id, credit] of creditByItem) {
    if (credit.primary) primaryByItem.set(id, credit.primary);
    if (credit.contributors.length) contributorsByItem.set(id, credit.contributors);
  }
  // Resolve a fact's (item, human) TOGETHER, preferring the first source item that resolves a HUMAN and
  // only falling back to the first resolvable item when none has one. Resolving them independently would
  // regress attribution: a fact whose episodes are [connector item (no human), John's item] must be
  // balanced under John — not dropped into the unattributed bucket because a human-less item came first
  // (which would also undercount `contributorCount` and disagree with `attributedFactTexts`, which
  // unions humans across ALL episodes). Memoized per fact — both closures below read the same result.
  const actorCache = new Map<string, { item: string; human: string }>();
  const actorOfFact = (f: AtomicFact): { item: string; human: string } => {
    const cached = actorCache.get(f.id);
    if (cached) return cached;
    let firstItem = "";
    let resolved = { item: "", human: "" };
    for (const u of f.episodeUuids) {
      const id = epToItem.get(u)?.itemId;
      if (!id) continue;
      if (!firstItem) firstItem = id;
      const h = primaryByItem.get(id);
      if (h) {
        resolved = { item: id, human: h };
        break;
      }
    }
    if (!resolved.item) resolved = { item: firstItem, human: "" };
    actorCache.set(f.id, resolved);
    return resolved;
  };
  const itemOfFact = (f: AtomicFact): string => actorOfFact(f).item;
  const humanOfFact = (f: AtomicFact): string => actorOfFact(f).human;
  // Drop facts whose evidence is ONLY non-active Linear issues (arcs are "what the team is working
  // through", so backlog/todo/done tickets are context, not narrative). A fact dedup'd across sources is
  // KEPT if ANY of its source items is eligible (or none resolve) — e.g. a fact cited by both a Done
  // Linear issue AND a meeting transcript stays, since the meeting is eligible evidence (filtering on the
  // single attribution item would wrongly drop it). Arc-synthesis-only; excluded content stays in the
  // graph + facts panel. Non-Linear facts pass through.
  const ineligible = await arcIneligibleItemIds(teamId, allItemIds);
  const factItemIds = (f: AtomicFact): string[] =>
    f.episodeUuids.map((u) => epToItem.get(u)?.itemId).filter((id): id is string => !!id);
  const eligiblePool = ineligible.size
    ? pool.filter((f) => {
        const items = factItemIds(f);
        return items.length === 0 || items.some((id) => !ineligible.has(id));
      })
    : pool;
  // If every recent fact traces ONLY to non-active Linear work, there's nothing to synthesize — return
  // [] so it flows into the empty-clobber guard (keep a recent prior, else honest blank), rather than
  // firing a zero-fact LLM call whose fabricated (evidence-less) arcs would clobber the real prior set.
  if (eligiblePool.length === 0 && correctionTexts.length === 0) return { arcs: [], factsHash: null };
  // Two-level balance (contributor → item, per-item capped) → a representative MAX_FACTS so every active
  // contributor is in the prompt AND no single giant document dominates its author's share.
  const facts = balanceFacts(eligiblePool, humanOfFact, itemOfFact, MAX_FACTS, PER_ITEM_CAP);
  // Request arcs proportional to how many distinct contributors actually made the balanced cut, so a
  // varied team gets more than a flat ceiling and each person's distinct threads have room to surface.
  const contributorCount = new Set(facts.map(humanOfFact).filter(Boolean)).size;
  const systemPrompt = buildSystemPrompt(arcsRequested(contributorCount));
  const userPrompt = buildPrompt(attributedFactTexts(facts, epToItem, primaryByItem), correctionTexts);

  // The stability key must cover EVERYTHING that determines the arcs' displayed content:
  //  • systemPrompt — so a deploy that edits the prompt / arc count re-synthesizes (not just fact churn);
  //  • userPrompt   — the attributed fact texts (a re-attribution rewrites the "(Name)" prefixes → new hash);
  //  • contribDigest — the per-item CONTRIBUTOR SET (arc `participants` come from this, NOT the prompt), so a
  //    contributor-set-only correction (e.g. locking to the SAME primary to drop a spurious credit) still
  //    changes the hash and re-synthesizes instead of pinning the wrong chip. All three are deterministic
  //    for an unchanged graph (fact order is uuid-tiebroken; contributor sets are version work order).
  const balancedItems = [...new Set(facts.map(itemOfFact).filter(Boolean))].sort();
  const contribDigest = balancedItems.map((id) => `${id}:${(contributorsByItem.get(id) ?? []).join(",")}`).join("\n");
  const factsHash = createHash("sha256")
    .update(systemPrompt)
    .update("\n--facts--\n")
    .update(userPrompt)
    .update("\n--contributors--\n")
    .update(contribDigest)
    .digest("hex");

  // STABILITY GUARD: identical input (+ no correction, + a real prior) → keep the prior arcs and SKIP the
  // LLM. This is what stops the day-to-day churn (same facts producing different arcs every recompute from
  // LLM non-determinism). The background refresh still runs (fetch/balance/hash), just not the model.
  if (canReuseArcs(prior ? { factsHash: prior.factsHash, arcCount: prior.arcs.length } : null, factsHash, correctionTexts.length > 0)) {
    return { arcs: prior!.arcs, factsHash };
  }

  const raw = await callLLMRaw(systemPrompt, userPrompt, keys, { db, teamId }, llmTimeoutMs);
  // Rank by recency → relevance so recent contributors' arcs lead, then attribute AI-agent names to
  // the humans behind each arc's own evidence.
  return { arcs: rankArcs(attributeArcs(parseArcsJson(raw, { facts, epToItem }), contributorsByItem)), factsHash };
}

// In-memory cache (per process). Keyed by the tier-visible group set. Fronts the Postgres `arc_cache`
// (lib/graph/arc-cache) — the persistent, cross-instance layer that survives restarts.
const cache = new Map<string, { arcs: NarrativeArc[]; at: number; factsHash: string | null }>();
// Group keys currently being recomputed in the background, so concurrent stale reads fire ONE
// recompute (and thus one LLM call), not N.
const refreshing = new Set<string>();

/**
 * Evict THIS process's in-memory arc cache for one team, so it stops serving a warm copy after a
 * re-attribution (the persistent `arc_cache` is separately marked stale — see `staleArcCache`). Keys are
 * sorted joins of `${teamSlug}_${tier}` group ids, so a key belongs to the team iff any comma-segment
 * starts with `${teamSlug}_`. Per-process only (the ≤4h cross-instance bound in the design doc).
 */
/** Does an arc-cache key (a comma-joined set of `${slug}_${tier}` group ids) belong to `teamSlug`? The
 *  `_` separator makes the `${slug}_` prefix test exact — team slugs are `[a-z0-9-]` (no `_`), so
 *  "acme" never matches "acme-corp_team" or "acmex_team". Pure + unit-tested. */
export function arcKeyBelongsToTeam(key: string, teamSlug: string): boolean {
  const prefix = `${teamSlug}_`;
  return key.split(",").some((g) => g.startsWith(prefix));
}

export function evictArcMemoryCache(teamSlug: string): void {
  for (const key of cache.keys()) {
    if (arcKeyBelongsToTeam(key, teamSlug)) cache.delete(key);
  }
}

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
  next: NarrativeArc[],
  factsHash: string | null
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
  cache.set(key, { arcs: next, at: Date.now(), factsHash });
  await writeArcCache(db, teamId, key, next, factsHash);
  return next;
}

/** Fire-and-forget background recompute for a stale cache key (serve-stale-while-revalidate). Uses
 *  its own adminClient so it doesn't depend on the request's client lifecycle. Deduped via
 *  `refreshing`; errors are logged, never thrown (nothing awaits this). */
function refreshArcsInBackground(
  teamId: string,
  key: string,
  groups: string[],
  keys: ProviderKeys,
  prior: { arcs: NarrativeArc[]; factsHash: string | null } | null
): void {
  if (refreshing.has(key)) return;
  refreshing.add(key);
  void (async () => {
    const bg = adminClient();
    try {
      // Not route-bound → give the reasoning model the full window (BG_ARC_TIMEOUT_MS). `prior` lets the
      // fact-set-hash guard skip the LLM when nothing changed since the last compute (stability).
      const { arcs, factsHash } = await synthesizeArcs(bg, teamId, groups, [], keys, BG_ARC_TIMEOUT_MS, prior);
      await commitArcs(bg, teamId, key, arcs, factsHash);
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
    cache.set(key, { arcs: persisted.arcs, at: persisted.computedAt, factsHash: persisted.factsHash });
    if (now - persisted.computedAt < CACHE_TTL_MS) return persisted.arcs;
    // Stale — hand back the stale arcs immediately and refresh behind the request, passing the prior so
    // the refresh can skip the LLM if the facts are unchanged.
    refreshArcsInBackground(teamId, key, groups, keys, { arcs: persisted.arcs, factsHash: persisted.factsHash });
    return persisted.arcs;
  }

  // 3. Cold miss — first-ever load for this key. Compute inline so the user gets a real answer.
  const { arcs, factsHash } = await synthesizeArcs(db, teamId, groups, [], keys);
  return commitArcs(db, teamId, key, arcs, factsHash);
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
  const { arcs: synthesized, factsHash } = await synthesizeArcs(db, teamId, groups, corrections.map((c) => c.corrected_text), keys);
  const arcs = await commitArcs(db, teamId, key, synthesized, factsHash);

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
