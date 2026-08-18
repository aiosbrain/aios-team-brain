# Credit a person on someone else's meeting — MTGATT-3

**Status:** spec, revised after TWO review rounds (round 1 **DECLINE**, round 2 **BLOCKED**). §6
records what each folded, and the two findings that did not survive re-derivation.
**Build with:** opus / high — it decides whether a named colleague appears on a meeting they may not
have attended, and it hides one note behind another. Both are the failure classes MTGATT-1 and
MTGATT-2 were opened for.

**Deps: MTGATT-2 (PR #598), not yet merged.** This stacks on `feat/meeting-attendance-identity` and
consumes `lib/meetings/event-identity.ts` (kind-qualified `eid:` / `uid:` keys, `seriesKeys`) and the
RSVP filter. PR base is that branch; retarget to `main` after it merges.

---

## What and why

**What:** when a person pushes a calendar event that carries the same identifier as a meeting already
in the system, the two are recognised as one meeting: the person's attendance is **added** to the
existing note, both submitters are credited, and the bodyless event stops showing as a second meeting.

**Why it matters — the operator's question, in their words:** *"John may be uploading meetings and if
they do they're gonna come saying just John Ellison but I would have already also been in that
meeting… my calendar is the only way we could do that."* Today those are two separate meetings on the
Meetings page and the second person is credited on neither. This is the mechanism that fixes it, and
it is the only one available: for a meeting John uploads, every signal that credits somebody else is
either that person asserting something themselves, or an inference from John's artifact (§1).

**The operator's ruling this implements (2026-08-18):** a declined invitee was not there — shipped in
MTGATT-2. An invitee who accepted **and pushes the event in their own daily update** was there. The
**push is the assertion**; the RSVP only vetoes, because people attend meetings they never RSVP to.

## Scope

**In:** grouping live notes by exact event key, the survivor rule, the additive attendance claim,
the two refusals, and the tick wiring.

**Out, deliberately:** per-attendee provenance columns (**MTGATT-4** — this slice writes attendance
rows indistinguishable from any other, which is precisely why MTGATT-4 exists); non-member attendees
(**MTGATT-5**); any fuzzy matcher — time windows, title similarity, conference links; any change to
the transcript-overlap merge.

---

## 0. Terrain, measured before designing (prod, read-only, 2026-08-18)

| | |
|---|---|
| calendar-source items | **0** |
| items carrying `calendar_event_id` / `ical_uid` / `conference_url` | **0 / 0 / 0** |
| live meeting notes / folded as duplicates | **66 / 6** |
| granola transcripts with named speaker labels | 41 of 63 — **but the names are the recorder plus a generic `Speaker`** |

**This slice ships ahead of its data. Review round 1 declined it on exactly that ground, and the
operator overrode the decline after being told the number** — so it is built, with the reviewer's
condition attached rather than dismissed: the first real pair must be confirmed with
`scripts/meeting-pairing-report.ts` before anyone treats the join as working.

What has changed since that decline: the producer emits the keys, and the operator has ruled on the
product question so the join is needed under every reading of it. What has **not** changed: a green
suite here proves the RULE, not the wiring to reality.

## 1. Why there is no cleverer signal

Ranked, and each one checked rather than assumed:

1. **The person's own calendar push** — first-person, exact once an identifier is shared. This slice.
2. **They recorded the meeting too** — very strong (their recorder was in the room). **Already
   works**: the transcript-overlap merge credits both submitters; 6 meetings folded all-time.
3. **Speaker diarization** — would be strong, and is **unusable here**: 41 of 63 transcripts carry
   named labels, but the names are `John Ellison` (the recorder) and a generic `Speaker`. Zoom/Gong/
   Otter carry real per-speaker names; prod has none of those sources.
4. **Addressed in the second person** in the transcript — model-inferred, and the path that produced
   MTGATT-1's invented attendees. A suggestion, never an assertion.
5. **Meet/Zoom attendance reports** — actual join/leave records, the *only* true verification of
   presence. No connector exists.

So the ceiling is honest and worth stating: **this cannot catch someone who accepted, pushed their
calendar, and then skipped the meeting.** Only (5) closes that.

## 2. The join

**Group live notes into CONNECTED COMPONENTS over shared `eventKeys` — and over nothing else.**

Components rather than one group per key, because round 2 built the case that breaks per-key
grouping: A carries `eid:x`, B carries **both** `eid:x` and `uid:x@google.com` (the ordinary shape — a
UID also emits its bare event id), C is the transcript carrying only the uid. Per key, `eid:x` is
processed first, folds B into A, and C — the note with the body — is stranded as a separate meeting
while a bodyless note survives. That is exactly the outcome §2.1 exists to make unreachable, arriving
through the grouping layer.

- **Never** `conferenceKey`: a Zoom Personal Meeting ID is reused for every meeting its owner hosts.
- **Never** `seriesKeys`: every occurrence of a recurring event shares one `iCalUID`.
- **Never** `titleSimilarity`: two same-day meetings titled with a person's name score 1.0.
- **Never date-pre-filtered.** A 19:00 PDT meeting is 02:00Z the next day, so a calendar event and its
  transcript legitimately carry different `occurred_at`. Requiring the same date would silently drop
  exactly the evening meetings, and look like the feature simply not matching.

### 2.1 The survivor is chosen by CONTENT, not arrival order

"Has a body" means `body.trim().length > 0`. A whitespace-only item is bodyless — otherwise a
producer emitting `"\n"` for an invite would become the content-bearing survivor and hide the real
transcript, which is the exact hazard this rule exists to remove.

| the group | outcome |
|---|---|
| exactly one note has a body, the rest do not (N ≥ 2 pushes of one event) | **the body wins**, whichever arrived first; every bodyless member folds into it |
| no note has a body (two people pushed the same event) | the **earliest-created** survives — deterministic, so processing order cannot change the result |
| **two or more notes have bodies** | **REFUSE.** Two transcripts of one meeting are the overlap merge's job; folding one away here would hide content |

That single rule removes MTGATT-1's deferred hazard structurally rather than by ordering the pushes:
a transcript arriving after its calendar event can never fold into the bodyless note and lose its
text, because it is the one with the body.

### 2.2 The second refusal: a day apart is not the same meeting

Members of one group whose `occurred_at` differ by **more than one day** are not linked.

This is a **veto applied AFTER an identifier match, never a filter that decides which notes are
compared** — and the review was right that calling it "not a date filter" was too cute. It is one,
narrowly: it can only ever remove a link, never create or find one, so it cannot reintroduce the
failure §2 forbids (dropping the evening meetings before they are ever compared). One day of slack is
exactly the timezone case; a fortnight is the residual series case `seriesKeys` cannot catch — a
producer sending only `ical_uid`, with no instance suffix and no `recurringEventId`, is
indistinguishable from a single event.

**An unknown `occurred_at` REFUSES the link** — the reverse of this spec's first draft, and round 2
is why. Its case: an undetectable weekly series where the transcript is dated 11 Aug and the calendar
event for 18 Aug carries no date at all. Skipping nulls switches the veto off precisely where it is
the only defence. Refusing costs little (a calendar event is dated by its `start`, a granola
transcript by `created`, and `deriveOccurredAt` has three fallbacks, so an undated note is rare) and
it fails in the safe direction: a duplicate meeting is visible and fixable, two meetings fused into
one are neither. Vetoes are counted by reason, never silent.

### 2.3 It is a claim, not a merge

The link **adds**: attendance rows from the folded note, and its submitter. It **does not** rewrite a
body, re-ingest an item, retire an item, or call a model — all of which `mergeIntoMeetingNote` does.
The folded note gets `merged_into` so one meeting shows once; that is one reversible column, and the
item behind it is untouched.

Idempotent by construction: a folded note is excluded from the next scan (`merged_into is null`), and
attendee/submitter writes are upserts. **Every write goes through `lib/meetings/notes.ts`** — the
audited single writer for all three tables (`test/guards/single-writer-meeting-notes.test.ts`).

**One fix this slice must carry, because it makes an existing hazard reachable.** The overlap merge
runs in the same tick, right after (`from-items.ts`), and `mergeIntoMeetingNote` propagates only two
submitter ids (`merge.ts:278-279`). So a survivor that has just ACCUMULATED submitters from a linked
calendar event can lose them when it is itself folded into a richer transcript moments later. MTGATT-2
recorded that as a latent defect; this slice is what makes it fire, so it is fixed here:
`backfillMergeDuplicateMeetings` passes the folded note's **full** submitter set, not just its
`submitted_by`.

**A pushed calendar event must also trigger the immediate backfill.**
`shouldScheduleMeetingBackfill` currently returns `isMeetingTranscript(kind, source)`, which is false
for a calendar event (`kind:'artifact'`), so today it waits up to a scheduler tick. The whole point of
this slice is that someone pushes their calendar and is credited; a silent half-hour asymmetry between
the two producers is the kind of thing that reads as "it didn't work".

## 3. Where it runs

`backfillMeetingNotesFromItems`, after note creation and **before** `backfillMergeDuplicateMeetings`,
so a linked calendar note is already folded and cannot be reconsidered by the overlap merge.

Bounded: one metadata query for live notes (capped at 500 newest), one for their items' `frontmatter`
+ a body-emptiness flag. At today's 66 notes that is two small reads; with zero identifiers it forms
zero groups and returns immediately. The cap is stated in code, because an unbounded per-tick scan is
how `TICKSTALL-1` starved the chain.

## 4. Acceptance

- **AC1 — unit, `test/meetings-identity-link.test.ts`:** grouping is by exact event key only — notes
  sharing a `conferenceKey`, a `seriesKey`, or an identical title but no event key form **no** group.
- **AC2 — unit, `test/meetings-identity-link.test.ts`:** the survivor is the note with a body, for
  both arrival orders; with no bodies it is the earliest-created; with **two** bodies the group is
  refused; with one body and **two** bodyless members, both fold into the body one.
- **AC3 — unit, `test/meetings-identity-link.test.ts`:** a whitespace-only body counts as **no** body.
- **AC4 — unit, `test/meetings-identity-link.test.ts`:** a component spanning more than a day is
  vetoed, including when only its widest pair exceeds the span; one spanning exactly a day (the
  timezone case) is **linked**; an unknown date refuses. The middle case is the inverse half — it is
  what stops the veto quietly becoming the date pre-filter §2 forbids.
- **AC4b — unit, `test/meetings-identity-link.test.ts`:** a three-note component bridged by a note
  carrying two keys folds into the one with the body, and two components sharing no key are not
  bridged.
- **AC5 — data-mechanics, `test/datamechanics/meeting-identity-link.datamechanics.test.ts`:** a
  transcript pushed by one member and a calendar event pushed by another, sharing a
  `calendar_event_id`, end as **one live note — the transcript's** (asserted by its `source_item_id`
  and its intact body, not by a uuid), carrying the calendar member as an attendee and both as
  submitters.
- **AC6 — data-mechanics, same file:** the identical pair created in the **reverse order** produces
  the same outcome — survivor identified the same way, body intact. Order-independence asserted, not
  argued.
- **AC7 — data-mechanics, same file:** the folded note is hidden (`merged_into` set), its **item
  still exists**, and a second tick does **not** resurrect it as a new note.
- **AC8 — data-mechanics, same file:** running the tick twice is a no-op the second time — attendee
  count, submitter count and survivor unchanged.
- **AC9 — data-mechanics, same file:** two notes with **no shared identifier** are both still live
  after the tick, even with identical titles on the same date. Mutation-verified against its own gate.
- **AC10 — data-mechanics, same file:** two notes that both have bodies and share an identifier are
  **not** folded by this path, and both keep their text.
- **AC11 — data-mechanics, same file:** a survivor that has just accumulated a submitter from a linked
  calendar event, and is then folded by the overlap merge in the SAME tick, **keeps that submitter on
  the final survivor** — the stranding hazard §2.3 fixes, asserted end to end rather than at the unit
  that changed.
- **AC12 — unit, `test/meetings-schedule-backfill.test.ts`:** a pushed calendar event schedules the
  immediate backfill for every calendar source and either `kind`; an unchanged re-push still does
  not, and a non-calendar artifact still does not — the two inverse halves that stop the widening
  becoming "schedule on everything".
- **AC13 — unit, `test/guards/meeting-identity-not-a-join-key.test.ts` (existing, extended by
  coverage):** the linker references no conference key, no series key and no `titleSimilarity` — it
  is under `lib/`, which that guard already walks.
- **AC14 — unit, `test/guards/single-writer-meeting-notes.test.ts` (existing):** stays green — the
  linker writes `meeting_notes` / `meeting_note_attendees` / `meeting_note_submitters` only through
  `lib/meetings/notes.ts`.

**Falsifier:** if any two notes are linked without sharing a normalised event key, the design has
failed regardless of how right the outcome looks. And if AC9 is deleted, nothing else in the suite
notices — which is why it asserts an absence and is mutation-verified.

## 5. Deliberately not in this slice

- **Per-attendee provenance (MTGATT-4).** A calendar-derived attendee is written exactly like a
  model-derived one, so a wrong claim is not yet diagnosable and the UI cannot say *"from Chetan's
  calendar"*. This is the strongest argument for doing MTGATT-4 next, and the operator has been asked
  whether invitees should be demoted to a weaker class at the same time.
- **Non-member attendees (MTGATT-5).**
- **Correcting the survivor's `occurred_at`** from the calendar's exact start, even though the
  calendar knows the true local date and the transcript's UTC-derived one can be a day off.
- **Any use of the pairing report inside product code.** It stays a hand-run instrument.

## 6. Review round 1 — what it changed, and what it got wrong

**DECLINE**, and the folds are in §0/§2 above. The blocker it led with — *ships ahead of its data* —
is the same one that correctly killed this slice inside MTGATT-2; the operator overrode it after being
shown the number, so it is recorded, not argued away, and the reviewer's condition (confirm the first
real pair with the instrument) is kept.

**Folded:**

- *"Claim, not merge" makes an existing hazard reachable.* Correct, and the sharpest finding: the
  overlap merge runs in the same tick and propagates only two submitter ids, so submitters this slice
  ACCUMULATES on a survivor can be stranded when that survivor is itself folded. Fixed here (§2.3),
  with AC11 asserting it end to end.
- *N-way groups and whitespace bodies* — both now specified (§2.1), with ACs.
- *Null-date policy and the "not a date filter" claim* — the claim was too cute; §2.2 now says what it
  actually is and why that is still safe, and states the null policy.
- *AC5's "same surviving note id" across two scenarios was ill-formed* — uuids differ by construction.
  Survivor identity is now asserted by `source_item_id` and body.
- *Counters, or "refusal is counted" is vacuous* — the summary gains them, and the deep-equal test in
  `meeting-notes-backfill.datamechanics.test.ts` will redden and be updated.
- *A calendar push does not trigger the immediate backfill* — true (`shouldScheduleMeetingBackfill`
  requires `kind='transcript'`), and fixed here rather than left as a silent half-hour asymmetry.

**Did NOT survive re-derivation, with evidence:**

- *"A team-tier calendar note folding into an external transcript leaks attendance externally."*
  It cannot. Meeting notes are team-tier by construction (`notes.ts:16-27`), and the timeline's whole
  meetings leg is gated on `canSeeMeetingNotes(tier)` (`work-timeline.ts:672-675`), which is false for
  external. No attendee row this slice writes is readable by an external viewer.
- *"It skips the invariants `mergeIntoMeetingNote` learned the hard way — merge-owned item, access
  floor, action-item remap, tombstone."* Those exist because that path WRITES A NEW BODY into an item:
  the merge-owned path stops a connector re-sync clobbering merged text, the floor stops merged text
  widening tier, the remap follows action items to the new item. This slice writes no body and creates
  no item, so each has nothing to protect. The one consequence that did carry over is the submitter
  stranding, folded above.

## 7. Review round 2 — attacking the fold

**BLOCKED**, on the fold rather than the original — which is the point of a second round.

- **HIGH, and it was real: per-key grouping stranded the transcript.** Reproduced against the module
  as written (A `eid:x` / B both keys / C the transcript on `uid:` → survivor A, C left live). Now
  connected components, §2 and AC4b.
- **MEDIUM, accepted: the null-date policy reopened the series hole it was written to close.** §2.2
  is reversed.
- **MEDIUM, deferred with a destination: `getMeetingNote` does not filter `merged_into`,** so a
  direct URL to a folded note still renders a dead-end detail page, and the meeting server actions
  resolve by id without excluding folded notes. That is **pre-existing** — the overlap merge has set
  `merged_into` since MTGATT-1 and produces the same page — and this slice increases how often it can
  be reached without changing its nature. Fixing it is a routing/product decision (should a folded
  note redirect to its survivor, or 404?), so it is **MTGATT-6**, not folded here.

It also re-checked and **confirmed both round-1 refutations** — no external tier leak, and no missing
merge invariant — and confirmed the submitter fix does not break the overlap merge's contract
provided `authorFallbackMemberId` is not credited as a submitter. It is not: only the folded note's
real submitter rows and its `submitted_by` are passed.
