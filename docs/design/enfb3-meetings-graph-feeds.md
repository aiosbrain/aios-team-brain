---
access: team
---

# ENFB-3 — oracle-gate the meetings surfaces + move the graph feeds to the stored-pointer path (enforcement backlog, slice 3)

## 0. What and why

**What:** the last two recorded enforcement residuals close. (1) The MEETINGS surfaces — list,
detail, and the three transcript-consuming actions — gate on the ITEM oracle: every
`meeting_notes` row carries a `source_item_id uuid NOT NULL` + `unique` (schema.sql:1434-47),
so the note's restriction axis is its source transcript, exactly the rule the work-timeline's
meetings leg already applies (`srcVisible`, work-timeline.ts:727-29 — the in-repo reference
implementation). (2) The graph FEED routes `app/api/brain/events` + `/facts` move off
`visibleTierGroupIds` (the legacy tier-pair resolution) onto `selectEnforcedGraphPartitions`
(the stored-pointer oracle path graph-query/arcs/retrieve adopted in ENFB-1), ending the
two-read-models disagreement about what a graph partition means.

**Why:** `getMeetingNote` serves the SAME `items.body` bytes that `/t/[team]/library/[itemId]`
gates behind `canSeeItem` — meetings is the unlocked back door onto the identical content
(notes.ts:389, posture-only at :377). The list pane serves titles/summaries/attendees at bare
posture. Three server actions take a client-supplied `noteId` and feed the transcript to an
LLM or push it into Linear/Plane — ACTION-SHAPED exfiltration where the write half (restricted
content into a third-party system, or overwriting a summary) is worse than the read. The
recorded residual reason ("meetings have no audience column yet") is FACTUALLY WRONG — the
gate is available today with no schema change, and this spec corrects the guard's line rather
than deleting it.

**Measured terrain (prod, read-only, 2026-08-19):**
- `meeting_notes`: 66 rows, **0 null-source** (structural: NOT NULL + all three writers set
  it — notes.ts:126-34,:193-202,:88, single-writer-guarded), 6 merged tombstones; 86
  transcript items. The provenance rule's null-source arm is UNREACHABLE for meetings —
  `rowVisibleByProvenance` is the wrong tool; the gate is `canSeeItem` (by-id) and the
  visible-set intersect (list, capped at 200 rows — an `.in()` is cheap).
- Graph: 2,733 episodes — 2,729 in `aios_team`, 4 in `aios_external`; the system projects'
  stored pointers ARE the legacy pair (`general → aios_team`, `external-shared →
  aios_external`). A stock member's oracle set resolves the SAME two partitions
  `visibleTierGroupIds` serves today (posture and the built-in grant are the same underlying
  row) — the swap is a measured no-op for the stock case, and the ENFB-1 minting trap cannot
  recur because `selectEnforcedGraphPartitions` IS the stored path.
- NOT measured: feed request volume (the facts feed polls every 60s per open dashboard tab —
  load-relevant for the arming decision, D3).

**Ticketing:** row `ENFB-3`; PR carries `AIOS-Work: ENFB-3`.
**Governing spec:** `docs/specs/project-context-classification-v1.md` §5.7/§5.8; the backlog
chain PRET-4 §5 → PRET-6 §5 → ENFB-1 §0b → ENFB-2 §0b.
**Deps:** ENFB-2 (#611) merged. **Schema: NONE.**
**Build with:** fable / high.

## 0b. Slice principle, deferrals, decidables

**IN:** the meetings read/action surfaces (the `lib/meetings/notes.ts` serving reads + the
five actions + both pages), the create→see reconcile for the GUI upload path (D2), the graph
feeds' cutover with the five named traps addressed, the guard extensions (the sweep gains
`meeting_notes` + `lib/meetings`; the two literal needles in `graph-group-slug-derivation`
move in the same commit; `graph-cutover-callsites` gains the feeds), and the stale-prose
corrections (work-timeline.ts:700-703, the actions.ts `tier-ok:` opt-out, the SWEEP_RESIDUALS
meetings line).

**DEFERRED, named:**
- **ENFB-4 — social** (jsonb evidence provenance + the admin-role precedent question) — the
  LAST residual after this slice.
- Connector-run ingest paths' inline reconcile (`lib/ingest/run.ts` call sites): connector
  content converges on the scheduler sweep as today; only the INTERACTIVE upload path (D2)
  reconciles inline — a user watching their own upload is the case with a human in front of
  it.
- `scripts/meeting-pairing-report.ts` (operator CLI, outside the web trust boundary — noted).
- The admin pipeline-health banner (VERIFY in build: serves counts only, no titles; one line).

**DECIDABLES — defaults stated for the design review to attack:**
- **D1 — `importPushedMeetingsAction`:** a member-triggered TEAM-WIDE materialization job
  (mints notes for every un-noted transcript, runs LLM extraction per note, returns
  `{created, scanned}` — a count of meetings the caller may not see). DEFAULT: the repo's
  admin-access gate (`canAccessAdmin` — admin role ∧ team posture, the established
  semantics, round-1 M: role alone is not the precedent), it is an ops-shaped
  materialization job and the scheduler already runs the same backfill routinely; the
  layout HIDES the import button for non-admins (`canManage` splits from the posture bit);
  returned counts are team-scoped by the admin gate, not redacted.
- **D2 — the fresh-upload invisibility window (the slice's grandfathered-pointer class):**
  `createMeetingNote` calls `ingestItem` in-process, which does NOT reconcile context — the
  new transcript has no membership until the ~30-min scheduler sweep, so a naive gate 404s
  the uploader's own meeting right after redirect. DEFAULT: reconcile INLINE in
  `createMeetingNote` (and the merge-owned item path) immediately after `ingestItem` — the
  same `reconcileItemContext` the HTTP items route runs in `after()`; the gate becomes
  honest at once, no second provenance rule, no fail-open arm. **Failure contract (round-1
  HIGH 1):** a reconcile failure does NOT abort or roll back the upload (the item + note are
  durable; deletion is the purge path's job) — the action returns `ok:false` with an HONEST
  message ("uploaded, but not yet visible — it appears within the sync interval"), logs the
  reconcile error loudly, and the scheduler sweep remains the standing convergence (the
  window degrades to exactly today's behavior, never silently). **Merge ordering (round-1
  HIGH 2):** the fresh merge-owned item is reconciled BEFORE `setMeetingNoteSourceItem`
  re-points the survivor; on reconcile failure the merge ABORTS before mutating
  `source_item_id`, so a visible survivor can never become invisible by merging — AC-pinned
  with the ordering asserted, not just the outcome.
- **D3 — the feeds' scope semantics (REVISED at design round 1's BLOCKER):** pass
  `k: Number.MAX_SAFE_INTEGER` and `arm: false` — but the round-1 blocker showed the debt
  probe is COUPLED to `arm` (`partition-read.ts:73-84`: `generalDebtP` runs only when
  `arm !== false`), so a naive `arm:false` feed would serve General during a restriction
  move that graph-query/arcs suppress. The coupling is DEAD SEMANTICS: `arm:false` was
  minted as "the permissive-union discriminator", and post-PRET-6 it has ZERO live callers
  (`resolveArcScope:169,:185` retired the permissive arm and always returns `arm:true`).
  MECHANISM CHANGE, in-slice: the General restriction-debt probe DECOUPLES from `arm` and
  runs for EVERY resolution (it is read-side protection, not an arming side effect); `arm`
  keeps only the arming-trigger semantic; the stale permissive-union comments retire. The
  feeds then pass `arm:false` (a 60-second poll per open tab must not be an arming
  heartbeat) and inherit General-debt suppression — a restriction move blanks the feeds for
  its window, the same fail-closed direction every enforced surface takes (stated in the
  route + release notes). dm arm: the debt suppression holds UNDER `arm:false`.
- **D4 — tombstones:** `getMeetingNote` currently serves `merged_into` rows by direct URL.
  DEFAULT: refuse tombstones at the detail read (the list already hides them; "which ids
  exist" should equal "which ids serve") — the merge survivor is the one canonical note.

## 1. The surface table

| Surface | Today (file:line) | This slice |
|---|---|---|
| meetings list (layout → `listMeetingNotesForTeam`, notes.ts:315-68) | posture only; titles/summaries/attendee+submitter names+avatars; already selects `source_item_id` and throws it away | intersect with the caller's visible-item set (the ENFB-2 scan pattern: the caller resolves `visibleItemIds`, the helper applies `.in("source_item_id", …)` in-query); attendee/submitter batches run over the FILTERED note ids only |
| meetings detail (`getMeetingNote`, notes.ts:371-467) | posture only; title/summary/attendees + the FULL transcript body (items.body by pk, no `canSeeItem`) + extracted todos + PM links | `canSeeItem(source_item_id)` — false → null → the page's EXISTING `notFound()` (§5.7: denied ≡ unknown, the library-page shape); tombstones refused (D4); the signature takes a PRINCIPAL, not a caller-supplied tier (a tier param is one refactor from a constant) |
| meetings index page (page.tsx:16-25) | renders newest note inline via the list, then `MeetingDetailView` re-fetches | BOTH gates are the same predicate over the same set by construction (list = in-query intersect, detail = the by-id probe of the same oracle — the agreement pin covers the pair), so the newest-visible note is always detail-visible; the cross-gate 404 cannot occur |
| `extractMeetingActionItemsAction` / `regenerateMeetingSummaryAction` / `pushMeetingTasksAction` (actions.ts:177,262,311) | posture only; feed the transcript to an LLM / overwrite the summary / push titles+bodies into Linear-Plane | each resolves the note through the SAME gated `getMeetingNote`/probe before any LLM call, summary write, or provider push — a denied `noteId` refuses with the absent-note shape BEFORE content leaves the system; the file-level `tier-ok:` opt-out (the "coarse wall is sufficiency" fallacy, verbatim) is REMOVED and the items read beneath it gated |
| `importPushedMeetingsAction` (actions.ts:145-71) | posture only; team-wide materialization + `{created, scanned}` disclosure | D1: admin-role gate |
| `uploadMeetingNoteAction` → `createMeetingNote` (notes.ts:109) | writes item via in-process `ingestItem` — no context reconcile (the 30-min window) | D2: inline `reconcileItemContext` after `ingestItem` (upload + merge-owned item paths) — the create→see round-trip holds immediately |
| `app/api/brain/events` + `/facts` (:44-57/:48-57) | `visibleTierGroupIds` — the legacy tier pair; serves episode titles, participant names, raw fact text | `selectEnforcedGraphPartitions(db, { teamId, visibleProjectIds: oracle set, k: MAX_SAFE_INTEGER, arm: false })` — the one partition read model. Stock-member parity is the measured no-op (the POSITIVE arm); a granted initiative's armed pointer joins the member's feed; non-grantees never see it. The graph-query LOUD-arm discrimination is inherited (visible system project + zero partitions = wiring fault → 500; the dashboard panels render their EXISTING error card on the non-2xx — a deliberate hard-error contract change for a wiring fault, stated (round-1 M); ordinary resolution failures keep the best-effort degraded-JSON shape the panels already tolerate). Deliberately NOT carried: the slug-derived unbootstrapped fallback (the stored path is the one owner; an unbootstrapped team's feeds are empty until the bootstrap tick — the same behavior graph-query/arcs shipped in ENFB-1, stated); `assertDirection`/`assertNoForeignHistory` (direction: inherits PRET-4 ruling 2 — an external member's grants ARE their scope, the settled arcs posture; foreign-history: pointer-only resolution never reaches the slug-reuse state, recorded not assumed) |

## 2. Mechanism notes

- **One predicate, two cost shapes** (the ENFB-1 §2.1 discipline): the list uses the
  visible-set intersect in-query; the detail/action path uses the `canSeeItem` by-id probe.
  Both halves are the EXISTING oracle primitives — no new rule, no meetings-specific
  provenance arm. dm agreement: the same fixtures assert list-membership ≡ detail-200 across
  granted/ungranted/general/tombstone arms.
- **Fail directions:** oracle resolution error → list empty is WRONG for a serving read that
  can distinguish — the list caller (layout) throws to the error boundary (the ENFB-2 L8
  shape); `getMeetingNote` → null → 404 (per-request, self-healing — the timeline's
  error-poisoning class does not apply because the loaders' `cache()` is request-scoped, and
  no TTL cache may be added without re-reading enforce.ts:26-31, stated in a comment).
- **Guards:** `SWEEP_READ` gains `meeting_notes`; `SWEEP_DIRS` gains `lib/meetings`; the two
  `visibleTierGroupIds(` needles in `graph-group-slug-derivation.test.ts:82-95` MOVE to the
  `selectEnforcedGraphPartitions(` loop in the same commit; `graph-cutover-callsites` gains
  the two feed needles incl. the `k`/`arm` arguments; `BODY_SURFACE_WIRING` gains the
  meetings list/detail/action application patterns. The rename-doctrine dm suite
  (`graph-rename-read-pointer`) keeps its live production caller
  (`lib/cache/tier-invalidation.ts:56`) — `visibleTierGroupIds` is NOT deleted; a comment
  records that the feeds left it and why the suite still proves the invalidation path.
- **Stale prose retired in the same change:** work-timeline.ts:700-703 ("neither can any
  other visibility helper" — false since PRET-6), the SWEEP_RESIDUALS meetings line (schema
  was never the blocker), the guard header's residual roll-call.

## 3. Acceptance criteria (spec-first; exact commands)

1. `npm run test:datamechanics:iso test/datamechanics/enfb3-meetings.datamechanics.test.ts`
   exits 0 — a restricted transcript's note: absent from the non-grantee's list, detail
   `getMeetingNote` → null (404-shape) indistinguishable from an unknown id, all three
   transcript actions refuse BEFORE any LLM/summary/provider write; the grantee gets all of
   it (non-vacuity); a General meeting serves every everyone-member; the tombstone arm (D4):
   a merged note's id refuses at detail; attendee/submitter reads run only over filtered
   ids; the list≡detail agreement pin across all arms.
2. Same file — D2 round-trip: `uploadMeetingNoteAction` → the uploader immediately sees
   their meeting (list + detail) with no scheduler sweep; the merge path keeps the survivor
   visible.
3. `npm run test:datamechanics:iso test/datamechanics/enfb3-graph-feeds.datamechanics.test.ts`
   exits 0 — the feeds' stubbed graph client receives exactly the member's oracle partitions:
   the stock-member parity arm (the legacy pair — the POSITIVE no-op pin), the granted-in /
   ungranted-out pair, `arm: false` pinned (the resolution must not trigger arming),
   uncapped `k` pinned, the loud-arm discrimination (a member seeing a system project
   with zero resolvable pointers → 500, not empty), the General-debt suppression holding
   UNDER `arm: false` (the round-1 blocker's regression arm), and a RENAME arm: a renamed
   team's feed scope still resolves through the stored pointers (round-1 M — the
   rename-doctrine proof moves with the serving path; the old dm suite keeps proving the
   surviving tier-invalidation caller).
4. `npx vitest run test/guards/dashboard-tier-filter.test.ts test/guards/graph-group-slug-derivation.test.ts test/guards/graph-cutover-callsites.test.ts`
   exits 0 with the moved needles + the meetings sweep active; mutation
   `node scripts/mutate.mjs` deleting the list's visible-set application reddens the
   meetings dm suite, and deleting a feed's `selectEnforcedGraphPartitions` call reddens the
   cutover guard — verbatim verdicts in the PR.
5. Full tiers green: unit, dm iso (sole tolerated red = the named TZ artifact),
   `npm run test:http:local`, `npm run check:docs`; ARCHITECTURE's meetings + graph rows
   updated in the same change; release notes name D1-D4's consequences.

## 4. Out of scope, named

ENFB-4 (social — the last residual), connector-path inline reconcile (scheduler sweep
suffices without a human watching), meeting-note audience columns (proven unnecessary),
`revoke-project` (still waiting on an audit-actor story), the feeds' wire-shape disclosure
pair (D3 accepts suppression instead), retrieval/timeline changes (already enforced).
