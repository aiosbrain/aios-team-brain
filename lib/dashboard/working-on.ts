import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recentFacts } from "@/lib/graph/learning";
import { visibleGroupIds } from "@/lib/graph/group";
import type { AccessTier } from "@/lib/graph/group";
import { subjectMatchesMember, type RosterPerson } from "./people-match";

/**
 * "What each person is currently working on", pulled from the Learning layer (Graphiti atomic
 * facts). Keyed on the member roster so identity is CLEAN and DEDUPED: the graph's noisy person
 * aliases (two "John" nodes, "Chetan" vs "Chetan Nandakumar") fold onto one roster row via
 * subjectMatchesMember, and we display the canonical roster name — never the raw graph name.
 *
 * Best-effort: recentFacts degrades to [] when Graphiti/Neo4j is unconfigured or errors, so the
 * panel simply shows an empty state rather than failing the page. Tier-scoped via visibleGroupIds.
 */

const WINDOW_DAYS = 7;
const FACT_LIMIT = 120; // enough recent facts to find a line for each active person

export interface WorkingOnEntry {
  memberId: string;
  name: string; // canonical roster display name
  handle: string;
  fact: string; // the most recent Learning-layer fact about this person
  at: string; // ISO timestamp of that fact
}

/** Roster = active, non-connector members (connectors author sync noise, not real people). */
function toRoster(
  rows: { id: string; display_name: string | null; actor_handle: string | null; email: string | null }[]
): RosterPerson[] {
  return rows
    .filter((m) => !(m.email ?? "").endsWith("@connector.local"))
    .map((m) => ({ memberId: m.id, displayName: m.display_name ?? "", handle: m.actor_handle ?? "" }))
    .filter((p) => p.displayName || p.handle);
}

export async function getWorkingOn(
  supabase: SupabaseClient,
  teamId: string,
  teamSlug: string,
  tier: AccessTier
): Promise<WorkingOnEntry[]> {
  const { data: members } = await supabase
    .from("members")
    .select("id, display_name, actor_handle, email")
    .eq("team_id", teamId)
    .eq("status", "active");
  const roster = toRoster(
    (members ?? []) as { id: string; display_name: string | null; actor_handle: string | null; email: string | null }[]
  );
  if (roster.length === 0) return [];

  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const facts = await recentFacts(visibleGroupIds(teamSlug, tier), since, FACT_LIMIT);
  if (facts.length === 0) return [];

  // Facts are newest-first, so the first fact matching a member is that member's latest.
  const byMember = new Map<string, WorkingOnEntry>();
  for (const f of facts) {
    if (byMember.size === roster.length) break; // every person covered
    const person = roster.find((p) => subjectMatchesMember(f.subject, p));
    if (!person || byMember.has(person.memberId)) continue;
    byMember.set(person.memberId, {
      memberId: person.memberId,
      name: person.displayName || person.handle,
      handle: person.handle,
      fact: f.fact,
      at: f.at,
    });
  }

  // Roster order, only people with a learning-layer signal.
  return roster.map((p) => byMember.get(p.memberId)).filter((e): e is WorkingOnEntry => Boolean(e));
}
