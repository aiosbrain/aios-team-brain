/**
 * Pure grouping for the Learning "Timeline" — a human-readable day → person → work-with-evidence
 * chronology. Fed already-attributed evidence (one row per real piece of work: a commit, a task, a
 * dated doc) by `lib/dashboard/work-timeline`; this file has NO server-only/DB imports so it unit-tests
 * cleanly (mirrors the team-work.ts / team-work-live.ts split).
 *
 * Ordering: days DESC (undated last); within a day, people by work-item count DESC; within a person,
 * sources by count DESC; items newest-work-first, capped per source with a "+N more" remainder.
 */

/** One piece of a person's work — a commit, a task, a dated deliverable. */
export interface EvidenceItem {
  id: string;
  title: string;
  url?: string;
  /** Normalized source slug (github/linear/plane/slack/notion/granola/gdrive/other) → drives the icon. */
  source: string;
  kind: string;
  /** WORK time — ISO. Items: committed_at/source_ts. Tasks: worked_at (state transition) / assigned_at
   *  (newly assigned) / updated_at (a real edit). Its date places the row on a day. */
  at: string;
}

export interface EvidenceWithMember extends EvidenceItem {
  memberId: string;
}

export interface SourceGroup {
  source: string;
  count: number; // total for this person+day+source (may exceed items.length when capped)
  items: EvidenceItem[]; // newest-first, capped
}

export interface PersonDay {
  memberId: string;
  name: string;
  handle: string;
  avatarUrl?: string | null;
  total: number; // total evidence rows this person contributed on the day
  sources: SourceGroup[];
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

/** The synthetic source slug for tasks freshly assigned to a person — floated above real work sources
 *  (which rank by count). Set by `lib/dashboard/work-timeline`; rendered by `components/icons/source-icon`. */
export const NEWLY_ASSIGNED_SOURCE = "newly-assigned";
const sourceRank = (source: string): number => (source === NEWLY_ASSIGNED_SOURCE ? 0 : 1);

/** YYYY-MM-DD one day before `todayISO` (UTC). Pure given the input. */
function yesterdayOf(todayISO: string): string {
  const t = Date.parse(`${todayISO}T00:00:00Z`);
  return Number.isNaN(t) ? "" : new Date(t - 86_400_000).toISOString().slice(0, 10);
}

/** Human day label. `today`/`yesterday` are pre-computed YYYY-MM-DD; other dates format to "Mon Jul 21".
 *  Undated bucket → "Undated". (Locale-formatted like the prior panel — display only.) */
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

/**
 * Group attributed evidence into the day → person → source structure the panel renders. `members`
 * resolves a memberId → display fields; evidence for an unknown member is dropped (never guessed).
 * `todayISO` = YYYY-MM-DD of "today" (caller passes it — no Date.now here, so tests are deterministic).
 */
export function groupTimeline(
  evidence: EvidenceWithMember[],
  members: Map<string, TimelineMember>,
  todayISO: string,
  perSourceCap: number = DEFAULT_PER_SOURCE_CAP
): TimelineDay[] {
  // day -> memberId -> source -> items
  const byDay = new Map<string, Map<string, Map<string, EvidenceItem[]>>>();
  for (const e of evidence) {
    if (!members.has(e.memberId)) continue; // unknown member → drop, don't guess
    const date = (e.at ?? "").slice(0, 10) || "unknown";
    const people = byDay.get(date) ?? new Map();
    byDay.set(date, people);
    const sources = people.get(e.memberId) ?? new Map();
    people.set(e.memberId, sources);
    const arr = sources.get(e.source) ?? [];
    arr.push(e);
    sources.set(e.source, arr);
  }

  const days: TimelineDay[] = [];
  for (const [date, people] of [...byDay.entries()].sort((a, b) => sortDaysDesc(a[0], b[0]))) {
    const personDays: PersonDay[] = [];
    for (const [memberId, sources] of people.entries()) {
      const m = members.get(memberId)!;
      const groups: SourceGroup[] = [...sources.entries()]
        .map(([source, items]) => {
          const sorted = items.slice().sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)); // newest-first
          return { source, count: sorted.length, items: sorted.slice(0, perSourceCap) };
        })
        .sort(
          (a, b) =>
            sourceRank(a.source) - sourceRank(b.source) || b.count - a.count || (a.source < b.source ? -1 : 1)
        );
      const total = groups.reduce((n, g) => n + g.count, 0);
      personDays.push({ memberId, name: m.name, handle: m.handle, avatarUrl: m.avatarUrl, total, sources: groups });
    }
    personDays.sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : 1));
    days.push({ date, label: dayLabel(date, todayISO), people: personDays });
  }
  return days;
}
