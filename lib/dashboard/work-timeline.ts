import "server-only";
import type { DbClient } from "@/lib/db/types";
import { visibleItems, visibleTasks, type ViewerTier } from "@/lib/auth/visibility";
import { subjectMatchesMember, type RosterPerson } from "./people-match";
import { commitSubject } from "./team-work";
import {
  groupTimeline,
  normalizeSource,
  type EvidenceItem,
  type EvidenceWithMember,
  type TaskInfo,
  type TaskSignal,
  type TimelineDay,
  type TimelineMember,
} from "./timeline-group";
import { computeTaskLinks } from "./issue-ref";

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
  row_key: string | null;
  title: string;
  status: string | null;
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
  // THROW on a query error — never treat a DB failure (pool contention, #249) as "empty". The pg
  // adapter returns {data:null,error} instead of throwing, so an unchecked `?? []` would silently
  // yield an empty/partial ledger — which `getCachedWorkTimeline` would then persist as a "fresh"
  // row and serve everywhere. The persisted layer's "empty = a quiet week" contract only holds if a
  // real error propagates instead: a cold-miss build 500s the route (and the panel's error boundary
  // catches it), and a background rebuild's throw is caught WITHOUT writing, keeping the good prior.
  // (teamRes only degrades the pmSource label, so a null there is cosmetic — not fatal.)
  if (memberRes.error) throw new Error(`work-timeline members: ${memberRes.error.message}`);

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
    // Recent tasks — NOT window-filtered: evidence may reference a task last touched >7d ago, and we
    // need its title/status/row_key to render the header + resolve issue-key links. The in-window SIGNAL
    // (worked/newly-assigned) is decided per-row in JS below.
    visibleTasks(
      db
        .from("tasks")
        .select("id, row_key, title, assignee, status, updated_at, worked_at, assigned_at")
        .eq("team_id", teamId)
        .order("updated_at", { ascending: false })
        .limit(TASK_LIMIT),
      tier
    ),
  ]);
  // THROW on any evidence-query error too — a partial ledger (one of the three legs failed) must not
  // be cached/served as complete. See the members-error note above.
  if (gitRes.error) throw new Error(`work-timeline git: ${gitRes.error.message}`);
  if (otherRes.error) throw new Error(`work-timeline items: ${otherRes.error.message}`);
  if (taskRes.error) throw new Error(`work-timeline tasks: ${taskRes.error.message}`);

  const tasks = (taskRes.data ?? []) as TaskRow[];
  const inWin = (ms: number | null): ms is number => ms !== null && ms >= windowStartMs;

  // Task display info (any evidence may reference a task) + per-person in-window signals (the "headers").
  const taskInfo = new Map<string, TaskInfo>();
  const taskSignals: TaskSignal[] = [];
  for (const t of tasks) {
    taskInfo.set(t.id, { title: t.title || "(untitled task)", status: t.status || "backlog", source: pmSource });
    const assignee = (t.assignee ?? "").trim();
    if (!assignee) continue;
    const person = roster.find((p) => subjectMatchesMember(assignee, p));
    if (!person) continue; // drop, never mis-attribute
    // Signal priority (PR-A): a worked_at transition, else a fresh assigned_at ("newly assigned"),
    // else a real updated_at edit. A dormant assigned ticket with none of these produces NO header —
    // it only appears if in-window EVIDENCE links to it (below). "If it's old and has no evidence,
    // don't list it." (KNOWN, deferred: a provider's FIRST import stamps assigned_at=now on the whole
    // backlog → a transient "Newly assigned" flood for 7 days; a first-seen watermark is a follow-up.)
    const workedTransition = tsMs(t.worked_at);
    const assignedAt = tsMs(t.assigned_at);
    const editedAt = tsMs(t.updated_at);
    if (inWin(workedTransition))
      taskSignals.push({ memberId: person.memberId, taskId: t.id, at: new Date(workedTransition).toISOString(), newlyAssigned: false });
    else if (inWin(assignedAt))
      taskSignals.push({ memberId: person.memberId, taskId: t.id, at: new Date(assignedAt).toISOString(), newlyAssigned: true });
    else if (inWin(editedAt))
      taskSignals.push({ memberId: person.memberId, taskId: t.id, at: new Date(editedAt).toISOString(), newlyAssigned: false });
  }

  // In-window evidence items (commits + docs) with the text an issue key would appear in. A git
  // commit's key is in its BODY; other items' in the title/path (no large-body fetch — see the
  // otherRes select). `kind='task'` items + meetings/transcripts are excluded (Slack evidence is PR-E).
  type Ev = EvidenceItem & { memberId: string; text: string };
  const evItems: Ev[] = [];
  for (const r of (gitRes.data ?? []) as ItemRow[]) {
    if (!r.member_id || !members.has(r.member_id)) continue;
    const at = itemWorkTime(r.frontmatter);
    if (!at || Date.parse(at) < windowStartMs) continue;
    const fm = r.frontmatter ?? {};
    const title = str(fm.title) || commitSubject(r.body ?? "") || "commit";
    evItems.push({ id: r.id, memberId: r.member_id, source: "github", kind: "commit", title, url: httpUrl(fm.source_url), at, text: `${title}\n${r.body ?? ""}` });
  }
  for (const r of (otherRes.data ?? []) as ItemRow[]) {
    if (!r.member_id || !members.has(r.member_id)) continue;
    const fm = r.frontmatter ?? {};
    if (str(fm.source) === "git") continue; // handled by gitRes — no double-count
    const source = normalizeSource(str(fm.source));
    if (source === "granola" || r.kind === "transcript") continue; // meetings/Slack = not per-person work (v1)
    const at = itemWorkTime(fm);
    if (!at || Date.parse(at) < windowStartMs) continue;
    const title = str(fm.title) || (r.path ? basename(r.path) : "") || "(untitled)";
    evItems.push({ id: r.id, memberId: r.member_id, source, kind: r.kind ?? "item", title, url: httpUrl(fm.source_url), at, text: `${title}\n${r.path ?? ""}` });
  }

  // Deterministic issue-key links, computed INLINE so the Timeline is always fresh (the persisted
  // task_evidence table is written separately off the scheduler for other surfaces).
  const links = computeTaskLinks(
    tasks.map((t) => ({ id: t.id, row_key: t.row_key })),
    evItems.map((e) => ({ id: e.id, text: e.text }))
  );

  // One evidence row per (item, linked task); unlinked items carry taskId=null (→ the "Other" bucket).
  // A commit citing two issues appears under both.
  const evidence: EvidenceWithMember[] = [];
  for (const e of evItems) {
    const base: EvidenceItem & { memberId: string } = { id: e.id, memberId: e.memberId, source: e.source, kind: e.kind, title: e.title, url: e.url, at: e.at };
    const taskIds = links.get(e.id);
    if (taskIds && taskIds.length) for (const taskId of taskIds) evidence.push({ ...base, taskId });
    else evidence.push({ ...base, taskId: null });
  }

  return groupTimeline(evidence, taskInfo, taskSignals, members, todayISO);
}
