import "server-only";
import { ACTIVE_STATUSES } from "@/lib/tasks/activity-policy";
import { resolvePositiveInt } from "@/lib/util/env";
import type { DbClient } from "@/lib/db/types";
import { visibleItems, visibleTasks, visibleDecisions, type ViewerTier } from "@/lib/auth/visibility";
import { commitSubject } from "./team-work";
import { subjectMatchesMember, type RosterPerson } from "./people-match";
import {
  groupTimeline,
  normalizeSource,
  type EvidenceItem,
  type EvidenceTaskRef,
  type EvidenceWithMember,
  type SignalWithMember,
  type TaskInfo,
  type TimelineDay,
  type TimelineMember,
} from "./timeline-group";
import { computeTaskLinks } from "./issue-ref";
import { resolveItemCreditIds } from "@/lib/attribution/contributor-credit";
import { slackParticipations, foldProviderId } from "@/lib/ingest/slack-participants";

// Only ACTIVE tasks are considered work "in progress" — Linear In Progress/In Review both normalize to
// `in_progress`; `blocked` is active-but-stuck. Backlog/ready/done are context, excluded from the timeline.


/**
 * Server-only fetch for the Learning "Timeline" — the team's recent work as a day → person → evidence
 * ledger, read from Postgres `items` + `tasks` (NOT the graph: attribution + source live reliably on
 * items, and one item = one row, so the graph's 16-chunk doc spam disappears). Tier-gated through the
 * `visibleItems`/`visibleTasks` §5 choke-points; the pure grouping is `./timeline-group`.
 *
 * Design decisions (Fable spec review):
 *  • WORK time = the first present of `WORK_TIME_KEYS` (git `committed_at` → generic/Slack `source_ts` →
 *    a doc's own edit/create time: `updated`/`last_edited_time`/`modifiedTime`/`date`/`created`/…) —
 *    NEVER `synced_at`. Resolved ONCE at ingest and read from `items.work_at` here — not re-derived,
 *    so a SQL window and a TS caller cannot disagree. This is what INCLUDES attributed docs (Notion/Google Docs/
 *    deliverables) that carry an edit time but no git-style timestamp — previously dropped. Items with
 *    no real work time at all are still DROPPED (mirrors lib/graph/learning `workTs`).
 *  • The window is SQL-NATIVE on the persisted `items.work_at` (`work_at >= since ORDER BY work_at, id`,
 *    gated on `work_at_from_source`), hitting `items_team_work_at_idx`. It used to bound on `synced_at`
 *    — but every re-sync tick bumps that, so after one tick the whole corpus sat inside the window and
 *    the query really returned "the ITEM_LIMIT most recently PUSHED rows", ties broken by query plan:
 *    a re-scan of an old corpus could fill the page with out-of-window docs and silently evict the
 *    week's real work, differently on each rebuild. `id` is the tiebreak that makes the page stable.
 *    SLACK is the one exception — see the comment on its leg.
 *  • Body fetched ONLY for git commits (the issue key lives in the commit message); other items match
 *    on title + path — avoids pulling large doc bodies.
 *  • Tasks are EVIDENCE-GATED (product): a task appears iff ≥1 of the person's in-window evidence
 *    references its issue key — so the timeline lists the work someone actually touched, NOT the whole
 *    backlog and NOT empty headers. Status does NOT gate it: a ticket that shipped today still heads its
 *    group (its status rides on the header). A task is placed under the EVIDENCE author (who did the
 *    work), not its assignee — so a commit citing someone else's ticket shows the contribution correctly.
 *    Only evidence referencing NO visible task falls to "Other".
 *  • Meetings (granola) are team signal, not one person's output → excluded from the per-person view
 *    (a granola item's member_id is the recorder, not the participants).
 *  • SLACK is included PER-PARTICIPANT: threads carry a `participants[]` frontmatter ledger (distinct
 *    authors + first/last contribution time, written by `lib/ingest/sources/slack-normalize`, kept OUT
 *    of `authors[]` so a replier can't steal thread ownership). Slack items are queried SEPARATELY (no
 *    `member_id` filter) so a thread whose ROOT is unmapped still surfaces for its mapped repliers; each
 *    contributor sees the thread in their day, dated by their last message. Unmapped participants drop.
 */

/** Default lookback for the timeline ledger — what every cached surface (panel, CLI) shows. */
export const WINDOW_DAYS = 7;
/** Hard cap on an on-demand "show earlier days" expansion. Bounds the fetch cost (ITEM_LIMIT is the
 *  real ceiling at scale) and keeps an uncached expand build cheap enough to run on a request. */
export const MAX_WINDOW_DAYS = 30;
/** Rows fetched per item leg. Env-tunable so the data-mechanics tier can exercise SATURATION (the cap
 *  actually biting) without seeding thousands of rows — the tests read this same constant, so the
 *  assertions stay honest at any window size. */
export const ITEM_LIMIT = resolvePositiveInt(process.env.TIMELINE_ITEM_LIMIT, 2000);
const TASK_LIMIT = 2000;
const DECISION_LIMIT = 500;
/** Resolved PR→task links pulled for the commit-inheritance join (prod today: ~1k work_events total). */
const WORK_EVENT_LIMIT = 5000;
/** Commit↔PR join width. `work_events.merged_sha` is the full 40 chars; the CLI pushes a 10-char
 *  `frontmatter.sha`, so both sides normalize to this prefix. 40 bits — collision risk ~1e-7 at our scale. */
const SHA_JOIN_LEN = 10;

/** The pg adapter hands timestamptz back as a string or a Date depending on the driver path; both
 *  become the ISO string the day-bucketing expects. Null only for a row written before `work_at`. */
function isoOrNull(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

type ItemRow = {
  id: string;
  kind?: string;
  member_id: string | null;
  member_id_locked?: boolean | null;
  frontmatter: Record<string, unknown> | null;
  body?: string | null;
  path?: string | null;
  /** Persisted work-time (R1) — read, never re-derived. */
  work_at?: string | Date | null;
  synced_at?: string | Date;
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
  tier: ViewerTier,
  windowDays: number = WINDOW_DAYS
): Promise<TimelineDay[]> {
  // Clamp to [1, MAX] — the window drives both the DB fetch bound (`sinceIso`) and the in-window filter,
  // so an unbounded caller value can't widen the query past the cost cap.
  const days = Math.max(1, Math.min(Math.floor(windowDays) || WINDOW_DAYS, MAX_WINDOW_DAYS));
  const windowStartMs = Date.now() - days * 86_400_000;
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

  // Slack user id → member (lowercased, matching the identity resolver's case-folding). Best-effort —
  // a failure isn't fatal, but WARN so a systemic break (renamed column, adapter change) that silently
  // kills all Slack evidence forever leaves a signal instead of an undiagnosable blank.
  if (slackIdRes.error) console.warn("[work-timeline] slack identities read failed:", slackIdRes.error.message);
  const slackIdToMember = new Map<string, string>();
  for (const r of (slackIdRes.data ?? []) as { external_id: string | null; member_id: string | null }[]) {
    if (r.external_id && r.member_id) slackIdToMember.set(foldProviderId(r.external_id), r.member_id);
  }

  // A task's source = the team's PM provider (linear/plane). With none configured, use a generic
  // "tasks" slug (check icon + "Tasks" label) rather than "other" (which reads as "Files").
  const pmProvider = str((teamRes.data as { primary_pm_provider: string | null } | null)?.primary_pm_provider);
  const pmSource = pmProvider ? normalizeSource(pmProvider) : "tasks";

  const [gitRes, otherRes, taskRes, slackRes, decisionRes] = await Promise.all([
    // Git commits (title = commit subject → needs body; commit bodies are small).
    visibleItems(
      db
        .from("items")
        .select("id, member_id, member_id_locked, frontmatter, body, work_at")
        .eq("team_id", teamId)
        .eq("frontmatter->>source", "git")
        .not("member_id", "is", null)
        .eq("work_at_from_source", true)
        .gte("work_at", sinceIso)
        .order("work_at", { ascending: false })
        .order("id", { ascending: false })
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
        .select("id, kind, member_id, member_id_locked, frontmatter, path, work_at")
        .eq("team_id", teamId)
        .neq("kind", "task")
        .not("member_id", "is", null)
        .eq("work_at_from_source", true)
        .gte("work_at", sinceIso)
        .order("work_at", { ascending: false })
        .order("id", { ascending: false })
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
        .in("status", [...ACTIVE_STATUSES])
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
        // DELIBERATE EXCEPTION: this leg keeps the `synced_at` bound while the others moved to
        // `work_at`. A Slack row's `work_at` is the thread ROOT's `source_ts`, which replies never
        // bump — but the builder dates each participant by their OWN last message. So a thread
        // rooted 10 days ago with a reply yesterday has an out-of-window `work_at` and an in-window
        // contribution: bounding on `work_at` silently drops exactly the long-running threads people
        // are actively working in. `synced_at` is a valid superset here (a live thread re-syncs every
        // tick), and the REAL filter is the per-participant window in the loop below.
        // The principled fix is for slack-normalize to date a thread by its LAST activity rather than
        // its root; that changes the graph's episode dating too, so it's deliberately not in this PR.
        .gte("synced_at", sinceIso)
        .order("synced_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(ITEM_LIMIT),
      tier
    ),
    // DECISIONS — the CONTEXT lane (signal, never counted as work). Dated by `decided_at` (a DATE).
    // Tier-gated by the decision's own `audience` via the §5 choke-point.
    visibleDecisions(
      db
        .from("decisions")
        .select("id, title, decided_by, decided_at, source_item_id, still_valid, audience")
        .eq("team_id", teamId)
        .gte("decided_at", sinceIso.slice(0, 10))
        .order("decided_at", { ascending: false })
        .limit(DECISION_LIMIT),
      tier
    ),
  ]);
  // THROW on any evidence-query error too — a partial ledger (one of the legs failed) must not
  // be cached/served as complete. See the members-error note above. Slack is best-effort ENRICHMENT
  // (a failure just means no Slack rows), so it does NOT throw — never fail the whole ledger over it.
  if (gitRes.error) throw new Error(`work-timeline git: ${gitRes.error.message}`);
  if (otherRes.error) throw new Error(`work-timeline items: ${otherRes.error.message}`);
  if (taskRes.error) throw new Error(`work-timeline tasks: ${taskRes.error.message}`);

  // The ACTIVE set. It is no longer the whole link-target set (any referenced task can head a group —
  // see the union at `linkTargets`), but it is still fetched separately so active tasks are guaranteed
  // present even when the all-status read clips at TASK_LIMIT. Evidence-gated in the grouper.
  const tasks = (taskRes.data ?? []) as TaskRow[];

  const taskInfo = new Map<string, TaskInfo>();
  for (const t of tasks) taskInfo.set(t.id, { title: t.title || "(untitled task)", status: t.status || "", source: pmSource });

  // ATTRIBUTION ORACLE (single source of truth): credit each evidence item to its PRIMARY contributor —
  // the actual worker, via `item_versions` — not merely the current `member_id` owner. So a reassigned
  // item shows under who did the work, matching arcs + the admin page (they all read this oracle → they
  // can't drift; guarded by test/guards/attribution-single-source). STRICT: a versions-read failure THROWS
  // (never cache an empty ledger as fresh — same contract as the leg queries above). At current scale
  // primary == owner for ~all items, so this is a near-no-op today but correct as handoffs grow. Slack is
  // EXEMPT — its per-participant `participants[]` ledger IS its evidence-gated credit (see its leg below).
  const gitOtherRows = [...((gitRes.data ?? []) as ItemRow[]), ...((otherRes.data ?? []) as ItemRow[])];
  // Pass the already-fetched rows so the oracle skips a redundant `items` re-read; it still reads
  // item_versions + members. `frontmatter` is forwarded (already selected, so it costs nothing): a
  // CONVERSATION source keeps its work ledger there, and omitting it would silently hand the oracle
  // the root-stamped version authors instead — wrong credit with no signal.
  const credit = await resolveItemCreditIds(db, teamId, gitOtherRows.map((r) => r.id), {
    strict: true,
    items: gitOtherRows.map((r) => ({
      id: r.id,
      member_id: r.member_id,
      member_id_locked: r.member_id_locked ?? null,
      frontmatter: r.frontmatter ?? null,
    })),
  });
  // Primary contributor for an item, falling back to the current owner when the oracle has no opinion
  // (e.g. no human version history). Kept the `.not("member_id","is",null)` prefetch prefilter on the leg
  // queries: an owner-null but version-authored item stays hidden (documented — matches prior behavior).
  const primaryOf = (r: ItemRow): string | null => credit.get(r.id)?.primaryId ?? r.member_id;

  // In-window evidence items (commits + docs) with the text an issue key would appear in. A git
  // commit's key is in its BODY; other items' in the title/path (no large-body fetch — see the
  // otherRes select). `kind='task'` items + granola meetings are excluded; Slack is its own leg below.
  // `sha` is set for git commits only — the join key to the PR that merged them (work_events.merged_sha).
  type Ev = EvidenceItem & { memberId: string; text: string; sha?: string };
  const evItems: Ev[] = [];
  for (const r of (gitRes.data ?? []) as ItemRow[]) {
    const memberId = primaryOf(r);
    if (!memberId || !members.has(memberId)) continue;
    const at = isoOrNull(r.work_at);
    if (!at || !inWindow(at)) continue;
    const fm = r.frontmatter ?? {};
    const title = str(fm.title) || commitSubject(r.body ?? "") || "commit";
    evItems.push({ id: r.id, memberId, source: "github", kind: "commit", title, url: httpUrl(fm.source_url), at, text: `${title}\n${r.body ?? ""}`, sha: str(fm.sha) });
  }
  for (const r of (otherRes.data ?? []) as ItemRow[]) {
    const fm = r.frontmatter ?? {};
    if (str(fm.source) === "git") continue; // handled by gitRes — no double-count
    const source = normalizeSource(str(fm.source));
    if (source === "slack" || source === "granola" || r.kind === "transcript") continue; // slack: own query; meetings: excluded
    // A PM issue's own description doc is the TICKET, not work done on it — and its path/title carry
    // the issue's own key, so admitting it as evidence would let every assigned ticket self-satisfy
    // the evidence gate and turn the timeline back into a backlog dump (the property "never the whole
    // backlog" exists to prevent). The ticket already appears as a TASK; real work on it arrives as
    // commits/docs that cite the key. (These docs are dated for the GRAPH's sake — see the linear/plane
    // normalizers — so this exclusion is what keeps the timeline's behavior unchanged.)
    if (str(fm.identifier) && (source === "linear" || source === "plane")) continue;
    const memberId = primaryOf(r);
    if (!memberId || !members.has(memberId)) continue;
    const at = isoOrNull(r.work_at);
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
    // Parsed by the SHARED ledger reader (`lib/ingest/slack-participants`) — the same one the credit
    // oracle uses, so the two surfaces can't drift on dedup or id case again. It already returns one
    // entry per distinct author (their latest contribution time), which also keeps the synthetic row
    // id unique per (thread, participant).
    for (const p of slackParticipations(fm)) {
      const authorId = p.authorId;
      const memberId = slackIdToMember.get(foldProviderId(authorId));
      if (!memberId || !members.has(memberId)) continue;
      const at = p.lastTs;
      if (!at || !inWindow(at)) continue;
      // One row per (thread, participant); text = title (no body fetch — a thread citing an issue key in
      // its first line still links to a task, else it lands in "Other").
      evItems.push({ id: `${r.id}:${authorId}`, memberId, source: "slack", kind: "slack", title, at, text: title });
    }
  }

  // Deterministic issue-key links, computed INLINE against ALL visible tasks (any status) so the Timeline
  // is always fresh AND a just-shipped ticket can head its own group. (Previously a second, active-only
  // pass drove nesting; that produced "Other · not linked to a task" rows each carrying a chip naming the
  // task they were linked to. Evidence-gating in the grouper is what keeps the backlog out.)
  const allTaskRes = await visibleTasks(
    db
      .from("tasks")
      .select("id, row_key, title, status")
      .eq("team_id", teamId)
      .not("row_key", "is", null)
      .order("updated_at", { ascending: false })
      .limit(TASK_LIMIT),
    tier
  );
  // Chips are ENRICHMENT (not a core ledger leg) — a failed read must NOT blank the ledger, but it also
  // must not be silent (the swallowed-error trap this file warns about). WARN, like the Slack leg.
  if (allTaskRes.error) console.warn("[work-timeline] chip-task read failed:", allTaskRes.error.message);
  const allTasks = (allTaskRes.data ?? []) as TaskRow[];
  const chipInfo = new Map<string, EvidenceTaskRef>();
  for (const t of allTasks) if (t.row_key) chipInfo.set(t.id, { key: t.row_key.toUpperCase(), title: t.title || "(untitled task)", status: t.status ?? "" });

  // A REFERENCED task is a nesting header whatever its status. Previously only ACTIVE tasks could head a
  // group, so a commit citing a just-shipped ticket landed in "Other · not linked to a task" — while
  // carrying a chip naming that very task. The header contradicted the row beneath it. Evidence-gating
  // (a task appears only where someone's in-window evidence references it) is what keeps the backlog out;
  // "active-only" was a second, redundant filter that only produced the contradiction. So: merge every
  // referenced task into `taskInfo`, and "Other" goes back to meaning what it says — no task at all.
  // The active fetch is still kept above so active tasks survive even if this all-status read clips at
  // TASK_LIMIT. Tier: `allTasks` came through the same `visibleTasks` choke-point as the active set.
  for (const t of allTasks) {
    if (!taskInfo.has(t.id)) taskInfo.set(t.id, { title: t.title || "(untitled task)", status: t.status || "", source: pmSource });
  }
  // Link targets = the UNION of both fetches, deduped. The all-status read orders by `updated_at DESC`, so
  // on a busy backlog an ACTIVE task can be pushed past TASK_LIMIT and vanish from `allTasks` — without the
  // union, a commit citing that active task's key would nest nowhere. The active fetch is the guarantee.
  const linkTargets = [...new Map([...allTasks, ...tasks].map((t) => [t.id, t])).values()];
  const allLinks = computeTaskLinks(
    linkTargets.map((t) => ({ id: t.id, row_key: t.row_key })),
    evItems.map((e) => ({ id: e.id, text: e.text }))
  );

  // PR-INHERITED links: the issue key usually lives on the PULL REQUEST, not on each commit message — so a
  // commit whose own text cites nothing still belongs to its PR's task. `work_events` already records that
  // PR→task resolution; join it by sha. `merged_sha` is the FULL 40 chars; the CLI pushes a 10-char
  // `frontmatter.sha`, so BOTH sides are normalized to the 10-char prefix — a future CLI that pushes the
  // full sha then still joins instead of silently missing. Squash-merge makes this 1 commit ↔ 1 PR (a
  // merge-commit PR's individual commits won't inherit — a known coverage limit, not a bug).
  // Enrichment → WARN, never throw.
  const shaKey = (s: string) => s.trim().toLowerCase().slice(0, SHA_JOIN_LEN);
  const commitShas = new Set(evItems.map((e) => e.sha).filter((s): s is string => !!s).map(shaKey));
  const prTaskIdsBySha = new Map<string, string[]>();
  if (commitShas.size > 0) {
    const weRes = await db
      .from("work_events")
      .select("merged_sha, task_id")
      .eq("team_id", teamId)
      .not("task_id", "is", null)
      // Bounded like every other leg. NEWEST-first so truncation sheds the OLDEST links — those belong to
      // PRs merged long before the window, which by construction can't match an in-window commit's sha.
      .order("updated_at", { ascending: false })
      .limit(WORK_EVENT_LIMIT);
    if (weRes.error) console.warn("[work-timeline] work-events read failed:", weRes.error.message);
    for (const w of (weRes.data ?? []) as { merged_sha: string | null; task_id: string | null }[]) {
      if (!w.merged_sha || !w.task_id) continue;
      const key = shaKey(w.merged_sha);
      if (!commitShas.has(key)) continue;
      const list = prTaskIdsBySha.get(key) ?? [];
      if (!list.includes(w.task_id)) list.push(w.task_id); // a PR can resolve to >1 task — keep them all
      prTaskIdsBySha.set(key, list);
    }
  }

  // One evidence row per (item, referenced task). An item that references NO task carries taskId=null and
  // is the only thing that lands in "Other". A commit citing two issues appears under both. The grouper
  // then evidence-gates: a task shows ONLY where it has ≥1 of this person's evidence that day (no empty
  // headers) — that gate, not a status filter, is what keeps the backlog off the timeline.
  const evidence: EvidenceWithMember[] = [];
  for (const e of evItems) {
    const base: EvidenceItem & { memberId: string } = { id: e.id, memberId: e.memberId, source: e.source, kind: e.kind, title: e.title, url: e.url, at: e.at };
    // Resolve against ALL referenced tasks (`allLinks`), not just the active ones, so a just-shipped
    // ticket heads its own group instead of its evidence falling to "Other" with a contradicting chip.
    const ownTaskIds = (allLinks.get(e.id) ?? []).filter((id) => taskInfo.has(id));
    // TIER: every id here — own-text or inherited — is resolved ONLY against `taskInfo`, which was built
    // entirely from reads through the `visibleTasks` choke-point. An id outside it links nothing, silently.
    const inherited = e.sha ? prTaskIdsBySha.get(shaKey(e.sha)) ?? [] : [];
    if (ownTaskIds.length) {
      // The item's OWN cited key wins — most specific.
      for (const taskId of ownTaskIds) evidence.push({ ...base, taskId, linkVia: "commit-text" });
      continue;
    }
    const inheritedVisible = inherited.filter((id) => taskInfo.has(id));
    if (inheritedVisible.length) {
      for (const taskId of inheritedVisible) evidence.push({ ...base, taskId, linkVia: "pr" });
      continue;
    }
    // Genuinely no task → "Other", with no chip. The #373 chip existed ONLY because a done/backlog task
    // couldn't be a header; now that any referenced task heads its own group, the chip is unreachable by
    // construction — every id `allLinks` can yield comes from `linkTargets`, all of which are in
    // `taskInfo`, so reaching here means the item references no visible task at all and there is nothing
    // to chip. (`EvidenceTaskRef`/`linkedTask` stay in the payload type so cached rows written by the
    // previous build still render during their TTL; nothing populates them any more.)
    evidence.push({ ...base, taskId: null });
  }

  // SIGNAL lane — decisions (data ABOUT work, never counted as work). WARN, not throw: this is a context
  // enrichment leg (like Slack), so a decisions read failure must not blank the WORK timeline.
  if (decisionRes.error) console.warn("[work-timeline] decisions read failed:", decisionRes.error.message);
  const signals: SignalWithMember[] = [];
  for (const d of (decisionRes.data ?? []) as {
    id: string;
    title: string | null;
    decided_by: string | null;
    decided_at: string | null;
    source_item_id: string | null;
    still_valid: boolean | null;
  }[]) {
    if (!d.decided_at) continue; // no day to place it on (mirrors the undated-work drop)
    const by = (d.decided_by ?? "").trim();
    if (!by) continue; // empty / group-level decided_by → dropped (a later team-signal lane's job)
    // MULTI-person decided_by ("Chetan + John", "A & B", "Dana and Lee") → drop: crediting one is wrong,
    // and `subjectMatchesMember` folds "Chetan + John" onto a bare-first-name member (would falsely match 1).
    if (/[+&,/]|\band\b/i.test(by)) continue;
    // Attribute to a member — but DROP on AMBIGUOUS (≥2 roster matches) or NO match: never guess.
    const matched = roster.filter((p) => subjectMatchesMember(by, p));
    if (matched.length !== 1) continue;
    signals.push({
      id: d.id,
      memberId: matched[0].memberId,
      kind: "decision",
      title: d.title || "(untitled decision)",
      at: d.decided_at.slice(0, 10), // bare YYYY-MM-DD — rendered with no time
      url: d.source_item_id ? `/library/${d.source_item_id}` : undefined,
      stillValid: d.still_valid ?? true,
    });
  }

  return groupTimeline(evidence, taskInfo, members, todayISO, undefined, signals);
}
