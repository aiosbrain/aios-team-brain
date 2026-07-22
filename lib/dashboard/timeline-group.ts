/**
 * Pure grouping for the Learning "Timeline" — a human-readable day → person → work chronology where a
 * person's evidence (commits, docs) nests UNDER the task it contributes to, with an "Other" bucket for
 * evidence linked to no task. Fed already-attributed evidence + task signals by `lib/dashboard/work-
 * timeline`; NO server-only/DB imports so it unit-tests cleanly.
 *
 * Structure per (day, person):
 *   • tasks[]  — each task the person had activity on that day (a worked_at/assigned_at signal, OR ≥1
 *                evidence item that references its issue key), with that day's linked evidence nested
 *                and grouped by source. A newly-assigned task shows even with no evidence yet.
 *   • other[]  — that day's evidence that referenced no task, grouped by source.
 * Ordering: days DESC (undated last); within a day, people by activity DESC; a person's tasks by
 * evidence count DESC (newly-assigned-with-no-evidence last); items newest-first, capped per source.
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
  /** The task this evidence references (via issue key), if any. Unlinked → the "Other" bucket. */
  taskId?: string | null;
}

/** Display info for a task, resolved once per in-window task (id → this). */
export interface TaskInfo {
  title: string;
  status: string; // task_status (backlog/ready/in_progress/done/…)
  source: string; // pm source slug: linear | plane | tasks
}

/** A per-(day,person) signal that a task was worked or freshly assigned that day (a task "header"). */
export interface TaskSignal {
  memberId: string;
  taskId: string;
  at: string; // ISO — worked_at or assigned_at
  newlyAssigned: boolean;
}

export interface SourceGroup {
  source: string;
  count: number; // total for this bucket (may exceed items.length when capped)
  items: EvidenceItem[]; // newest-first, capped
}

/** A task with its day's evidence nested under it. */
export interface TaskGroup {
  taskId: string;
  title: string;
  status: string;
  source: string; // pm source slug (icon)
  newlyAssigned: boolean;
  sources: SourceGroup[]; // evidence grouped by source under this task
  evidenceCount: number; // total nested evidence items (uncapped)
}

export interface PersonDay {
  memberId: string;
  name: string;
  handle: string;
  avatarUrl?: string | null;
  total: number; // evidence items + task headers — orders people within a day
  tasks: TaskGroup[];
  other: SourceGroup[]; // evidence linked to no task
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

/** Group evidence into SourceGroups (by source, count DESC, newest-first, per-source capped). */
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
 * Group attributed evidence + task signals into the day → person → (tasks + other) structure the panel
 * renders. `taskInfo` supplies each task's display fields; `members` resolves memberId → display; work
 * for an unknown member (or an evidence taskId with no taskInfo) is handled gracefully (evidence with a
 * dangling taskId falls back to "Other"). `todayISO` is passed in — no Date.now here (deterministic).
 */
export function groupTimeline(
  evidence: EvidenceWithMember[],
  taskInfo: Map<string, TaskInfo>,
  taskSignals: TaskSignal[],
  members: Map<string, TimelineMember>,
  todayISO: string,
  perSourceCap: number = DEFAULT_PER_SOURCE_CAP
): TimelineDay[] {
  // day -> memberId -> { tasks: Map<taskId,{newlyAssigned, ev[]}>, other: EvidenceItem[] }
  type PersonBucket = { tasks: Map<string, { newlyAssigned: boolean; ev: EvidenceItem[] }>; other: EvidenceItem[] };
  const byDay = new Map<string, Map<string, PersonBucket>>();

  const bucketFor = (date: string, memberId: string): PersonBucket => {
    const people = byDay.get(date) ?? new Map<string, PersonBucket>();
    byDay.set(date, people);
    const b = people.get(memberId) ?? { tasks: new Map(), other: [] };
    people.set(memberId, b);
    return b;
  };
  const taskEntry = (b: PersonBucket, taskId: string) => {
    const e = b.tasks.get(taskId) ?? { newlyAssigned: false, ev: [] };
    b.tasks.set(taskId, e);
    return e;
  };

  // Task signals → (possibly empty) task headers on their signal day.
  for (const sig of taskSignals) {
    if (!members.has(sig.memberId) || !taskInfo.has(sig.taskId)) continue;
    const e = taskEntry(bucketFor(dayOf(sig.at), sig.memberId), sig.taskId);
    if (sig.newlyAssigned) e.newlyAssigned = true;
  }

  // Evidence → nested under its linked task (if the task is known), else the Other bucket.
  for (const ev of evidence) {
    if (!members.has(ev.memberId)) continue; // unknown member → drop, don't guess
    const b = bucketFor(dayOf(ev.at), ev.memberId);
    const item: EvidenceItem = { id: ev.id, title: ev.title, url: ev.url, source: ev.source, kind: ev.kind, at: ev.at };
    if (ev.taskId && taskInfo.has(ev.taskId)) taskEntry(b, ev.taskId).ev.push(item);
    else b.other.push(item);
  }

  const days: TimelineDay[] = [];
  for (const [date, people] of [...byDay.entries()].sort((a, b) => sortDaysDesc(a[0], b[0]))) {
    const personDays: PersonDay[] = [];
    for (const [memberId, b] of people.entries()) {
      const m = members.get(memberId)!;
      const tasks: TaskGroup[] = [...b.tasks.entries()]
        .map(([taskId, t]) => {
          const info = taskInfo.get(taskId)!;
          return {
            taskId,
            title: info.title,
            status: info.status,
            source: info.source,
            newlyAssigned: t.newlyAssigned,
            sources: toSourceGroups(t.ev, perSourceCap),
            evidenceCount: t.ev.length,
          };
        })
        // most-evidenced tasks first; a newly-assigned-with-no-evidence sinks below worked ones.
        .sort((x, y) => y.evidenceCount - x.evidenceCount || (x.title < y.title ? -1 : 1));
      const other = toSourceGroups(b.other, perSourceCap);
      const total =
        tasks.reduce((n, t) => n + t.evidenceCount, 0) + tasks.length + other.reduce((n, g) => n + g.count, 0);
      personDays.push({ memberId, name: m.name, handle: m.handle, avatarUrl: m.avatarUrl, total, tasks, other });
    }
    personDays.sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : 1));
    days.push({ date, label: dayLabel(date, todayISO), people: personDays });
  }
  return days;
}
