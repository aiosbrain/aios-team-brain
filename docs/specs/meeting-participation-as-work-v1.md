---
eval_tier: full
spec_gate: block
---

# Meeting participation counts as work — Team Brain V1

## Why

**A meeting you sat in is work, and today the brain records none of it.**

Measured on prod (2026-08-06, read-only):

| fact | value |
| --- | --- |
| meeting notes stored | 54 (2026-07-13 → 2026-08-05) |
| notes with ≥1 resolved attendee | 49 |
| attendee rows (real `members` FKs) | 69 (avg 1.4/meeting) |
| meetings attended, last 14d | John Ellison 16 · Chetan 13 |
| **meeting evidence in the live timeline payload** | **0** |

The live `work_timeline_cache` payload (v11, 7 days) contains evidence of kinds
`commit`/`deliverable`/`slack`/`artifact` only. Not one meeting appears, for anyone.

### This reverses a documented decision, and the reason it was made is now obsolete

Meetings are excluded deliberately, at `lib/dashboard/work-timeline.ts:358`, and the rationale is
stated twice:

> `work-timeline.ts:57` — *"Meetings (granola) are team signal, not one person's output → excluded
> from the per-person view (**a granola item's `member_id` is the recorder, not the participants**)."*

> `docs/design/rollup-work-vs-signal.md:22` — *"Out (follow-ups): meetings-as-signal (**a granola
> item's `member_id` is the recorder, not the participants** — team-level, not per-person)"*

Both give the SAME blocker, and it is an **attribution** problem, not a judgement that meetings aren't
work: we could not say who was in the room, so a meeting could only be credited to whoever pushed it.
That is confirmed on prod — all 29 transcripts in the last 14d resolve to one member (John Ellison,
who runs the push), including *"1-1 with Chetan RE: AIOS next steps"*, which is attended by **John and
Chetan** and credited to John alone.

**`meeting_note_attendees` removes that blocker.** It is `(meeting_note_id, member_id)` with a real FK
to `members` — attendance is *already* resolved to people. It is strictly better data than Slack had
when PR #356 built the per-participant Slack leg (Slack needed a frontmatter `participants[]` ledger
parsed and case-folded by hand). The precedent for the mechanism is therefore already in the codebase.

### The one genuine product reversal, stated plainly

The prior design also holds that a meeting, once attributable, should land in the **`signals[]`
Context lane** — shown but explicitly *"never counted as work"*. `SignalKind` is a one-member union
with the comment *"a decision now; meetings later"* (`timeline-group.ts:90`).

**This spec overrides that: meetings count as WORK.** A deliberate product decision by the owner of
this surface, and the one place this spec contradicts existing design.

It does NOT follow that every "meetings are signal" rule in the codebase should flip. §7 shows by
execution that flipping the shared `classifyWork` oracle would both fail to do what it looks like AND
open an LLM cost leak. The honest resolution is that two different questions are being asked under one
word, so V1 changes the timeline's answer and leaves the scoring oracle's answer alone — with a
comment recording why the remaining asymmetry is correct rather than drift.

Consequence worth naming up front: a person's `total` will rise, and someone whose day was mostly
calls will now outrank a quiet coder in the within-day ordering. That is the intended meaning of
"count meetings as work".

## What

Add a **meeting-participation leg** to the work-timeline builder, mirroring the Slack per-participant
leg: one evidence item per `(meeting, attendee)`, so a meeting appears on the card of **every person
who was in it** — not only whoever pushed the transcript.

Built at the **data layer**, so it lands in `work_timeline_cache` and reaches every surface
identically. The readers of `work_timeline_cache` today are exactly: the dashboard timeline panel,
Home "Working on" (`/api/dashboard/team-work`), and **`GET /api/v1/timeline`** — the machine/CLI
surface, which is what "the context layer" means for this ledger. (`lib/query` does not read this
cache yet; its own header calls the LLM retrieval path a *later* consumer. Meeting text already
reaches Q&A separately, via `items` FTS.) Explicitly not a rendering-only change.

## Interfaces and contracts

### 1. The evidence source and who gets credited

A dedicated query over `meeting_notes ⋈ meeting_note_attendees`, scoped to team + window. **Not** the
`otherRes` items leg — see §2 for why it cannot be reused.

- **Credited person** = each `meeting_note_attendees.member_id`; one evidence item per attendee, with
  a synthetic id `` `${noteId}:${memberId}` `` (the Slack leg's convention at `work-timeline.ts:408`).
- Attendees not on the active roster are dropped, as every other leg does.
- **Tombstoned notes** (`merged_into is not null`) are excluded — the merge target carries the union
  of attendees, so counting both double-credits the same meeting.
- **Zero-attendee meetings** (5 of 54 on prod) fall back to **`meeting_notes.submitted_by`** — the one
  person we know was involved — marked `via: "submitter"` so it is distinguishable from real
  attendance. Silently presenting it as attendance is the misattribution this spec exists to remove.
  `submitted_by` is chosen over the transcript item's `member_id` because it needs no join, and it
  survives a merge (where `meeting_note_submitters` holds the union). If `submitted_by` is null or
  resolves to a connector/inactive member, the meeting contributes **nothing** — it is dropped, not
  credited to a guess.

**Known limitation, inherited not introduced:** `matchAttendees` (`lib/meetings/llm-extract.ts:155`)
drops any name it cannot resolve to a roster member, leaving **no trace at all** — no row, no
unmatched-names column. So 1.4 attendees/meeting is a floor, not the truth, and a real participant
can be missing. This spec consumes the table as-is and improves automatically as extraction does; it
does not paper over the gap by guessing. See Out of scope.

### 2. The day a meeting lands on

Priority, first non-null wins:

1. `meeting_notes.occurred_at` — the meeting's own date.
2. the transcript item's `work_at`, when the note has no `occurred_at`.
3. `meeting_notes.created_at` as the last resort.

**`at` is ALWAYS a bare `YYYY-MM-DD`, never a timestamp** — including when it came from source 2 or 3,
which are timestamps and must be sliced. `occurred_at` is a `date` column (`schema.sql:1273`) with no
clock time, so a meeting genuinely has no time-of-day to show. Mixing the two granularities would sort
a bare date before every same-day timestamp and render a bogus midnight. Decisions already made this
choice for the same reason (`SignalItem.at` is bare-date); meetings follow it. The card must therefore
render a meeting row without a time.

Never `synced_at`: the persisted `work_at` column exists precisely so a re-sync tick cannot move
work to another day.

**This is why the existing `otherRes` leg cannot be reused.** That query filters
`work_at_from_source = true` (`work-timeline.ts:227`), and a GUI-uploaded meeting is ingested with
`frontmatter: { title }` only — no work-time key matches, so `work_at_from_source` is **false** and
the row never leaves SQL. A separate query is required, not merely a relaxed `continue`.

### 3. Payload shape

`PersonDay` gains **no new array**, and `SignalKind` is **not** widened. A meeting is an ordinary
`EvidenceItem`:

- `source: "meetings"` — a new source-vocabulary value, so it forms its own `SourceGroup` and is
  countable and filterable rather than blended into `other`.
- `kind: "meeting"`, `title` = the meeting title, `url` = `/t/<team>/meetings/<noteId>`, `at` = §2.
- `via: "submitter"` only on the §1 fallback; absent otherwise.

Meetings flow through the existing lanes: under a task when a linking pass links them, else into
`other[]`. A new top-level lane would need its own rendering, counting rule, and line in every
consumer, and `tasks[]`/`other[]` already expresses "tied to a task or not".

**`unlinked` must NOT count meetings.** It is documented (`timeline-group.ts:127`) as the coverage
metric for the doc→task assignment pass — the number that decides when omitting `other[]` becomes
safe. Meetings are permanently unlinkable in V1 (linking them is out of scope), so counting them would
inflate the metric forever and destroy its meaning: John's 16 meetings/14d alone would swamp it. So
`unlinked` counts non-meeting `other[]` groups; `total` counts everything including meetings.

**`via` must be carried through the grouper.** `timeline-group.ts:296` copies evidence fields
explicitly (`{ id, title, url, source, kind, at, linkedTask, linkVia }`) — a new key not added there is
silently dropped between the builder and the payload. Pin the call site, not just the type.

**`PAYLOAD_VERSION` 11 → 12** — required under both stated rules (`timeline-cache.ts:35-69`): the
payload gains evidence it never had (shape) and a v11 row would keep serving meeting-less person-days
for a full TTL after deploy (meaning).

**`MIN_SALVAGEABLE_VERSION` stays 11.** It is raised only when a change makes existing synopsis
*prose* wrong. Adding meetings does not; raising it would blank every summary — the regression the
constant's own comment records as having been reported twice as *"we've lost the summaries"*.

`test/guards/timeline-payload-shape.test.ts` pins node KEYS, not source values, so what v12 must add is
the new `via` key on `evidenceItem` — with the fixture actually producing it, or the REQUIRED half is
vacuous. (A "meetings source group" is not something that guard can express; asserting meeting
evidence belongs in the data-mechanics tier.)

**`meetings` needs an icon + label** in `components/icons/source-icon.tsx`, which has no entry for it
today (`granola` is already labelled "Meetings" with a Mic icon — reuse it). It is deliberately NOT
added to `lib/ingest/source-rules.ts`: that table is keyed on ingest sources, and `meetings` is a
payload-only source slug, not something the ingest path ever sees.

### 4. Tier isolation (sole enforcement — no RLS backstop, CLAUDE.md §5)

`meeting_notes` has **no `access`/`audience` column at all**, so `visibleItems` cannot gate it and
neither can any existing visibility helper. Meeting notes are team-tier only by construction
(`lib/meetings/notes.ts:16` — *"always ingested at access='team', never external. There is no UI path
to make one external."*).

The timeline is built and cached **per tier** and served to `external` API keys. Therefore:

- the meetings leg is skipped entirely unless `canSeeMeetingNotes(tier)` — routed through that
  existing predicate, not a re-spelled `tier === "external"`, so there is one rule and not two;
- the `external` payload MUST contain zero `source: "meetings"` evidence.

### 5. The roll-up into the individual update

`summaryPromptFor` MUST describe the meetings. Its own stated invariant is *"the prompt describes
what the card shows"*, and a day of calls otherwise yields a synopsis omitting the day's main
activity. Once meetings carry `source: "meetings"` they are covered by the existing "Other work that
day" branch, but the acceptance criterion asserts the prompt text directly so it cannot regress
silently.

The per-person-day `summary` is what the ask calls "their individual update for that day".

### 6. Double-counting

The transcript `items` row stays excluded. A meeting appears **once**, via this leg. Admitting the
item as well would show the same meeting twice — once to the pusher and once per attendee.

### 7. Do NOT flip `classifyWork` — the two questions are different

The obvious move is to change `lib/dashboard/work-classification.classifyWork` to return `"work"` for a
meeting transcript, so there is "one policy". **That is wrong, and the spec review proved it by
execution.** Two independent reasons:

1. **It doesn't do what it looks like.** `classifyWork` checks `isSignalSource(source)` at line 22
   *before* the transcript rule at line 23, and `granola` is in `SIGNAL_SOURCES`. Verified:
   `classifyWork("transcript","granola") === "signal"` — the transcript rule never fires for the
   sources that matter. Making it return `"work"` would require removing `granola`/`zoom`/`calendar`
   from `SIGNAL_SOURCES`, which silently changes the attribution-health banner's meaning.

2. **It would open an unbounded LLM cost leak.** `classifyWork`'s only other production consumer is
   `lib/dashboard/doc-task-infer-run.ts:174`: `isScoreableSource(source) && classifyWork(...) === "work"`.
   `isScoreableSource("granola")` is **true** (it excludes only `github`/`slack`/`tweet`), so
   `classifyWork === "work"` is the ONLY thing keeping meeting transcripts out of the LLM doc→task
   pass. Flipping it would send large transcripts to the model on **every background timeline
   rebuild**, consume the bounded per-run doc slots, and write `task_evidence` rows keyed to the
   transcript item id — which **nothing renders**, because §6 keeps transcript items out of the
   timeline and this leg's ids are synthetic `${noteId}:${memberId}`. Ongoing spend, invisible output.

The resolution is that `classifyWork` and this spec answer **different questions**, and the apparent
inconsistency is real but correct:

| question | answered by | meetings |
| --- | --- | --- |
| "is this an authored document worth scoring against tasks?" | `classifyWork` + `isScoreableSource` | **no** — like Slack, it is a conversation |
| "did this person spend their day on this?" | this meetings leg | **yes** — it is work |

Slack is the existing precedent for exactly this split: `classifyWork("transcript","slack")` is
`"work"`, yet Slack is excluded from scoring via `CONVERSATIONAL_SOURCES`. Meetings sit in the same
class, reached by a different route.

**So V1 does not touch `classifyWork`, `SIGNAL_SOURCES`, or `doc-task-infer` at all.** The meetings leg
is driven by the `meeting_notes` ledger and is independent of the source-name classifiers. What the
spec owes instead is a comment at `work-classification.ts` and at `work-timeline.ts:57` recording that
the two questions are distinct and must not be "unified" by a later reader — the inconsistency is
load-bearing, and a future cleanup that collapses them re-opens the cost leak above.

Also noted, unchanged and out of scope: `SIGNAL_SOURCES` (7 entries) and `MEETING_TRANSCRIPT_SOURCES` (8 entries) share only `granola`/`zoom`/`meet`. V1 depends on neither, because it keys on the ledger.

## Acceptance criteria

Independently checkable; none constrains another's outcome. Each names the observable it is verified to.

1. Given a meeting with attendees A and B pushed by A, **both** A's and B's person-day for the
   meeting's date contain one `source: "meetings"` evidence item for it, **in the team-tier payload**.
   (The tier qualifier matters: if B is an external-tier member, B sees no meetings through an external
   key — criterion 4 — and that is correct, not a conflict.)
2. That meeting appears **exactly once** per person-card — no duplicate from the transcript item.
3. A meeting counts toward `total` and the card's item count, and does **not** increment `unlinked`.
   `signals[]` is unchanged and still contains only decisions.
4. An `external`-tier payload contains **zero** meeting evidence. **Mutation-checked**: deleting the
   `canSeeMeetingNotes` gate must turn this RED.
5. A meeting with no resolved attendees is credited to `submitted_by` and carries `via: "submitter"`;
   one whose `submitted_by` is null/inactive contributes nothing at all.
6. A tombstoned (`merged_into`) note contributes no evidence; its merge target contributes one item per
   unioned attendee.
7. `summaryPromptFor` output for a person-day containing meetings mentions them.
8. A meeting is dated by `occurred_at` when present, its `at` is always a bare `YYYY-MM-DD`, and a
   re-sync changing only `synced_at` does not move it. A GUI-uploaded meeting
   (`work_at_from_source = false`) still appears — proving the leg does not inherit the `otherRes` filter.
9. `via` survives the grouper: an evidence item carrying `via` in the builder still carries it in the
   payload. **Mutation-checked**: removing `via` from the field copy at `timeline-group.ts:296` must
   turn this RED. (This replaces an earlier criterion asserting the timeline routes through
   `classifyWork`, which §7 shows is both unachievable and undesirable.)
10. `PAYLOAD_VERSION === 12`, `MIN_SALVAGEABLE_VERSION === 11`, and the shape guard pins v12 with `via`.
11. `classifyWork` is **unchanged**, and meeting transcripts remain excluded from `doc_task_infer` —
    no new LLM spend. Verified by asserting `classifyWork("transcript","granola") === "signal"` still
    holds, so a later "cleanup" that flips it fails a test carrying the reason.

## Out of scope (and where the work goes instead)

Named explicitly so nothing is fenced out without a destination.

- **Improving attendee extraction.** The 1.4/meeting average and the silent-drop behaviour of
  `matchAttendees` belong to `lib/meetings/llm-extract`. Filed as a follow-up; this spec gets better
  as that does. It is the single biggest limiter on this feature's accuracy and must not be presented
  as solved.
- **Unifying `SIGNAL_SOURCES` / `MEETING_TRANSCRIPT_SOURCES`.** Separate change (§7); avoided here by
  keying on the `meeting_notes` ledger.
- **Meeting duration as effort.** No duration column exists; "2h of meetings" is not expressible.
  Needs schema; separate spec.
- **Calendar events with no transcript.** `meeting_notes` is the only ledger, so a meeting that
  produced no note is invisible. Not precluded — the leg reads a ledger, not a transcript.
- **Teaching `doc_task_infer` about meetings.** Until then meetings land in `other[]`, which is a
  rendered lane, not a hidden one.
- **The Pulse "Working on" card.** Reuses the same `PersonDay`, so it inherits this automatically —
  called out so its absence from the task list is not read as an oversight.

## Verification

- **data-mechanics (real Postgres):** criteria 1, 2, 4, 5, 6, 8 — persistence and access questions the
  unit tier's fake DB cannot answer.
- **unit:** criteria 3, 7, 9, 10 — pure grouping, prompt text, the oracle, and the shape guard.
- **Mutation checks:** criterion 4 with the tier gate deleted, and criterion 9 with the timeline
  reverted to its inline literal, must both go RED.
