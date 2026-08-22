import "server-only";
import type { DbClient } from "@/lib/db/types";
import { GraphitiClient, type GraphFact } from "@/lib/graph/graphiti-client";
import { selectEnforcedGraphPartitions } from "@/lib/graph/partition-read";
import { isRestrictedTier } from "@/lib/auth/visibility";
import { runSql } from "@/lib/db/pg/pool";
import { newSqlParams, provenanceRowSqlFromIds, type MemberTag, type TokenTag } from "@/lib/access/provenance-sql";
import {
  selectedProviderName,
  type RetrievalProvider,
  type Source,
  type RetrievedContext,
} from "./provider";
import { externalProvider } from "./external-provider";
import { denseSearch, fuseByRrf } from "./dense-search";
import { rankedFtsSearch } from "./fts-search";
import { analyzeTermSpecificity } from "./grounding";
import { taskStatusCounts, matchingDecisions } from "./structured-extras";

// Types live in ./provider (the pluggable seam). Re-exported here so existing importers
// (lib/query/claude, tests, …) keep importing them from "@/lib/query/retrieve" unchanged.
export type { Source, RetrievedContext };

const MAX_SOURCE_CHARS = 8_000;
const MAX_TOTAL_CHARS = 160_000; // ~40k tokens context cap
// How many ranked keyword candidates to pull before the char budget truncates. Was 20 — too small
// once many channels make a broad query legitimately match dozens of items; the top-20 then dropped
// relevant evidence. `MAX_TOTAL_CHARS` is the real output ceiling (it truncates large corpora), so a
// larger candidate pool just lets more of a many-small-item corpus through, best-ranked first. Tune
// via FTS_CANDIDATE_LIMIT. (The recall CEILING beyond this is the dense/rerank job, not keyword FTS.)
const FTS_CANDIDATE_LIMIT = Number(process.env.FTS_CANDIDATE_LIMIT ?? 50);
// When the question names a source (`parseSourceScope`), how many of its MOST-RECENT items to pull in
// by recency (bypassing FTS rank) so "what's the conversation in slack" surfaces the latest threads.
const SOURCE_RECENCY_LIMIT = Number(process.env.SOURCE_RECENCY_LIMIT ?? 8);
const GIT_WINDOW_DAYS = 90; // recency window for the per-contributor git-activity digest
const PEOPLE_WINDOW_DAYS = 90; // recency window for the per-person cross-tool activity digest

// Optional external retrieval augmentation (e.g. a local GBrain adapter or a
// cloud retrieval service). Vendor-neutral HTTP contract:
//   POST { query, limit, tier } -> { sources: [{ path, text, score?, project?, kind? }] }
// Unset → Postgres-only retrieval (the default; works with local OR cloud LLMs).
const RETRIEVAL_AUGMENT_URL = process.env.RETRIEVAL_AUGMENT_URL;
const RETRIEVAL_AUGMENT_TOKEN = process.env.RETRIEVAL_AUGMENT_TOKEN;
const RETRIEVAL_AUGMENT_TIMEOUT_MS = Number(process.env.RETRIEVAL_AUGMENT_TIMEOUT_MS ?? 3000);
const RETRIEVAL_AUGMENT_LIMIT = Number(process.env.RETRIEVAL_AUGMENT_LIMIT ?? 6);

// Optional cross-encoder reranker (ZeroEntropy/llama.cpp/Cohere wire shape):
//   POST { model, query, documents: string[] } -> { results: [{ index, relevance_score }] }
// Local default: a llama-server --reranking instance (e.g. Qwen3-Reranker).
// Cloud: point at a hosted rerank endpoint. Unset → keep Postgres order.
const RERANK_URL = process.env.RERANK_URL;
const RERANK_MODEL = process.env.RERANK_MODEL ?? "qwen3-reranker-0.6b";
const RERANK_TIMEOUT_MS = Number(process.env.RERANK_TIMEOUT_MS ?? 4000);
const RERANK_TOKEN = process.env.RERANK_TOKEN; // bearer for hosted rerankers

type AugmentHit = { path?: string; text?: string; score?: number; project?: string; kind?: string };

/**
 * Reorder sources by cross-encoder relevance. Best-effort: on timeout/error/
 * misconfig it returns the input order unchanged. sids are reassigned so the
 * most relevant source is S1 (keeps the LLM's citations stable & meaningful).
 */
async function rerankSources(question: string, sources: Source[]): Promise<Source[]> {
  if (!RERANK_URL || sources.length < 2) return sources;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RERANK_TIMEOUT_MS);
  try {
    const res = await fetch(RERANK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(RERANK_TOKEN ? { Authorization: `Bearer ${RERANK_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        model: RERANK_MODEL,
        query: question,
        documents: sources.map((s) => s.text),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return sources;
    const data = (await res.json()) as { results?: { index: number; relevance_score: number }[] };
    if (!Array.isArray(data.results) || !data.results.length) return sources;
    const ordered = [...data.results]
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .map((r) => sources[r.index])
      .filter(Boolean);
    // Append any sources the reranker omitted, preserving them.
    for (const s of sources) if (!ordered.includes(s)) ordered.push(s);
    return ordered.map((s, i) => ({ ...s, sid: `S${i + 1}` }));
  } catch {
    return sources; // degrade gracefully to the Postgres order
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort augmentation from an external retrieval service. Never throws:
 * on timeout/error/misconfig it returns [] so the brain falls back to its
 * Postgres retrieval. This is the seam that makes retrieval source pluggable
 * (local GBrain via the adapter, or any cloud retrieval endpoint).
 */
async function fetchAugmentedSources(
  question: string,
  tier: "team" | "external"
): Promise<AugmentHit[]> {
  if (!RETRIEVAL_AUGMENT_URL) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RETRIEVAL_AUGMENT_TIMEOUT_MS);
  try {
    const res = await fetch(RETRIEVAL_AUGMENT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(RETRIEVAL_AUGMENT_TOKEN ? { Authorization: `Bearer ${RETRIEVAL_AUGMENT_TOKEN}` } : {}),
      },
      body: JSON.stringify({ query: question, limit: RETRIEVAL_AUGMENT_LIMIT, tier }),
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { sources?: AugmentHit[] };
    return Array.isArray(data.sources) ? data.sources : [];
  } catch {
    return []; // timeout or network error → degrade to Postgres-only
  } finally {
    clearTimeout(timer);
  }
}

// Graphiti graph-memory blend (temporal knowledge graph over ALL ingestions). Best-effort:
// tier-scoped via group_ids, short timeout, never throws — a clean [] when GRAPHITI_URL is unset
// or the call fails, so retrieval degrades to Postgres-only. Facts join the structured digest.
const GRAPH_FACTS_LIMIT = Number(process.env.GRAPH_QUERY_FACTS ?? 12);
const GRAPH_QUERY_TIMEOUT_MS = Number(process.env.GRAPH_QUERY_TIMEOUT_MS ?? 4000);


/**
 * Enforcement input (PCCC-6 + QMIR-1): the item set gates the item legs; `graphProjectIds` —
 * present ONLY for a team-tier MEMBER on an enforcing team — re-enables the Graphiti leg over
 * their K-capped ready partitions. `principal` discriminates the org-structural mirror legs
 * (QMIR-1, docs/design/query-mirror-legs-classification.md): "member" regains actors +
 * REPORTS_TO (tier-classed data — enforcement narrows item/graph partitions, never org
 * visibility); anything else — "token", absent, or a foreign value — takes token semantics
 * (default-deny; the serve test is the POSITIVE `=== "member"`, guard-pinned). Routes assign it;
 * a caller never chooses its own arm.
 */
/**
 * ⚠️ A DISCRIMINATED UNION, so the token's authority is REQUIRED BY THE TYPE (Codex diff review).
 *
 * It was an optional field first, which meant `{ visibleItemIds, principal: "token" }` type-checked
 * and silently restored pre-AUDITFIX-7 behaviour — the arm closes, no test reddens, and it looks
 * exactly like the shipped default. An AST guard caught it in the two files it analyses; the type
 * system now catches it everywhere, including the provider seam that omitted the field entirely.
 *
 * `tokenProjectIds` MAY be empty — an empty set closes the arm, which is the correct fail-closed
 * outcome for a token with no reachable projects. What it may not be is ABSENT.
 */
export type RetrieveEnforce =
  | {
      visibleItemIds: ReadonlySet<string>;
      graphProjectIds?: readonly string[];
      principal: MemberTag;
      tokenProjectIds?: undefined;
    }
  | {
      visibleItemIds: ReadonlySet<string>;
      graphProjectIds?: readonly string[];
      principal: TokenTag;
      /** The token's effective project set. REQUIRED: an omitted forward looks exactly like the
       *  fail-closed default and so reddens nothing on its own (the M13 lesson). */
      tokenProjectIds: readonly string[];
    };

/** The wire half of the graph leg, injectable for tests (the client was previously constructed
 *  inline, making the partition wiring unpinnable). */
export async function fetchGraphFactsForGroups(
  question: string,
  groupIds: readonly string[],
  client?: GraphitiClient
): Promise<GraphFact[]> {
  const c = client ?? new GraphitiClient({ timeoutMs: GRAPH_QUERY_TIMEOUT_MS });
  if (!c.configured || groupIds.length === 0) return [];
  try {
    return await c.search(question, [...groupIds], GRAPH_FACTS_LIMIT);
  } catch {
    return [];
  }
}

// Question words + common stopwords dropped before building the FTS query — they carry no signal
// and (under AND semantics) tanked recall (e.g. "what has john been posting to slack" required the
// literal "posting"/"slack" in the body). We keep all other terms.
const FTS_STOP = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "was", "were",
  "be", "been", "being", "what", "who", "whom", "whose", "when", "where", "why", "how", "which",
  "did", "do", "does", "has", "have", "had", "with", "about", "from", "by", "our", "we", "you",
  "i", "me", "my", "your", "their", "this", "that", "these", "those", "it", "its", "as", "at",
  "any", "all", "can", "could", "would", "should", "tell", "show", "give", "list", "get",
  // Temporal/recency deictics: query INTENT, not content — they never match usefully as keywords
  // and (df≈0) would otherwise poison the grounding signal (Gap #3). Recency is handled by the
  // recency fallback + activity digests, not by matching the literal word.
  "latest", "recent", "recently", "lately", "today", "yesterday", "tomorrow", "currently", "now", "soon", "upcoming",
]);

/**
 * Is this raw token (original case preserved) worth searching on?
 *   • never a stopword
 *   • ≥3 chars → yes
 *   • exactly 2 chars → only if it's a version/product token with a digit (v2, s3, k8) OR an
 *     acronym the user upper-cased (CI, QA, PR, DB) — NOT a lowercase common word (us, up, so, no).
 *   • 1 char → no (single letters are noise)
 * The 2-char rule is the fix for eng-heavy channels where CI/QA/PR/S3 are the load-bearing terms;
 * dropping them (the old `length >= 3` filter) meant a query ABOUT them searched on filler words.
 */
function isSignificantTerm(original: string): boolean {
  const t = original.toLowerCase();
  if (FTS_STOP.has(t)) return false;
  if (t.length >= 3) return true;
  if (t.length === 2) return /\d/.test(t) || original === original.toUpperCase();
  return false;
}

/**
 * Build a recall-friendly FTS query: significant terms OR-joined. `websearch_to_tsquery` treats the
 * word "or" as the OR operator, so this matches docs containing ANY significant term (then the LLM
 * filters relevance) instead of requiring ALL of them. Falls back to the raw question when nothing
 * significant remains. (Ranked/semantic retrieval — pgvector — is the durable fix at larger scale.)
 */
export function significantTerms(question: string): string[] {
  // Match on the ORIGINAL (case preserved) so `isSignificantTerm` can tell an upper-cased acronym
  // (CI) from a lowercase common word (us); lowercase only after the keep/drop decision. De-duped.
  const terms = (question.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) ?? [])
    .filter(isSignificantTerm)
    .map((t) => t.toLowerCase());
  return [...new Set(terms)];
}

/**
 * Conjunctive intent (Gap: OR-semantics can't require BOTH topics). An explicit upper-cased `AND`
 * between topics is an opt-in precision operator (like a search engine's AND): narrow to docs that
 * contain ALL the named topics, instead of the OR default's recall bias. Returns the de-duped term
 * list when the operator is present with a real topic on each side, else null (→ OR path unchanged).
 *
 * Deliberately ONLY upper-cased `AND`, never lowercase "and": "and" is a ubiquitous stopword (it is
 * in FTS_STOP), so treating every "and" as a hard conjunction would gut recall on ordinary questions
 * ("what did john and mary decide"). Conservative, mirroring parseChannelScope (Gap #4) — no false
 * positives. Multi-word sides collapse to a flat AND of every significant term (websearch_to_tsquery
 * has no grouping), so "auth flow AND payments" requires auth+flow+payments; single-word sides (the
 * common "auth AND payments") are exact. Pure + unit-tested.
 */
export function conjunctiveTerms(question: string): string[] | null {
  if (!/\bAND\b/.test(question)) return null; // case-sensitive: only the upper-cased operator
  const sides = question.split(/\bAND\b/).map(significantTerms);
  if (sides.length < 2 || sides.some((s) => s.length === 0)) return null; // a real topic each side
  const all = [...new Set(sides.flat())];
  return all.length >= 2 ? all : null;
}

/**
 * The FTS query the retrieval leg runs. `websearch_to_tsquery('english', …)` reads the literal word
 * "or" as OR and space/"and" as AND, so the join word alone flips the operator — no SQL change. OR by
 * default (recall bias; the LLM filters relevance); AND only when `conjunctiveTerms` fires (precision).
 */
export function buildFtsQuery(question: string): { query: string; terms: string[]; conjunctive: boolean } {
  const conj = conjunctiveTerms(question);
  if (conj) return { query: conj.join(" and "), terms: conj, conjunctive: true };
  const terms = significantTerms(question);
  return { query: terms.length ? terms.join(" or ") : question, terms, conjunctive: false };
}

export function toOrQuery(question: string): string {
  return buildFtsQuery(question).query;
}

/**
 * Detect an EXPLICIT channel scope in the question and strip it (Gap #4). Conservative on purpose —
 * only `#channel` (Slack style) or "in/on/from [the] X channel" qualify, so "the sales pipeline"
 * (no literal "channel") never wrongly scopes. Returns the lowercased channel name (matched against
 * a path's 2nd segment `<source>/<name>/…` in retrieval) and the question with the scope phrase
 * removed, so the channel word doesn't also leak in as a content search term. Pure + unit-tested.
 */
export function parseChannelScope(question: string): { channel: string | null; cleaned: string } {
  const hash = question.match(/#([a-z0-9][a-z0-9_-]{1,40})\b/i);
  if (hash) {
    return { channel: hash[1].toLowerCase(), cleaned: question.replace(hash[0], " ").replace(/\s{2,}/g, " ").trim() };
  }
  const phrase = question.match(/\b(?:in|on|from|to)\s+(?:the\s+)?([a-z0-9][a-z0-9_-]{1,40})\s+channel\b/i);
  if (phrase) {
    return { channel: phrase[1].toLowerCase(), cleaned: question.replace(phrase[0], " ").replace(/\s{2,}/g, " ").trim() };
  }
  return { channel: null, cleaned: question };
}

/**
 * The PATH SEGMENT a channel name lives under, for the soft recency legs.
 *
 * `parseChannelScope` yields a NAME ("#growth" → `growth`), and for sources that key paths by name
 * (`linear/aio/…`) that name IS the 2nd path segment. Slack is different: its paths are keyed on the
 * immutable channel ID so a rename can't re-key every thread into duplicate items, which leaves the
 * segment opaque (`slack/c0b8v119g4d/…`) and the readable name in `frontmatter.channel`. So resolve
 * name → segment once; a name that resolves to nothing (non-Slack sources) falls back to itself,
 * preserving the previous behavior exactly.
 *
 * One small indexed lookup, and ONLY when the question actually names a channel. It exists because
 * the pg adapter has no `.or()` — the precise FTS leg matches both arms in one SQL predicate.
 */
async function resolveChannelSegment(
  db: DbClient,
  teamId: string,
  tier: "team" | "external",
  channel: string,
  visArr?: string[] | null
): Promise<string> {
  // Mode-keyed like every content leg since PRET-4 §1b (no RLS backstop): enforcing (visArr
  // present) → the oracle set alone — the posture conjunct would re-block ruling 2's granted
  // team rows; permissive → the two-bucket posture wall alone.
  let q = db.from("items").select("path").eq("team_id", teamId).eq("frontmatter->>channel", channel).limit(1);
  if (visArr) q = q.in("id", visArr); // enforcement: don't resolve a segment from an invisible item (Codex Medium)
  const { data } = await q;
  const path = (data as { path: string }[] | null)?.[0]?.path;
  const seg = path ? path.split("/")[1] : "";
  return seg || channel;
}

/**
 * Detect an explicit SOURCE scope — a query naming an ingestion source it wants the recent content
 * FROM ("what's the conversation in slack right now", "latest notion docs", "what's on linear"). Generic
 * content-similarity ranking BURIES such items: a Slack thread matches the query only on the single word
 * "slack" in its `— Slack thread` heading, so it ranks below the FTS candidate cut (`FTS_CANDIDATE_LIMIT`)
 * and never reaches the model — which then truthfully says it has no Slack, even though we ingest it.
 * When a source is named, `nativeRetrieve` adds a RECENCY leg for it (most-recent items of that source,
 * by `synced_at`, bypassing FTS rank). The source word is NOT stripped from the query (unlike a channel
 * scope) — it's also a legit content term. Conservative: a concrete source brand-name as a whole word
 * AND a recency/scope signal ("in/on/from/latest/recent/now/conversation/messages/…"), so ordinary prose
 * ("the notion of causality", "linear algebra") never wrongly scopes. Returns the `frontmatter.source`
 * value to filter on, or null. Pure + unit-tested.
 */
const SOURCE_SCOPE: Record<string, string> = {
  slack: "slack",
  notion: "notion",
  granola: "granola",
  linear: "linear",
  plane: "plane",
  confluence: "confluence",
};
// Scope requires ADJACENCY, not just a source word somewhere (a bare-word gate scoped "growth linear in
// Q3" / "linear regression" / "plane ticket"). Two forms:
//   • `<prep> [the] <source>`     — "in slack", "from notion"          (BRAND-only sources)
//   • `<source> <content-noun>`   — "notion docs", "linear issues"     (ALL sources)
// `linear`/`notion`/`plane` are also common English words, so they scope ONLY via the content-noun form
// (never bare "on the linear regression"); the brand-only names (slack/granola/confluence) also take a
// preposition. Deliberately NOT scopeable yet: gdrive, git/github (github activity is served by the
// per-contributor git digest). Pure + unit-tested (positives + the common-word false-positives).
const BRAND_ONLY_SOURCES = ["slack", "granola", "confluence"];
const SOURCE_NOUNS = "conversations?|messages?|threads?|chats?|discussions?|posts?|docs?|notes?|updates?|channels?|activity|issues?";
const PREP_SOURCE_RE = new RegExp(`\\b(?:in|on|from|to)\\s+(?:the\\s+)?(${BRAND_ONLY_SOURCES.join("|")})\\b`, "i");
const SOURCE_NOUN_RE = new RegExp(`\\b(${Object.keys(SOURCE_SCOPE).join("|")})\\s+(?:${SOURCE_NOUNS})\\b`, "i");

export function parseSourceScope(question: string): { source: string | null } {
  const m = question.match(PREP_SOURCE_RE) ?? question.match(SOURCE_NOUN_RE);
  return { source: m ? SOURCE_SCOPE[m[1].toLowerCase()] : null };
}

const MAX_EXPANSION_TERMS = 24;

/**
 * SEMANTIC EXPANSION via Graphiti. The graph's hybrid search returns the *facts* (entities +
 * relationships) relevant to a question even when it's phrased with no surface-term overlap. We
 * harvest the salient words from those facts (entity names + fact text) into extra FTS OR-terms, so
 * a second keyword pass can reach the *source items* a literal search missed (paraphrase/synonym
 * recall — Graphiti's `/search` returns facts, not item ids, so query-expansion is how we surface
 * items). Pure + unit-tested; returns "" when there are no facts (→ keyword-only, no behavior change).
 */
export function graphExpansionQuery(facts: GraphFact[]): string {
  const terms = new Set<string>();
  const add = (s: string | undefined | null) => {
    for (const w of (s ?? "").match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) ?? []) {
      if (isSignificantTerm(w)) terms.add(w.toLowerCase());
    }
  };
  for (const f of facts) {
    add(f.source_node_name);
    add(f.target_node_name);
    add(f.fact);
    if (terms.size >= MAX_EXPANSION_TERMS) break;
  }
  return [...terms].slice(0, MAX_EXPANSION_TERMS).join(" or ");
}

// Activity-intent detector for context shaping. The git + per-person activity digests are the
// heaviest always-on context blocks (two extra scans + tokens). We only compute/include them when
// the question is actually about who's doing what — biased INCLUSIVE (a false positive just restores
// the old always-on behavior; a false negative would drop relevant context, so we'd rather over-include).
const ACTIVITY_INTENT =
  /\b(who|whose|doing|working|worked|activity|active|busy|contribut\w*|commit\w*|posting|posted|assigned|assignee|standup|workload|lately|recently|my|mine|github|submission\w*|prs?|ship\w*|complet\w*|accomplish\w*|finish\w*|deliver\w*|merg\w*|yesterday|today)\b|\bi've\b|\babout me\b|\bme[?!.\s]*$|\bpull request\b|\bup to\b|\b(this|last) (week|sprint|month)\b/i;

/** True when a query is about people/activity (→ include the git + people-activity digests). */
export function wantsActivityContext(question: string): boolean {
  return ACTIVITY_INTENT.test(question);
}

/**
 * Per-contributor git-activity digest from `code_contributions` (the scan aggregates). This is the
 * ONLY place the query pipeline surfaces git history — without it, "what is John doing in git" has
 * no context to answer from (the data lived only in the codebase metrics tables, never in retrieval).
 * Author→person is already resolved at scan time (`code_contributions.member_id`); we fold the
 * member display name in here. **team-tier only** — code/contributor activity is internal, never
 * shown to an external viewer (CLAUDE.md §5). Returns "" when there's no recent activity.
 */
async function gitActivityDigest(db: DbClient, teamId: string): Promise<string> {
  const since = new Date(Date.now() - GIT_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const { data: contribs } = await db
    .from("code_contributions")
    .select("codebase_id, member_id, author_name, author_email, commits, ai_commits, additions, deletions, day")
    .eq("team_id", teamId)
    .gte("day", since)
    .order("day", { ascending: false })
    .limit(2000);
  if (!contribs?.length) return "";

  const { data: members } = await db.from("members").select("id, display_name").eq("team_id", teamId);
  const nameById = new Map((members ?? []).map((m) => [(m as { id: string }).id, (m as { display_name: string }).display_name]));
  const { data: cbs } = await db.from("codebases").select("id, slug").eq("team_id", teamId);
  const slugById = new Map((cbs ?? []).map((c) => [(c as { id: string }).id, (c as { slug: string }).slug]));

  type Agg = { name: string; email: string; commits: number; ai: number; adds: number; dels: number; repos: Set<string>; lastDay: string };
  const byPerson = new Map<string, Agg>();
  for (const r of contribs as {
    codebase_id: string; member_id: string | null; author_name: string; author_email: string;
    commits: number; ai_commits: number; additions: number; deletions: number; day: string;
  }[]) {
    const key = r.member_id ?? r.author_email ?? r.author_name;
    const name = (r.member_id && nameById.get(r.member_id)) || r.author_name || r.author_email || "unknown";
    const a = byPerson.get(key) ?? { name, email: r.author_email ?? "", commits: 0, ai: 0, adds: 0, dels: 0, repos: new Set<string>(), lastDay: "" };
    a.commits += r.commits;
    a.ai += r.ai_commits;
    a.adds += r.additions;
    a.dels += r.deletions;
    const slug = slugById.get(r.codebase_id);
    if (slug) a.repos.add(slug);
    if (r.day > a.lastDay) a.lastDay = r.day;
    byPerson.set(key, a);
  }

  const lines = [...byPerson.values()]
    .sort((a, b) => b.commits - a.commits)
    .map(
      (p) =>
        `- ${p.name}${p.email ? ` (${p.email})` : ""}: ${p.commits} commits${p.ai ? ` (${p.ai} AI-assisted)` : ""}, ` +
        `+${p.adds}/-${p.dels} across ${[...p.repos].join(", ") || "—"}; last commit ${p.lastDay}`
    );
  return ["", `## Git activity (last ${GIT_WINDOW_DAYS}d, by contributor)`, ...lines].join("\n");
}

/**
 * Per-person cross-tool activity digest from attributed `items` — the payoff of the identity work:
 * once Slack threads / Linear+Plane issues / docs carry the author's `member_id`, "what is each
 * person doing" is answerable beyond git. Counts each person's recent items by source (Slack/PM/docs),
 * EXCLUDING `git` (the git digest above covers code) and connector members (`is_connector`).
 * **team-tier only** — internal activity, never shown to an external viewer. Returns "" when
 * there's nothing attributed.
 */
async function peopleActivityDigest(db: DbClient, teamId: string): Promise<string> {
  const since = new Date(Date.now() - PEOPLE_WINDOW_DAYS * 86_400_000).toISOString();
  const { data: items } = await db
    .from("items")
    .select("member_id, kind, frontmatter, work_at")
    .eq("team_id", teamId)
    .gte("work_at", since)
    .order("work_at", { ascending: false })
    .limit(5000);
  if (!items?.length) return "";

  const { data: members } = await db
    .from("members")
    .select("id, display_name, email, is_connector")
    .eq("team_id", teamId);
  const memById = new Map(
    (members ?? []).map((m) => {
      const r = m as { id: string; display_name: string; email: string; is_connector: boolean };
      return [r.id, { name: r.display_name, email: r.email, isConnector: r.is_connector }];
    })
  );
  // Connector members author the unattributed remainder — skip them.
  const isConnector = (id: string) => memById.get(id)?.isConnector === true;

  type Agg = { name: string; email: string; bySource: Map<string, number>; last: string };
  const byPerson = new Map<string, Agg>();
  for (const it of items as {
    member_id: string | null;
    kind: string | null;
    frontmatter: Record<string, unknown> | null;
    work_at: string | Date;
  }[]) {
    if (!it.member_id || isConnector(it.member_id)) continue;
    const fm = it.frontmatter ?? {};
    const source = typeof fm.source === "string" && fm.source ? fm.source : it.kind ?? "item";
    if (source === "git") continue; // code activity has its own section
    // Work-time (R1), not sync time: this digest reports when each person LAST DID something, and a
    // re-sync tick would otherwise make everyone look active today. Comes back as a Date on the pg
    // adapter; normalize to an ISO string.
    const ts = typeof it.work_at === "string" ? it.work_at : new Date(it.work_at).toISOString();
    const m = memById.get(it.member_id);
    const a = byPerson.get(it.member_id) ?? { name: m?.name ?? "unknown", email: m?.email ?? "", bySource: new Map(), last: "" };
    a.bySource.set(source, (a.bySource.get(source) ?? 0) + 1);
    if (ts > a.last) a.last = ts;
    byPerson.set(it.member_id, a);
  }
  if (byPerson.size === 0) return "";

  const total = (a: Agg) => [...a.bySource.values()].reduce((x, y) => x + y, 0);
  const lines = [...byPerson.values()]
    .sort((a, b) => total(b) - total(a))
    .slice(0, 15)
    .map((p) => {
      const parts = [...p.bySource.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${n} ${s}`);
      return `- ${p.name}${p.email ? ` (${p.email})` : ""}: ${parts.join(", ")}; last active ${p.last.slice(0, 10)}`;
    });
  return ["", `## Activity by person (Slack/issues/docs, last ${PEOPLE_WINDOW_DAYS}d)`, ...lines].join("\n");
}

/**
 * Tier-filtered retrieval: recall-friendly FTS + always-include structured context
 * (recent decisions, open/blocked tasks, projects, compact graph digest, Graphiti temporal facts,
 * + a per-contributor git-activity digest on the team tier) + recently synced items. All independent
 * queries run in parallel; all respect the caller's tier.
 */
async function nativeRetrieve(
  db: DbClient,
  teamId: string,
  tier: "team" | "external",
  question: string,
  projectSlug?: string | null,
  enforce?: RetrieveEnforce | null
): Promise<RetrievedContext> {
  // Access enforcement (Phase B slice 2): `enforcing` supplies the principal's membership-visible
  // item set. `visible(id)` gates the item legs (FTS/recency/dense) + source-linked decisions/tasks.
  // `omitGraph` (= enforcing) drops the ITEM-GRAINED aggregate legs that can't be
  // membership-filtered: external augmentation, the git/people activity digests, the
  // full-corpus task-count aggregate, and the commitments mirror leg — fail closed rather than
  // leak restricted content/metadata.
  // (The Graphiti leg is partition-served via graphProjectIds since PCCC-6; the ORG-STRUCTURAL
  // mirror legs are tier-classed and gated by `serveOrgStructural` below since QMIR-1 — this flag
  // no longer speaks for them.) Permissive → all no-ops.
  const visibleIds = enforce?.visibleItemIds ?? null;
  const visible = (itemId: string | null | undefined): boolean => visibleIds === null || (itemId != null && visibleIds.has(itemId));
  // PRET-6: enforcement is unconditional — the aggregate omissions are permanent.
  // QMIR-1 (docs/design/query-mirror-legs-classification.md §3): the actors + REPORTS_TO legs are
  // TEAM-STRUCTURAL — an enforcing MEMBER keeps them (they see the roster on every dashboard
  // surface); tokens and both default-deny arms (absent/foreign principal) do not. The POSITIVE
  // `=== "member"` test is the rule — a `!== "token"` negation would fail OPEN for a future
  // constructor that omits the field (guard-pinned).
  const serveOrgStructural = enforce?.principal === "member";
  // In-query filter array (Codex fold): applied inside the item-leg SQL so LIMITs rank over
  // visible rows only. null = permissive. The visible() post-filter below stays as defense-in-depth.
  const visArr: string[] | null = visibleIds ? [...visibleIds] : null;
  // Channel scope (Gap #4): if the question names a channel ("#eng" / "in the sales channel"), scope
  // item retrieval to it and strip the phrase so the channel word isn't also a content search term.
  const { channel, cleaned } = parseChannelScope(question);
  const q = channel ? cleaned : question;
  // Source scope (this fix): if the question names a source it wants recent content FROM ("what's the
  // conversation in slack"), we add a recency leg for that source below — such items are buried by
  // content-ranking (they match only on the source word in their heading) and never reach the model.
  const { source: scopedSource } = parseSourceScope(question);

  // Kick off the Graphiti graph-memory search concurrently with Postgres retrieval.
  // PCCC-6 read cutover, widened by PRET-4 §1b (ruling 2): an enforcing MEMBER of ANY posture
  // gets the graph leg over their K-capped, read-ready, unsuppressed partitions (stored
  // pointers) — an external member's oracle resolves their granted projects' partitions, no
  // tier arm. Delegated tokens keep the §5.8b omit (no graphProjectIds). Permissive keeps the
  // two-bucket path with POSTURE as its input.
  let graphScope: { covered: number; total: number } | undefined;
  const graphFactsP = (async (): Promise<GraphFact[]> => {
    // Configured check FIRST (review Medium 8): a default no-Graphiti install must not pay team,
    // project, arming, or aggregate reads — let alone latch WRITES — for a leg that cannot run.
    if (!new GraphitiClient().configured) return [];
    // PRET-6: the tier-group path retired with the permissive model; scope presence decides.
    if (!enforce?.graphProjectIds) return [];
    try {
      const scope = await selectEnforcedGraphPartitions(db, { teamId, visibleProjectIds: enforce.graphProjectIds });
      graphScope = { covered: scope.covered, total: scope.total };
      return fetchGraphFactsForGroups(q, scope.groups);
    } catch (err) {
      // Fail CLOSED and gracefully (review Medium 6) — but never SILENTLY (review-2 Medium 6): a
      // wedged arming path must be distinguishable from the healthy omit for operators.
      console.error(
        `[graph] enforced partition selection failed for team ${teamId}: ${err instanceof Error ? err.message : err}`
      );
      return [];
    }
  })();
  // Optional dense (semantic) passage search — pgvector. Runs concurrently; resolves to [] unless
  // EMBEDDINGS_URL is set AND the pgvector schema is loaded (default installs stay pure-FTS).
  // Enforcement is IN-QUERY (visArr), like the FTS leg — see denseSearch (Codex B3 Medium).
  const denseP = denseSearch(teamId, tier, q, projectSlug, undefined, undefined, visArr);
  // Git-activity + per-person activity digests (team tier only — internal) run in parallel too.
  // Context shaping: the activity digests are heavy + only relevant to "who's doing what" questions.
  // omitGraph (= enforcing) also gates the unpartitionable aggregate legs (git/people
  // activity digests): item-derived, name restricted work, can't be membership-filtered → omit
  // under enforcing, fail closed until they gain a partition (slice-B2 Fable HIGH-2/3, §5.8b).
  const wantsActivity = false; // PRET-6: the unpartitionable activity digests are permanently omitted (enforcement is unconditional)
  const gitDigestP = wantsActivity ? gitActivityDigest(db, teamId) : Promise.resolve("");
  const peopleDigestP = wantsActivity ? peopleActivityDigest(db, teamId) : Promise.resolve("");

  // All independent retrieval queries run in PARALLEL (was sequential → ~7 serial round-trips).
  // 1. Recall-friendly, RANKED FTS over items (OR of significant terms; see toOrQuery). Ordered by
  //    ts_rank so the capped top-20 is the most relevant 20, not an arbitrary 20 (Gap #2). Raw SQL
  //    (fts-search) because the builder emits an unordered `@@` filter.
  // OR of significant terms by default; AND when the query carries an explicit `AND` operator
  // (conjunctive intent — narrows to docs about ALL topics). Same string flows to every FTS leg.
  const { query: ftsQuery, terms } = buildFtsQuery(q);
  const ftsP = rankedFtsSearch(teamId, tier, ftsQuery, FTS_CANDIDATE_LIMIT, channel, visArr);
  // Grounding specificity (Gap #3) — runs concurrently; combined with hadFtsHit below.
  const specificityP = analyzeTermSpecificity(teamId, tier, terms, visArr ?? []); // ENFB-1: the visible corpus is the statistic's universe
  // Structured-context scaling (Gaps #5/#6): a FULL-corpus task count (aggregates survive the 80-row
  // cap) + a keyword search over ALL decisions (an old-but-relevant decision survives the 50-row
  // recency window). Both run concurrently; folded into the structured block below.
  const taskCountsP = Promise.resolve({ total: 0, open: 0, byStatus: {} as Record<string, number> }); // PRET-6: the full-corpus aggregate is permanently omitted
  const matchedDecisionsP = terms.length
    ? matchingDecisions(teamId, tier, ftsQuery, 10, {
        visibleItemIds: visibleIds ?? new Set(),
        teamPosture: tier === "team",
        // FORWARDED, never re-derived (AUDITFIX-1 §2a). This leg is token-reachable, and the
        // discriminator is the only thing standing between a scoped token and every hand-typed
        // decision in the team. Deriving it here from `tier` would say "member" for every token.
        principal: enforce?.principal,
        // AUDITFIX-7: this leg is the SECOND token-reachable path to a hand-typed decision. Round 1
        // of the spec review found acceptance that seeded only a TASK — which would have gated the
        // task leg correctly and left THIS one open. Forwarded on the same terms.
        tokenProjectIds: enforce?.tokenProjectIds,
      })
    : Promise.resolve([]);

  // 2. Recency: most recent items (a fallback so fresh content always has a shot). Ordered by the
  //    persisted WORK time, not `synced_at` (R1/M3): every re-sync tick bumps `synced_at`, so ordering
  //    by it made "latest" mean "most recently re-scanned" — a backfill of an old corpus would answer
  //    "what's the latest" with months-old documents. `id` breaks ties so the page is deterministic.
  let recentB = db
    .from("items")
    .select("id, path, kind, body, synced_at, work_at, projects(slug)")
    .eq("team_id", teamId)
    .order("work_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(8);
  if (visArr) recentB = recentB.in("id", visArr); // enforcement: recency over visible items only
  // Channel scope (Gap #4) — keep the recency fallback inside the same channel. LIKE on the 2nd path
  // segment, resolved from the name first (Slack's segment is its channel ID — see
  // resolveChannelSegment); the FTS leg does the precise matching, this soft filter is padding.
  const channelSeg = channel ? await resolveChannelSegment(db, teamId, tier, channel, visArr) : null;
  if (channelSeg) recentB = recentB.like("path", `%/${channelSeg}/%`);

  // 2a. SOURCE-scoped recency: when the question names a source, pull its most-recent items by
  // WORK time (`work_at`, like the leg above) REGARDLESS of keyword rank (the recall fix for "what's the conversation in slack" —
  // Slack threads rank below the FTS cut, so they never reached the model). Tier-filtered like every
  // leg; also channel-scoped when both are named. `null` → no source query (resolves to empty rows).
  let sourceRecencyB: typeof recentB | null = null;
  if (scopedSource) {
    sourceRecencyB = db
      .from("items")
      .select("id, path, kind, body, synced_at, work_at, projects(slug)")
      .eq("team_id", teamId)
      .eq("frontmatter->>source", scopedSource)
      .order("work_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(SOURCE_RECENCY_LIMIT);
    if (visArr) sourceRecencyB = sourceRecencyB.in("id", visArr); // enforcement
    if (channelSeg) sourceRecencyB = sourceRecencyB.like("path", `%/${channelSeg}/%`);
  }

  // 3. Structured-context queries — ENFB-2 §2.2: the provenance predicate compiles IN-QUERY
  // (before LIMIT), so the recency-50 and task-80 windows fill with rows THIS principal may
  // see — the ENFB-1 deferred starvation class (Codex M1) dies here. The id-array fragment is
  // the exact SQL twin of `rowVisibleByProvenance` (one contract, THREE owners, dm-pinned to
  // fixture-level expected truth). Audience conjuncts preserved verbatim.
  // `principal` is FORWARDED from the caller's enforcement view — see AUDITFIX-1 §2a. Absent
  // enforcement yields `undefined`, which CLOSES the hand-typed arm; it must never become "member".
  const provCtx = {
    visibleItemIds: visibleIds ?? new Set<string>(),
    teamPosture: tier === "team",
    principal: enforce?.principal,
    // AUDITFIX-7: FORWARDED, never derived. Absent closes the hand-typed arm for a token, which is
    // the fail-closed direction and also today's behaviour — so a deleted forward reddens nothing on
    // its own. That is why the guard requires this to be CARRIED alongside `principal`.
    tokenProjectIds: enforce?.tokenProjectIds,
  };
  const dParams = newSqlParams();
  const dTeam = dParams.add(teamId);
  const dAccess = isRestrictedTier(tier) ? `and d.audience = 'external'` : "";
  const decisionsB = runSql<{
    row_key: string; decided_at: string | Date | null; title: string; decided_by: string;
    still_valid: boolean; source_item_id: string | null; created_by: string | null; slug: string;
  }>(
    `select d.row_key, d.decided_at, d.title, d.decided_by, d.still_valid, d.source_item_id, d.created_by,
            coalesce(p.slug, '') as slug
       from decisions d
       left join projects p on p.id = d.project_id
      where d.team_id = ${dTeam} ${dAccess}
        and ${provenanceRowSqlFromIds("d", dParams, provCtx)}
      order by d.decided_at desc
      limit 50`,
    dParams.values
  ).then((r) => ({ data: r.rows.map((row) => ({ ...row, projects: { slug: row.slug } })) }));
  // ALL statuses (incl. `done`), most-recently-updated first — so "what got completed today?"
  // can ground on finished tasks. `tasks.updated_at` is bumped on every sync upsert (incl. a
  // status→done transition), so recency ordering surfaces today's completions. (Was active-only:
  // `in_progress/blocked/ready`, which structurally hid every completion from the brain.)
  // Tasks carry `audience` (audit H1); an external principal sees only external-tier tasks. Without
  // this filter the external query context leaked every internal task board.
  const tParams = newSqlParams();
  const tTeam = tParams.add(teamId);
  const tAccess = isRestrictedTier(tier) ? `and t.audience = 'external'` : "";
  const tasksB = runSql<{
    row_key: string; title: string; assignee: string | null; status: string; sprint: string | null;
    updated_at: string | Date | null; source_item_id: string | null; created_by: string | null; slug: string;
  }>(
    `select t.row_key, t.title, t.assignee, t.status, t.sprint, t.updated_at, t.source_item_id, t.created_by,
            coalesce(p.slug, '') as slug
       from tasks t
       left join projects p on p.id = t.project_id
      where t.team_id = ${tTeam} ${tAccess}
        and ${provenanceRowSqlFromIds("t", tParams, provCtx)}
      order by t.updated_at desc
      limit 80`,
    tParams.values
  ).then((r) => ({ data: r.rows.map((row) => ({ ...row, projects: { slug: row.slug } })) }));
  // graph_entities / graph_relationships carry NO tier column, so they can't be audience-filtered.
  // For an external principal we omit them entirely (audit H1) rather than risk leaking internal
  // commitments/actors/reporting lines. `emptyRows` resolves to the same `{ data }` shape.
  const emptyRows = Promise.resolve({ data: [] as unknown[] });
  // COMMITMENTS stay omitted for every enforcing principal (QMIR-1 §3.5): the type has no
  // production writer today, and the moment one lands its rows are ITEM-DERIVED and must be
  // partition-classed from birth — this leg must not be the door they leak through.
  const commitmentsB =
    true // PRET-6: commitments stay omitted for every principal (QMIR §3.5 — no production writer)
      ? emptyRows
      : db
          .from("graph_entities")
          .select("entity_id, name, attrs")
          .eq("team_id", teamId)
          .eq("entity_type", "commitment")
          .limit(30);
  // PRET-4 §1d — the QMIR-1 inversion: structure serves EVERY member, so the posture disjunct
  // is gone from the two org-structural legs (it was the only thing closing them to external
  // members; `serveOrgStructural`'s positive principal test already excludes tokens and both
  // default-deny arms). The enforcing arm narrows to the ORG-STRUCTURAL allowlist (REPORTS_TO
  // only — OWNS/BLOCKS have no production writer and would be item-derived); the permissive
  // triple survives for team-posture readers, while the newly-opened restricted-posture
  // permissive audience gets the same REPORTS_TO narrow as enforcing (cold-read L3: a new
  // audience gets the allowlist, not fixture types).
  const relsB = !serveOrgStructural
    ? emptyRows
    : db
        .from("graph_relationships")
        .select("from_id, to_id, relationship_type")
        .eq("team_id", teamId)
        .in("relationship_type", ["REPORTS_TO"])
        .limit(80);
  const actorsB = !serveOrgStructural
    ? emptyRows
    : db
        .from("graph_entities")
        .select("entity_id, name, attrs")
        .eq("team_id", teamId)
        .eq("entity_type", "actor")
        .limit(40);

  const [
    ftsHits,
    { data: recentHits },
    { data: sourceRecentHits },
    { data: decisions },
    { data: tasks },
    { data: commitments },
    { data: rels },
    { data: actors },
    augmented,
  ] = await Promise.all([
    ftsP,
    recentB,
    sourceRecencyB ?? Promise.resolve({ data: [] as unknown[] }),
    decisionsB,
    tasksB,
    commitmentsB,
    relsB,
    actorsB,
    Promise.resolve([] as Awaited<ReturnType<typeof fetchAugmentedSources>>), // PRET-6: external augmentation is unpartitionable — permanently omitted
  ]);

  // Merge, dedupe by id, cap sizes. Ranked FTS hits (already ordered by relevance) come first, then
  // recency padding. Normalize the two row shapes (FTS carries `project` as a slug string; the
  // recency builder embeds `projects(slug)`).
  type MergeHit = { id: string; path: string; kind: string; body: string; synced_at: string; work_at: string; slug: string };
  const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : String(v ?? ""));
  const rankedHits: MergeHit[] = ftsHits.map((h) => ({ id: h.id, path: h.path, kind: h.kind, body: h.body, synced_at: h.synced_at, work_at: h.work_at, slug: h.project }));
  type RecencyRow = { id: string; path: string; kind: string; body: string | null; synced_at: string | Date; work_at: string | Date; projects: unknown };
  const toMergeHit = (h: RecencyRow): MergeHit => ({ id: h.id, path: h.path, kind: h.kind, body: h.body ?? "", synced_at: iso(h.synced_at), work_at: iso(h.work_at), slug: (h.projects as { slug: string })?.slug ?? "" });
  const recencyHits: MergeHit[] = ((recentHits ?? []) as RecencyRow[]).map(toMergeHit);
  // Source-scoped recent items (when the question named a source) — placed AHEAD of the generic recency
  // padding so a named source's latest content beats arbitrary fresh items, but AFTER the ranked FTS
  // hits so query-specific relevance still leads. Dedup by id handles any overlap.
  const sourceRecencyHits: MergeHit[] = ((sourceRecentHits ?? []) as RecencyRow[]).map(toMergeHit);
  const seen = new Set<string>();
  const sources: Source[] = [];
  let total = 0;
  let n = 1;
  for (const hit of [...rankedHits, ...sourceRecencyHits, ...recencyHits]) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    if (!visible(hit.id)) continue; // enforcement: only membership-visible items (Phase B slice 2)
    if (projectSlug && hit.slug !== projectSlug) continue;
    const text = (hit.body || "").slice(0, MAX_SOURCE_CHARS);
    if (total + text.length > MAX_TOTAL_CHARS) break;
    total += text.length;
    sources.push({
      sid: `S${n++}`,
      item_id: hit.id,
      project: hit.slug,
      path: hit.path,
      kind: hit.kind,
      synced_at: hit.synced_at,
      work_at: hit.work_at,
      text,
    });
  }

  // 2b. Optional external retrieval augmentation (GBrain adapter / cloud service).
  // Merged after Postgres hits, deduped by path, same char budget. No-op + safe
  // fallback when RETRIEVAL_AUGMENT_URL is unset or the call fails.
  const seenPaths = new Set(sources.map((s) => s.path));
  for (const hit of augmented) {
    const text = (hit.text || "").slice(0, MAX_SOURCE_CHARS);
    if (!text) continue;
    const path = hit.path || `gbrain:${n}`;
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    if (total + text.length > MAX_TOTAL_CHARS) break;
    total += text.length;
    sources.push({
      sid: `S${n++}`,
      item_id: null,
      project: hit.project ?? "",
      path,
      kind: hit.kind ?? "brain",
      synced_at: "",
      work_at: "",
      text,
    });
  }

  // Grounding signal (stay-quiet): is there query-SPECIFIC evidence, or are the sources just recency
  // padding / an incidental common-word match? (Gap #3.) A specific (rare) term that actually matches
  // → grounded. If every query term is corpus-common, fall back to "any FTS hit" (don't over-abstain
  // on legit common-word queries). Otherwise — specific terms that match nothing + incidental common
  // words — NOT grounded, so the answer layer abstains instead of confabulating.
  const hadFtsHit = ftsHits.length > 0;
  const spec = await specificityP;
  let grounded = spec.specificMatching ? true : spec.allCommon ? hadFtsHit : false;
  // A named-source recency item that actually made it INTO `sources` (survived the project filter + char
  // budget — not merely returned by the leg) IS query-specific evidence: the user asked about that source
  // and its recent content reached the model, so don't let the IDF grounding abstain it away (that would
  // reproduce the "we ingest Slack but the answer says we don't" bug this leg fixes). Checking membership
  // in `sources`, not the raw leg length, avoids claiming grounded when every scoped hit was filtered out.
  const includedItemIds = new Set(sources.map((s) => s.item_id).filter(Boolean));
  if (sourceRecencyHits.some((h) => includedItemIds.has(h.id))) grounded = true;

  // 2c. Semantic expansion via Graphiti (the graph search ran in parallel above). Use the facts'
  // entity/relationship terms to expand the FTS and surface items the literal keyword search missed.
  // No-op when Graphiti is unconfigured / returned nothing → pure keyword behavior, no regression.
  const graphFacts = await graphFactsP;
  const expansion = graphExpansionQuery(graphFacts);
  if (expansion) {
    const semHits = await rankedFtsSearch(teamId, tier, expansion, 10, channel, visArr);
    if (semHits.length > 0) grounded = true;
    for (const hit of semHits) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      if (!visible(hit.id)) continue; // enforcement (semantic hits)
      if (projectSlug && hit.project !== projectSlug) continue;
      const text = (hit.body || "").slice(0, MAX_SOURCE_CHARS);
      if (total + text.length > MAX_TOTAL_CHARS) break;
      total += text.length;
      sources.push({ sid: `S${n++}`, item_id: hit.id, project: hit.project, path: hit.path, kind: hit.kind, synced_at: hit.synced_at, work_at: hit.work_at, text });
    }
  }

  // 2d. Dense (semantic) passage retrieval — the optional pgvector leg. Adds best-chunk sources for
  // items keyword search missed, then RRF-fuses the keyword + dense rankings into the source order.
  // denseHits is [] unless dense retrieval is configured, so default installs are byte-for-byte
  // unchanged. Tier already enforced in denseSearch (live items.access).
  // Post-filter grounding under enforcing: a match on only-invisible items must not report
  // grounded=true (abstention side channel, §5.7 — slice-B2 Fable Medium).
  if (sources.length === 0) grounded = false; // enforcement is unconditional
  let orderedSources = sources;
  const denseHits = await denseP;
  if (denseHits.length) {
    // A dense hit here is a REAL semantic match — denseSearch applies a distance floor, so far
    // nearest-neighbors (which every query has) are already excluded. That's what makes this a valid
    // grounding signal rather than "any vector exists" (which would defeat the IDF grounding above).
    // Ground only on a VISIBLE hit (Codex B3 Medium): an invisible-only dense match must not
    // suppress abstention (§5.7 side channel). The in-query filter already restricts the hits
    // under enforcing; this visible() check is the belt-and-braces layer.
    if (denseHits.some((h) => visible(h.item_id))) grounded = true;
    for (const h of denseHits) {
      if (seen.has(h.item_id)) continue;
      seen.add(h.item_id);
      if (!visible(h.item_id)) continue; // enforcement (dense hits)
      if (projectSlug && h.project !== projectSlug) continue;
      const text = (h.content || "").slice(0, MAX_SOURCE_CHARS);
      if (!text) continue;
      if (total + text.length > MAX_TOTAL_CHARS) break;
      total += text.length;
      sources.push({
        sid: `S${n++}`,
        item_id: h.item_id,
        project: h.project,
        path: h.path,
        kind: h.kind,
        synced_at: h.synced_at,
        work_at: h.work_at,
        text,
      });
    }
    orderedSources = fuseByRrf(
      sources,
      ftsHits.map((h) => h.id),
      denseHits.map((h) => h.item_id)
    );
  }

  // 3. Structured context (compact, always included) — built from the parallel results above.
  const [gitDigest, peopleDigest, taskCounts, matchedDecisions] = await Promise.all([
    gitDigestP,
    peopleDigestP,
    taskCountsP,
    matchedDecisionsP,
  ]);

  // Decisions: the recency-50 window PLUS any keyword-matched decision that scrolled past it (Gap #6),
  // deduped by row_key. Recency rows first (fresh context), then the older matches under their own note.
  type DecisionLine = { row_key: string; decided_at: string | null; title: string; decided_by: string; still_valid: boolean; source_item_id: string | null; slug: string };
  // ENFB-2 §2.2: BOTH decision legs now filter IN-QUERY (the recency window above, the keyword
  // window inside matchingDecisions) — the post-LIMIT filters this map replaced were the ENFB-1
  // deferred starvation site. The rule's owners: lib/access/provenance (TS) +
  // lib/access/provenance-sql (SQL twin), agreement dm-pinned.
  const recencyDecisions: DecisionLine[] = (decisions ?? []).map((d) => ({
    row_key: d.row_key as string,
    decided_at:
      d.decided_at instanceof Date ? d.decided_at.toISOString().slice(0, 10) : ((d.decided_at as string | null) ?? null),
    title: d.title as string,
    decided_by: d.decided_by as string,
    still_valid: d.still_valid as boolean,
    source_item_id: (d.source_item_id as string | null) ?? null,
    slug: (d.projects as unknown as { slug: string })?.slug ?? "",
  }));
  const recencyKeys = new Set(recencyDecisions.map((d) => d.row_key));
  const olderMatches = matchedDecisions.filter((d) => !recencyKeys.has(d.row_key));
  const fmtDecision = (d: DecisionLine) =>
    `- #${d.row_key} (${d.decided_at ?? "?"}, ${d.slug}) ${d.title} — by ${d.decided_by}${d.still_valid ? "" : " [SUPERSEDED]"}`;

  // The disabled set the relationships renderer consults (Codex QMIR-1 Medium 1) — sourced from
  // the same actors fetch the actor filter uses, so the two filters cannot disagree about who is
  // departed.
  const disabledActorIds = new Set(
    (actors ?? [])
      .filter((a) => (a.attrs as { status?: string } | null)?.status === "disabled")
      .map((a) => a.entity_id as string)
  );

  const structured = [
    true
      ? `## Tasks visible to you` // enforcing: no full-corpus aggregate (§5.7 volume disclosure)
      : `## Task counts (all ${taskCounts.total} tasks: ${taskCounts.open} open, ${taskCounts.byStatus.done ?? 0} done)`,
    "## Recent decisions (newest first)",
    ...recencyDecisions.map(fmtDecision),
    ...(olderMatches.length ? ["", "## Older decisions matching this query", ...olderMatches.map(fmtDecision)] : []),
    "",
    "## Tasks (all statuses, most recently updated first)",
    // ENFB-2 §2.2: the provenance rule (PRET-5 H2's settled rule) moved IN-QUERY into the
    // task window above — the inline duplicate that lived here was the one-owner drift site
    // the design review named (round-1 sweep risk 6); the SQL twin is the sole filter now.
    ...(tasks ?? [])
      .map((t) => {
      const u = t.updated_at;
      const day = typeof u === "string" ? u.slice(0, 10) : u ? new Date(u).toISOString().slice(0, 10) : "?";
      return `- ${t.row_key} [${t.status}] ${t.title} (${t.assignee || "unassigned"}, ${t.sprint || "no sprint"}) — updated ${day}`;
    }),
    "",
    "## Commitments (graph)",
    ...(commitments ?? []).map(
      (c) =>
        `- ${c.entity_id}: ${c.name || (c.attrs as Record<string, unknown>)?.description || ""} [${(c.attrs as Record<string, unknown>)?.status ?? "unknown"}]`
    ),
    "",
    "## Actors (graph)",
    ...(actors ?? [])
      .filter((a) => (a.attrs as { status?: string } | null)?.status !== "disabled")
      .map((a) => `- ${a.entity_id}: ${a.name} (${(a.attrs as Record<string, unknown>)?.role ?? ""})`),
    "",
    "## Key relationships",
    // A departed member's edges must not render either (Codex QMIR-1 Medium 1: the actor filter
    // above hid the disabled PERSON while this line still cited their REPORTS_TO edge — the
    // "never cited as current staff" claim, one leg over). Checkable endpoints only: an endpoint
    // outside the actors fetch (its 40-row cap, or a non-actor id) has no status to consult and
    // renders as an opaque id — that fail-open residual is named, not hidden.
    ...(rels ?? [])
      .filter((r) => !disabledActorIds.has(r.from_id) && !disabledActorIds.has(r.to_id))
      .map((r) => `- ${r.from_id} ${r.relationship_type} ${r.to_id}`),
    gitDigest,
    peopleDigest,
  ].join("\n");

  // 3b. Blend in Graphiti temporal facts (graph memory over all ingestions), if any. (`graphFacts`
  // was awaited above for the semantic expansion.)
  const structuredWithGraph = graphFacts.length
    ? structured +
      "\n\n" +
      [
        `## Graph memory (temporal facts — entity/relationship knowledge across all ingestions)${graphScope ? ` — graph expansion covered ${graphScope.covered} of your ${graphScope.total} projects` : ""}`,
        ...graphFacts.map(
          (f) =>
            `- ${f.fact}${f.valid_at ? ` (valid ${f.valid_at.slice(0, 10)})` : ""}${f.invalid_at ? " [SUPERSEDED]" : ""}`
        ),
      ].join("\n")
    : structured;

  // 4. Optional cross-encoder rerank (local llama-server or cloud). No-op when
  // RERANK_URL is unset; reorders so the most relevant source is cited first.
  // (Runs on the RRF-fused order when dense retrieval contributed, else the FTS/recency order.)
  const ranked = await rerankSources(question, orderedSources);

  return { sources: ranked, structured: structuredWithGraph, grounded, ...(graphScope ? { graphScope } : {}) };
}

/**
 * The default context provider: Postgres FTS + structured digests + Graphiti temporal facts
 * (+ optional external augmentation and cross-encoder rerank). Tier is enforced in-DB.
 */
export const nativeProvider: RetrievalProvider = {
  name: "native",
  retrieve: (r) => nativeRetrieve(r.db, r.teamId, r.tier, r.question, r.projectSlug, r.enforce ?? null),
};

/**
 * Public retrieval entry — dispatches to the selected context provider (CONTEXT_PROVIDER, default
 * `native`). Signature is unchanged so every caller (the two query routes, tests) is untouched;
 * swapping the whole context layer for gbrain/another is `CONTEXT_PROVIDER=external` + an adapter.
 */
export async function retrieve(
  db: DbClient,
  teamId: string,
  tier: "team" | "external",
  question: string,
  projectSlug?: string | null,
  // Access enforcement (Phase B slice 2 + PCCC-6 + QMIR-1, spec §5.2/§5.8b). Present = the team
  // is 'enforcing' and this principal's membership-visible item set is supplied: item legs
  // (FTS/recency/dense) and source-linked decisions/tasks are filtered to it. The GRAPHITI graph
  // leg is PARTITIONED (PCCC-6) when graphProjectIds is present (team-tier members): searched over
  // the K-capped, read-ready, unsuppressed stored-pointer partitions with covered/total disclosed;
  // absent graphProjectIds (external principals, delegated tokens) that leg stays OMITTED —
  // §5.8b fail-closed. The ORG-STRUCTURAL mirror legs (actors + REPORTS_TO) are tier-classed
  // (QMIR-1): served when `principal === "member"`, omitted for tokens and both default-deny
  // arms; commitments and the aggregate digests stay omitted for everyone.
  // PRET-6: enforcement is REQUIRED — with the permissive posture walls deleted, a null view
  // would run the item legs UNFILTERED (fail open), so a caller without a principal's view is a
  // bug and throws (the timeline's memberId==null rule, applied here). Both query routes
  // construct the view or 500 before calling.
  enforce?: RetrieveEnforce | null
): Promise<RetrievedContext> {
  if (enforce == null) throw new Error("retrieve without an enforcement view (fail closed)");
  const provider = selectedProviderName() === "external" ? externalProvider : nativeProvider;
  return provider.retrieve({ db, teamId, tier, question, projectSlug: projectSlug ?? null, enforce });
}
