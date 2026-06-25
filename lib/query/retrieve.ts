import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GraphitiClient, type GraphFact } from "@/lib/graph/graphiti-client";
import { visibleGroupIds } from "@/lib/graph/group";

export type Source = {
  sid: string; // S1, S2…
  item_id: string | null;
  project: string;
  path: string;
  kind: string;
  synced_at: string;
  text: string;
};

export type RetrievedContext = {
  sources: Source[];
  structured: string; // decisions/tasks/graph digest (always included)
};

const MAX_SOURCE_CHARS = 8_000;
const MAX_TOTAL_CHARS = 160_000; // ~40k tokens context cap
const GIT_WINDOW_DAYS = 90; // recency window for the per-contributor git-activity digest

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
  supabase: SupabaseClient,
  teamId: string,
  tier: "team" | "external",
  question: string
): Promise<GraphFact[]> {
  const client = new GraphitiClient({ timeoutMs: GRAPH_QUERY_TIMEOUT_MS });
  if (!client.configured) return [];
  try {
    const { data: team } = await supabase.from("teams").select("slug").eq("id", teamId).maybeSingle();
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

/**
 * Per-contributor git-activity digest from `code_contributions` (the scan aggregates). This is the
 * ONLY place the query pipeline surfaces git history — without it, "what is John doing in git" has
 * no context to answer from (the data lived only in the codebase metrics tables, never in retrieval).
 * Author→person is already resolved at scan time (`code_contributions.member_id`); we fold the
 * member display name in here. **team-tier only** — code/contributor activity is internal, never
 * shown to an external viewer (CLAUDE.md §5). Returns "" when there's no recent activity.
 */
async function gitActivityDigest(supabase: SupabaseClient, teamId: string): Promise<string> {
  const since = new Date(Date.now() - GIT_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const { data: contribs } = await supabase
    .from("code_contributions")
    .select("codebase_id, member_id, author_name, author_email, commits, ai_commits, additions, deletions, day")
    .eq("team_id", teamId)
    .gte("day", since)
    .order("day", { ascending: false })
    .limit(2000);
  if (!contribs?.length) return "";

  const { data: members } = await supabase.from("members").select("id, display_name").eq("team_id", teamId);
  const nameById = new Map((members ?? []).map((m) => [(m as { id: string }).id, (m as { display_name: string }).display_name]));
  const { data: cbs } = await supabase.from("codebases").select("id, slug").eq("team_id", teamId);
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
 * Tier-filtered retrieval: recall-friendly FTS + always-include structured context
 * (recent decisions, open/blocked tasks, projects, compact graph digest, Graphiti temporal facts,
 * + a per-contributor git-activity digest on the team tier) + recently synced items. All independent
 * queries run in parallel; all respect the caller's tier.
 */
export async function retrieve(
  supabase: SupabaseClient,
  teamId: string,
  tier: "team" | "external",
  question: string,
  projectSlug?: string | null
): Promise<RetrievedContext> {
  // Kick off the Graphiti graph-memory search concurrently with Postgres retrieval.
  const graphFactsP = fetchGraphFacts(supabase, teamId, tier, question);
  // Git-activity digest (team tier only — code/contributor activity is internal) runs in parallel too.
  const gitDigestP = tier === "team" ? gitActivityDigest(supabase, teamId) : Promise.resolve("");

  // All independent retrieval queries run in PARALLEL (was sequential → ~7 serial round-trips).
  // 1. Recall-friendly FTS over items (OR of significant terms; see toOrQuery).
  let ftsB = supabase
    .from("items")
    .select("id, path, kind, body, synced_at, projects(slug)")
    .eq("team_id", teamId)
    .textSearch("search", toOrQuery(question), { type: "websearch", config: "english" })
    .limit(20);
  if (tier === "external") ftsB = ftsB.eq("access", "external");

  // 2. Recency: most recent items (a fallback so fresh content always has a shot).
  let recentB = supabase
    .from("items")
    .select("id, path, kind, body, synced_at, projects(slug)")
    .eq("team_id", teamId)
    .order("synced_at", { ascending: false })
    .limit(8);
  if (tier === "external") recentB = recentB.eq("access", "external");

  // 3. Structured-context query builders (awaited together with the above).
  let decisionsB = supabase
    .from("decisions")
    .select("row_key, decided_at, title, decided_by, still_valid, projects(slug)")
    .eq("team_id", teamId)
    .order("decided_at", { ascending: false })
    .limit(50);
  if (tier === "external") decisionsB = decisionsB.eq("audience", "external");
  const tasksB = supabase
    .from("tasks")
    .select("row_key, title, assignee, status, sprint, projects(slug)")
    .eq("team_id", teamId)
    .in("status", ["in_progress", "blocked", "ready"])
    .limit(50);
  const commitmentsB = supabase
    .from("graph_entities")
    .select("entity_id, name, attrs")
    .eq("team_id", teamId)
    .eq("entity_type", "commitment")
    .limit(30);
  const relsB = supabase
    .from("graph_relationships")
    .select("from_id, to_id, relationship_type")
    .eq("team_id", teamId)
    .in("relationship_type", ["REPORTS_TO", "OWNS", "BLOCKS"])
    .limit(80);
  const actorsB = supabase
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

  // 3. Structured context (compact, always included) — built from the parallel results above.
  const gitDigest = await gitDigestP;
  const structured = [
    "## Recent decisions (newest first)",
    ...(decisions ?? []).map(
      (d) =>
        `- #${d.row_key} (${d.decided_at ?? "?"}, ${(d.projects as unknown as { slug: string })?.slug}) ${d.title} — by ${d.decided_by}${d.still_valid ? "" : " [SUPERSEDED]"}`
    ),
    "",
    "## Open/active tasks",
    ...(tasks ?? []).map(
      (t) =>
        `- ${t.row_key} [${t.status}] ${t.title} (${t.assignee || "unassigned"}, ${t.sprint || "no sprint"})`
    ),
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
  ].join("\n");

  // 3b. Blend in Graphiti temporal facts (graph memory over all ingestions), if any.
  const graphFacts = await graphFactsP;
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
  const ranked = await rerankSources(question, sources);

  return { sources: ranked, structured: structuredWithGraph };
}
