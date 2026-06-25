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

/**
 * Tier-filtered retrieval: FTS top-12 + always-include structured context
 * (recent decisions, open/blocked tasks, projects, compact graph digest, and
 * Graphiti temporal facts) + 5 most recently synced items. All queries respect
 * the caller's tier.
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

  // 1. FTS over items
  let fts = supabase
    .from("items")
    .select("id, path, kind, body, synced_at, projects(slug)")
    .eq("team_id", teamId)
    .textSearch("search", question, { type: "websearch", config: "english" })
    .limit(12);
  if (tier === "external") fts = fts.eq("access", "external");
  const { data: ftsHits } = await fts;

  // 2. Recency: 5 most recent items
  let recent = supabase
    .from("items")
    .select("id, path, kind, body, synced_at, projects(slug)")
    .eq("team_id", teamId)
    .order("synced_at", { ascending: false })
    .limit(5);
  if (tier === "external") recent = recent.eq("access", "external");
  const { data: recentHits } = await recent;

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
  for (const hit of await fetchAugmentedSources(question, tier)) {
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

  // 3. Structured context (compact, always included)
  let decisionsQ = supabase
    .from("decisions")
    .select("row_key, decided_at, title, decided_by, still_valid, projects(slug)")
    .eq("team_id", teamId)
    .order("decided_at", { ascending: false })
    .limit(50);
  if (tier === "external") decisionsQ = decisionsQ.eq("audience", "external");
  const { data: decisions } = await decisionsQ;

  const { data: tasks } = await supabase
    .from("tasks")
    .select("row_key, title, assignee, status, sprint, projects(slug)")
    .eq("team_id", teamId)
    .in("status", ["in_progress", "blocked", "ready"])
    .limit(50);

  const { data: commitments } = await supabase
    .from("graph_entities")
    .select("entity_id, name, attrs")
    .eq("team_id", teamId)
    .eq("entity_type", "commitment")
    .limit(30);

  const { data: rels } = await supabase
    .from("graph_relationships")
    .select("from_id, to_id, relationship_type")
    .eq("team_id", teamId)
    .in("relationship_type", ["REPORTS_TO", "OWNS", "BLOCKS"])
    .limit(80);

  const { data: actors } = await supabase
    .from("graph_entities")
    .select("entity_id, name, attrs")
    .eq("team_id", teamId)
    .eq("entity_type", "actor")
    .limit(40);

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
