/**
 * Who was in the meeting — from what the producer ASSERTED, falling back to a model only when
 * nothing was asserted (MTGATT-1 / AIO-962).
 *
 * WHY THIS EXISTS. Attendance used to be inferred by asking an LLM to name "every person who appears
 * to have attended or spoken", then keeping whatever matched the roster. That has no representation
 * of PRESENT versus DISCUSSED, so on 2026-08-11's "Content creation strategy session" it recorded
 * Abe Isleem and Fatma — both named only in the third person, and explicitly as absent ("one day to
 * get Abe, who's in Germany… can we get him on Zoom?"). Meanwhile the item's own frontmatter said
 * `participants: "[John Ellison]"`, which was exactly right, and was ignored.
 *
 * Two properties made that failure worse than an ordinary hallucination, and they are why the
 * precedence below is ordered rather than blended:
 *   · the roster filter concentrates every error onto a REAL teammate, so a wrong answer always looks
 *     plausible;
 *   · a third false attendee was avoided only because the roster spells him `Stephan` and the
 *     transcript said `Stefan`.
 *
 * Pure — no DB, no `server-only` — so every shape below is testable directly against the ones that
 * actually occur in prod.
 */
import { matchAttendees, type RosterPerson } from "./llm-extract";

/** Where an attendance answer came from. Carried so a caller can log/report it, never guessed at. */
export type AttendanceSource = "calendar" | "participants" | "llm" | "none";

export interface AttendanceResult {
  memberIds: string[];
  source: AttendanceSource;
  /** Names the producer asserted that resolved to nobody on this team — reported, never silently lost. */
  unresolved: string[];
}

/**
 * Names from a `participants` frontmatter value, or `[]` when it carries no names.
 *
 * SHAPES THAT ACTUALLY OCCUR (measured across every row in prod carrying the field, 2026-08-17):
 *   granola, 45 rows, STRING:  "[John Ellison]"
 *                              "[John Ellison, Chetan, Stephan Ledain, Fatma Ghedira]"
 *                              "[John Ellison, Alex Marchetti, Mira, Daniel 'Dash' Okonkwo]"
 *   slack,   19 rows, ARRAY of objects: [{ author_id: "U0B9…", first_ts: …, last_ts: … }]
 *
 * The Slack shape is the reason this returns `[]` rather than "whatever it can stringify". Those
 * objects carry a Slack user id and NO name; coercing them would feed `U0B92140SHJ` into a name
 * matcher, and a matcher that receives garbage is one first-name collision away from inventing an
 * attendee — the exact failure this module replaces. Slack transcripts never take the meeting path
 * today, so this is defence against a future wiring change, not a live case.
 *
 * An array of plain STRINGS is accepted because it is the obvious shape a future producer would send.
 */
export function parseParticipantNames(raw: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v !== "string") return;
    const name = v.trim();
    if (name) out.push(name);
  };

  if (Array.isArray(raw)) {
    // Objects are only usable if they carry a human name; Slack's do not.
    for (const entry of raw) {
      if (typeof entry === "string") push(entry);
      else if (entry && typeof entry === "object") {
        const o = entry as Record<string, unknown>;
        push(o.name ?? o.display ?? o.display_name ?? o.full_name);
      }
    }
    return dedupe(out);
  }

  if (typeof raw !== "string") return [];
  const s = raw.trim();
  if (!s) return [];
  // `[A, B]` — the granola shape. Strip ONE layer of brackets, then split on commas.
  //
  // Comma-splitting is exact for every name in prod (the only punctuation inside one is an
  // apostrophe: `Daniel 'Dash' Okonkwo`). A name containing a real comma would split wrongly and
  // then fail to resolve, which drops it — the safe direction: a missing attendee is visible in
  // `unresolved`, an invented one is not.
  const inner = s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1) : s;
  for (const part of inner.split(",")) push(part);
  return dedupe(out);
}

function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}


/** Normalisation shared with `matchAttendees` — lowercase, strip punctuation, collapse whitespace. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Match ASSERTED names to members — strictly, and never by first name alone.
 *
 * WHY NOT `matchAttendees`. That one falls back to "the first word matches and it's the only
 * candidate", which is right for a MODEL's guess (the transcript says "hey it's just Alex") and wrong
 * for a name the producer asserted in full. Both reviewers landed on this independently, the second
 * escalating it: with the loose rule, `participants: "[John Smith]"` against a roster holding
 * `John Ellison` RECORDS JOHN ELLISON — inventing exactly the plausible-real-teammate attendance this
 * whole change exists to stop, now sourced from the path we called authoritative. And granola's
 * participant lists demonstrably carry outsiders (placeholder names: Alex Marchetti, Mira,
 * Priya Raghavan, Sam Fielding — real people in production, not named here; the repo is public).
 *
 * The rule: normalised equality, or one name is a WHOLE-WORD PREFIX of the other. That keeps prod's
 * real cases (`Chetan Nandakumar` → roster `Chetan`, `Fatma Ghedira` → roster `Fatma`) and rejects
 * `John Smith` → `John Ellison`, because neither is a prefix of the other.
 *
 * Ambiguity resolves to NOTHING, reported. If an asserted name matches two members, or two asserted
 * names match the same member, the extra is returned as `unresolved` rather than silently collapsed —
 * the second review's other finding: `[Chetan Nandakumar, Chetan Gupta]` against one `Chetan` used to
 * yield one id and an EMPTY unresolved list, losing a real participant with no trace.
 */
export function matchAsserted(
  names: string[],
  roster: RosterPerson[]
): { memberIds: string[]; unresolved: string[] } {
  const memberIds: string[] = [];
  const unresolved: string[] = [];
  const taken = new Set<string>();

  for (const raw of names) {
    const n = norm(raw);
    if (!n) continue;
    const hits = roster.filter((p) => {
      const r = norm(p.displayName);
      return r === n || n.startsWith(r + " ") || r.startsWith(n + " ");
    });
    // Zero hits: an outsider, or a spelling we cannot resolve. One hit already claimed by an earlier
    // asserted name: two distinct people collapsing onto one member — report, do not double-count.
    if (hits.length !== 1 || taken.has(hits[0].id)) {
      unresolved.push(raw);
      continue;
    }
    taken.add(hits[0].id);
    memberIds.push(hits[0].id);
  }
  return { memberIds, unresolved };
}

export interface ResolveAttendanceInput {
  /** Emails from a calendar event's frontmatter (rank 1). Already-resolved member ids. */
  calendarMemberIds?: string[] | null;
  /** True when the item IS a calendar event — distinguishes "no attendees" from "not a calendar event". */
  isCalendar?: boolean;
  /** Raw `frontmatter.participants` (rank 2). */
  participants?: unknown;
  roster: RosterPerson[];
  /** Rank 3. Only invoked when neither structured source is present. */
  llm?: () => Promise<string[]>;
}

/**
 * The precedence: calendar emails → asserted participant names → model.
 *
 * THE RULE THAT MATTERS MOST: a structured list that resolves to NOBODY does not fall through to the
 * model. If granola says `[Alex Marchetti]` and Alex is not a member, the answer is "no member
 * attendees", not "ask a model who else might have been there". Falling through would re-open the
 * original bug precisely on the meetings most likely to involve outsiders — the ones where the model
 * has the most third-party names lying around to mistake for attendees. The unresolved names are
 * returned instead, so the loss is reportable rather than silent.
 */
export async function resolveAttendance(input: ResolveAttendanceInput): Promise<AttendanceResult> {
  const { roster } = input;

  // Rank 1 — a calendar event's attendees, resolved by EMAIL upstream. Exact; no model, no matching.
  if (input.isCalendar) {
    return { memberIds: dedupe(input.calendarMemberIds ?? []), source: "calendar", unresolved: [] };
  }

  // Rank 2 — the names the producer asserted, matched STRICTLY (see `matchAsserted`).
  const names = parseParticipantNames(input.participants);
  if (names.length > 0) {
    const { memberIds, unresolved } = matchAsserted(names, roster);
    return { memberIds, source: "participants", unresolved };
  }

  // Rank 3 — nothing was asserted. Only now does a model get asked.
  if (!input.llm) return { memberIds: [], source: "none", unresolved: [] };
  const fromModel = await input.llm();
  return { memberIds: dedupe(fromModel), source: "llm", unresolved: [] };
}
