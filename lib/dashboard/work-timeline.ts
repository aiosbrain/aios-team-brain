import "server-only";
import type { DbClient } from "@/lib/db/types";
import { visibleItems, visibleTasks, type ViewerTier } from "@/lib/auth/visibility";
import { subjectMatchesMember, type RosterPerson } from "./people-match";
import { commitSubject } from "./team-work";
import { groupTimeline, normalizeSource, NEWLY_ASSIGNED_SOURCE, type EvidenceWithMember, type TimelineDay, type TimelineMember } from "./timeline-group";

/**
 * Server-only fetch for the Learning "Timeline" — the team's recent work as a day → person → evidence
 * ledger, read from Postgres `items` + `tasks` (NOT the graph: attribution + source live reliably on
 * items, and one item = one row, so the graph's 16-chunk doc spam disappears). Tier-gated through the
 * `visibleItems`/`visibleTasks` §5 choke-points; the pure grouping is `./timeline-group`.
 *
 * Design decisions (Fable spec review):
 *  • WORK time = `committed_at` ?? `source_ts` ONLY — never `synced_at`. A re-scanned doc gets a fresh
 *    synced_at, so a synced_at fallback would resurface it as "today's work" every rescan. Items with
 *    no real work time are DROPPED (mirrors lib/graph/learning `workTs`).
 *  • `.gte("synced_at", sinceIso)` bounds the fetch: sync is always at-or-after the work, so a 7-day
 *    synced_at window is a complete superset of the 7-day work window (and hits `items_team_synced_idx`).
 *    Caveat: re-pushes bump synced_at, so at scale the real bound is `ITEM_LIMIT` ordered by synced_at;
 *    a >2000-live-item team could clip in-window work. Fine at current scale — a follow-up is to push
 *    the work-time filter into SQL (needs a computed/indexed work-time column).
 *  • Body fetched ONLY for git commits (their title is the commit subject); other items title from
 *    frontmatter — avoids pulling large doc bodies.
 *  • Tasks come from the `tasks` table (the only per-assignee source), attributed via the proven
 *    `subjectMatchesMember`; unmatched tasks are dropped, never mis-attributed. `kind='task'` ITEMS are
 *    excluded (file-level, attributed to the pusher — the double-count/mis-attribution trap). A task's
 *    work signal is `worked_at` (a PURE provider state transition), `assigned_at` (when the assignee
 *    changed → the "Newly assigned" group), or a real `updated_at` edit — the durable fix in `lib/ingest`
 *    now bumps `updated_at` only on a real persisted change, so a routine re-sync (which re-materializes
 *    every row in a tasks file) no longer lists a whole file's tasks under "today". Dormant tickets with
 *    no in-window signal are dropped.
 *  • Meetings (granola / transcripts) are team signal, not one person's output → excluded from the
 *    per-person view in v1 (a granola item's member_id is the recorder, not the participants).
 */

const WINDOW_DAYS = 7;
const ITEM_LIMIT = 2000;
const TASK_LIMIT = 2000;

type ItemRow = {
  id: string;
  kind?: string;
  member_id: string | null;
  frontmatter: Record<string, unknown> | null;
  body?: string | null;
  path?: string | null;
  synced_at: string | Date;
};
type TaskRow = {
  id: string;
  title: string;
  assignee: string | null;
  updated_at: string | Date;
  worked_at: string | Date | null;
  assigned_at: string | Date | null;
};

/** WORK time from an item's frontmatter — `committed_at` ?? `source_ts`, normalized to ISO. Null when
 *  neither is present/parseable (the item is then dropped — see the synced_at note above). */
function itemWorkTime(fm: Record<string, unknown> | null): string | null {
  const raw =
    (typeof fm?.committed_at === "string" && fm.committed_at) ||
    (typeof fm?.source_ts === "string" && fm.source_ts) ||
    null;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** A nullable timestamp (ISO string | Date | null) → epoch ms, or null when absent/unparseable. */
function tsMs(v: string | Date | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Only surface http(s) evidence URLs — a pusher-supplied `source_url` could be `javascript:…`; the
 *  panel renders it as an href, so sanitize at the data layer (nothing else reaches the client). */
const httpUrl = (v: unknown): string | undefined => {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : undefined;
};

export async function getWorkTimeline(
  db: DbClient,
  teamId: string,
  tier: ViewerTier
): Promise<TimelineDay[]> {
  const windowStartMs = Date.now() - WINDOW_DAYS * 86_400_000;
  const sinceIso = new Date(windowStartMs).toISOString();
  const todayISO = new Date().toISOString().slice(0, 10);

  const [memberRes, teamRes] = await Promise.all([
    db.from("members").select("id, display_name, actor_handle, avatar_url, email").eq("team_id", teamId).eq("status", "active"),
    db.from("teams").select("primary_pm_provider").eq("id", teamId).maybeSingle(),
  ]);

  // Real people only — connectors author sync noise, not work (mirrors team-work-live.toRoster).
  const humans = ((memberRes.data ?? []) as {
    id: string;
    display_name: string | null;
    actor_handle: string | null;
    avatar_url: string | null;
    email: string | null;
  }[]).filter((m) => !(m.email ?? "").endsWith("@connector.local"));
  const members = new Map<string, TimelineMember>();
  const roster: RosterPerson[] = [];
  for (const m of humans) {
    members.set(m.id, {
      name: m.display_name ?? m.actor_handle ?? "Unknown",
      handle: m.actor_handle ?? "",
      avatarUrl: m.avatar_url,
    });
    roster.push({ memberId: m.id, displayName: m.display_name ?? "", handle: m.actor_handle ?? "" });
  }
  if (members.size === 0) return [];

  // A task's source = the team's PM provider (linear/plane). With none configured, use a generic
  // "tasks" slug (check icon + "Tasks" label) rather than "other" (which reads as "Files").
  const pmProvider = str((teamRes.data as { primary_pm_provider: string | null } | null)?.primary_pm_provider);
  const pmSource = pmProvider ? normalizeSource(pmProvider) : "tasks";

  const [gitRes, otherRes, taskRes] = await Promise.all([
    // Git commits (title = commit subject → needs body; commit bodies are small).
    visibleItems(
      db
        .from("items")
        .select("id, member_id, frontmatter, body, synced_at")
        .eq("team_id", teamId)
        .eq("frontmatter->>source", "git")
        .not("member_id", "is", null)
        .gte("synced_at", sinceIso)
        .order("synced_at", { ascending: false })
        .limit(ITEM_LIMIT),
      tier
    ),
    // Everything else (no body; title from frontmatter/path). `kind='task'` items excluded — the
    // tasks table is the authoritative per-assignee source. NOTE: we do NOT `.neq("frontmatter->>source",
    // "git")` here — the builder compiles that to `source <> 'git'`, which is NULL-falsy and would drop
    // items with no `source` key (a hand-pushed doc with a real work time). Git commits are excluded in
    // the JS loop below instead.
    visibleItems(
      db
        .from("items")
        .select("id, kind, member_id, frontmatter, path, synced_at")
        .eq("team_id", teamId)
        .neq("kind", "task")
        .not("member_id", "is", null)
        .gte("synced_at", sinceIso)
        .order("synced_at", { ascending: false })
        .limit(ITEM_LIMIT),
      tier
    ),
    visibleTasks(
      db
        .from("tasks")
        .select("id, title, assignee, updated_at, worked_at, assigned_at")
        .eq("team_id", teamId)
        // `updated_at` is the outer bound: worked_at/assigned_at only move via a persisted change that
        // also bumps updated_at (or a fresh import that sets updated_at=now), so this is a valid
        // superset. The real in-window decision is made per-row in JS below (worked_at/assigned_at).
        .gte("updated_at", sinceIso)
        .order("updated_at", { ascending: false })
        .limit(TASK_LIMIT),
      tier
    ),
  ]);

  const evidence: EvidenceWithMember[] = [];

  for (const r of (gitRes.data ?? []) as ItemRow[]) {
    if (!r.member_id || !members.has(r.member_id)) continue;
    const at = itemWorkTime(r.frontmatter);
    if (!at || Date.parse(at) < windowStartMs) continue;
    const fm = r.frontmatter ?? {};
    evidence.push({
      id: r.id,
      memberId: r.member_id,
      source: "github",
      kind: "commit",
      title: str(fm.title) || commitSubject(r.body ?? "") || "commit",
      url: httpUrl(fm.source_url),
      at,
    });
  }

  for (const r of (otherRes.data ?? []) as ItemRow[]) {
    if (!r.member_id || !members.has(r.member_id)) continue;
    const fm = r.frontmatter ?? {};
    if (str(fm.source) === "git") continue; // git commits are handled by gitRes — no double-count
    const source = normalizeSource(str(fm.source));
    if (source === "granola" || r.kind === "transcript") continue; // meetings = team signal (v1)
    const at = itemWorkTime(fm);
    if (!at || Date.parse(at) < windowStartMs) continue;
    evidence.push({
      id: r.id,
      memberId: r.member_id,
      source,
      kind: r.kind ?? "item",
      title: str(fm.title) || (r.path ? basename(r.path) : "") || "(untitled)",
      url: httpUrl(fm.source_url),
      at,
    });
  }

  for (const t of (taskRes.data ?? []) as TaskRow[]) {
    const assignee = (t.assignee ?? "").trim();
    if (!assignee) continue;
    const person = roster.find((p) => subjectMatchesMember(assignee, p));
    if (!person) continue; // drop, never mis-attribute

    // A task appears ONLY with a real in-window signal, in priority order:
    //   1. worked (transition) — worked_at (a PURE provider state transition) in-window → PM source.
    //   2. newly assigned      — assigned_at in-window & no transition → its own "Newly assigned"
    //                            group (freshly on their plate, not yet worked). Checked BEFORE the
    //                            updated_at fallback so a just-created assigned ticket reads as newly
    //                            assigned, not "worked".
    //   3. worked (edited)     — updated_at in-window (a persisted change that's neither a transition
    //                            nor a new assignment, e.g. a workspace task whose status advanced).
    //   4. (evidence-backed — a linked work item; arrives in a later PR — not wired here.)
    // An old task with none of these is DROPPED — "if it's old and has no evidence, don't list it"
    // (a routine re-sync no longer bumps updated_at on unchanged rows, so case 3 is real work).
    const inWin = (ms: number | null): ms is number => ms !== null && ms >= windowStartMs;
    const workedTransition = tsMs(t.worked_at); // pure transition — NO updated_at fallback here
    const assignedAt = tsMs(t.assigned_at);
    const editedAt = tsMs(t.updated_at);
    const push = (source: string, atMs: number) =>
      evidence.push({
        id: `task:${t.id}`,
        memberId: person.memberId,
        source,
        kind: "task",
        title: t.title || "(untitled task)",
        at: new Date(atMs).toISOString(),
      });
    if (inWin(workedTransition)) push(pmSource, workedTransition);
    else if (inWin(assignedAt)) push(NEWLY_ASSIGNED_SOURCE, assignedAt);
    else if (inWin(editedAt)) push(pmSource, editedAt);
    // else: dormant assigned ticket, no in-window signal → dropped.
    // KNOWN, deferred (PR-B): the FIRST import of a provider team stamps assigned_at=now on every
    // pre-existing assigned row, so a whole backlog transiently floods "Newly assigned" for 7 days.
    // The durable fix (a per-team first-seen watermark, or gating on the provider's own assignment
    // time) lands with the persisted work_timeline layer; it's one-time, self-resolving onboarding noise.
  }

  return groupTimeline(evidence, members, todayISO);
}
