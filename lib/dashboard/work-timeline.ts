import "server-only";
import type { DbClient } from "@/lib/db/types";
import { visibleItems, visibleTasks, type ViewerTier } from "@/lib/auth/visibility";
import { subjectMatchesMember, type RosterPerson } from "./people-match";
import { commitSubject } from "./team-work";
import { groupTimeline, normalizeSource, type EvidenceWithMember, type TimelineDay, type TimelineMember } from "./timeline-group";

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
 *    excluded (file-level, attributed to the pusher — the double-count/mis-attribution trap). KNOWN v1
 *    noise: task `updated_at` is bulk-bumped when any row in a pushed tasks.md changes (materializeTasks)
 *    or on PM-sync writeback, so editing one row can list its whole file's tasks under "today". Deferred
 *    (the durable fix — only bump changed rows — lives in `lib/ingest`, out of this view's scope).
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
type TaskRow = { id: string; title: string; assignee: string | null; updated_at: string | Date };

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

function toIso(v: string | Date): string {
  return typeof v === "string" ? v : new Date(v).toISOString();
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
        .select("id, title, assignee, updated_at")
        .eq("team_id", teamId)
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
    const at = toIso(t.updated_at);
    if (Date.parse(at) < windowStartMs) continue;
    evidence.push({
      id: `task:${t.id}`,
      memberId: person.memberId,
      source: pmSource,
      kind: "task",
      title: t.title || "(untitled task)",
      at,
    });
  }

  return groupTimeline(evidence, members, todayISO);
}
