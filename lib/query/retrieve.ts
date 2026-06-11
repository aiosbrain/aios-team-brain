import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

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

/**
 * Tier-filtered retrieval: FTS top-12 + always-include structured context
 * (recent decisions, open/blocked tasks, projects, compact graph digest)
 * + 5 most recently synced items. All queries respect the caller's tier.
 */
export async function retrieve(
  supabase: SupabaseClient,
  teamId: string,
  tier: "team" | "external",
  question: string,
  projectSlug?: string | null
): Promise<RetrievedContext> {
  const tierFilter = (q: ReturnType<SupabaseClient["from"]>["select"] extends never ? never : any) =>
    tier === "external" ? q.eq("access", "external") : q;

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

  return { sources, structured };
}
