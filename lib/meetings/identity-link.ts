/**
 * One meeting, two pushes — the join MTGATT-2 deliberately did not build (MTGATT-3).
 *
 * THE PROBLEM, in the operator's words: *"John may be uploading meetings and if they do they're gonna
 * come saying just John Ellison but I would have already also been in that meeting… my calendar is the
 * only way we could do that."* Today those are two meetings on the Meetings page and the second person
 * is credited on neither.
 *
 * THE RULE the operator settled on: a person's own calendar push is a first-person assertion that they
 * were there. The push IS the assertion; their RSVP only vetoes it (a `declined` is filtered upstream
 * by `attendingAttendees`), because people attend meetings they never RSVP to.
 *
 * WHAT THIS IS NOT. It is not a matcher. Groups are formed by an EXACT shared event key and nothing
 * else — never a conference link (a Zoom personal room is reused for every meeting its owner hosts),
 * never a series key (every occurrence of a recurring event shares one iCalUID), never title
 * similarity (two same-day meetings named after the same person score 1.0). And candidates are never
 * pre-filtered by date: a 19:00 PDT meeting is 02:00Z the next day, so a calendar event and its
 * transcript legitimately carry different `occurred_at`, and filtering first would silently drop
 * exactly the evening meetings.
 *
 * Pure — the decisions live here so they are testable without a database; the caller does the I/O.
 */

/** The minimum a note must expose for this module to decide anything about it. */
export interface LinkCandidate {
  noteId: string;
  /** Every kind-qualified meeting key the note's item carries (`eid:` / `uid:`). NEVER series keys. */
  eventKeys: string[];
  /** True when the note's item has real content. Whitespace does not count — see `plan`. */
  hasBody: boolean;
  /** `YYYY-MM-DD`, or null when the producer dated nothing. */
  occurredAt: string | null;
  /** Note creation time, ISO. The deterministic tie-break when nothing has a body. */
  createdAt: string;
}

export interface LinkGroup {
  /** The note everything else folds INTO. */
  survivorId: string;
  /** Notes to hide behind the survivor, and whose attendance/submitters it inherits. */
  foldedIds: string[];
  /** The keys that connected this component — carried for logging, never re-derived downstream. */
  keys: string[];
}

export type RefusalReason = "two-bodies" | "dates-too-far-apart" | "unknown-date";

export interface LinkPlan {
  groups: LinkGroup[];
  /** Why a group was refused, counted by reason — a silent refusal is indistinguishable from no match. */
  refusals: Record<RefusalReason, number>;
}

const NO_REFUSALS: Record<RefusalReason, number> = {
  "two-bodies": 0,
  "dates-too-far-apart": 0,
  "unknown-date": 0,
};

/** A calendar event and its transcript can be a day apart legitimately; a fortnight cannot. */
export const MAX_DAY_SPAN = 1;

/**
 * Days between two `YYYY-MM-DD` values, or Infinity if either cannot be parsed.
 *
 * INFINITY, NOT ZERO. Returning 0 on an unparseable date would silently disarm the veto — the exact
 * failure §2.2 exists to prevent — and it would do so on malformed input, which is when a guard is
 * most needed. Today the adapter pins date columns to `YYYY-MM-DD` so this is unreachable, but
 * `plan()` is an exported pure API and its callers are not all written yet.
 */
function daysApart(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : Number.POSITIVE_INFINITY;
}

/**
 * The date VETO. It runs only on a component an identifier has already formed, and it can only ever
 * REMOVE a link — never find or widen one — which is why it does not reintroduce the date pre-filter
 * this module refuses. What it catches is the residual series case `seriesKeys` cannot: a producer
 * sending only `ical_uid`, with no instance suffix and no `recurringEventId`, is indistinguishable
 * from a single event, so two occurrences weeks apart would otherwise link.
 *
 * AN UNKNOWN DATE REFUSES THE LINK. The first draft said the opposite — the identifier is the
 * evidence, so an unknown date is not counter-evidence — and review round 2 broke it with a concrete
 * case: an undetectable weekly series where the transcript is dated 11 Aug and the calendar event for
 * 18 Aug carries no date at all. With nulls skipped, the veto's only defence against that series is
 * switched off precisely when it is needed. Refusing costs little (a calendar event is dated by its
 * `start`, a granola transcript by `created`, and `deriveOccurredAt` has three fallbacks, so an
 * undated note is rare) and it fails in the safe direction: a duplicate meeting is visible and
 * fixable, two meetings fused into one are neither.
 */
function dateVerdict(members: LinkCandidate[]): "ok" | RefusalReason {
  if (members.some((m) => !m.occurredAt)) return "unknown-date";
  const dated = members.map((m) => m.occurredAt as string);
  for (let i = 0; i < dated.length; i++) {
    for (let j = i + 1; j < dated.length; j++) {
      if (daysApart(dated[i], dated[j]) > MAX_DAY_SPAN) return "dates-too-far-apart";
    }
  }
  return "ok";
}

/**
 * Which notes fold into which — the whole decision, as data.
 *
 * THE SURVIVOR IS CHOSEN BY CONTENT, NOT ARRIVAL ORDER, and that is what makes this safe. MTGATT-1
 * deferred this join partly because `mergeIntoMeetingNote` keeps whichever note existed FIRST, so a
 * transcript arriving after its calendar event would fold into the bodyless note and lose its text.
 * Here the note with a body always wins, so that outcome is unreachable rather than merely unlikely,
 * and processing order cannot change the result.
 *
 * TWO BODIES ARE REFUSED. Two transcripts of one meeting are the overlap merge's job — it combines
 * their text; this path would hide one. Refusing is the conservative direction: a duplicate meeting is
 * visible and fixable, lost content is neither.
 */
export function plan(candidates: LinkCandidate[]): LinkPlan {
  // CONNECTED COMPONENTS over shared keys, not one group per key. Review round 2 built the case that
  // killed per-key grouping: A carries `eid:x`, B carries BOTH `eid:x` and `uid:x@google.com` (the
  // ordinary shape — a UID also emits its bare event id), C is the TRANSCRIPT carrying only the uid.
  // Per-key, `eid:x` is processed first, folds B into A, and C — the one with the body — is left
  // stranded as a separate meeting while a bodyless note survives. That is the precise outcome the
  // survivor rule exists to make unreachable, entering through the grouping layer instead.
  const byKey = new Map<string, LinkCandidate[]>();
  for (const c of candidates) {
    for (const k of c.eventKeys) byKey.set(k, [...(byKey.get(k) ?? []), c]);
  }

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    return root;
  };
  const union = (a: string, b: string): void => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const c of candidates) parent.set(c.noteId, c.noteId);
  for (const members of byKey.values()) {
    for (const m of members.slice(1)) union(members[0].noteId, m.noteId);
  }

  const components = new Map<string, LinkCandidate[]>();
  for (const c of candidates) {
    // A note with no keys is in no component — it cannot be connected to anything, and grouping the
    // keyless together would fold an entire corpus that carries no identifiers (today: all of prod).
    if (!c.eventKeys.length) continue;
    const root = find(c.noteId);
    components.set(root, [...(components.get(root) ?? []), c]);
  }

  const groups: LinkGroup[] = [];
  const refusals: Record<RefusalReason, number> = { ...NO_REFUSALS };

  // Deterministic order WITHIN each component (so the survivor and the folded set never depend on
  // input order), and a stable sort across components. The array ORDER of `groups` follows the
  // union-find root and is not itself a contract — each group is applied independently.
  for (const root of [...components.keys()].sort()) {
    const members = (components.get(root) ?? []).sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.noteId < b.noteId ? -1 : 1
    );
    if (members.length < 2) continue;

    const withBody = members.filter((m) => m.hasBody);
    if (withBody.length > 1) {
      refusals["two-bodies"]++;
      continue;
    }
    const dates = dateVerdict(members);
    if (dates !== "ok") {
      refusals[dates]++;
      continue;
    }

    // One body → it survives. No bodies → the earliest-created survives (members are sorted).
    const survivor = withBody[0] ?? members[0];
    const folded = members.filter((m) => m.noteId !== survivor.noteId);
    const keys = [...new Set(members.flatMap((m) => m.eventKeys))].sort();
    groups.push({ survivorId: survivor.noteId, foldedIds: folded.map((f) => f.noteId), keys });
  }

  return { groups, refusals };
}
