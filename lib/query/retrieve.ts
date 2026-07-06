import "server-only";
import type { DbClient } from "@/lib/db/types";
import { GraphitiClient, type GraphFact } from "@/lib/graph/graphiti-client";
import { visibleGroupIds } from "@/lib/graph/group";
import {
  selectedProviderName,
  type RetrievalProvider,
  type Source,
  type RetrievedContext,
} from "./provider";
import { externalProvider } from "./external-provider";
import { denseSearch, fuseByRrf } from "./dense-search";

// Types live in ./provider (the pluggable seam). Re-exported here so existing importers
// (lib/query/claude, tests, …) keep importing them from "@/lib/query/retrieve" unchanged.
export type { Source, RetrievedContext };

const MAX_SOURCE_CHARS = 8_000;
const MAX_TOTAL_CHARS = 160_000; // ~40k tokens context cap
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

async function fetchGraphFacts(
  db: DbClient,
  teamId: string,
  tier: "team" | "external",
  question: string
): Promise<GraphFact[]> {
  const client = new GraphitiClient({ timeoutMs: GRAPH_QUERY_TIMEOUT_MS });
  if (!client.configured) return [];
  try {
    const { data: team } = await db.from("teams").select("slug").eq("id", teamId).maybeSingle();
    const slug = (team as { slug: string } | null)?.slug;
    if (!slug) return [];
    const groupIds = visibleGroupIds(slug, tier);
    return await client.search(question, groupIds, GRAPH_FACTS_LIMIT);
  } catch {
    return []; // degrade to Postgres-only retrieval
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
]);

/**
 * Build a recall-friendly FTS query: significant terms OR-joined. `websearch_to_tsquery` treats the
 * word "or" as the OR operator, so this matches docs containing ANY significant term (then the LLM
 * filters relevance) instead of requiring ALL of them. Falls back to the raw question when nothing
 * significant remains. (Ranked/semantic retrieval — pgvector — is the durable fix at larger scale.)
 */
export function toOrQuery(question: string): string {
  const terms = (question.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter(
    (t) => t.length >= 3 && !FTS_STOP.has(t)
  );
  const unique = [...new Set(terms)];
  return unique.length ? unique.join(" or ") : question;
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
    for (const w of (s ?? "").toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []) {
      if (w.length >= 3 && !FTS_STOP.has(w)) terms.add(w);
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
 * EXCLUDING `git` (the git digest above covers code) and connector members (their `@connector.local`
 * email). **team-tier only** — internal activity, never shown to an external viewer. Returns "" when
 * there's nothing attributed.
 */
async function peopleActivityDigest(db: DbClient, teamId: string): Promise<string> {
  const since = new Date(Date.now() - PEOPLE_WINDOW_DAYS * 86_400_000).toISOString();
  const { data: items } = await db
    .from("items")
    .select("member_id, kind, frontmatter, synced_at")
    .eq("team_id", teamId)
    .gte("synced_at", since)
    .order("synced_at", { ascending: false })
    .limit(5000);
  if (!items?.length) return "";

  const { data: members } = await db
    .from("members")
    .select("id, display_name, email")
    .eq("team_id", teamId);
  const memById = new Map(
    (members ?? []).map((m) => {
      const r = m as { id: string; display_name: string; email: string };
      return [r.id, { name: r.display_name, email: r.email }];
    })
  );
  // Connector members (slack-sync@connector.local, …) author the unattributed remainder — skip them.
  const isConnector = (id: string) => (memById.get(id)?.email ?? "").endsWith("@connector.local");

  type Agg = { name: string; email: string; bySource: Map<string, number>; last: string };
  const byPerson = new Map<string, Agg>();
  for (const it of items as {
    member_id: string | null;
    kind: string | null;
    frontmatter: Record<string, unknown> | null;
    synced_at: string | Date;
  }[]) {
    if (!it.member_id || isConnector(it.member_id)) continue;
    const fm = it.frontmatter ?? {};
    const source = typeof fm.source === "string" && fm.source ? fm.source : it.kind ?? "item";
    if (source === "git") continue; // code activity has its own section
    // synced_at comes back as a Date on the pg adapter; normalize to an ISO string.
    const ts = typeof it.synced_at === "string" ? it.synced_at : new Date(it.synced_at).toISOString();
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
  projectSlug?: string | null
): Promise<RetrievedContext> {
  // Kick off the Graphiti graph-memory search concurrently with Postgres retrieval.
  const graphFactsP = fetchGraphFacts(db, teamId, tier, question);
  // Optional dense (semantic) passage search — pgvector. Runs concurrently; resolves to [] unless
  // EMBEDDINGS_URL is set AND the pgvector schema is loaded (default installs stay pure-FTS).
  const denseP = denseSearch(teamId, tier, question, projectSlug);
  // Git-activity + per-person activity digests (team tier only — internal) run in parallel too.
  // Context shaping: the activity digests are heavy + only relevant to "who's doing what" questions.
  const wantsActivity = tier === "team" && wantsActivityContext(question);
  const gitDigestP = wantsActivity ? gitActivityDigest(db, teamId) : Promise.resolve("");
  const peopleDigestP = wantsActivity ? peopleActivityDigest(db, teamId) : Promise.resolve("");

  // All independent retrieval queries run in PARALLEL (was sequential → ~7 serial round-trips).
  // 1. Recall-friendly FTS over items (OR of significant terms; see toOrQuery).
  let ftsB = db
    .from("items")
    .select("id, path, kind, body, synced_at, projects(slug)")
    .eq("team_id", teamId)
    .textSearch("search", toOrQuery(question), { type: "websearch", config: "english" })
    .limit(20);
  if (tier === "external") ftsB = ftsB.eq("access", "external");

  // 2. Recency: most recent items (a fallback so fresh content always has a shot).
  let recentB = db
    .from("items")
    .select("id, path, kind, body, synced_at, projects(slug)")
    .eq("team_id", teamId)
    .order("synced_at", { ascending: false })
    .limit(8);
  if (tier === "external") recentB = recentB.eq("access", "external");

  // 3. Structured-context query builders (awaited together with the above).
  let decisionsB = db
    .from("decisions")
    .select("row_key, decided_at, title, decided_by, still_valid, projects(slug)")
    .eq("team_id", teamId)
    .order("decided_at", { ascending: false })
    .limit(50);
  if (tier === "external") decisionsB = decisionsB.eq("audience", "external");
  // ALL statuses (incl. `done`), most-recently-updated first — so "what got completed today?"
  // can ground on finished tasks. `tasks.updated_at` is bumped on every sync upsert (incl. a
  // status→done transition), so recency ordering surfaces today's completions. (Was active-only:
  // `in_progress/blocked/ready`, which structurally hid every completion from the brain.)
  const tasksB = db
    .from("tasks")
    .select("row_key, title, assignee, status, sprint, updated_at, projects(slug)")
    .eq("team_id", teamId)
    .order("updated_at", { ascending: false })
    .limit(80);
  const commitmentsB = db
    .from("graph_entities")
    .select("entity_id, name, attrs")
    .eq("team_id", teamId)
    .eq("entity_type", "commitment")
    .limit(30);
  const relsB = db
    .from("graph_relationships")
    .select("from_id, to_id, relationship_type")
    .eq("team_id", teamId)
    .in("relationship_type", ["REPORTS_TO", "OWNS", "BLOCKS"])
    .limit(80);
  const actorsB = db
    .from("graph_entities")
    .select("entity_id, name, attrs")
    .eq("team_id", teamId)
    .eq("entity_type", "actor")
    .limit(40);

  const [
    { data: ftsHits },
    { data: recentHits },
    { data: decisions },
    { data: tasks },
    { data: commitments },
    { data: rels },
    { data: actors },
    augmented,
  ] = await Promise.all([
    ftsB,
    recentB,
    decisionsB,
    tasksB,
    commitmentsB,
    relsB,
    actorsB,
    fetchAugmentedSources(question, tier),
  ]);

  // Merge, dedupe by id, cap sizes
  const seen = new Set<string>();
  const sources: Source[] = [];
  let total = 0;
  let n = 1;
  for (const hit of [...(ftsHits ?? []), ...(recentHits ?? [])]) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    const slug = (hit.projects as unknown as { slug: string })?.slug ?? "";
    if (projectSlug && slug !== projectSlug) continue;
    const text = (hit.body || "").slice(0, MAX_SOURCE_CHARS);
    if (total + text.length > MAX_TOTAL_CHARS) break;
    total += text.length;
    sources.push({
      sid: `S${n++}`,
      item_id: hit.id,
      project: slug,
      path: hit.path,
      kind: hit.kind,
      synced_at: hit.synced_at,
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
      text,
    });
  }

  // Grounding signal (stay-quiet): did query-specific SEARCH match anything, or are the sources just
  // recency padding? FTS/semantic hits = real grounding; if both are empty the answer layer is told
  // retrieval found no strong match so it abstains instead of confabulating from recent items.
  let grounded = (ftsHits?.length ?? 0) > 0;

  // 2c. Semantic expansion via Graphiti (the graph search ran in parallel above). Use the facts'
  // entity/relationship terms to expand the FTS and surface items the literal keyword search missed.
  // No-op when Graphiti is unconfigured / returned nothing → pure keyword behavior, no regression.
  const graphFacts = await graphFactsP;
  const expansion = graphExpansionQuery(graphFacts);
  if (expansion) {
    let semB = db
      .from("items")
      .select("id, path, kind, body, synced_at, projects(slug)")
      .eq("team_id", teamId)
      .textSearch("search", expansion, { type: "websearch", config: "english" })
      .limit(10);
    if (tier === "external") semB = semB.eq("access", "external");
    const { data: semHits } = await semB;
    if ((semHits?.length ?? 0) > 0) grounded = true;
    for (const hit of (semHits ?? []) as { id: string; path: string; kind: string; body: string; synced_at: string; projects: unknown }[]) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      const slug = (hit.projects as { slug: string })?.slug ?? "";
      if (projectSlug && slug !== projectSlug) continue;
      const text = (hit.body || "").slice(0, MAX_SOURCE_CHARS);
      if (total + text.length > MAX_TOTAL_CHARS) break;
      total += text.length;
      sources.push({ sid: `S${n++}`, item_id: hit.id, project: slug, path: hit.path, kind: hit.kind, synced_at: hit.synced_at, text });
    }
  }

  // 2d. Dense (semantic) passage retrieval — the optional pgvector leg. Adds best-chunk sources for
  // items keyword search missed, then RRF-fuses the keyword + dense rankings into the source order.
  // denseHits is [] unless dense retrieval is configured, so default installs are byte-for-byte
  // unchanged. Tier already enforced in denseSearch (live items.access).
  let orderedSources = sources;
  const denseHits = await denseP;
  if (denseHits.length) {
    grounded = true;
    for (const h of denseHits) {
      if (seen.has(h.item_id)) continue;
      seen.add(h.item_id);
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
        text,
      });
    }
    orderedSources = fuseByRrf(
      sources,
      (ftsHits ?? []).map((h) => (h as { id: string }).id),
      denseHits.map((h) => h.item_id)
    );
  }

  // 3. Structured context (compact, always included) — built from the parallel results above.
  const [gitDigest, peopleDigest] = await Promise.all([gitDigestP, peopleDigestP]);
  const structured = [
    "## Recent decisions (newest first)",
    ...(decisions ?? []).map(
      (d) =>
        `- #${d.row_key} (${d.decided_at ?? "?"}, ${(d.projects as unknown as { slug: string })?.slug}) ${d.title} — by ${d.decided_by}${d.still_valid ? "" : " [SUPERSEDED]"}`
    ),
    "",
    "## Tasks (all statuses, most recently updated first)",
    ...(tasks ?? []).map((t) => {
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
    ...(actors ?? []).map(
      (a) => `- ${a.entity_id}: ${a.name} (${(a.attrs as Record<string, unknown>)?.role ?? ""})`
    ),
    "",
    "## Key relationships",
    ...(rels ?? []).map((r) => `- ${r.from_id} ${r.relationship_type} ${r.to_id}`),
    gitDigest,
    peopleDigest,
  ].join("\n");

  // 3b. Blend in Graphiti temporal facts (graph memory over all ingestions), if any. (`graphFacts`
  // was awaited above for the semantic expansion.)
  const structuredWithGraph = graphFacts.length
    ? structured +
      "\n\n" +
      [
        "## Graph memory (temporal facts — entity/relationship knowledge across all ingestions)",
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

  return { sources: ranked, structured: structuredWithGraph, grounded };
}

/**
 * The default context provider: Postgres FTS + structured digests + Graphiti temporal facts
 * (+ optional external augmentation and cross-encoder rerank). Tier is enforced in-DB.
 */
export const nativeProvider: RetrievalProvider = {
  name: "native",
  retrieve: (r) => nativeRetrieve(r.db, r.teamId, r.tier, r.question, r.projectSlug),
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
  projectSlug?: string | null
): Promise<RetrievedContext> {
  const provider = selectedProviderName() === "external" ? externalProvider : nativeProvider;
  return provider.retrieve({ db, teamId, tier, question, projectSlug: projectSlug ?? null });
}
