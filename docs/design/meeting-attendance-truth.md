# Meeting attendance from stored truth, not inference — MTGATT-1 / AIO-962

**Status:** spec, pre-review.
**Build with:** opus / high — a correctness fix on a surface the owner reads daily, where the current
failure invents named colleagues, plus a merge path that must not destroy existing notes.

**Deps: none.** `lib/meetings/from-calendar.ts` and its wiring in `lib/meetings/from-items.ts` are
already merged; this slice consumes them and does not wait on anything.

---

## What and why

**What:** meeting attendance stops being inferred by a language model whenever the producer already
told us who was there, and a pushed calendar event stops creating a second meeting note beside the
transcript of the same meeting.

**Why it matters:** the current inference invents named colleagues on meetings the owner reads. It
put two real teammates in a meeting neither attended, and the roster filter guarantees every such
error names someone plausible. It also drops real attendees, so the per-attendee timeline under-credits
people for work they did. The information needed to be right is already stored on the item.

## Scope

**In:** the attendance precedence (calendar → participants → model), the rewritten fallback prompt,
the calendar↔transcript merge, and a reporting backfill for existing notes.

**Cut, deliberately:** non-member attendees (a NOT NULL FK to `members`; see §5), and any change to
transcript ingestion or chunking.

---

## 0. The bug, reproduced on live data

The owner reported that "Content creation strategy session" (2026-08-11) lists **Fatma** and **Abe
Doe** as attendees when neither was there. Confirmed, and the mechanism is exact.

`lib/meetings/llm-extract.ts` asks a model for *"the full names of every person who appears to have
attended or spoken"*, then `matchAttendees` keeps only names that resolve against the member roster.
It has **no representation of "present" versus "discussed"**.

In that transcript both appear only in the third person, and explicitly as **absent**:

> *"it would be amazing one day to get **Abe**, who's in Germany… **Can we get him on Zoom?**"*
> *"And **Fatma and I are gonna get one** here"*

The transcript's only speaker label is `**John Ellison:**`.

**Two properties make this worse than a normal hallucination:**

1. **The roster filter concentrates the error onto real teammates.** Carol, Pranita, Yana and Chayton
   are mentioned too and were dropped for not being members. So every false attendee is, necessarily,
   someone who plausibly *could* have been there.
2. **Stefan escaped by one letter.** Mentioned three times; the roster spells him `Stephan Doe`, so
   `matchAttendees`'s first-name fallback compared `stefan` ≠ `stephan`. A spelling coincidence is the
   only reason there were two false attendees rather than three.

## 1. The truth is already stored, and ignored

`items.frontmatter.participants` carries Granola's own participant list. For this meeting:

```
"participants": "[John Ellison]"
```

Exactly right — and overridden by a guess. Present on **42 of 63** granola transcripts.

**Measured comparison, Granola's list vs what we recorded:**

| meeting | granola says | we recorded |
|---|---|---|
| Content creation strategy | John | **+ Abe, + Fatma** |
| Meet with Alex & Mira | John, Alex, Mira, Daniel | **John only** |
| John + Priya | John, Priya | **John only** |
| Onboarding Stephan | John, Chetan, Stephan, Fatma | **John, Stephan** |
| Aios Event at home | John, Fatma | **John, + Chetan, − Fatma** |

**The inference is wrong in both directions** — it invents attendees *and* drops real ones. Across
prod, 44 of 85 attendee rows name someone who never appears as a speaker label.

**A correction to my own first analysis, recorded because acting on it would have been worse than the
bug.** "Never appears as a speaker label" is NOT a usable oracle for absence: these Granola exports
label only the recorder, and everyone else's turns are merged into that block unlabelled. So
"Onboarding Stephan on AIOS" shows Stephan never speaking while he is obviously the point of the
meeting. A fix built on speaker labels would have stripped real attendees from most meetings — the
opposite error, and larger.

## 2. Calendar events cannot merge with transcripts — by construction

`lib/meetings/from-calendar.ts` already resolves attendance **by email, exactly, with no model**, and
`from-items.ts` already turns pushed calendar events into meeting notes. That half is built.

What does not work is the join. `findDuplicateMeeting` (`lib/meetings/merge.ts:105`) decides two notes
are the same meeting by **text overlap of their bodies**, and skips any candidate whose item has no
body (`merge.ts:139`, `if (!item?.body) continue`). **A calendar event has no body by design** — its
own module header says so.

So a pushed calendar event and the Granola transcript of the same meeting can **never** merge. They
become two notes for one meeting: one with correct attendance and no content, one with content and
invented attendance.

This is the owner's stated goal — *"intelligently merge calendar events from someone's daily update
with meetings that are submitted"* — and it is currently impossible, not merely unimplemented.

**No calendar events exist in prod yet.** The owner will begin pushing them daily. So this slice
must be correct against data that does not exist yet, which raises the bar on tests: the
data-mechanics tier has to construct the shapes rather than observe them.

---

## 3. The design

### 3.1 Attendance precedence — structured first, model last

One ordered resolution, applied wherever a meeting note's attendees are written:

| rank | source | resolution |
|---|---|---|
| 1 | **calendar attendees** (`frontmatter.attendees`, emails) | exact, by email → member |
| 2 | **`frontmatter.participants`** (Granola's list) | exact/normalized name → member |
| 3 | **LLM inference** | only when neither exists |

Ranks 1 and 2 are facts the producer asserted. Rank 3 is a guess and is now clearly labelled as the
last resort rather than the default.

**A structured list that resolves to nobody does NOT fall through to the model.** If Granola says
`[Alex Marchetti]` and Alex is not a member, the answer is "no member attendees recorded", not "ask a
model who else might have been there". Falling through would reintroduce exactly the failure this
fixes, on the meetings most likely to involve outsiders.

### 3.2 The fallback prompt, rewritten

Only reached when no structured list exists. Two changes, both aimed at the observed failure:

- Require **evidence of participation** — the person speaks, is addressed, or is recorded as present.
- **Explicitly exclude** people discussed in the third person, named as absent, or proposed for a
  future meeting. The prompt will carry a negative example drawn from this incident, because that is
  the shape the model actually got wrong.

### 3.3 Calendar ↔ transcript merge

`findDuplicateMeeting` gains a second, **structural** matcher used when either side has no body:

- same `occurred_at`, **and**
- title similarity above a threshold, **or** an overlapping attendee set with a compatible time.

On a match, the calendar event does not create a second note — it **enriches** the transcript's note:
attendance is replaced by the calendar's exact set (rank 1), content stays the transcript's.

**Direction matters and is stated:** the transcript note survives as the primary; the calendar event
folds into it. The reverse would discard the content.

### 3.4 Backfill

A one-shot pass re-resolves attendance for existing notes under §3.1 and rewrites rows where the
structured truth disagrees. It **reports** every change rather than applying silently, because it is
removing named people from meetings the owner has already read.

---

## 4. Acceptance

- **AC1 — unit, `test/meetings-attendance-source.test.ts`:** the precedence function returns rank-1
  calendar attendees when present, rank-2 participants when only those exist, and only calls the
  model when neither does.
- **AC2 — unit, `test/meetings-attendance-source.test.ts`:** a structured list that resolves to zero
  members yields zero attendees and **does not** invoke the LLM fallback.
- **AC3 — unit, `test/meetings-attendance-source.test.ts`:** `"[John Ellison]"` — the real stored
  shape, a bracketed string and not JSON — parses to exactly one name.
- **AC4 — unit, `test/meetings-llm-extract.test.ts`:** the rewritten prompt names the exclusion of
  third-person mentions, and the parser still drops unmatched names.
- **AC5 — data-mechanics, `test/datamechanics/meeting-attendance.datamechanics.test.ts`:** the real
  2026-08-11 shape (participants `[John Ellison]`, a transcript mentioning Abe and Fatma) yields
  **exactly John Ellison** — the reported bug, as a red-then-green test.
- **AC6 — data-mechanics, same file:** a calendar event and a transcript for the same meeting produce
  **one** note, with the calendar's attendance and the transcript's body.
- **AC7 — data-mechanics, same file:** the merge never fires across different `occurred_at` dates,
  and never folds a note that already has `merged_into` set.
- **AC8 — data-mechanics, same file:** the backfill corrects the known-bad meeting and **leaves
  correct meetings unchanged** — the no-op half, which is what stops it becoming a rewrite.

**Falsifier for the slice:** if the backfill changes attendance on a meeting whose structured list
agrees with what is already recorded, it is doing something other than what it claims.

## 4b. What actually shipped — AC status, after review

| AC | status |
|---|---|
| AC1 precedence | ✅ `test/meetings-attendance-source.test.ts` |
| AC2 no-fallthrough on an unresolvable list | ✅ same file |
| AC3 the `"[John Ellison]"` shape | ✅ same file |
| AC4 rewritten prompt | ✅ same file (source-text pins) |
| AC5 the reported bug | ✅ **at unit level** (`resolveAttendance` with the shipped hallucination mocked). The spec asked for data-mechanics; **not built** |
| AC6 calendar + transcript → one note | ❌ **not delivered — the merge is DORMANT** |
| AC7 merge never crosses dates / merged notes | ❌ deferred with AC6 |
| AC8 backfill corrects the bad meeting, leaves correct ones | ✅ **proven on prod, dry-run**: 17 changed, **22 already correct**, and exactly `REMOVE: Abe Doe, Fatma` on the reported meeting |

**AC6/AC7 are not delivered, and the first review is why this says so.** The title comparator was
built and tested, and I wrote in `docs/ARCHITECTURE.md` and the commit message that a calendar event
"now folds into the transcript's note". It does not: `findDuplicateMeeting`'s only caller passes no
title, and the path a pushed calendar event actually takes never calls it. **The tests were green over
a feature nobody could reach** — the pin-the-call-site failure exactly. The claim is retracted
everywhere it appeared and the comparator is labelled dormant at its definition.

**Wiring it is MTGATT-2**, and it must first close two hazards the review surfaced, both of which
*destroy* data rather than merely fail:

1. Person names are not stopwords, so two different same-day meetings titled "1:1 with John" and
   "Meeting with John" score **1.0** and would merge.
2. The merge survivor is whichever note existed first, so a transcript arriving after its calendar
   event folds INTO the bodyless note and **loses its body** — the inverse of §3.3's stated direction.

**Also found and fixed by that review, and more dangerous than the missing feature:** the precedence
was enforced only at create time. `mergeIntoMeetingNote` (every scheduler tick) and
`refreshMeetingNoteExtraction` (the summary-healing script's default mode) both wrote the model's
attendees unconditionally — so a repaired meeting would be re-polluted on the next tick. Both closed,
and pinned by `test/guards/meeting-attendance-write-routes.test.ts`.

## 5. Deliberately not in this slice

- **Non-member attendees.** `meeting_note_attendees.member_id` is NOT NULL and FKs to `members`, so
  Alex, Priya and Sam cannot be recorded at all. That is the reason real attendees vanish, and it
  is a schema change with its own blast radius — named here, not folded in.
- Any change to how transcripts are ingested or chunked.
