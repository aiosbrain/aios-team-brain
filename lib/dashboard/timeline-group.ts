/**
 * Pure grouping for the Learning "Timeline" — a human-readable day → person → work chronology where a
 * person's evidence (commits, docs) nests UNDER the task it contributes to, with an "Other" bucket for
 * evidence linked to no task. Fed already-attributed, task-linked evidence by `lib/dashboard/work-
 * timeline`; NO server-only/DB imports so it unit-tests cleanly.
 *
 * Structure per (day, person):
 *   • tasks[]  — ONLY tasks that have ≥1 of the person's evidence items that day (evidence-gated: a
 *                task with no evidence never appears). STATUS does not gate it — a ticket that shipped
 *                today still heads its group, carrying its status — so this is "the work they touched",
 *                each with that day's evidence nested + grouped by source.
 *   • other[]  — that day's evidence that referenced NO task, grouped by source (rendered below).
 * Ordering: days DESC (undated last); within a day, people by activity DESC; a person's tasks by
 * evidence count DESC; items newest-first, capped per source.
 */

import { SOURCE_RULES } from "@/lib/ingest/source-rules";

/** LEGACY (no longer populated). This described a task an "Other"-bucket item referenced but which was
 *  barred from being a nesting header by the old ACTIVE-only rule, shown as a chip so the association
 *  stayed visible. Now that ANY referenced task heads its own group, the chip is unreachable — the type
 *  is retained only so payloads cached by the previous build still render during their TTL. */
export interface EvidenceTaskRef {
  key: string; // the task's issue key / row_key, e.g. AIO-138
  title: string;
  status: string;
}

/**
 * The payload `source` slug for a meeting. Deliberately NOT an ingest source (it is absent from
 * `lib/ingest/source-rules`, which is keyed on what the ingest path actually sees) — a meeting reaches
 * the timeline from the `meeting_notes` ledger, not from a connector.
 */
export const MEETING_SOURCE = "meetings";

/**
 * Is this `EvidenceItem.at` a bare date (`YYYY-MM-DD`) rather than a full timestamp?
 *
 * Some evidence genuinely has no clock time — a meeting is dated from `meeting_notes.occurred_at`, a
 * `date` column. Rendering it as a time anyway produces a confident, wrong "12:00 AM" (or whatever the
 * viewer's timezone makes of UTC midnight), which is worse than showing nothing. Pure, so the rule is
 * testable without rendering; used by the person card.
 */
export function isBareDate(at: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(at.trim());
}

export interface EvidenceItem {
  id: string;
  title: string;
  url?: string;
  /** Normalized source slug (github/notion/gdrive/…) → drives the icon. */
  source: string;
  kind: string;
  /** WORK time — ISO. Its date places the row on a day. */
  at: string;
  /** LEGACY chip — no longer populated (any referenced task now heads its own group). Kept so cached
   *  payloads from the previous build still render during their TTL. */
  linkedTask?: EvidenceTaskRef;
  /** How this evidence got its task, in DESCENDING precision: the item's OWN cited issue key, inherited
   *  from the PR that merged it (`work_events`), or `inferred` by the LLM doc→task pass (`task_evidence`
   *  `method='llm'`). Carried in the payload so a lower-precision link is diagnosable — and correctable —
   *  from every surface that reads the ledger, not just inside the builder. */
  linkVia?: "commit-text" | "pr" | "inferred";
  /**
   * How this person came to be credited, when it was NOT the ordinary path. Set to `"submitter"` on a
   * meeting with no resolved attendees, where the credit falls back to whoever submitted the note —
   * the one person we know was involved. Absent means the ordinary path (real attendance, authorship).
   *
   * It exists so a fallback is never silently indistinguishable from the real thing: meeting attendee
   * extraction drops any name it can't resolve, so "no attendees" means "we don't know", not "nobody".
   */
  via?: "submitter";
}

export interface EvidenceWithMember extends EvidenceItem {
  memberId: string;
  /** The task this evidence references (via issue key or PR inheritance), any status. Unlinked → "Other". */
  taskId?: string | null;
}

/** Display info for a referenced task, resolved once per in-window task (id → this). */
export interface TaskInfo {
  title: string;
  status: string; // task_status (the task's status, e.g. in_progress / in_review / blocked / done)
  source: string; // pm source slug: linear | plane | tasks
  /** The task's ASSIGNEE as a member id, or null when unassigned/unresolvable. Carried so a card can
   *  say WHOSE task it is. Without it, work you did on a teammate's ticket is indistinguishable from
   *  your own ticket — the timeline places a task under whoever did the work (by design), so the only
   *  thing that made it legible was knowing the assignee, and the payload didn't have it. */
  assigneeMemberId: string | null;
}

export interface SourceGroup {
  source: string;
  count: number; // total for this bucket (may exceed items.length when capped)
  items: EvidenceItem[]; // newest-first, capped
}

/** A task with its day's evidence nested under it (only ever present when it HAS evidence). */
export interface TaskGroup {
  taskId: string;
  title: string;
  status: string;
  source: string; // pm source slug (icon)
  sources: SourceGroup[]; // evidence grouped by source under this task
  evidenceCount: number; // total nested evidence items (uncapped)
  /** Set ONLY when the task belongs to SOMEONE ELSE — its owner, for the miniature avatar the card
   *  renders to the LEFT of the task. You are credited for the work you did; the face says whose ticket
   *  it was. Undefined for your own task (nothing to say) and for an unassigned one (nothing true to
   *  say). `name` doubles as the accessible label and hover title, since an avatar alone is not text. */
  assignee?: { name: string; avatarUrl?: string | null };
}

/** SIGNAL — data ABOUT work (a decision now; meetings later), shown in the Context lane, NEVER counted as
 *  work. Kept a DISTINCT type from `EvidenceItem` so "signal never enters the work total/ordering/synopsis"
 *  is true by construction, not a runtime flag. `at` is a bare `YYYY-MM-DD` (decisions have no time). */
export type SignalKind = "decision";
export interface SignalItem {
  id: string;
  kind: SignalKind;
  title: string;
  at: string; // bare YYYY-MM-DD — placed on that day, rendered with NO time
  url?: string; // /library/<source_item_id> when present (dashboard-created decisions have none)
  stillValid?: boolean; // false = later superseded (a "superseded" hint; NOT a filter — it WAS decided that day)
}
export interface SignalWithMember extends SignalItem {
  memberId: string;
}
export interface SignalGroup {
  kind: SignalKind;
  count: number;
  items: SignalItem[]; // newest-first, capped
}

export interface PersonDay {
  memberId: string;
  name: string;
  handle: string;
  avatarUrl?: string | null;
  total: number; // WORK evidence items ONLY — orders people within a day (signals never counted here)
  /** A 1–3 sentence human synopsis of what this person did that day (LLM; optional — the panel falls
   *  back to a counts line). Added in the cache-build path (`lib/dashboard/timeline-summary`), not the
   *  pure builder, so it's computed once per rebuild and never runs in the data-mechanics tier. */
  summary?: string;
  tasks: TaskGroup[];
  /** That day's evidence that referenced NO task, grouped by source — rendered BELOW the tasks.
   *
   *  This was omitted entirely for one deploy, and that was wrong. Omitting taskless work is the right
   *  end state — but only once linking works. Measured on prod the day it shipped: 220 items of real
   *  work in 7 days, NINE linked. The omission hid ~96% of two people's week, which is a far worse
   *  failure than a lane competing for attention. Subordinate, not absent, until coverage earns it. */
  other: SourceGroup[];
  /** How many rows are in `other` — the coverage metric for the doc→task assignment pass. */
  unlinked: number;
  signals: SignalGroup[]; // Context lane — decisions etc. (about work); shown, never counted as work
}

export interface TimelineDay {
  date: string; // YYYY-MM-DD (work day) or "unknown"
  label: string; // "Today" / "Yesterday" / "Mon Jul 21" / "Undated"
  people: PersonDay[];
}

export interface TimelineMember {
  name: string;
  handle: string;
  avatarUrl?: string | null;
}

/**
 * Pure: the LLM input describing one person's day — the tasks they touched (with the work items nested
 * under each) + any "Other" work. Fed to `lib/dashboard/timeline-summary` to produce a 1–3 sentence
 * synopsis. Returns "" when there's nothing to summarize (caller skips the LLM call). Per-source items
 * are capped so a huge day can't blow the prompt.
 */
export function summaryPromptFor(p: PersonDay, dayLabel: string, itemCap = 8): string {
  const titles = (g: SourceGroup): string => g.items.slice(0, itemCap).map((i) => i.title).join("; ");
  const lines: string[] = [];
  if (p.tasks.length) {
    lines.push("Tasks touched (with the work done on each):");
    for (const t of p.tasks) {
      const work = t.sources.map((g) => `${g.source}: ${titles(g)}`).join(" · ");
      lines.push(`- ${t.title} [${t.status}]${work ? ` — ${work}` : ""}`);
    }
  }
  // Unlinked work IS described. It is rendered on the card (in its own section below the tasks), so
  // leaving it out of the prompt does not make the summary tidier — it makes it absent: a person-day
  // with no linked task produces an EMPTY prompt, the caller skips the model, and that person loses
  // their synopsis entirely. With linking at ~4% that was almost everyone. The rule is simply that the
  // prompt describes what the card shows.
  if (p.other.length) {
    lines.push("Other work that day (not tied to a task):");
    for (const g of p.other) lines.push(`- ${g.source}: ${titles(g)}`);
  }
  if (lines.length === 0) return "";
  return `${p.name} on ${dayLabel}:\n${lines.join("\n")}`;
}

/**
 * Collapse the day-grouped timeline to ONE entry per person — their MOST RECENT day of work — for the
 * Home "Working on" section ("what each person was most recently working on"). Days are ordered
 * newest-first ("unknown"/undated last); the first time a person appears wins, so the result is each
 * person's latest active day, ordered by recency (then that day's within-day `total` order). Pure +
 * unit-tested. The card that renders each entry is identical to a Timeline day's, so the two surfaces match.
 *
 * "Working on" is about WORK, so it selects each person's most recent day WITH real work (`total > 0`) — a
 * signals-only day (a decision logged with no commits) must NOT displace their actual most-recent-work day.
 * A person with only signals therefore doesn't appear on Home (they're not "working on" anything there).
 */
export function mostRecentPerPerson(days: TimelineDay[]): PersonDay[] {
  const ordered = [...days].sort((a, b) => {
    if (a.date === b.date) return 0;
    if (a.date === "unknown") return 1;
    if (b.date === "unknown") return -1;
    return a.date < b.date ? 1 : -1; // newest date first
  });
  const seen = new Set<string>();
  const out: PersonDay[] = [];
  for (const day of ordered) {
    for (const p of day.people) {
      if (seen.has(p.memberId) || p.total === 0) continue; // skip already-seen AND signal-only days
      seen.add(p.memberId);
      out.push(p);
    }
  }
  return out;
}

/**
 * WORK time from an item's frontmatter, ISO-normalized; null when the source gave us nothing usable
 * (the builder then DROPS the item — an undated item can't be placed on a day).
 *
 * The key list and the parsing live in the shared `lib/ingest/work-time` resolver, which the GRAPH
 * PROJECTOR uses too. Previously each surface had its own notion of "when it happened" and they
 * disagreed: a git commit was dated by `committed_at` here but fell back to `synced_at` in the graph.
 * Re-exported under the local name so timeline callers keep an intention-revealing import.
 */

/** github/git → github; any REGISTERED source passes through; anything else → "other" (generic icon).
 *  The allowlist is the source-rules table itself rather than a second literal list — a new connector
 *  (or a different task tracker) then gets its own icon without editing this file, which is the same
 *  reason the ticket-document rule lives there. */
export function normalizeSource(raw: string | null | undefined): string {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "git" || s === "github") return "github";
  if (s === "google_drive" || s === "gdrive" || s === "drive") return "gdrive";
  return s in SOURCE_RULES ? s : "other";
}

const DEFAULT_PER_SOURCE_CAP = 6;

/** YYYY-MM-DD one day before `todayISO` (UTC). Pure given the input. */
function yesterdayOf(todayISO: string): string {
  const t = Date.parse(`${todayISO}T00:00:00Z`);
  return Number.isNaN(t) ? "" : new Date(t - 86_400_000).toISOString().slice(0, 10);
}

/** Human day label. `today`/`yesterday` are pre-computed YYYY-MM-DD; other dates format to "Mon Jul 21". */
export function dayLabel(date: string, todayISO: string): string {
  if (date === "unknown") return "Undated";
  if (date === todayISO) return "Today";
  if (date === yesterdayOf(todayISO)) return "Yesterday";
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(t)
    ? "Undated"
    : new Date(t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function sortDaysDesc(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "unknown") return 1; // undated always last
  if (b === "unknown") return -1;
  return a < b ? 1 : -1;
}

const dayOf = (at: string): string => (at ?? "").slice(0, 10) || "unknown";

/** Group evidence items into SourceGroups (by source, count DESC, newest-first, per-source capped). */
function toSourceGroups(items: EvidenceItem[], cap: number): SourceGroup[] {
  const bySource = new Map<string, EvidenceItem[]>();
  for (const it of items) {
    const arr = bySource.get(it.source) ?? [];
    arr.push(it);
    bySource.set(it.source, arr);
  }
  return [...bySource.entries()]
    .map(([source, arr]) => {
      const sorted = arr.slice().sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
      return { source, count: sorted.length, items: sorted.slice(0, cap) };
    })
    .sort((a, b) => b.count - a.count || (a.source < b.source ? -1 : 1));
}

/**
 * Group attributed, task-linked evidence into the day → person → tasks → evidence structure the panel
 * renders. EVIDENCE-GATED: a task group exists only where the person has evidence referencing it that
 * day — there are no empty task headers. `taskInfo` supplies each active task's display fields; evidence
 * whose `taskId` isn't in `taskInfo` (unlinked, or linked to a now-inactive task) falls to "Other".
 * `todayISO` is passed in (no Date.now — deterministic).
 */
export function groupTimeline(
  evidence: EvidenceWithMember[],
  taskInfo: Map<string, TaskInfo>,
  members: Map<string, TimelineMember>,
  todayISO: string,
  perSourceCap: number = DEFAULT_PER_SOURCE_CAP,
  signals: SignalWithMember[] = [], // Context lane — never counted as work
): TimelineDay[] {
  // day -> memberId -> { tasks, other (unlinked WORK — counted only), signals (SIGNAL) }
  type PersonBucket = { tasks: Map<string, EvidenceItem[]>; other: EvidenceItem[]; signals: SignalItem[] };
  const byDay = new Map<string, Map<string, PersonBucket>>();
  const bucket = (date: string, memberId: string): PersonBucket => {
    const people = byDay.get(date) ?? new Map<string, PersonBucket>();
    byDay.set(date, people);
    const b = people.get(memberId) ?? { tasks: new Map<string, EvidenceItem[]>(), other: [], signals: [] };
    people.set(memberId, b);
    return b;
  };

  for (const ev of evidence) {
    if (!members.has(ev.memberId)) continue; // unknown member → drop, don't guess
    const b = bucket(dayOf(ev.at), ev.memberId);
    // EXPLICIT copy — a new EvidenceItem field must be added here too, or it is silently dropped
    // between the builder and the payload (the field exists on the type, so nothing type-errors).
    const item: EvidenceItem = { id: ev.id, title: ev.title, url: ev.url, source: ev.source, kind: ev.kind, at: ev.at, linkedTask: ev.linkedTask, linkVia: ev.linkVia, via: ev.via };
    if (ev.taskId && taskInfo.has(ev.taskId)) {
      const arr = b.tasks.get(ev.taskId) ?? [];
      arr.push(item);
      b.tasks.set(ev.taskId, arr);
    } else {
      b.other.push(item);
    }
  }
  // Signals bucket per (day, person) SEPARATELY — a signal can create a person-day (so "made decisions, no
  // commits" is visible) but never touches tasks/total.
  for (const s of signals) {
    if (!members.has(s.memberId)) continue;
    bucket(dayOf(s.at), s.memberId).signals.push({ id: s.id, kind: s.kind, title: s.title, at: s.at, url: s.url, stillValid: s.stillValid });
  }

  const days: TimelineDay[] = [];
  for (const [date, people] of [...byDay.entries()].sort((a, b) => sortDaysDesc(a[0], b[0]))) {
    const personDays: PersonDay[] = [];
    for (const [memberId, b] of people.entries()) {
      const m = members.get(memberId)!;
      const tasks: TaskGroup[] = [...b.tasks.entries()]
        .map(([taskId, ev]) => {
          const info = taskInfo.get(taskId)!;
          // Whose task is it? Only stated when it is SOMEONE ELSE'S — "contributing to John's task" is
          // information; "contributing to your own task" is noise on every row.
          const owner =
            info.assigneeMemberId && info.assigneeMemberId !== memberId
              ? members.get(info.assigneeMemberId)
              : undefined;
          return {
            taskId,
            title: info.title,
            status: info.status,
            source: info.source,
            sources: toSourceGroups(ev, perSourceCap),
            evidenceCount: ev.length,
            ...(owner ? { assignee: { name: owner.name, avatarUrl: owner.avatarUrl } } : {}),
          };
        })
        .sort((x, y) => y.evidenceCount - x.evidenceCount || (x.title < y.title ? -1 : 1));
      // UNLINKED work is rendered, BELOW the tasks. Omitting it is the right end state and shipped one
      // deploy too early: with linking at 9/220 items it hid ~96% of the team's week. `unlinked` stays
      // as the coverage metric that says when omission becomes safe.
      const other = toSourceGroups(b.other, perSourceCap);
      // `unlinked` is the doc->task COVERAGE metric (see the field's doc) — the number that decides
      // when omitting `other[]` becomes safe. Meetings are work, but they are not linkable documents:
      // nothing tries to attach them to a task, so counting them would inflate the metric permanently
      // and destroy its meaning (one person's 16 meetings a fortnight alone would swamp it). They are
      // still in `other`, still rendered, still counted in `total` — just not in this metric.
      const unlinked = b.other.filter((e) => e.source !== MEETING_SOURCE).length;
      // `total` = all WORK the card shows, so the header count and the body agree. Signals are grouped by
      // kind, newest-first, capped — never counted.
      const total = tasks.reduce((n, t) => n + t.evidenceCount, 0) + other.reduce((n, g) => n + g.count, 0);
      const signalGroups: SignalGroup[] = [...groupByKind(b.signals).entries()]
        .map(([kind, items]) => ({ kind, count: items.length, items: [...items].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)).slice(0, perSourceCap) }))
        .sort((x, y) => y.count - x.count);
      // Only a person-day with NOTHING at all is dropped — unlinked work counts as something to say.
      if (tasks.length === 0 && other.length === 0 && signalGroups.length === 0) continue;
      personDays.push({ memberId, name: m.name, handle: m.handle, avatarUrl: m.avatarUrl, total, tasks, other, unlinked, signals: signalGroups });
    }
    // Order by WORK; a signals-only person (total 0) ranks last but still shows in the day view.
    personDays.sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : 1));
    // A day whose every person was dropped has nothing to render — emitting it would put a date header
    // over an empty column.
    if (personDays.length === 0) continue;
    days.push({ date, label: dayLabel(date, todayISO), people: personDays });
  }
  return days;
}

function groupByKind(items: SignalItem[]): Map<SignalKind, SignalItem[]> {
  const m = new Map<SignalKind, SignalItem[]>();
  for (const s of items) (m.get(s.kind) ?? m.set(s.kind, []).get(s.kind)!).push(s);
  return m;
}
