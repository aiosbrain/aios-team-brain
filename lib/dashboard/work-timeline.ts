import "server-only";
import { ACTIVE_STATUSES } from "@/lib/tasks/activity-policy";
import { resolvePositiveInt } from "@/lib/util/env";
import type { DbClient } from "@/lib/db/types";
import { isRestrictedTier, type ViewerTier } from "@/lib/auth/visibility";
import { commitSubject } from "./team-work";
import { sourceRules } from "@/lib/ingest/source-rules";
import { assigneeMember, decisionActors, type RosterPerson } from "./people-match";
import {
  groupTimeline,
  normalizeSource,
  MEETING_SOURCE,
  type EvidenceItem,
  type EvidenceTaskRef,
  type EvidenceWithMember,
  type SignalWithMember,
  type TaskInfo,
  type TimelineDay,
  type TimelineMember,
} from "./timeline-group";
import { computeTaskLinks } from "./issue-ref";
import { MIN_CONFIDENCE } from "./doc-task-infer";
import { resolveItemCreditIds } from "@/lib/attribution/contributor-credit";
import { slackParticipations, foldProviderId } from "@/lib/ingest/slack-participants";
import { canSeeMeetingNotes } from "@/lib/meetings/notes";
import { isCalendarEvent } from "@/lib/meetings/from-calendar";

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
 *  • MEETINGS are per-person WORK, one row per ATTENDEE (see the meetings leg at the end of the
 *    builder). This reverses the older "meetings are team signal, excluded" rule, whose stated blocker
 *    was "a granola item's member_id is the recorder, not the participants" — an ATTRIBUTION problem,
 *    which `meeting_note_attendees` (real member FKs) solves. The transcript ITEM stays excluded below
 *    so a meeting is counted once, via the ledger, not twice.
 *    NOTE the deliberate asymmetry with `lib/dashboard/work-classification.classifyWork`, which still
 *    calls a meeting transcript "signal". That oracle answers a DIFFERENT question — "is this a
 *    scoreable authored document?" — for `doc_task_infer`, and for a meeting the answer is still no
 *    (exactly as for Slack). Do NOT "unify" them: flipping classifyWork sends large transcripts to the
 *    LLM on every rebuild and writes task_evidence keyed to ids nothing renders. Pinned by
 *    test/timeline-meetings.test.ts.
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
/** Inferred (LLM) task↔item edges pulled per build. Bounded like every other leg. */
/** Meeting notes scanned per build. Meetings are human-paced (tens per team per month), so this is a
 *  runaway backstop rather than a working limit — unlike the item caps it sits beside. */
const MEETING_NOTE_LIMIT = resolvePositiveInt(process.env.TIMELINE_MEETING_LIMIT, 2000);
const TASK_EVIDENCE_LIMIT = 5000;

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
  assignee: string | null;
  source_item_id?: string | null;
  created_by?: string | null;
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
  windowDays: number = WINDOW_DAYS,
  // Access enforcement (Phase B slice 4, spec §5.8/§17-B): the principal's membership-visible item
  // set. Null/absent = permissive → byte-identical to today. Item legs carry the item filter
  // IN-QUERY (each leg's limit must rank over VISIBLE rows — a post-filter lets invisible items
  // crowd visible ones out of the page). Structured rows (tasks/decisions/meetings) gate on their
  // SOURCE ITEM when they have one — a restricted item's derived TITLE is the leak.
  enforce: { visibleItemIds: ReadonlySet<string> } | null = null
): Promise<TimelineDay[]> {
  const visArr: string[] | null = enforce ? [...enforce.visibleItemIds] : null;
  // A SOURCED structured row is visible iff its source item is. Meetings + decisions gate on this
  // alone (a null source there is the PURGE case — a restricted item removed via `on delete set
  // null` — so fail closed and drop it; Codex B2's retrieve ruling).
  const srcVisible = (sourceItemId: string | null | undefined): boolean =>
    enforce != null && sourceItemId != null && enforce.visibleItemIds.has(sourceItemId); // PRET-6: fail closed on null
  // A TASK's null source is ambiguous: a hand-typed dashboard task (no restricted basis, already
  // tier-gated by visibleTasks) OR a synced task whose restricted source was purged (its title
  // still names the restricted work). The FIRST must survive — dropping all null-source tasks
  // erased every dashboard-created task for everyone incl. admins on flip (Fable B4 Medium) — the
  // SECOND must not (leak). The distinction is CREATION PROVENANCE: `created_by` is set ONLY by the
  // dashboard create path (`app/actions/tasks.ts`, the sole writer) and never by sync/ingest — so a
  // non-null `created_by` proves the task was hand-typed and NEVER had a source item. NOT `origin`:
  // that is a durability/ownership state, and `lib/pm-sync/inbound.ts` flips an ADOPTED synced issue
  // to `origin='ui'` while it still carries an imported (later-purgeable) source — using origin let a
  // formerly-restricted adopted title leak (Codex B4 High). `created_by` nulls only on creator
  // deletion (`on delete set null`) → the task drops (over-restriction, fail closed). Immutable
  // otherwise: no UPDATE writes it.
  const taskVisible = (t: TaskRow): boolean => {
    if (enforce == null) return false; // PRET-6: a null enforcement is a caller bug — fail closed
    if (t.source_item_id != null) return enforce.visibleItemIds.has(t.source_item_id);
    // PRET-5 H2 ruling: a hand-typed task belongs to NO project — no membership axis exists —
    // so the audience wall survives on exactly this one branch (a team-audience hand-typed
    // title must not reach a restricted-posture viewer through an evidence link).
    return t.created_by != null && !isRestrictedTier(tier);
  };
  // Conditionally AND the item-membership conjunct into an item-leg query (kept in ONE place so a
  // new leg has an obvious handle). An EMPTY visible set compiles to `WHERE false` in the pg
  // adapter (`query-builder.ts` `.in([]) → "false"`, the only backend), so the item legs return
  // nothing and fail closed — while the null-source UI tasks still surface via `taskVisible`
  // (a member with zero visible ITEMS can still own dashboard-created tasks).
  const withVis = <T extends { in: (col: string, vals: string[]) => T }>(q: T): T =>
    visArr ? q.in("id", visArr) : q;
  // PRET-5 §1 (docs/design/pret5-leak-suite.md): the wall is MODE-keyed like every content
  // leg since PRET-4 §1b — ENFORCING (a vis-set present) → the oracle-derived set alone (the
  // posture wall would re-block ruling 2: an external member granted X must see X's team
  // evidence); PERMISSIVE → the posture wall alone. The structured legs' enforcing gates are
  // srcVisible/taskVisible below.
  // PRET-6: the permissive posture-wall arms retired with the model — the vis-set is the only
  // gate on evidence legs (withVis at the call sites; taskVisible/srcVisible on structured
  // rows). Kept as named identities so the call sites keep their one obvious handle.
  const walledItems = <T extends { in: (col: string, vals: string[]) => T }>(q: T, _t: ViewerTier): T => q;
  const walledTasks = <T extends { in: (col: string, vals: string[]) => T }>(q: T, _t: ViewerTier): T => q;
  const walledDecisions = <T extends { in: (col: string, vals: string[]) => T }>(q: T, _t: ViewerTier): T => q;
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
    db.from("teams").select("primary_pm_provider, slug").eq("id", teamId).maybeSingle(),
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
  // For the meetings leg's detail links. `teamRes` is best-effort (a null only degrades the pmSource
  // label), so a missing slug must not produce a broken `/t/undefined/...` href — the leg omits the url.
  const teamSlug = str((teamRes.data as { slug: string | null } | null)?.slug);
  const pmSource = pmProvider ? normalizeSource(pmProvider) : "tasks";

  const [gitRes, otherRes, taskRes, slackRes, decisionRes] = await Promise.all([
    // Git commits (title = commit subject → needs body; commit bodies are small).
    walledItems(
      withVis(
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
          .limit(ITEM_LIMIT)
      ),
      tier
    ),
    // Everything else (no body; title from frontmatter/path). `kind='task'` items excluded — the
    // tasks table is the authoritative per-assignee source. NOTE: we do NOT `.neq("frontmatter->>source",
    // "git")` here — the builder compiles that to `source <> 'git'`, which is NULL-falsy and would drop
    // items with no `source` key (a hand-pushed doc with a real work time). Git commits are excluded in
    // the JS loop below instead.
    walledItems(
      withVis(
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
          .limit(ITEM_LIMIT)
      ),
      tier
    ),
    // ACTIVE tasks only — filtered in SQL so a backlog-heavy team can't push active tasks past
    // TASK_LIMIT. NOT window-filtered (evidence may reference a task last touched >7d ago; we need its
    // title/row_key). Evidence-gated in the grouper.
    walledTasks(
      db
        .from("tasks")
        .select("id, row_key, title, status, assignee, source_item_id, created_by")
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
    walledItems(
      withVis(
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
        .limit(ITEM_LIMIT)
      ),
      tier
    ),
    // DECISIONS — the CONTEXT lane (signal, never counted as work). Dated by `decided_at` (a DATE).
    // Tier-gated by the decision's own `audience` via the §5 choke-point.
    walledDecisions(
      db
        .from("decisions")
        .select("id, title, decided_by, decided_at, source_item_id, created_by, still_valid, audience")
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
  // Enforcing: a task is kept only when its SOURCE ITEM is visible — the header carries the task's
  // TITLE, so an invisible (or null → unprovable) source means the title itself would leak.
  const tasks = ((taskRes.data ?? []) as TaskRow[]).filter(taskVisible);

  // Assignee → member id, via the SHARED resolver (`assigneeMember`): `tasks.assignee` is a free-text
  // string the PM tool supplied and prod carries several spellings per person, so a raw compare would
  // mark a teammate's task as unowned — and a second, differently-fuzzy copy of this logic is how the
  // card and the inference came to disagree about who owns a task. Ambiguous or unresolved → null, and
  // the card then says nothing rather than showing the wrong face.
  const infoFor = (t: TaskRow): TaskInfo => ({
    title: t.title || "(untitled task)",
    status: t.status || "",
    source: pmSource,
    assigneeMemberId: assigneeMember(t.assignee, roster),
  });

  const taskInfo = new Map<string, TaskInfo>();
  for (const t of tasks) taskInfo.set(t.id, infoFor(t));

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
    // Each of these has its OWN leg, so admitting the raw item here would count the same work twice.
    // CALENDAR is the newest and was the easy one to miss: unlike a granola transcript it arrives as a
    // plain `artifact` with `occurred_at` frontmatter, so it passes `work_at_from_source` and lands in
    // this lane credited to the PUSHER — while the meetings leg credits every attendee. Measured: the
    // pusher's `total` was 2 for a single event. "What else reads the set I just widened."
    // NB `source` here is NORMALIZED, and `normalizeSource` collapses anything not in SOURCE_RULES to
    // "other" — so the calendar check must read the RAW frontmatter value. Checking the normalized one
    // silently never matched, and the pusher kept getting the event twice.
    if (source === "slack" || source === "granola" || isCalendarEvent(str(fm.source)) || r.kind === "transcript") continue;
    // A PM issue's own description doc is the TICKET, not work done on it — and its path/title carry
    // the issue's own key, so admitting it as evidence would let every assigned ticket self-satisfy
    // the evidence gate and turn the timeline back into a backlog dump (the property "never the whole
    // backlog" exists to prevent). The ticket already appears as a TASK; real work on it arrives as
    // commits/docs that cite the key. WHICH sources those are is a FACT ABOUT THE SOURCE
    // (`emitsTicketDocuments`), not a list of tracker names here — the brain is self-hosted per org and
    // the next one's tracker must work without editing this file. Guarded.
    if (str(fm.identifier) && sourceRules(source).emitsTicketDocuments) continue;
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
    // AUTHORSHIP. The thread `title` is a snippet of its ROOT message (`slack-normalize.threadTitle`),
    // so it is the ROOT AUTHOR'S WORDS. Every participant used to get a row carrying it verbatim, which
    // rendered a teammate's message under the replier's own name — reported on prod as John's
    // "Hey Chetan! Two sizzle reels…" appearing on CHETAN's card as if he wrote it. Participation itself
    // was right (he replied twice); the LABEL claimed authorship he didn't have.
    // So only the ROOT AUTHOR's row presents the snippet as their own; a replier's row is labelled as a
    // reply TO that thread. The distinction is drawn from `frontmatter.author_id` (the root's user id),
    // case-folded through the same `foldProviderId` the id map uses so a case variant can't silently
    // demote a genuine author.
    const rootAuthorId = foldProviderId(str(fm.author_id) ?? "");
    for (const p of slackParticipations(fm)) {
      const authorId = p.authorId;
      const folded = foldProviderId(authorId);
      const memberId = slackIdToMember.get(folded);
      if (!memberId || !members.has(memberId)) continue;
      const at = p.lastTs;
      if (!at || !inWindow(at)) continue;
      // UNKNOWN root (a pre-`author_id` row) is labelled as a reply too: over-claiming authorship is the
      // harmful direction — "replied in" understates a genuine author, but presenting someone else's
      // words as yours is the bug this exists to stop.
      const wroteRoot = rootAuthorId !== "" && folded === rootAuthorId;
      const rowTitle = wroteRoot ? title : `Replied in ${title}`;
      // One row per (thread, participant). `text` stays the FULL thread title for issue-key linking: a
      // thread ABOUT a ticket is work on that ticket for everyone in it, which is a topical association,
      // not a claim about who wrote the words. Only the rendered label distinguishes authorship.
      evItems.push({ id: `${r.id}:${authorId}`, memberId, source: "slack", kind: "slack", title: rowTitle, at, text: title });
    }
  }

  // Deterministic issue-key links, computed INLINE against ALL visible tasks (any status) so the Timeline
  // is always fresh AND a just-shipped ticket can head its own group. (Previously a second, active-only
  // pass drove nesting; that produced "Other · not linked to a task" rows each carrying a chip naming the
  // task they were linked to. Evidence-gating in the grouper is what keeps the backlog out.)
  const allTaskRes = await walledTasks(
    db
      .from("tasks")
      .select("id, row_key, title, status, assignee, source_item_id, created_by")
      .eq("team_id", teamId)
      .not("row_key", "is", null)
      .order("updated_at", { ascending: false })
      .limit(TASK_LIMIT),
    tier
  );
  // Chips are ENRICHMENT (not a core ledger leg) — a failed read must NOT blank the ledger, but it also
  // must not be silent (the swallowed-error trap this file warns about). WARN, like the Slack leg.
  if (allTaskRes.error) console.warn("[work-timeline] chip-task read failed:", allTaskRes.error.message);
  // Same source-item gate as the active set: a chip names the task too.
  const allTasks = ((allTaskRes.data ?? []) as TaskRow[]).filter(taskVisible);
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
    if (!taskInfo.has(t.id)) taskInfo.set(t.id, infoFor(t));
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

  // INFERRED links — the LLM doc→task pass (`lib/dashboard/doc-task-infer-run`) persists its confident
  // answers as `task_evidence` rows with `method='llm'`. This is that table's FIRST reader: a design doc
  // that cites no issue key anywhere in its title or path is exactly what the deterministic matcher can
  // never catch, so without this the pass's output would be invisible.
  //
  // The confidence gate is re-applied HERE as DEFENCE IN DEPTH, not because the writer is unreliable:
  // `applyInferredLinks` already drops sub-threshold answers, so today nothing below the bar reaches the
  // table via the pass. It matters for every OTHER way an `llm` row can appear — a backfill, a manual
  // insert, an older row written when the threshold was lower — none of which should be able to promote
  // a guess just by existing. One constant, enforced on both sides.
  //
  // Enrichment, like the chips/work-events legs: WARN on failure, never throw — an unreadable inference
  // table must not blank the factual ledger.
  const inferredTaskIds = new Map<string, string[]>();
  {
    const teRes = await db
      .from("task_evidence")
      .select("item_id, task_id, confidence")
      .eq("team_id", teamId)
      .eq("method", "llm")
      .gte("confidence", MIN_CONFIDENCE)
      .limit(TASK_EVIDENCE_LIMIT);
    if (teRes.error) console.warn("[work-timeline] inferred-link read failed:", teRes.error.message);
    for (const r of (teRes.data ?? []) as { item_id: string; task_id: string; confidence: number }[]) {
      const list = inferredTaskIds.get(r.item_id) ?? [];
      if (!list.includes(r.task_id)) list.push(r.task_id);
      inferredTaskIds.set(r.item_id, list);
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
    // Then, and only then, a model INFERENCE — least specific, so it never outranks a real citation.
    // Same tier mechanism as the two above: resolved solely against `taskInfo`, which was built from
    // `visibleTasks` reads, so an inferred id the viewer may not see links nothing, silently.
    const inferredVisible = (inferredTaskIds.get(e.id) ?? []).filter((id) => taskInfo.has(id));
    if (inferredVisible.length) {
      for (const taskId of inferredVisible) evidence.push({ ...base, taskId, linkVia: "inferred" });
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
    created_by?: string | null;
    still_valid: boolean | null;
  }[]) {
    // The settled provenance rule, decisions edition (ENFB-1 §2.7): a sourced decision gates on
    // its source item; a null-source one survives ONLY when hand-typed (created_by — the
    // dashboard action's sole write; a purged restricted basis stays dropped) at team posture.
    const decisionVisible = d.source_item_id != null
      ? srcVisible(d.source_item_id)
      : (d.created_by ?? null) != null && !isRestrictedTier(tier);
    if (!decisionVisible) continue;
    if (!d.decided_at) continue; // no day to place it on (mirrors the undated-work drop)
    const by = (d.decided_by ?? "").trim();
    if (!by) continue; // empty / group-level decided_by → dropped (a later team-signal lane's job)
    // EVERY member named, not just a lone one. A joint or qualified `decided_by` used to be dropped
    // outright, which hid 48% of prod's decision log — and hid precisely the calls two people made
    // TOGETHER. A decision appears in each named person's day, the same way a Slack thread credits each
    // participant; an unmatched or ambiguous fragment still contributes nothing.
    const actorIds = decisionActors(by, roster);
    for (const memberId of actorIds) {
      signals.push({
        id: actorIds.length > 1 ? `${d.id}:${memberId}` : d.id, // unique per person-row, like Slack's
        memberId,
        kind: "decision",
        title: d.title || "(untitled decision)",
        at: d.decided_at.slice(0, 10), // bare YYYY-MM-DD — rendered with no time
        url: d.source_item_id ? `/library/${d.source_item_id}` : undefined,
        stillValid: d.still_valid ?? true,
      });
    }
  }

  // ── MEETINGS: one evidence row per (meeting, ATTENDEE) ────────────────────────────────────────────
  // A meeting you sat in is work. This is the leg the file header's old "meetings are team signal"
  // note deferred, and its stated blocker — "a granola item's member_id is the recorder, not the
  // participants" — is solved by `meeting_note_attendees`, which resolves attendance to real member
  // FKs. Structurally the SLACK participant leg above: one item is many people's work.
  //
  // Its OWN query, not the `otherRes` leg: that one filters `work_at_from_source = true`, and a
  // GUI-uploaded meeting is ingested with `frontmatter: { title }` only — no work-time key matches, so
  // it never leaves SQL. Relaxing the `continue` at the transcript filter would not have admitted it.
  //
  // TIER: `meeting_notes` has NO access/audience column, so `visibleItems` cannot gate it and neither
  // can any other visibility helper. Meeting notes are team-tier by construction; this is the sole
  // enforcement (no RLS backstop, CLAUDE.md §5), routed through the existing predicate so the rule is
  // spelled once.
  if (canSeeMeetingNotes(tier)) {
    const meetRes = await db
      .from("meeting_notes")
      .select("id, title, occurred_at, created_at, submitted_by, merged_into, source_item_id")
      .eq("team_id", teamId)
      .is("merged_into", null) // a tombstone's attendees live on its merge target — counting both double-credits
      // NO date bound in SQL — ordered newest-by-meeting-date and capped instead, with `inWindow(at)`
      // below doing the windowing on the RESOLVED date.
      //
      // It used to bound on `created_at`, which was safe only while every meeting arrived as a
      // recording of something already past, so the note always post-dated the meeting. A shared
      // CALENDAR event inverts that: choose to share next month's meetings today and the note's
      // `created_at` is today, so by the time `occurred_at` enters the 7-day window `created_at` has
      // long left it and the meeting silently never reaches anyone's card. Bounding on `occurred_at`
      // instead would need an OR for null-dated notes, which this query builder has no `.or()` for —
      // and meetings are a low-volume table (tens of rows per team), so a capped ordered scan is both
      // simpler and exactly correct.
      .order("occurred_at", { ascending: false })
      .limit(MEETING_NOTE_LIMIT);
    if (meetRes.error) {
      // Best-effort, like Slack/decisions: a meetings outage must not fail the whole ledger.
      console.warn("[timeline] meetings leg skipped:", meetRes.error.message);
    } else {
      // Enforcing: a meeting note's restriction axis is its source TRANSCRIPT item — the note's
      // title (and its attendee rows) surface it, so an invisible source drops the whole note.
      const notes = ((meetRes.data ?? []) as MeetingNoteRow[]).filter((n) => srcVisible(n.source_item_id));
      const noteIds = notes.map((n) => n.id);
      const attendeesByNote = new Map<string, string[]>();
      for (const batch of chunkIds(noteIds)) {
        const attRes = await db.from("meeting_note_attendees").select("meeting_note_id, member_id").in("meeting_note_id", batch);
        if (attRes.error) {
          console.warn("[timeline] meeting attendees skipped:", attRes.error.message);
          continue;
        }
        for (const a of (attRes.data ?? []) as { meeting_note_id: string; member_id: string }[]) {
          const arr = attendeesByNote.get(a.meeting_note_id) ?? [];
          arr.push(a.member_id);
          attendeesByNote.set(a.meeting_note_id, arr);
        }
      }
      for (const n of notes) {
        // ALWAYS a bare YYYY-MM-DD. `occurred_at` is a `date` column with no clock time, so a meeting
        // has no time of day to show; mixing granularities would sort a bare date before every
        // same-day timestamp and render a bogus midnight. Decisions made the same choice.
        const at = (str(n.occurred_at) || isoOrNull(n.created_at) || "").slice(0, 10);
        if (!at || !inWindow(at)) continue;
        const attendees = (attendeesByNote.get(n.id) ?? []).filter((id) => members.has(id));
        // No RESOLVED attendee is "we don't know who was there", not "nobody" — attendee extraction
        // drops any name it can't match to the roster, leaving no trace. Fall back to the submitter,
        // the one person we know was involved, and MARK it so it can't be read as attendance.
        const credited: { memberId: string; via?: "submitter" }[] = attendees.length
          ? attendees.map((memberId) => ({ memberId }))
          : n.submitted_by && members.has(n.submitted_by)
            ? [{ memberId: n.submitted_by, via: "submitter" as const }]
            : []; // …and an unattributable meeting is DROPPED, never credited to a guess
        for (const c of credited) {
          evidence.push({
            id: `${n.id}:${c.memberId}`, // synthetic, mirroring the Slack participant leg
            memberId: c.memberId,
            source: MEETING_SOURCE,
            kind: "meeting",
            title: str(n.title) || "Meeting",
            url: teamSlug ? `/t/${teamSlug}/meetings/${n.id}` : undefined,
            at,
            via: c.via,
          });
        }
      }
    }
  }

  return groupTimeline(evidence, taskInfo, members, todayISO, undefined, signals);
}

type MeetingNoteRow = {
  id: string;
  title: string | null;
  occurred_at: string | Date | null;
  created_at: string | Date | null;
  submitted_by: string | null;
  merged_into: string | null;
  source_item_id?: string | null;
};

/** Batch ids for an `.in(...)` filter — the pg adapter binds each element and Postgres caps at 65535. */
function chunkIds(ids: readonly string[], size = 1000): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
