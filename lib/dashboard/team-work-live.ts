import "server-only";
import type { DbClient } from "@/lib/db/types";
import { getArcs, type ProviderKeys } from "@/lib/graph/arcs";
import { visibleGroupIds, type AccessTier } from "@/lib/graph/group";
import { visibleItems, visibleTasks } from "@/lib/auth/visibility";
import type { RosterPerson } from "./people-match";
import { assembleTeamWork, commitSubject, type TaskLite, type CommitLite, type PersonWork } from "./team-work";

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
  db: DbClient,
  teamId: string,
  teamSlug: string,
  tier: AccessTier,
  keys: ProviderKeys
): Promise<PersonWork[]> {
  const { data: members } = await db
    .from("members")
    .select("id, display_name, actor_handle, email")
    .eq("team_id", teamId)
    .eq("status", "active");
  const roster = toRoster(
    (members ?? []) as { id: string; display_name: string | null; actor_handle: string | null; email: string | null }[]
  );
  if (roster.length === 0) return [];

  const doneSinceIso = new Date(Date.now() - DONE_WINDOW_DAYS * 86_400_000).toISOString();
  // Tier isolation (audit H1): tasks carry `audience`, git-commit items carry `access`. An external
  // viewer of this box must not receive internal task titles or commit subjects. The `tier` param was
  // previously used only for arcs — the task/commit queries ran unfiltered.
  const [{ data: taskRows }, { data: commitRows }, arcs] = await Promise.all([
    visibleTasks(
      db
        .from("tasks")
        .select("id, title, assignee, status, updated_at")
        .eq("team_id", teamId)
        .order("updated_at", { ascending: false })
        .limit(2000),
      tier
    ),
    // Git commits are member_id-attributed (author→member at scan time) — the real "done" signal for
    // code contributors, who often have no `done` task rows. frontmatter->>source='git' + member set.
    visibleItems(
      db
        .from("items")
        .select("id, body, member_id, frontmatter, synced_at")
        .eq("team_id", teamId)
        .eq("frontmatter->>source", "git")
        .not("member_id", "is", null)
        .order("synced_at", { ascending: false })
        .limit(600),
      tier
    ),
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

  const commits: CommitLite[] = ((commitRows ?? []) as {
    id: string;
    body: string | null;
    member_id: string | null;
    frontmatter: Record<string, unknown> | null;
    synced_at: string | Date;
  }[]).flatMap((r) => {
    if (!r.member_id) return [];
    const committedAt = r.frontmatter?.committed_at;
    // Commit date drives the "accomplished" window; normalize to UTC ISO so it sorts vs task dates.
    const at = committedAt
      ? new Date(String(committedAt)).toISOString()
      : typeof r.synced_at === "string"
        ? r.synced_at
        : new Date(r.synced_at).toISOString();
    return [{ id: r.id, memberId: r.member_id, title: commitSubject(r.body ?? ""), at }];
  });

  const people = assembleTeamWork(roster, tasks, arcs, commits, doneSinceIso);
  return people.filter((p) => p.summary || p.threads.length || p.openTasks.length || p.accomplished.length);
}
