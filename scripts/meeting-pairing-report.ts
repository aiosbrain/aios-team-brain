/**
 * How many meetings could actually be PAIRED, and by what — the measurement MTGATT-3 has to be built
 * from (MTGATT-2 §3).
 *
 * WHY IT EXISTS. A pushed calendar event and the Granola transcript of the same meeting are two notes
 * for one meeting. Joining them needs a key both sides carry, and nobody knows yet how often that
 * happens, because until this slice no producer emitted one. Rather than guess a matching rule (a
 * time window, a title threshold) and discover its error rate in production, this counts the real
 * pairs and reports what would have matched them.
 *
 * READ-ONLY. It writes nothing and is run by hand.
 *
 * IT REPORTS BY SOURCE PAIR, ON PURPOSE. "12 notes share a key" is an adjacent number: 12 Granola
 * notes sharing keys with each other says nothing about whether a calendar event can find its
 * transcript. Only the CROSS-source count (calendar ↔ transcript) is the population MTGATT-3 draws
 * from, so the report separates them, and prints how many notes of EACH source carry a key at all.
 * A run that finds nothing must be distinguishable from a run whose parser matched nothing — so zero
 * is always reported alongside the denominators that explain it.
 *
 * Run:
 *   DATABASE_URL=… npx tsx --conditions react-server scripts/meeting-pairing-report.ts [teamSlug]
 */
import { adminClient } from "@/lib/db/admin";
import { eventIdentity } from "@/lib/meetings/event-identity";
import { isCalendarEvent } from "@/lib/meetings/from-calendar";

type TeamRow = { id: string; slug: string };
type NoteRow = { id: string; title: string; occurred_at: string | null; source_item_id: string };
type ItemRow = { id: string; frontmatter: Record<string, unknown> | null };

/** Which producer a note came from — the axis that decides whether a pair is useful. */
export type NoteSource = "calendar" | "transcript";

export interface Note {
  id: string;
  title: string;
  occurredAt: string | null;
  source: NoteSource;
  /** The producer's own timestamp, when it carried one (42 of 63 granola items in prod do). */
  startedAt: string | null;
  eventKeys: string[];
  conferenceKey: string | null;
}

/** ISO timestamp from the fields a producer plausibly dates an event with, or null. */
function startedAt(fm: Record<string, unknown> | null): string | null {
  for (const k of ["start", "start_time", "startTime", "created", "source_ts", "occurred_at"]) {
    const v = fm?.[k];
    // A bare date (`2026-08-11`) is deliberately NOT accepted: this column exists to size a TIME
    // window, and a date with no clock would silently enter that fit as midnight.
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v;
  }
  return null;
}

function pairsOf<T>(xs: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) out.push([xs[i], xs[j]]);
  return out;
}

function hoursApart(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ms = Math.abs(Date.parse(a) - Date.parse(b));
  return Number.isFinite(ms) ? Math.round((ms / 3_600_000) * 100) / 100 : null;
}

async function reportTeam(db: ReturnType<typeof adminClient>, team: TeamRow): Promise<void> {
  const { data: noteRows } = await db
    .from("meeting_notes")
    .select("id, title, occurred_at, source_item_id")
    .eq("team_id", team.id)
    .is("merged_into", null);
  const notes = (noteRows ?? []) as NoteRow[];
  if (!notes.length) {
    console.log(`\n## ${team.slug}\n  no live meeting notes`);
    return;
  }

  const { data: itemRows } = await db
    .from("items")
    .select("id, frontmatter")
    .in("id", notes.map((n) => n.source_item_id));
  const itemById = new Map(((itemRows ?? []) as ItemRow[]).map((i) => [i.id, i]));

  const enriched: Note[] = notes.map((n) => {
    const fm = itemById.get(n.source_item_id)?.frontmatter ?? null;
    const identity = eventIdentity(fm);
    const src = typeof fm?.source === "string" ? fm.source : null;
    return {
      id: n.id,
      title: n.title,
      occurredAt: n.occurred_at,
      source: isCalendarEvent(src) ? "calendar" : "transcript",
      startedAt: startedAt(fm),
      eventKeys: identity.eventKeys,
      conferenceKey: identity.conferenceKey,
    };
  });

  const by = (s: NoteSource): Note[] => enriched.filter((n) => n.source === s);
  const withKey = (ns: Note[]): Note[] => ns.filter((n) => n.eventKeys.length > 0);
  const withConf = (ns: Note[]): Note[] => ns.filter((n) => !!n.conferenceKey);
  const withClock = (ns: Note[]): Note[] => ns.filter((n) => !!n.startedAt);

  console.log(`\n## ${team.slug}`);
  console.log(`  live notes: ${enriched.length}  (calendar ${by("calendar").length} · transcript ${by("transcript").length})`);
  for (const s of ["calendar", "transcript"] as const) {
    const ns = by(s);
    console.log(
      `  ${s.padEnd(10)} event key: ${withKey(ns).length}/${ns.length} · conference: ${withConf(ns).length}/${ns.length} · full timestamp: ${withClock(ns).length}/${ns.length}`
    );
  }

  const summary = summarisePairs(enriched);
  console.log(
    `  pairs sharing an event key: ${summary.cross + summary.same}  (CROSS calendar↔transcript ${summary.cross} · same-source ${summary.same})`
  );
  // The CROSS number is the only one MTGATT-3 can be fitted to. Printed even at zero, next to the
  // denominators above, so "no pairs yet" cannot be mistaken for "the parser found nothing".
  if (summary.rows.length) {
    console.log(summary.rows.join("\n"));
    console.log(`  of the CROSS pairs, ${summary.missedByDate} would have been MISSED by a same-date rule (the timezone case)`);
  }

  const confGroups = new Map<string, Note[]>();
  for (const n of enriched) if (n.conferenceKey) confGroups.set(n.conferenceKey, [...(confGroups.get(n.conferenceKey) ?? []), n]);
  const confPairs = [...confGroups.values()].flatMap((m) => pairsOf(m));
  const confCross = confPairs.filter(([a, b]) => a.source !== b.source).length;
  // Diagnostic ONLY. A conference link is reused by a Zoom Personal Meeting ID and by a whole
  // recurring series, so this number includes false pairs BY CONSTRUCTION and must never become a
  // join. It is here to answer "how much would it have added?" — not "should we use it?".
  console.log(`  pairs sharing a conference link: ${confPairs.length} (CROSS ${confCross}) — diagnostic, never a join key`);
}

export interface PairSummary {
  /** Distinct NOTE pairs where the two sides came from different producers — the MTGATT-3 population. */
  cross: number;
  /** Distinct note pairs from the same producer. Real, but not what a calendar↔transcript join needs. */
  same: number;
  /** Of the cross pairs, how many a same-date pre-filter would have thrown away (the timezone case). */
  missedByDate: number;
  rows: string[];
}

/**
 * Count PAIRS OF NOTES that share an event key — pure, so the counting rule is testable without a DB.
 *
 * Deduped by note pair, not by key. One pair routinely shares BOTH an `eid:` and a `uid:` (a UID
 * emits its bare event id as a second key by design), so counting key groups reported two pairs for
 * one meeting — inflating the exact number a later matching rule would be fitted to.
 */
export function summarisePairs(notes: Note[]): PairSummary {
  const groups = new Map<string, Note[]>();
  for (const n of notes) for (const k of n.eventKeys) groups.set(k, [...(groups.get(k) ?? []), n]);

  const seen = new Set<string>();
  const missed = new Set<string>();
  const out: PairSummary = { cross: 0, same: 0, missedByDate: 0, rows: [] };
  for (const [key, members] of groups) {
    for (const [a, b] of pairsOf(members)) {
      if (a.id === b.id) continue;
      const pairId = [a.id, b.id].sort().join("|");
      if (seen.has(pairId)) continue;
      seen.add(pairId);
      const isCross = a.source !== b.source;
      if (isCross) {
        out.cross++;
        if (a.occurredAt !== b.occurredAt) missed.add(pairId);
      } else out.same++;
      const gap = hoursApart(a.startedAt, b.startedAt);
      out.rows.push(
        `    ${isCross ? "CROSS" : "same "}  ${key.slice(0, 28).padEnd(28)}  ` +
          `dates ${a.occurredAt ?? "?"}/${b.occurredAt ?? "?"} ${a.occurredAt === b.occurredAt ? "=" : "\u2260"}  ` +
          `gap ${gap === null ? "unknown" : `${gap}h`}  ${a.title.slice(0, 30)} | ${b.title.slice(0, 30)}`
      );
    }
  }
  out.missedByDate = missed.size;
  return out;
}

async function main(): Promise<void> {
  const slug = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const db = adminClient();
  const q = db.from("teams").select("id, slug");
  const { data } = slug ? await q.eq("slug", slug) : await q;
  const teams = (data ?? []) as TeamRow[];
  if (!teams.length) {
    console.error(slug ? `no team with slug ${slug}` : "no teams");
    process.exit(1);
  }
  console.log("# meeting pairing report — read-only");
  for (const t of teams) await reportTeam(db, t);
}

// Run only when invoked directly, so the pure counting rule above can be imported by a test without
// the import opening a database connection.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
