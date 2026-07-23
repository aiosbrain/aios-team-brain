/**
 * Pure grouping for the Learning "Timeline" — a human-readable day → person → work chronology where a
 * person's evidence (commits, docs) nests UNDER the task it contributes to, with an "Other" bucket for
 * evidence linked to no task. Fed already-attributed, task-linked evidence by `lib/dashboard/work-
 * timeline`; NO server-only/DB imports so it unit-tests cleanly.
 *
 * Structure per (day, person):
 *   • tasks[]  — ONLY tasks that have ≥1 of the person's evidence items that day (evidence-gated: a
 *                task with no evidence never appears). Only ACTIVE tasks are ever link targets (the
 *                builder filters backlog/done out), so this is "the in-progress work they touched,"
 *                each with that day's evidence nested + grouped by source.
 *   • other[]  — that day's evidence that referenced no active task, grouped by source.
 * Ordering: days DESC (undated last); within a day, people by activity DESC; a person's tasks by
 * evidence count DESC; items newest-first, capped per source.
 */

/** One piece of a person's work — a commit or a dated deliverable. `taskId` links it to a task. */
export interface EvidenceItem {
  id: string;
  title: string;
  url?: string;
  /** Normalized source slug (github/notion/gdrive/…) → drives the icon. */
  source: string;
  kind: string;
  /** WORK time — ISO. Its date places the row on a day. */
  at: string;
}

export interface EvidenceWithMember extends EvidenceItem {
  memberId: string;
  /** The active task this evidence references (via issue key), if any. Unlinked → the "Other" bucket. */
  taskId?: string | null;
}

/** Display info for an active task, resolved once per in-window task (id → this). */
export interface TaskInfo {
  title: string;
  status: string; // task_status (in_progress / blocked — active only)
  source: string; // pm source slug: linear | plane | tasks
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
}

export interface PersonDay {
  memberId: string;
  name: string;
  handle: string;
  avatarUrl?: string | null;
  total: number; // evidence items — orders people within a day
  /** A 1–3 sentence human synopsis of what this person did that day (LLM; optional — the panel falls
   *  back to a counts line). Added in the cache-build path (`lib/dashboard/timeline-summary`), not the
   *  pure builder, so it's computed once per rebuild and never runs in the data-mechanics tier. */
  summary?: string;
  tasks: TaskGroup[];
  other: SourceGroup[]; // evidence linked to no active task
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
 * Pure: the LLM input describing one person's day — their in-progress tasks (with the work items nested
 * under each) + any "Other" work. Fed to `lib/dashboard/timeline-summary` to produce a 1–3 sentence
 * synopsis. Returns "" when there's nothing to summarize (caller skips the LLM call). Per-source items
 * are capped so a huge day can't blow the prompt.
 */
export function summaryPromptFor(p: PersonDay, dayLabel: string, itemCap = 8): string {
  const titles = (g: SourceGroup): string => g.items.slice(0, itemCap).map((i) => i.title).join("; ");
  const lines: string[] = [];
  if (p.tasks.length) {
    lines.push("In-progress tasks (with the work done on each):");
    for (const t of p.tasks) {
      const work = t.sources.map((g) => `${g.source}: ${titles(g)}`).join(" · ");
      lines.push(`- ${t.title} [${t.status}]${work ? ` — ${work}` : ""}`);
    }
  }
  if (p.other.length) {
    lines.push("Other work (not tied to a task):");
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
      if (seen.has(p.memberId)) continue;
      seen.add(p.memberId);
      out.push(p);
    }
  }
  return out;
}

/** github/git → github; a known source passes through; anything else → "other" (generic icon). */
export function normalizeSource(raw: string | null | undefined): string {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "git" || s === "github") return "github";
  if (s === "google_drive" || s === "gdrive" || s === "drive") return "gdrive";
  if (["linear", "plane", "slack", "notion", "granola", "confluence"].includes(s)) return s;
  return "other";
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
 * Group attributed, task-linked evidence into the day → person → (tasks + other) structure the panel
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
  perSourceCap: number = DEFAULT_PER_SOURCE_CAP
): TimelineDay[] {
  // day -> memberId -> { tasks: Map<taskId, EvidenceItem[]>, other: EvidenceItem[] }
  type PersonBucket = { tasks: Map<string, EvidenceItem[]>; other: EvidenceItem[] };
  const byDay = new Map<string, Map<string, PersonBucket>>();

  for (const ev of evidence) {
    if (!members.has(ev.memberId)) continue; // unknown member → drop, don't guess
    const date = dayOf(ev.at);
    const people = byDay.get(date) ?? new Map<string, PersonBucket>();
    byDay.set(date, people);
    const b: PersonBucket = people.get(ev.memberId) ?? { tasks: new Map<string, EvidenceItem[]>(), other: [] };
    people.set(ev.memberId, b);
    const item: EvidenceItem = { id: ev.id, title: ev.title, url: ev.url, source: ev.source, kind: ev.kind, at: ev.at };
    if (ev.taskId && taskInfo.has(ev.taskId)) {
      const arr = b.tasks.get(ev.taskId) ?? [];
      arr.push(item);
      b.tasks.set(ev.taskId, arr);
    } else {
      b.other.push(item);
    }
  }

  const days: TimelineDay[] = [];
  for (const [date, people] of [...byDay.entries()].sort((a, b) => sortDaysDesc(a[0], b[0]))) {
    const personDays: PersonDay[] = [];
    for (const [memberId, b] of people.entries()) {
      const m = members.get(memberId)!;
      const tasks: TaskGroup[] = [...b.tasks.entries()]
        .map(([taskId, ev]) => {
          const info = taskInfo.get(taskId)!;
          return { taskId, title: info.title, status: info.status, source: info.source, sources: toSourceGroups(ev, perSourceCap), evidenceCount: ev.length };
        })
        .sort((x, y) => y.evidenceCount - x.evidenceCount || (x.title < y.title ? -1 : 1));
      const other = toSourceGroups(b.other, perSourceCap);
      const total = tasks.reduce((n, t) => n + t.evidenceCount, 0) + other.reduce((n, g) => n + g.count, 0);
      personDays.push({ memberId, name: m.name, handle: m.handle, avatarUrl: m.avatarUrl, total, tasks, other });
    }
    personDays.sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : 1));
    days.push({ date, label: dayLabel(date, todayISO), people: personDays });
  }
  return days;
}
