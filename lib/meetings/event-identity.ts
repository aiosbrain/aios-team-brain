/**
 * The identity a calendar event and its transcript can SHARE — parsed, normalised, and (for now)
 * measured rather than acted on (MTGATT-2).
 *
 * WHY THIS EXISTS WITHOUT A JOIN BEHIND IT. A pushed calendar event and the Granola transcript of the
 * same meeting are two notes for one meeting, and the only comparator that can reach a bodyless event
 * today is `titleSimilarity` — which decides on a RESEMBLANCE and is dormant for that reason. The
 * durable fix is an identifier both sides carry. Nothing in production carries one yet (measured
 * 2026-08-18: zero items), and the transcripts come from a producer on a machine this repo does not
 * control, so this slice ships the CONTRACT and the MEASUREMENT; the join is MTGATT-3, sized from the
 * pairs this actually finds.
 *
 * ⚠️ A CONFERENCE URL IS NOT AN IDENTITY, and `conferenceKey` must never become a join key. A Zoom
 * Personal Meeting ID (`zoom.us/j/1234567890`) is reused for every meeting that person hosts, and one
 * Google Meet room serves an entire recurring series — so grouping on it fuses unrelated meetings,
 * which is the fatal direction for this feature. It is parsed here to be COUNTED (how often would it
 * have been the only shared signal?), and `test/guards/meeting-identity-not-a-join-key.test.ts` is
 * what keeps it out of a decision path.
 *
 * NOT MEASURED, and not pretended otherwise: the nested `google_calendar_event` shape comes from
 * Google's documented Events resource plus our own producer's existing use of `.start.dateTime`.
 * Granola's local cache and token are encrypted on the machine this was written on, so nobody here
 * has read one. That is the reason for the tolerance below, and the reason it is stated.
 *
 * Pure — no DB, no `server-only`.
 */

/** Frontmatter keys that carry a calendar event id, in the spellings a producer might reasonably use. */
const EVENT_ID_KEYS = ["calendar_event_id", "calendarEventId", "event_id", "gcal_event_id"] as const;
/** Frontmatter keys that carry the cross-calendar-stable UID. */
const UID_KEYS = ["ical_uid", "icalUID", "iCalUID", "ical_uid_raw"] as const;
/** Frontmatter keys that carry the video-call link. Measured only — never a join key. */
const CONFERENCE_KEYS = ["conference_url", "hangout_link", "hangoutLink", "meeting_url", "conferenceUrl"] as const;

/**
 * Google documents an event id as 5–1024 characters, so the floor is 5 — an earlier 8 silently
 * discarded valid short ids, which would have made the pairing report undercount real pairs and a
 * future join miss them, with nothing to show that it had happened.
 */
const MIN_KEY_LENGTH = 5;

/**
 * Values that are a producer saying "I had nothing to put here". They must never become keys: an
 * exact matcher that accepted them would fuse every meeting that had nothing to put there — the one
 * failure an exact join is supposed to be incapable of. A denylist rather than a length rule, because
 * the length rule that caught them also caught real ids.
 *
 * KNOWN COLLISION, accepted deliberately: Google's event-id charset is `a-v` + `0-9`, so `false` and
 * `undefined` are *technically* legal ids, and an event whose id is literally one of those would be
 * discarded here. That trade is one-directional on purpose — a missed key costs an undercount in a
 * diagnostic, while a placeholder becoming a join key silently fuses unrelated meetings, which is the
 * failure this whole slice is shaped around. Pinned by a test so it stays a decision, not an accident.
 */
const PLACEHOLDER_KEYS = new Set(["none", "null", "nil", "n/a", "na", "unknown", "undefined", "tbd", "false", "-"]);

export interface EventIdentity {
  /**
   * Every distinct key that identifies THIS MEETING, each QUALIFIED by which identifier it came from
   * (`eid:` / `uid:`).
   *
   * The qualifier is not decoration. An unqualified normaliser that stripped `@google.com` would make
   * the UID `Foo@google.com` and a bare producer key `foo` the same string — a second, unproven merge
   * rule smuggled in beside the real one. Qualified, an event id can only ever match an event id.
   * They are kept as a SET rather than one winner because the two identifiers have different
   * stability guarantees and either side of a future pair may carry only one of them.
   */
  eventKeys: string[];
  /**
   * Keys that identify a SERIES rather than a meeting — kept apart from `eventKeys` so they can never
   * be joined on by accident. See `isRecurringInstance`.
   */
  seriesKeys: string[];
  /** The normalised conference link, if any. Diagnostic. Never a join key — see the file header. */
  conferenceKey: string | null;
}

/**
 * True when this frontmatter describes ONE OCCURRENCE of a recurring event.
 *
 * Google names an instance `<base>_20260811T090000Z` and sets `recurringEventId` on it. Either signal
 * is enough; both are checked because a producer may forward only one.
 */
function isRecurringInstance(fm: Record<string, unknown>, nested: Record<string, unknown>): boolean {
  const recurringId = fm.recurring_event_id ?? fm.recurringEventId ?? nested.recurringEventId;
  if (typeof recurringId === "string" && recurringId.trim()) return true;
  const ids = [firstString(fm, EVENT_ID_KEYS), typeof nested.id === "string" ? nested.id : null];
  return ids.some((v) => typeof v === "string" && /_\d{8}t\d{6}z$/i.test(v.trim()));
}

/**
 * Normalise an event id or UID: trim, lowercase. Nothing else is removed.
 *
 * A RECURRING INSTANCE KEEPS ITS SUFFIX. Google names one instance `<base>_20260811T090000Z`, and
 * both attendees' copies of that instance carry the same suffix — so it is exactly the part that
 * distinguishes this week's standup from next week's. Stripping it would fuse a whole series into one
 * meeting, which is the same class of error as matching on a Zoom PMI.
 *
 * ⚠️ THE SUFFIX RULE ALONE IS NOT THE PROTECTION, and an earlier version of this comment claimed it
 * was. Every occurrence of a recurring event shares ONE `iCalUID`, so the UID channel fuses the series
 * even while `eid:` correctly separates it — and the bare-`eid:` derivation below carried that fusion
 * straight into the meeting channel. Recurring UIDs now go to `seriesKeys` instead (see
 * `isRecurringInstance`), and the derivation is applied only to a single event's UID.
 *
 * The `@google.com` suffix on a UID is otherwise KEPT. Google documents the derivation
 * (`iCalUID = <eventId>@google.com` for a single event it created), so the bare form is emitted as a
 * SEPARATE `eid:` key rather than by mutating the UID — the derivation is then visible in the key set
 * and measurable, instead of being an invisible equivalence baked into a normaliser.
 */
function normaliseId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v.length < MIN_KEY_LENGTH || PLACEHOLDER_KEYS.has(v)) return null;
  return v;
}

/**
 * Normalise a conference link to host + path.
 *
 * The query string is dropped because it carries per-person junk (`?authuser=1`, `?pwd=…`), so two
 * people's copies of the same link differ there and nowhere else. A trailing slash is dropped for the
 * same reason.
 */
function normaliseConference(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s.includes("://") ? s : `https://${s}`);
    const path = u.pathname.replace(/\/+$/, "");
    const key = `${u.host.toLowerCase()}${path.toLowerCase()}`;
    return key.length >= MIN_KEY_LENGTH ? key : null;
  } catch {
    return null;
  }
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = source[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/**
 * The identity keys an item's frontmatter carries. Accepts the flat spellings AND the nested
 * `google_calendar_event` object (Granola stores Google's event resource verbatim under that key), so
 * a producer that forwards the whole object works without a second contract.
 */
export function eventIdentity(fm: Record<string, unknown> | null | undefined): EventIdentity {
  if (!fm) return { eventKeys: [], seriesKeys: [], conferenceKey: null };

  const nested = fm.google_calendar_event ?? fm.calendar_event ?? null;
  const nestedObj: Record<string, unknown> = nested && typeof nested === "object" ? (nested as Record<string, unknown>) : {};
  const recurring = isRecurringInstance(fm, nestedObj);

  const keys = new Set<string>();
  const series = new Set<string>();
  const addEventId = (raw: unknown): void => {
    const k = normaliseId(raw);
    if (k) keys.add(`eid:${k}`);
  };
  const addUid = (raw: unknown): void => {
    const k = normaliseId(raw);
    if (!k) return;

    // A UID IS A SERIES IDENTITY WHEN THE EVENT RECURS, and that is Google's documented behaviour, not
    // an edge case: "in recurring events, all occurrences of one event have different ids while they
    // all share the same iCalUIDs". So every Tuesday standup for a year carries ONE iCalUID. Treating
    // it as a meeting key would group the whole series — the exact fusion the instance suffix on
    // `eid:` exists to prevent, arriving through the identifier beside it — and the derived bare
    // `eid:` below would smuggle the same fusion into the meeting channel, because for an instance the
    // bare form is the SERIES id and not this occurrence's id.
    if (recurring) {
      series.add(`suid:${k}`);
      return;
    }

    keys.add(`uid:${k}`);
    // Google's documented derivation for a SINGLE event: `iCalUID = <eventId>@google.com`. The bare
    // form is added as its own `eid:` key so a producer that sends only the UID can still line up with
    // one that sends only the id — as an EXPLICIT extra key, never by rewriting the UID.
    const bare = k.replace(/@google\.com$/, "");
    if (bare !== k) addEventId(bare);
  };

  // The nested object uses Google's own field names, which are not the flat spellings above.
  addEventId(firstString(fm, EVENT_ID_KEYS));
  addEventId(typeof nestedObj.id === "string" ? nestedObj.id : null);
  addUid(firstString(fm, UID_KEYS));
  addUid(firstString(nestedObj, UID_KEYS));

  const conference =
    normaliseConference(firstString(fm, CONFERENCE_KEYS)) ??
    normaliseConference(firstString(nestedObj, CONFERENCE_KEYS)) ??
    normaliseConference(entryPointUri(nestedObj.conferenceData));

  return { eventKeys: [...keys], seriesKeys: [...series], conferenceKey: conference };
}

/**
 * Google buries the joinable link at `conferenceData.entryPoints[].uri` when there is no
 * `hangoutLink`.
 *
 * The VIDEO entry point is preferred, not merely the first one: a conference with a dial-in lists
 * `{entryPointType: "phone", uri: "tel:+1…"}` too, and on a phone-first payload taking the first uri
 * would record a telephone number as the meeting's conference link — junk in a measurement whose
 * whole job is to say how often a link would have identified a meeting.
 */
function entryPointUri(conferenceData: unknown): string | null {
  if (!conferenceData || typeof conferenceData !== "object") return null;
  const points = (conferenceData as { entryPoints?: unknown }).entryPoints;
  if (!Array.isArray(points)) return null;
  const uriOf = (p: unknown): string | null => {
    const uri = p && typeof p === "object" ? (p as { uri?: unknown }).uri : null;
    return typeof uri === "string" && uri.trim() ? uri : null;
  };
  const isVideo = (p: unknown): boolean =>
    !!p && typeof p === "object" && (p as { entryPointType?: unknown }).entryPointType === "video";
  return uriOf(points.find(isVideo)) ?? uriOf(points.find((p) => uriOf(p) && !((p as { entryPointType?: unknown })?.entryPointType === "phone")));
}
