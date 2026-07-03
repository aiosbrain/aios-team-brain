import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getArcs, type ProviderKeys } from "@/lib/graph/arcs";
import { visibleGroupIds, type AccessTier } from "@/lib/graph/group";
import type { RosterPerson } from "./people-match";
import { assembleTeamWork, type TaskLite, type PersonWork } from "./team-work";

/**
 * Live wiring for the consolidated "Working On" box: roster (members) + tasks (one query) + arcs
 * (LLM, cached 10 min), handed to the pure `assembleTeamWork`. Kept apart from team-work.ts so that
 * pure assembler stays free of the server-only / Neo4j / LLM import chain (and unit-tests cleanly).
 */

const DONE_WINDOW_DAYS = 30;

/** Roster = active, non-connector members (connectors author sync noise, not real people). */
function toRoster(
  rows: { id: string; display_name: string | null; actor_handle: string | null; email: string | null }[]
): RosterPerson[] {
  return rows
    .filter((m) => !(m.email ?? "").endsWith("@connector.local"))
    .map((m) => ({ memberId: m.id, displayName: m.display_name ?? "", handle: m.actor_handle ?? "" }))
    .filter((p) => p.displayName || p.handle);
}

/**
 * Tier-scoped via visibleGroupIds. Best-effort — arcs degrade to [] when Graphiti/LLM is
 * unavailable, so the box still shows tasks. Returns only people who have SOME signal.
 */
export async function getTeamWork(
  supabase: SupabaseClient,
  teamId: string,
  teamSlug: string,
  tier: AccessTier,
  keys: ProviderKeys
): Promise<PersonWork[]> {
  const { data: members } = await supabase
    .from("members")
    .select("id, display_name, actor_handle, email")
    .eq("team_id", teamId)
    .eq("status", "active");
  const roster = toRoster(
    (members ?? []) as { id: string; display_name: string | null; actor_handle: string | null; email: string | null }[]
  );
  if (roster.length === 0) return [];

  const doneSinceIso = new Date(Date.now() - DONE_WINDOW_DAYS * 86_400_000).toISOString();
  const [{ data: taskRows }, arcs] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, assignee, status, updated_at")
      .eq("team_id", teamId)
      .order("updated_at", { ascending: false })
      .limit(2000),
    getArcs(teamSlug, tier, visibleGroupIds(teamSlug, tier), keys).catch(() => []),
  ]);

  const tasks: TaskLite[] = ((taskRows ?? []) as {
    id: string;
    title: string;
    assignee: string | null;
    status: string;
    updated_at: string | Date;
  }[]).map((t) => ({
    id: t.id,
    title: t.title,
    assignee: t.assignee ?? "",
    status: t.status,
    // pg adapter returns timestamptz as Date; normalize for the string compare in assembleTeamWork.
    updatedAt: typeof t.updated_at === "string" ? t.updated_at : new Date(t.updated_at).toISOString(),
  }));

  const people = assembleTeamWork(roster, tasks, arcs, doneSinceIso);
  return people.filter((p) => p.summary || p.threads.length || p.openTasks.length || p.accomplished.length);
}
