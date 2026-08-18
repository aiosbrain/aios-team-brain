# Attendance by identifier, not by resemblance — MTGATT-2

**Status:** spec, pre-review.
**Build with:** opus / high — it writes to the attendance surface a human reads daily, it adds a
column to a table another slice will backfill, and the failure mode it must avoid (putting a person
in a meeting they were not in) is the exact failure MTGATT-1 shipped to remove.

**Deps: none blocking.** MTGATT-1 (`c10d9e6`) is merged: `resolveAttendance`, `from-calendar.ts` and
the write-route guard exist and this slice consumes them.

---

## What and why

**What:** a pushed calendar event and the Granola transcript of the same meeting are joined by an
**identifier they both carry** — never by how similar their titles look — and the calendar's
attendance is added to the surviving note as a **claim that records where it came from**.

**Why it matters:** today they cannot be joined at all. `findDuplicateMeeting` compares transcript
bodies, and a calendar event has no body by design, so one meeting becomes two notes: one with the
content and inferred attendance, one with exact attendance and nothing else. The comparator built for
that case (`titleSimilarity`) is dormant and must stay dormant — it decides on a resemblance, and the
operator's stated worry is precisely misassociation at larger team sizes.

The property that makes this safe is not a better matcher. It is **who is asserting**: when a person
pushes their own calendar, that is a first-person assertion about themselves. Each person only ever
asserts about themselves, so no one can accidentally add someone else — at 50 people that is 50
self-assertions rather than one system guessing 50 times.

## Scope

**In:** the event-identity normalizer, exact-identifier linking with a content-chosen survivor,
per-attendee provenance (`source` + `asserted_by`), RSVP (`declined` is not an attendee), and the
producer-side frontmatter contract.

**Cut, deliberately** (each named, none silent): time-window + shared-participant matching → MTGATT-3;
non-member attendees → MTGATT-4; any use of `titleSimilarity` in a decision — it stays dormant.

---

## 0. Terrain, measured before designing (prod, 2026-08-18)

| | |
|---|---|
| calendar-source items | **0** — the feature has no live data yet; the operator starts pushing this week |
| granola transcript items | **63**, of which **62** carry `granola_id`, **45** carry `participants` |
| granola items with a full ISO timestamp in `created` | **42** (e.g. `2026-08-12T01:14:01.689Z`) |
| live meeting notes / attendee rows | **60** / **81** |
| items carrying any calendar identifier today | **0** |

Two facts from that table shape the design more than anything else:

**1. Nothing in prod carries an identifier yet, and the transcripts are not ours to change.** Every
granola item in prod was pushed by *John's* producer (`1-inbox/transcripts/…`, `status: ingested`),
not by this operator's `~/scripts` staging path — which emits only `type/access/created/source/
granola_id`. So rank 1 fires only once **both** producers emit the id. That is why §3.5 is a written
contract with a deliberately tolerant parser, and why this slice's honest claim is *"the join is
exact and inert until the data arrives"*, not *"meetings now merge"*. Shipping it inert is the point:
MTGATT-1's review caught a comparator whose tests were green over a feature nobody could reach, so
this one states its dormancy in the spec, in the code, and in the PR.

**2. The link must not be pre-filtered by date.** `deriveOccurredAt` dates a granola note from UTC
`created` and a calendar event from its local `start`. A 19:00 PDT meeting is 02:00Z the next day, so
the two dates legitimately differ for the same meeting. Any date pre-filter would silently drop
exactly the evening meetings, and it would look like the feature simply "didn't match".

## 1. Why an identifier, and the order of them

Ranked by how much ambiguity each one can produce:

1. **`iCalUID`** — Google's documented cross-calendar-stable identifier. Two people's copies of one
   invitation share it by definition.
2. **Event `id`** — shared across attendees' copies for Google↔Google invitations, and the field
   Granola already stores on `google_calendar_event`. Not *guaranteed* stable across calendars the
   way `iCalUID` is, which is why it is rank 2 rather than rank 1 and why both are indexed.
3. **Conference URL** (`meet.google.com/abc-defg-hij`, a Zoom `/j/<id>`) — both sides have it, and it
   is exact after normalisation.
4. ~~Title similarity~~ — **not used.** It is the only one of these that can misassociate two
   different meetings, and it is the one with no producer change behind it.

Ranks 1–3 are all **exact string equality after normalisation**. There is no threshold to tune and no
score to defend, which is the property that makes this safe at 50 people.

**Recurring instances keep their suffix.** Google names an instance `<base>_20260811T090000Z`; both
attendees' copies carry the same suffix, and stripping it would fuse *every* weekly standup into one
meeting. So normalisation lowercases and trims and does nothing else.

## 2. A claim, not a merge

`mergeIntoMeetingNote` re-ingests a merged body, retires an item and can call an LLM. Running that
between a calendar event and a transcript is what produced MTGATT-1's deferred hazard: the survivor is
whichever note existed first, so a transcript arriving after its event folds **into the bodyless
note** and loses its text.

This slice does not merge notes. It:

- **adds** attendance rows to the survivor (union; nothing is overwritten),
- **adds** the folded note's submitter to the survivor,
- sets `merged_into` on the folded note so one meeting shows once.

No body is rewritten, no item is retired, no model is called. A wrong claim is one row to delete.

**The survivor is chosen by content, not by arrival order** — the note whose item has a body wins.
That single rule removes the data-loss hazard structurally rather than by ordering the pushes:

| both notes | survivor |
|---|---|
| one has a body (transcript), one does not (calendar event) | **the one with a body**, whichever arrived first |
| neither has a body (two people pushed the same event) | the **earliest-created** note — deterministic, and the outcome is identical whatever order they are processed in |
| both have bodies (two transcripts of one event) | **no link.** Two real bodies is the transcript-overlap merge's job; folding one away here would hide content |

## 3. The design

### 3.1 `lib/meetings/event-identity.ts` — pure

`eventIdentity(frontmatter)` → `{ eventKeys: string[], conferenceKey: string | null }`.

Accepted, because this is a cross-repo boundary and a reasonable producer choice must not silently
yield an unlinked meeting (the lesson written into `from-calendar.ts`):

```
calendar_event_id / calendarEventId / event_id / gcal_event_id   → event key
ical_uid / icalUID / iCalUID                                     → event key
google_calendar_event: { id, iCalUID, hangoutLink, conferenceData }  ← the nested Granola shape
conference_url / hangout_link / hangoutLink / meeting_url         → conference key
```

Normalisation: trim, lowercase, drop a `@google.com` suffix on a UID, and for a URL keep host + path
only (query strings carry per-person `?authuser=` and passcodes). A value that normalises to fewer
than 8 characters is discarded — `""`, `"-"` and `"none"` are not identities, and a short shared
token is exactly how an exact matcher would fuse unrelated meetings.

### 3.2 `lib/meetings/link-by-identity.ts` — the join

Runs each tick from `backfillMeetingNotesFromItems`, after note creation and **before** the
transcript-overlap merge (so a linked calendar note is already folded and cannot be reconsidered).

1. Select live notes' items that carry an identity key — two bounded windows (`calendar_event_id`
   not null, `ical_uid` not null, conference key not null), unioned in app code, newest first, capped.
   Today that selects **zero rows**, so the tick cost is two indexed metadata queries.
2. Group by each normalised key. A group of one is ignored.
3. Apply §2's survivor rule; union attendance + submitters; set `merged_into`.
4. Return counts (`groups`, `linked`, `skippedBothBodies`) so an inert leg is visibly inert rather
   than indistinguishable from a broken one.

**Never** consults titles, dates or scores. A group is formed only by an exact shared key.

### 3.3 Provenance: `source` + `asserted_by`

`meeting_note_attendees` gains, by migration (additive, mirrored into `schema.sql`):

- `source text not null default 'unknown'` — `calendar` | `participants` | `llm` | `unknown`
- `asserted_by uuid null references members(id) on delete set null` — the member whose push carried
  the assertion (the calendar owner). Null when nobody asserted it (a model's guess).

Existing 81 rows become `unknown`, which is true: they predate the column and their real provenance
is a mix. Backdating them to `calendar` would be an invented fact.

**A stronger claim upgrades a weaker one; a weaker one never downgrades.** Rank
`calendar > participants > llm > unknown`. Without this, the calendar claim for a member the model had
already guessed would be dropped by `on conflict do nothing`, and the row would keep saying `llm` for
a fact we now know exactly — the diagnostic would lie in the one case it exists for.

### 3.4 RSVP — a declined invitee is not an attendee

Today every invitee on an event counts as present. `calendarAttendees` starts carrying
`responseStatus` (tolerant of `responseStatus` / `response_status` / `rsvp` / `status`), and only an
explicit, normalised `declined` excludes.

Only `declined`, deliberately: `needsAction` and a missing field are the overwhelmingly common shapes
(Granola's nested event carries no RSVP at all), so excluding on "not accepted" would empty the
attendee list of nearly every event and look exactly like a broken join.

### 3.5 The producer contract

Documented in `docs/ARCHITECTURE.md` so the other producer can emit it, and implemented in this
operator's own sync (`~/scripts/granola_sync.py` → vault frontmatter, `granola_to_aios_brain.py` →
staged frontmatter), which today drops all of it:

```yaml
calendar_event_id: 6f3k9q2n1m8h5s7d0a4v2b1c3e   # google_calendar_event.id
ical_uid: 6f3k9q2n1m8h5s7d0a4v2b1c3e@google.com
conference_url: https://meet.google.com/abc-defg-hij
```

The brain never *requires* these. An item without them behaves exactly as it does today.

## 4. Acceptance

- **AC1 — unit, `test/meetings-event-identity.test.ts`:** every accepted producer shape in §3.1 —
  flat keys, camelCase, and the nested `google_calendar_event` object — yields the same normalised
  key, and an item with none of them yields no keys.
- **AC2 — unit, `test/meetings-event-identity.test.ts`:** a recurring instance suffix is **kept**
  (`base_20260811T090000Z` ≠ `base_20260818T090000Z`), and values shorter than the floor
  (`""`, `"-"`, `"none"`) yield no key.
- **AC3 — unit, `test/meetings-event-identity.test.ts`:** conference URLs differing only by query
  string or case normalise equal, and two different Meet rooms do not.
- **AC4 — unit, `test/meetings-attendance-provenance.test.ts`:** the source rank upgrades
  `llm` → `calendar` and refuses the reverse, for every ordered pair.
- **AC5 — data-mechanics, `test/datamechanics/meeting-identity-link.datamechanics.test.ts`:** a
  bodyless calendar event and a transcript sharing an event id produce **one** live note — the one
  with the body — carrying the union of both attendee sets, with the calendar-derived rows recording
  `source='calendar'` and the asserting member.
- **AC6 — data-mechanics, same file:** the same pair linked in the **reverse arrival order** yields
  the identical surviving note and the identical body — the order-independence §2 claims.
- **AC7 — data-mechanics, same file:** two notes with **identical titles on the same date** and no
  shared identifier are **not** linked, and both stay live. This is the misassociation the operator
  asked about, asserted as an absence.
- **AC8 — data-mechanics, same file:** two notes that both have bodies and share an identifier are
  **not** linked here, and neither is hidden — content is never folded away by this path.
- **AC9 — data-mechanics, same file:** an attendee whose RSVP is `declined` is absent from the
  resulting attendance, while `accepted`, `tentative`, `needsAction` and a missing RSVP are all
  present.
- **AC10 — unit, `test/guards/meeting-identity-no-similarity.test.ts`:** the linking module does not
  reference `titleSimilarity` or any threshold constant — the guard that keeps the dormant comparator
  dormant, mutation-verified by re-adding the reference.
- **AC11 — data-mechanics, same file:** a `unknown`-source row already present for a member is
  upgraded to `calendar` when the calendar claim arrives, and a later `llm` pass does **not**
  downgrade it.

**Falsifier for the slice:** if any two notes are linked without sharing a normalised identifier, the
design has failed, whatever the outcome looks like. And if AC7 is deleted, nothing else in the suite
notices — which is why it asserts an absence and is mutation-verified against its own gate.

## 5. Deliberately not in this slice

- **Time-window + shared-participant matching (MTGATT-3).** 42 items carry a real timestamp, so it is
  feasible — but the window and the tie-breaks should be sized from paired data that does not exist
  yet. Guessing a window now is the "unmeasured constant" failure this workstream has retired twice.
- **Non-member attendees (MTGATT-4).** `member_id` is a NOT NULL FK, so Pete, Anusheel and Rob still
  cannot be recorded, whatever the calendar says. Provenance (§3.3) is the natural place to hang them
  later; it is not done here.
- **Correcting a survivor's `occurred_at` from the calendar's exact start.** The calendar knows the
  true local date and the transcript's UTC-derived one can be a day off (§0). That is a *mutation* of
  an existing note's field, with its own rules, and it is not folded into a slice about attendance.
- **Any UI change.** The provenance columns are written and readable; nothing renders them yet, and
  this spec claims nothing about the Meetings page.
