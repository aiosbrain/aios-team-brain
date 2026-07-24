import "server-only";
import type { DbClient } from "@/lib/db/types";
import { visibleItems, visibleTasks, type ViewerTier } from "@/lib/auth/visibility";
import { commitSubject } from "./team-work";
import {
  groupTimeline,
  normalizeSource,
  itemWorkTime,
  type EvidenceItem,
  type EvidenceWithMember,
  type TaskInfo,
  type TimelineDay,
  type TimelineMember,
} from "./timeline-group";
import { computeTaskLinks } from "./issue-ref";
import { resolveItemCreditIds } from "@/lib/attribution/contributor-credit";

// Only ACTIVE tasks are considered work "in progress" — Linear In Progress/In Review both normalize to
// `in_progress`; `blocked` is active-but-stuck. Backlog/ready/done are context, excluded from the timeline.
const ACTIVE_TASK_STATUSES = new Set(["in_progress", "blocked"]);

/**
 * Server-only fetch for the Learning "Timeline" — the team's recent work as a day → person → evidence
 * ledger, read from Postgres `items` + `tasks` (NOT the graph: attribution + source live reliably on
 * items, and one item = one row, so the graph's 16-chunk doc spam disappears). Tier-gated through the
 * `visibleItems`/`visibleTasks` §5 choke-points; the pure grouping is `./timeline-group`.
 *
 * Design decisions (Fable spec review):
 *  • WORK time = the first present of `WORK_TIME_KEYS` (git `committed_at` → generic/Slack `source_ts` →
 *    a doc's own edit/create time: `updated`/`last_edited_time`/`modifiedTime`/`date`/`created`/…) —
 *    NEVER `synced_at`. Every listed field is source-frozen, so a re-scan can't resurface an item as
 *    "today's work"; `synced_at` would. This is what INCLUDES attributed docs (Notion/Google Docs/
 *    deliverables) that carry an edit time but no git-style timestamp — previously dropped. Items with
 *    no real work time at all are still DROPPED (mirrors lib/graph/learning `workTs`).
 *  • `.gte("synced_at", sinceIso)` bounds the fetch: sync is always at-or-after the work, so a 7-day
 *    synced_at window is a complete superset of the 7-day work window (and hits `items_team_synced_idx`).
 *    Caveat: re-pushes bump synced_at, so at scale the real bound is `ITEM_LIMIT` ordered by synced_at;
 *    a >2000-live-item team could clip in-window work. Fine at current scale — a follow-up is to push
 *    the work-time filter into SQL (needs a computed/indexed work-time column).
 *  • Body fetched ONLY for git commits (the issue key lives in the commit message); other items match
 *    on title + path — avoids pulling large doc bodies.
 *  • Tasks are ACTIVE-only + EVIDENCE-GATED (product): a task appears iff its status is in-progress
 *    (`ACTIVE_TASK_STATUSES`) AND ≥1 of the person's in-window evidence references its issue key. So the
 *    timeline lists the in-progress work someone actually touched — NOT the whole backlog, and NOT empty
 *    headers. A task is placed under the EVIDENCE author (who did the work), not its assignee — so a
 *    commit citing someone else's ticket shows the contribution correctly. Evidence referencing a
 *    backlog/done issue (not in the active set) falls to "Other".
 *  • Meetings (granola) are team signal, not one person's output → excluded from the per-person view
 *    (a granola item's member_id is the recorder, not the participants).
 *  • SLACK is included PER-PARTICIPANT: threads carry a `participants[]` frontmatter ledger (distinct
 *    authors + first/last contribution time, written by `lib/ingest/sources/slack-normalize`, kept OUT
 *    of `authors[]` so a replier can't steal thread ownership). Slack items are queried SEPARATELY (no
 *    `member_id` filter) so a thread whose ROOT is unmapped still surfaces for its mapped repliers; each
 *    contributor sees the thread in their day, dated by their last message. Unmapped participants drop.
 */

const WINDOW_DAYS = 7;
const ITEM_LIMIT = 2000;
const TASK_LIMIT = 2000;

type ItemRow = {
  id: string;
  kind?: string;
  member_id: string | null;
  member_id_locked?: boolean | null;
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
};


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
  // Upper bound (+1d clock/timezone skew): a hand-authored doc can carry a FUTURE `date`/`updated`
  // (a plan dated next month). Without this it'd create a future day bucket that sorts first and pins as
  // a person's "most recent day" until the date passes. Git/Slack times are never future; this guards docs.
  const futureBoundMs = Date.now() + 86_400_000;
  const inWindow = (at: string): boolean => {
    const t = Date.parse(at);
    return !Number.isNaN(t) && t >= windowStartMs && t <= futureBoundMs;
  };
  const todayISO = new Date().toISOString().slice(0, 10);

  const [memberRes, teamRes, slackIdRes] = await Promise.all([
    db.from("members").select("id, display_name, actor_handle, avatar_url, email").eq("team_id", teamId).eq("status", "active"),
    db.from("teams").select("primary_pm_provider").eq("id", teamId).maybeSingle(),
    // Slack user id → member, for per-participant Slack attribution. Best-effort ENRICHMENT (a missing
    // map just means no Slack rows), so — unlike the core ledger legs — a failure here isn't fatal.
    db.from("member_identities").select("external_id, member_id").eq("team_id", teamId).eq("provider", "slack"),
  ]);
  // THROW on a query error — never treat a DB failure (pool contention, #249) as "empty". The pg
  // adapter returns {data:null,error} instead of throwing, so an unchecked `?? []` would silently
  // yield an empty/partial ledger — which `getCachedWorkTimeline` would then persist as a "fresh"
  // row and serve everywhere. The persisted layer's "empty = a quiet week" contract only holds if a
  // real error propagates instead: a cold-miss build 500s the route (and the panel's error boundary
  // catches it), and a background rebuild's throw is caught WITHOUT writing, keeping the good prior.
  // (teamRes only degrades the pmSource label, so a null there is cosmetic — not fatal.)
  if (memberRes.error) throw new Error(`work-timeline members: ${memberRes.error.message}`);

  // Real people only — connectors author sync noise, not work (excludes connector/service members).
  const humans = ((memberRes.data ?? []) as {
    id: string;
    display_name: string | null;
    actor_handle: string | null;
    avatar_url: string | null;
    email: string | null;
  }[]).filter((m) => !(m.email ?? "").endsWith("@connector.local"));
  const members = new Map<string, TimelineMember>();
  for (const m of humans) {
    members.set(m.id, {
      name: m.display_name ?? m.actor_handle ?? "Unknown",
      handle: m.actor_handle ?? "",
      avatarUrl: m.avatar_url,
    });
  }
  if (members.size === 0) return [];

  // Slack user id → member (lowercased, matching the identity resolver's case-folding). Best-effort —
  // a failure isn't fatal, but WARN so a systemic break (renamed column, adapter change) that silently
  // kills all Slack evidence forever leaves a signal instead of an undiagnosable blank.
  if (slackIdRes.error) console.warn("[work-timeline] slack identities read failed:", slackIdRes.error.message);
  const slackIdToMember = new Map<string, string>();
  for (const r of (slackIdRes.data ?? []) as { external_id: string | null; member_id: string | null }[]) {
    if (r.external_id && r.member_id) slackIdToMember.set(r.external_id.toLowerCase(), r.member_id);
  }

  // A task's source = the team's PM provider (linear/plane). With none configured, use a generic
  // "tasks" slug (check icon + "Tasks" label) rather than "other" (which reads as "Files").
  const pmProvider = str((teamRes.data as { primary_pm_provider: string | null } | null)?.primary_pm_provider);
  const pmSource = pmProvider ? normalizeSource(pmProvider) : "tasks";

  const [gitRes, otherRes, taskRes, slackRes] = await Promise.all([
    // Git commits (title = commit subject → needs body; commit bodies are small).
    visibleItems(
      db
        .from("items")
        .select("id, member_id, member_id_locked, frontmatter, body, synced_at")
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
        .select("id, kind, member_id, member_id_locked, frontmatter, path, synced_at")
        .eq("team_id", teamId)
        .neq("kind", "task")
        .not("member_id", "is", null)
        .gte("synced_at", sinceIso)
        .order("synced_at", { ascending: false })
        .limit(ITEM_LIMIT),
      tier
    ),
    // ACTIVE tasks only — filtered in SQL so a backlog-heavy team can't push active tasks past
    // TASK_LIMIT. NOT window-filtered (evidence may reference a task last touched >7d ago; we need its
    // title/row_key). Evidence-gated in the grouper.
    visibleTasks(
      db
        .from("tasks")
        .select("id, row_key, title, status")
        .eq("team_id", teamId)
        .in("status", [...ACTIVE_TASK_STATUSES])
        .order("updated_at", { ascending: false })
        .limit(TASK_LIMIT),
      tier
    ),
    // SLACK threads — fetched SEPARATELY (no `member_id` filter, unlike gitRes/otherRes) so a thread
    // whose ROOT author is unmapped or a connector is still processed for its MAPPED repliers: per-
    // participant attribution reads `frontmatter.participants[]`, not the item's single `member_id`.
    // Tier-gated through the same §5 choke-point. `participants`/`title` are backfilled onto existing
    // items by the ingest frontmatter-heal, so this is empty until the first Slack sync post-deploy.
    visibleItems(
      db
        .from("items")
        .select("id, frontmatter, synced_at")
        .eq("team_id", teamId)
        .eq("frontmatter->>source", "slack")
        .gte("synced_at", sinceIso)
        .order("synced_at", { ascending: false })
        .limit(ITEM_LIMIT),
      tier
    ),
  ]);
  // THROW on any evidence-query error too — a partial ledger (one of the legs failed) must not
  // be cached/served as complete. See the members-error note above. Slack is best-effort ENRICHMENT
  // (a failure just means no Slack rows), so it does NOT throw — never fail the whole ledger over it.
  if (gitRes.error) throw new Error(`work-timeline git: ${gitRes.error.message}`);
  if (otherRes.error) throw new Error(`work-timeline items: ${otherRes.error.message}`);
  if (taskRes.error) throw new Error(`work-timeline tasks: ${taskRes.error.message}`);

  // ONLY ACTIVE tasks (filtered in SQL above) are the link-target set: a commit citing a backlog/done
  // issue's key won't link → its evidence goes to "Other", and the backlog/done task never appears.
  // Tasks are then EVIDENCE-GATED in the grouper (no empty headers).
  const tasks = (taskRes.data ?? []) as TaskRow[];

  const taskInfo = new Map<string, TaskInfo>();
  for (const t of tasks) taskInfo.set(t.id, { title: t.title || "(untitled task)", status: t.status || "in_progress", source: pmSource });

  // ATTRIBUTION ORACLE (single source of truth): credit each evidence item to its PRIMARY contributor —
  // the actual worker, via `item_versions` — not merely the current `member_id` owner. So a reassigned
  // item shows under who did the work, matching arcs + the admin page (they all read this oracle → they
  // can't drift; guarded by test/guards/attribution-single-source). STRICT: a versions-read failure THROWS
  // (never cache an empty ledger as fresh — same contract as the leg queries above). At current scale
  // primary == owner for ~all items, so this is a near-no-op today but correct as handoffs grow. Slack is
  // EXEMPT — its per-participant `participants[]` ledger IS its evidence-gated credit (see its leg below).
  const gitOtherRows = [...((gitRes.data ?? []) as ItemRow[]), ...((otherRes.data ?? []) as ItemRow[])];
  // Pass the already-fetched rows so the oracle skips a redundant `items` re-read (it only needs
  // id/member_id/member_id_locked, all selected above); it still reads item_versions + members.
  const credit = await resolveItemCreditIds(db, teamId, gitOtherRows.map((r) => r.id), {
    strict: true,
    items: gitOtherRows.map((r) => ({ id: r.id, member_id: r.member_id, member_id_locked: r.member_id_locked ?? null })),
  });
  // Primary contributor for an item, falling back to the current owner when the oracle has no opinion
  // (e.g. no human version history). Kept the `.not("member_id","is",null)` prefetch prefilter on the leg
  // queries: an owner-null but version-authored item stays hidden (documented — matches prior behavior).
  const primaryOf = (r: ItemRow): string | null => credit.get(r.id)?.primaryId ?? r.member_id;

  // In-window evidence items (commits + docs) with the text an issue key would appear in. A git
  // commit's key is in its BODY; other items' in the title/path (no large-body fetch — see the
  // otherRes select). `kind='task'` items + granola meetings are excluded; Slack is its own leg below.
  type Ev = EvidenceItem & { memberId: string; text: string };
  const evItems: Ev[] = [];
  for (const r of (gitRes.data ?? []) as ItemRow[]) {
    const memberId = primaryOf(r);
    if (!memberId || !members.has(memberId)) continue;
    const at = itemWorkTime(r.frontmatter);
    if (!at || !inWindow(at)) continue;
    const fm = r.frontmatter ?? {};
    const title = str(fm.title) || commitSubject(r.body ?? "") || "commit";
    evItems.push({ id: r.id, memberId, source: "github", kind: "commit", title, url: httpUrl(fm.source_url), at, text: `${title}\n${r.body ?? ""}` });
  }
  for (const r of (otherRes.data ?? []) as ItemRow[]) {
    const fm = r.frontmatter ?? {};
    if (str(fm.source) === "git") continue; // handled by gitRes — no double-count
    const source = normalizeSource(str(fm.source));
    if (source === "slack" || source === "granola" || r.kind === "transcript") continue; // slack: own query; meetings: excluded
    const memberId = primaryOf(r);
    if (!memberId || !members.has(memberId)) continue;
    const at = itemWorkTime(fm);
    if (!at || !inWindow(at)) continue;
    const title = str(fm.title) || (r.path ? basename(r.path) : "") || "(untitled)";
    evItems.push({ id: r.id, memberId, source, kind: r.kind ?? "item", title, url: httpUrl(fm.source_url), at, text: `${title}\n${r.path ?? ""}` });
  }

  // SLACK — per PARTICIPANT (its own query so a thread whose ROOT is unmapped is still processed for its
  // mapped repliers). Each contributor sees the thread in their day, dated by when THEY last messaged;
  // an unmapped/connector participant is dropped (never guessed). `title` is the topic snippet.
  // Best-effort — WARN (don't throw) so a systemic slack-read failure is visible, not a silent blank.
  if (slackRes.error) console.warn("[work-timeline] slack items read failed:", slackRes.error.message);
  for (const r of (slackRes.data ?? []) as ItemRow[]) {
    const fm = r.frontmatter ?? {};
    const title = str(fm.title) || `#${str(fm.channel) ?? "slack"} thread`;
    const participants = Array.isArray(fm.participants) ? (fm.participants as { author_id?: unknown; last_ts?: unknown }[]) : [];
    const seen = new Set<string>(); // stored frontmatter is pusher-shaped — dedup so a duplicate author entry can't emit two rows with the same synthetic id (React key collision).
    for (const p of participants) {
      const authorId = str(p?.author_id);
      const memberId = authorId ? slackIdToMember.get(authorId.toLowerCase()) : undefined;
      if (!memberId || !members.has(memberId)) continue;
      if (seen.has(authorId!)) continue;
      seen.add(authorId!);
      const at = str(p?.last_ts);
      if (!at || !inWindow(at)) continue;
      // One row per (thread, participant); text = title (no body fetch — a thread citing an issue key in
      // its first line still links to a task, else it lands in "Other").
      evItems.push({ id: `${r.id}:${authorId}`, memberId, source: "slack", kind: "slack", title, at, text: title });
    }
  }

  // Deterministic issue-key links to the ACTIVE tasks only (computed INLINE so the Timeline is always
  // fresh). A commit citing a backlog/done issue won't match (it's not in the active set) → "Other".
  const links = computeTaskLinks(
    tasks.map((t) => ({ id: t.id, row_key: t.row_key })),
    evItems.map((e) => ({ id: e.id, text: e.text }))
  );

  // One evidence row per (item, linked active task); unlinked items carry taskId=null (→ the "Other"
  // bucket). A commit citing two issues appears under both. The grouper then evidence-gates: a task
  // shows ONLY where it has ≥1 of this person's evidence that day (no empty headers).
  const evidence: EvidenceWithMember[] = [];
  for (const e of evItems) {
    const base: EvidenceItem & { memberId: string } = { id: e.id, memberId: e.memberId, source: e.source, kind: e.kind, title: e.title, url: e.url, at: e.at };
    const taskIds = links.get(e.id);
    if (taskIds && taskIds.length) for (const taskId of taskIds) evidence.push({ ...base, taskId });
    else evidence.push({ ...base, taskId: null });
  }

  return groupTimeline(evidence, taskInfo, members, todayISO);
}
