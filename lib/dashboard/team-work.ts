import { subjectMatchesMember, type RosterPerson } from "./people-match";

/**
 * "Working On" — one consolidated per-person view for the dashboard, assembled from the CONTEXT
 * layer plus tasks:
 *   • summary  ← narrative arcs (Layer 3) the person participates in — the storylines/key threads
 *   • openTasks ← tasks they're assigned that are still in flight
 *   • accomplished ← tasks they've recently completed (a running "done" list)
 *
 * Keyed on the member ROSTER so people are deduped and named canonically (folds the graph's noisy
 * "two Johns" / "Chetan" vs "Chetan Nandakumar" onto one row via subjectMatchesMember).
 *
 * This module is PURE (no server-only / Neo4j / LLM imports) so `assembleTeamWork` unit-tests in
 * isolation; the live wiring (roster + tasks + arcs) lives in team-work-live.ts.
 */

export interface TaskLite {
  id: string;
  title: string;
  assignee: string;
  status: string;
  updatedAt: string;
}

export interface ArcLite {
  title: string;
  summary: string;
  confidence: "high" | "medium" | "low";
  participants: string[];
}

/** A shipped git commit, already attributed to a roster member by member_id (clean identity). */
export interface CommitLite {
  id: string;
  memberId: string;
  title: string; // commit subject
  at: string; // ISO (UTC) — normalized upstream so it sorts against task updatedAt
}

/**
 * Pull the commit subject out of a projected git-item body (lib/codebases/commits-to-items). The
 * body is `# Commit <sha> — <repo>\n\n**<author>** · <date>\n\n<message>\n\n\`<sha>\` · +a/-d`, so the
 * subject is the first line that isn't the heading, the bold author line, or the backtick footer.
 * Pure so it's unit-tested against the real format.
 */
export function commitSubject(body: string): string {
  for (const raw of (body ?? "").split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("# Commit")) continue; // heading
    if (l.startsWith("**")) continue; // author · date line
    if (l.startsWith("`")) continue; // `sha` · +a/-d footer
    return l;
  }
  return "";
}

export interface PersonWork {
  memberId: string;
  name: string;
  handle: string;
  summary: string; // the most relevant arc's summary (context layer); "" when none
  threads: string[]; // arc titles the person is part of — the "key projects/storylines"
  openTasks: { id: string; title: string; status: string }[];
  accomplished: { id: string; title: string; at: string }[];
}

const OPEN_STATUSES = new Set(["ready", "in_progress", "blocked"]);
const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };
const MAX_OPEN = 6;
const MAX_DONE = 6;
const MAX_THREADS = 3;

/**
 * Pure assembly: fold tasks + arcs onto the roster. `doneSinceIso` bounds the "accomplished" list.
 * Every active person is included (deduped); each carries whatever signal exists for them.
 */
export function assembleTeamWork(
  roster: RosterPerson[],
  tasks: TaskLite[],
  arcs: ArcLite[],
  commits: CommitLite[],
  doneSinceIso: string
): PersonWork[] {
  const assignedPerson = (assignee: string): RosterPerson | undefined =>
    assignee ? roster.find((p) => subjectMatchesMember(assignee, p)) : undefined;

  // Arcs a person participates in, best (highest-confidence) first.
  const arcsForPerson = (person: RosterPerson): ArcLite[] =>
    arcs
      .filter((a) => a.participants.some((name) => subjectMatchesMember(name, person)))
      .sort((a, b) => (CONFIDENCE_RANK[b.confidence] ?? 0) - (CONFIDENCE_RANK[a.confidence] ?? 0));

  return roster.map((person) => {
    const mine = tasks.filter((t) => assignedPerson(t.assignee)?.memberId === person.memberId);
    const openTasks = mine
      .filter((t) => OPEN_STATUSES.has(t.status))
      .slice(0, MAX_OPEN)
      .map((t) => ({ id: t.id, title: t.title, status: t.status }));

    // Accomplished = completed tasks (assignee-matched) + shipped commits (member_id-attributed),
    // newest first, de-duped by title, capped. Git is the real "done" signal for code contributors,
    // who often have no `done` task rows at all.
    const doneTasks = mine
      .filter((t) => t.status === "done" && t.updatedAt >= doneSinceIso)
      .map((t) => ({ id: t.id, title: t.title, at: t.updatedAt }));
    const myCommits = commits
      .filter((c) => c.memberId === person.memberId && c.at >= doneSinceIso && c.title)
      .map((c) => ({ id: c.id, title: c.title, at: c.at }));
    const seenTitles = new Set<string>();
    const accomplished = [...doneTasks, ...myCommits]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .filter((e) => {
        const key = e.title.trim().toLowerCase();
        if (seenTitles.has(key)) return false;
        seenTitles.add(key);
        return true;
      })
      .slice(0, MAX_DONE);

    const personArcs = arcsForPerson(person);
    return {
      memberId: person.memberId,
      name: person.displayName || person.handle,
      handle: person.handle,
      summary: personArcs[0]?.summary ?? "",
      threads: personArcs.slice(0, MAX_THREADS).map((a) => a.title),
      openTasks,
      accomplished,
    };
  });
}
