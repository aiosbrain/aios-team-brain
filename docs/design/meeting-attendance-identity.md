# Declines, identity, and the measurement before the match — MTGATT-2

**Status:** spec, revised twice. Two cold plan reviews returned **DECLINE** on the two earlier
versions; §6 records what each one killed and why the survivor is this small.
**Build with:** opus / high — it touches the rule that decides whether a named colleague is recorded
as having attended a meeting, which is the exact failure MTGATT-1 shipped to remove.

**Deps: none blocking.** MTGATT-1 (`c10d9e6`) is merged; this slice narrows one edge of the calendar
path and lays the plumbing a later join needs.

---

## What and why

**What:** three things, none of them dormant, none of them a matcher.

1. **A calendar invitee who DECLINED is not an attendee.** Today every invitee on a pushed event is
   credited, including one whose RSVP says they would not be there.
2. **The producer emits the event's identity** (`calendar_event_id`, `ical_uid`, `conference_url`) so
   that a join has an exact key to work with when it is built.
3. **An instrument** that counts how many meeting pairs actually share each of those keys, split by
   source, so MTGATT-3's matching rule is fitted to measured pairs rather than a guessed window.

**Why it matters:** the operator starts pushing calendar events this week, and asked for the opposite
of a guess — "we don't want to misassociate me with a meeting that I wasn't actually at, especially
for larger teams." A declined RSVP is the one place the current code records exactly that, and it
does so with the credibility of the structured path rather than the visible sloppiness of a model.

**What this explicitly does NOT do:** decide whether *being invited* should count as attending at all.
That is a live product question (§4) and it belongs to the operator, not to this slice.

## Scope

**In:** the decline rule and the RSVP parsing under it; the identity normaliser; the producer-side
frontmatter; the pairing instrument; the guard that keeps a conference link out of any matching path.

**Cut by review, each with its destination** (§6 has the reasoning):

- the calendar↔transcript **linker** → **MTGATT-3**, built from what the instrument measures;
- **conference URL as a join key** → nowhere, ever. Measured, never matched on;
- **per-attendee provenance columns** → **MTGATT-4**, when a second source exists to distinguish;
- **"the pusher is the only attendee"** → withdrawn entirely (§6, round 2). It reversed a shipped,
  tested product contract;
- non-member attendees → **MTGATT-5**; `titleSimilarity` stays dormant and untouched.

---

## 0. Terrain, measured before designing (prod, 2026-08-18)

| | |
|---|---|
| calendar-source items | **0** — nothing has exercised the calendar path in production yet |
| granola transcript items | **63**, of which **62** carry `granola_id`, **45** carry `participants` |
| granola items with a full ISO timestamp in `created` | **42** (e.g. `2026-08-12T01:14:01.689Z`) |
| live meeting notes / attendee rows | **60** / **81** |
| items carrying any calendar identifier | **0** |

**0 calendar items** is why the decline rule is free to land: no stored attendance changes, so this is
a correction arriving *before* the first wrong row rather than a migration of wrong ones.

**0 identifiers** is why there is no linker here. A join needs the key on **both** sides, and every
transcript in prod comes from a producer on another person's machine (`1-inbox/transcripts/…`,
`frontmatter.status: ingested`) which emits `type/access/created/source/granola_id` and nothing else.
A linker shipped now could not fire, could not be validated against a real pair, and would read as
"attendance is fixed" while the thing the operator asked for — being credited on someone else's
meeting — still did not happen.

**What is NOT measured, and is not claimed to be:** the shape of Granola's nested
`google_calendar_event`. Granola's local cache (`granola.db`) and token file are both encrypted on
this machine and the calendar CLI lives on another box, so the field list in §2 comes from Google's
documented Events resource plus our own producer's existing use of `.start.dateTime`
(`~/scripts/granola_sync.py:109-116`) — not from a payload anyone here has read. That is an adapter
risk, not a solved problem: the parser is tolerant, every shape is behind one tested function, and
**the first real sync must report which spelling actually arrived** (§3) rather than assuming the
guess held.

## 1. A declined invitee is not an attendee

The shipped rule is that a shared calendar event credits **every** member attendee, and that is
deliberate: the point of the feature is that a meeting Bob only attended is still a record of Bob's
work (`test/datamechanics/calendar-meetings.datamechanics.test.ts:67-113`). This slice does not touch
it.

The one case it gets wrong is the person whose own RSVP says they would not be there. Crediting them
is the MTGATT-1 failure — a real teammate recorded in a meeting they were not in — with better
paperwork attached, and a decline is that person's own first-person statement about themselves, which
is the strongest evidence this system ever gets.

**Only `declined`, deliberately.** `needsAction`, `tentative`, an unrecognised value and a missing
field all count as present. "No RSVP" is the overwhelmingly common shape — Granola's nested event
carries none, and the gog puller's `{id, display, role}` shape has no RSVP field at all — so
excluding on "not accepted" would empty the attendee list of nearly every event and be
indistinguishable from a broken feature. The tolerant direction here keeps a real attendee; the
strict one silently deletes them.

**The removal is counted** (`BackfillSummary.calendarDeclined`). This is the only place attendance is
deliberately *taken away*, and a removal nobody can see is indistinguishable from a parser that
quietly stopped matching.

## 2. The producer contract

An item may carry any of these; the brain requires none and behaves exactly as today without them.
Several spellings are accepted because this is a cross-repo boundary and a reasonable producer choice
must not silently yield an unlinkable meeting — the lesson already written into `from-calendar.ts`:

```
calendar_event_id | calendarEventId | event_id | gcal_event_id     → eid: key
ical_uid | icalUID | iCalUID                                        → uid: key
conference_url | hangout_link | hangoutLink | meeting_url           → conference key (measured, never joined)
google_calendar_event: { id, iCalUID, hangoutLink, conferenceData } → the nested shape, same keys
```

**Keys are qualified by kind** (`eid:` / `uid:`). An unqualified normaliser that stripped
`@google.com` would make the UID `Foo@google.com` and a bare producer key `foo` the same string — a
second, unproven merge rule smuggled in beside the real one. Google's documented derivation
(`iCalUID = <eventId>@google.com`) is instead emitted as an **explicit extra `eid:` key**, so the
equivalence is visible in the key set and measurable rather than baked invisibly into a normaliser.

Normalisation is trim + lowercase and nothing else; a URL keeps host + path (query strings carry
per-person `?authuser=` and passcodes). A value under 8 characters is discarded — `""`, `"-"` and
`"none"` are not identities. **A recurring instance keeps its suffix** (`<base>_20260811T090000Z`):
both attendees' copies carry it, and stripping it would fuse a whole series into one meeting.

**Implemented in this operator's own sync**, which today drops all of it: `~/scripts/granola_sync.py`
reads the fields off `google_calendar_event`, `~/scripts/granola_to_obsidian.py` persists them in the
vault note, and `~/scripts/granola_to_aios_brain.py` forwards them into the staged frontmatter that
`aios push` sends. Documented in `docs/ARCHITECTURE.md` so the other producer can emit the same keys.

**Known limit, not papered over:** `cmd_save` skips a meeting it has already saved
(`granola_to_obsidian.py:195-209`), so the identity fields appear on **newly synced meetings only**.
Backfilling the existing vault notes is a separate pass, not done here.

## 3. The instrument

`scripts/meeting-pairing-report.ts` — read-only, run by hand, importing the *same* normaliser as the
product code rather than a mirrored copy.

It reports, per team: how many notes of **each source** carry an event key, a conference key and a
full timestamp; how many **pairs** share an event key, split into **CROSS (calendar ↔ transcript)**
and same-source; for each pair, whether a naive same-date rule would have found it and how far apart
the two timestamps are.

The CROSS number is the only one MTGATT-3 can be fitted to — "12 notes share a key" is an adjacent
number if all twelve are transcripts sharing keys with each other. Zero is always printed **next to
its denominators**, so "no pairs yet" cannot be mistaken for "the parser matched nothing", which is a
failure this workstream has already shipped once.

## 4. The product question this slice deliberately does not answer

**Should being on an invite count as attending?**

The first review's blocker was that a twelve-person invite writes twelve attendance rows, including
people who never joined. That is true, and it is also the shipped feature working as designed. The
two readings are:

- **as built** — an invite is the best structured evidence available, and under-crediting real
  attendance is the worse error (this is why the feature exists);
- **the alternative** — only self-assertions count: a person's own calendar push credits them, and
  everyone else needs their own push or a transcript that names them. It can never invent an
  attendee, and it scales by addition; it also under-credits every meeting where only one person
  pushes, and it would delete the tested behaviour above.

Deciding this is the operator's call, and reversing a shipped contract inside a slice about RSVPs
would be exactly the silent scope drift this process exists to stop. **Recorded here, raised in the
PR, not decided.**

## 5. Acceptance

- **AC1 — unit, `test/meetings-calendar-rsvp.test.ts`:** an invitee whose RSVP is `declined` is
  dropped, and `accepted`, `tentative`, `needsAction`, a missing RSVP and an *unrecognised* value are
  all kept — the inverse half, which is what catches a filter that widens past `declined`.
- **AC2 — unit, `test/meetings-calendar-rsvp.test.ts`:** the RSVP is read from `responseStatus`,
  `response_status`, `rsvp` and `status`, case-insensitively, and an attendee shape carrying none
  (the gog puller's) parses to `rsvp: null` rather than failing.
- **AC3 — data-mechanics, `test/datamechanics/meeting-calendar-rsvp.datamechanics.test.ts`:** the
  declined member has **no row** in `meeting_note_attendees` and **no meeting** on their timeline
  card, while a non-declined invitee has both — asserted against the DB, because the failure is a
  wrong row, not a wrong return value.
- **AC4 — data-mechanics, same file:** every non-declined invitee is still recorded — the shipped
  "credit every attendee" contract, re-asserted against this change so a widening reddens here.
- **AC5 — data-mechanics, same file:** the count of removed invitees is exact, including a
  **non-member** decline — the metric is "invitees the rule removed", not "members it removed".
- **AC6 — data-mechanics, same file:** an event where everyone declined produces a note with zero
  attendees and does **not** fall through to the model — MTGATT-1's no-fallthrough rule still holds.
- **AC7 — unit, `test/meetings-event-identity.test.ts`:** every accepted spelling in §2 (flat,
  camelCase, nested) yields the same normalised key; a UID also yields its bare `eid:`; an `eid:` can
  never equal a `uid:`; a recurring instance suffix is kept; short junk yields no key.
- **AC8 — unit, `test/meetings-event-identity.test.ts`:** a conference link normalises past its query
  string and case, two different rooms stay different, and a conference link never becomes an event
  key.
- **AC9 — unit, `test/guards/meeting-identity-not-a-join-key.test.ts`:** no module outside the parser
  and the report references `conferenceKey`; the parser touches no DB and no matching helper; the
  report calls no write method. Mutation-verified by adding each forbidden reference.
- **AC10 — producer, `~/scripts/test_calendar_identity.py`:** extraction from a synthetic
  `google_calendar_event` yields the three keys, and a document without one changes the emitted
  frontmatter not at all.

**Falsifier for the slice:** if a meeting a person declined shows up as their work, the rule is not
implemented, whatever the unit tests say — which is why AC3 asserts the timeline card and not just
the parser. And if AC4 is deleted, nothing else notices that the filter has swallowed `needsAction`.

## 6. What the two reviews killed

**Round 1 — DECLINE.** Two blockers, both re-derived against the code before being accepted.

- *The safety premise was a claim about a model I had not built.* The spec asserted "each person only
  asserts about themselves" while the code recorded every invitee (`from-items.ts:238-242`).
- *Conference URL cannot be an identity.* A Zoom Personal Meeting ID is reused for every meeting that
  person hosts and one Meet room serves a whole recurring series, so exact-matching on it fuses
  unrelated meetings. Now measured, never matched on, and pinned by AC9.
- *Resequence: the linker was inert.* Accepted; it is MTGATT-3.

**Round 2 — DECLINE, on the fix for round 1.** The rewrite made the pusher the only attendee. That
was an over-correction, and the review caught it with the evidence:

- *It reverses a shipped, tested product contract.* `calendar-meetings.datamechanics.test.ts:67-113`
  asserts that a non-pushing attendee is credited, with the reason written in the test — "Bob pushed
  nothing and wrote nothing that day… the meeting is still a record of work he did". Verified before
  folding.
- *"The pusher" is not even a stable handle.* `items.member_id` is the resolved AUTHOR, not the
  pushing account (`lib/ingest/index.ts:422` + the route's frontmatter-derived `authorMemberId`), and
  it is null for connector pushes — so "record the pusher" would sometimes record nobody and
  sometimes record the wrong person.
- *It would have deleted a live provenance signal.* The timeline distinguishes attendance from a
  `via: "submitter"` fallback (`lib/dashboard/work-timeline.ts:721`); making the pusher an attendee
  erases that distinction.

The rule was withdrawn to §4 as a product question. What survived is the part neither review
disputed: a decline is not attendance.

**Findings recorded rather than fixed here**, because the code they attack is no longer in this slice:
the transcript merge propagates only two submitter ids (`merge.ts:278-279`) and can strand an
accumulated submitter set; the pg adapter's `upsert` updates every non-conflict column
(`query-builder.ts:392`), so MTGATT-4's provenance column needs conditional-rank SQL rather than a
naive upsert.

## 7. Deliberately not in this slice

- **The linker (MTGATT-3).** Until it lands, a pushed calendar event still creates its **own** note
  beside the transcript's, and the operator's original ask — being credited on John's meeting — is
  **not delivered by this slice**. This spec claims nothing else.
- **Per-attendee provenance (MTGATT-4).** **Non-member attendees (MTGATT-5).**
- **Correcting a note's `occurred_at` from the calendar's exact start**, and any UI change.
