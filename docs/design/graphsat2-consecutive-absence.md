---
access: team
---

# GRAPHSAT-2 — the saturated-group re-queue becomes safe to enable: the landed watermark (re-scoped at design review — the persisted consecutive-absence draft was DECLINED)

Deps: GRAPHSAT-1 (merged #633 — the per-item lookup path, the REST-window oracle, the hold) and
RECONULL-1 (merged #636 — a failed listing is counted, never judged). Build-with: fable / high
(the one irreversible action in the graph leg). Reviewers: Codex gpt-5.6-sol on the spec and the
diff; Fable on the diff.

## 0. What and why

**The stuck state, measured (prod, read-only, 2026-08-21).** Since GRAPHSAT-1 deployed, two deep
passes have judged General (11:51 and 14:52): both **held 247 rows** as never-landed, with 197 past
the 50-row enumerable bound; the oldest-50 sample is IDENTICAL across the two passes; `reconciled`
2,605 → 2,616, `partialItems` 116 → 115. A stable set of 247 items whose ledger row says "pushed"
and whose Episodic node Neo4j does not hold. The mechanism is known: the graphiti service's worker
queue is in-memory and the service restarts on every brain merge (GRAPHDEPLOY-1) — every
accepted-but-unprocessed episode at restart time is lost; and (PATCH 6, `graphiti/README.md:100`) an
episode whose extraction throws is DROPPED, not retried. Either way the ledger never learns. Under
GRAPHSAT-1's rules those 247 **cannot heal**: the flag is ineligible while the population is
non-enumerable, because the 1-hour grace cannot tell QUEUED from LOST.

**The draft that died (Codex design round 1, three BLOCKERs).** Persisting per-row
`absent_since`/`absent_passes` and re-queuing after K consecutive absences + a 6 h floor. Killed
because three hourly observations of the SAME serial backlog are correlated, not independent — a
1,000-item re-ingest (~17 h of serial work) sits absent across every hourly pass and would be
re-queued while still queued; because the counters would survive an unrelated re-push of the same
row (a content edit bumps `projected_at` and queues fresh work under an old counter); and because
the adapter cannot express an atomic `absent_passes + 1`. The schema recorded repeated observations;
it never established that an episode was no longer queued.

**What does establish it — the queue's own order.** Graphiti's worker is ONE serial consumer of
an `asyncio.Queue` (`graphiti/patch-resilient-worker.py:26-34`: `job = await self.queue.get()` in
a single loop); a job is either processed to completion (its Episodic node exists) or dropped
(PATCH 6) — never re-queued, never reordered. So for two episodes accepted in order A then B: **if
B has landed, A is not queued** — it landed or it is gone. The brain's ledger records accept order
as `projected_at` (written immediately after the accepted `POST /messages`). Therefore, on a judged
lookup pass: let `landedWatermark` = the greatest `projected_at` among rows CONFIRMED this pass
(team-wide — one graphiti service serves the install, so any group's landing advances the queue).
A never-landed row with `projected_at + MARGIN < landedWatermark` was passed over by the queue: it
is LOST, and re-pushing it cannot duplicate queued work. A never-landed row newer than the
watermark may still be queued: HOLD it, as today. No counters, no schema, no K, no age — and the
rule is correct for a backlog of any length, because the watermark moves only when the queue does.

**The topology this rests on, and how it is held (Codex design round 2 BLOCKER).** The
watermark is sound only if there is ONE queue: one graphiti replica, one worker task, one
`asyncio.Queue`, one job per message. Measured: the current graphiti deployment's logs show exactly
one `Started server process`; Railway injects no replica variables into the service; the image's
`CMD` starts one uvicorn with no `--workers` (`graphiti/Dockerfile:388`). Upstream's
`routers/ingest.py` constructs one module-level `AsyncWorker()` and one `create_task` — but that file
lives in the base image, not the repo, so this slice adds a BUILD-TIME verifier
(`graphiti/verify-single-worker.py`, the `verify-small-model-default.py` discipline): it parses the
shipped `ingest.py` and asserts exactly one `AsyncWorker` instantiation, exactly one
`asyncio.create_task` of its worker, a single `asyncio.Queue`, and one `queue.put` per message in
the `/messages` handler — a base-image bump that changes any of those fails the graphiti BUILD.
Deploy overlap (a graphiti redeploy runs old and new containers for minutes) is TWO queues for that
window: new POSTs land on the empty new container and advance the watermark while the old one
keeps draining; every old-container-queued row older than the margin that the throttle reaches is
re-pushed AND completes on the old container — so the duplicate bound is **≤ `REQUEUE_MAX_PER_PASS`
per reconcile pass during the overlap**, and ~1 (the in-flight job) after SIGTERM, when upstream's
`stop()` cancels the task and drains the queue (Fable diff review M1 corrected the earlier "one
duplicate" claim). Stated; GRAPHDEPLOY-1 is what makes those restarts rare. Single-replica is recorded as a
deployment invariant in `docs/RAILWAY-TEMPLATE.md` (no horizontal scaling of the graphiti service).

## 0b. Decidables — defaults stated for the design round to attack

- **D1 — the rule.** On the lookup path (saturated group, oracle held) a never-landed row past
  the grace is RE-QUEUED iff `GRAPH_DEEP_REQUEUE` is on AND
  `row.projected_at + LANDED_WATERMARK_MARGIN_MS < landedWatermark`; otherwise HELD (counted, as
  today). `landedWatermark` is computed in-pass from THIS pass's confirmations across all of the
  team's groups (the REST-judged small groups included — a confirmation is a confirmation), BEFORE
  any re-queue write; it is not stored. `LANDED_WATERMARK_MARGIN_MS` default **10 min** (env,
  `resolvePositiveInt`, garbage → default): `projected_at` is written after the POST returns, and
  two items projected in the same page can have accept order and `projected_at` order differ by
  the push latency; 10 min is two orders of magnitude above that, and costs only that a row must be
  10 min older than the newest landing to be judged — nothing structural.
- **D2 — an anchor is a present FIRST PUSH, collected before the grace check (Fable diff review
  BLOCKER; round 2 M1).** "Present" does NOT mean the push stamped at `projected_at` landed: on a
  retaining source (everything but Slack) an edit re-pushes WITHOUT deleting the old episodes
  (`addEpisodes` does not overwrite by name — `project.ts:1408`), so an edited item stays present
  under its OLD episodes while its stamp is the NEW, still-queued push — an anchor later than any
  landed accept, which would judge a whole backlog lost (140 queued rows "proven lost" by one
  edited `tasks.md`). Tombstones (`''` + a pending flag written after a best-effort delete) invert
  the same way. So an anchor is a row whose presence can ONLY come from the push it is stamped
  with: a FIRST push into its group — real sha, no pending flag, and `projected_at` within
  `FIRST_PUSH_SLACK_MS` (**60 s**) of `first_seen_at` (the row's set-once creation, the reservation
  written right before that first push; measured gap in prod: p50 0.36 s, p95 0.95 s, p99 1.1 s,
  none between 1 and 10 min). THE BOUND: such a row has a landed push accepted no earlier than
  `projected_at − slack`; a candidate is judged lost only if older than `projected_at − margin`;
  with `margin > slack` (pinned — the module throws otherwise) every such candidate was accepted
  strictly before a landed accept, so the FIFO processed it — this holds even if the anchor row was
  edited and re-pushed inside the slack, which closes the "edited within the slack" residual. The
  filter is TWO-SIDED (Codex diff review BLOCKER): a NEGATIVE delta (`first_seen_at` later than the
  stamp — the 2026-08-16 migration backfilled `first_seen_at` at migration time for 2,301 prod
  rows) means the "first accept ≥ `first_seen_at`" premise is fictional, so those rows never
  anchor; new rows do. And the delta is CLOCK-CORRECTED (Codex targeted re-check): `first_seen_at`
  is the DATABASE clock (an INSERT default) while `projected_at` is the APP clock, so a constant
  skew shifts the delta — and a Postgres-ahead skew can cancel against row age on a later re-push.
  Reconcile measures the skew once per pass (`select now()` vs `Date.now()`) and brings
  `first_seen_at` onto the app clock before comparing; a failed probe means no anchors that pass
  (conservative, logged). `watermarkAnchors` rides meta on every deep-resolved pass so "held N,
  eligible 0" is legible as "no valid anchor" vs "an older anchor". Re-pushed, re-queued, armed and tombstoned rows never
  anchor — conservative, and new items arrive constantly so anchors are not scarce. Residual, named:
  the straggler-after-verified-empty shape (an item purged and re-created while a leftover old
  episode survives) — rare, throttle-bounded. The EXACT successor is a brain-chosen episode uuid per
  push recorded in the ledger (`/messages` accepts a client `uuid`; `episode_uuid` already exists) —
  its own slice. Anchors are collected from present first pushes regardless of the grace (a
  5-minute-old landing is exactly the evidence) while `confirmed`, the uuid backfill and
  `partialItems` keep their grace gate unchanged. A pass with no present first push anywhere has no
  watermark and re-queues nothing on the lookup path.
- **D3 — what still holds from GRAPHSAT-1 / RECONULL-1, beneath this.** The REST-window oracle
  (a lookup missing a window-confirmed item → unjudged), the unreachable rule (a failed listing →
  unjudged), the never-pushed discriminator, the `REQUEUE_MAX_PER_PASS` throttle, the flag as the
  master switch, `deepRequeueHeld` / sample / elided for rows that are held. A pass that is not
  judged has no watermark and no verdicts.
- **D4 — enumerability, answered differently.** GRAPHSAT-1 D4 required every held candidate to be
  inspectable because the verdict was a guess a human had to check. Under D1 the verdict is a
  structural fact (the queue passed this row), so the enable decision is "do I accept re-pushing
  N lost items at 20/pass" — a COUNT, reported as `requeueEligible` (rows meeting D1 this pass,
  whether or not the flag is on) beside `deepRequeueHeld` (rows newer than the watermark). Both
  ride summary → meta → log; `requeueEligible > 0` with the flag OFF is a recording-gate signal
  (level-triggered: every pass records while work waits on a human — the "measurement mode is
  loud" rule, stated). The structured sample/elided stay for at-a-glance identity.
- **D5 — REST-path verdicts are untouched; parked rows are excluded on the lookup path (round 2
  HIGH).** Small groups re-queue after the grace as they always have (the listing IS the truth for
  them). A row already on the `''` sentinel (re-queued, awaiting the projector's re-push) is
  re-judged by today's never-landed branch every pass until re-pushed — a pre-existing no-op
  re-write + `reQueued++` on the REST path, harmless because the walk precedes reconcile in every
  tick. On the LOOKUP path this slice makes the exclusion explicit: a parked row (`content_sha256
  === ''`) is neither eligible, nor held-counted, nor written, nor throttle-consuming — it is
  already queued for re-push. The REST path's accounting is left as it is (named, not changed).
- **D6 — the prod rollout.** Deploy (no schema). The next judged pass reports `requeueEligible`
  — expected ≈ 247 immediately, because General's newest landings are minutes old and the 247 are
  days old. A human decision, recorded on the ticket: set `GRAPH_DEEP_REQUEUE=true`; the 247
  re-push at 20/pass ≈ 13 passes, at the per-item extraction cost read from `llm_usage` at enable
  time. Re-pushed items that land confirm on a later pass; any that vanish again (GRAPHDEPLOY-1
  still unfixed → a restart mid-backlog) are judged lost again once the queue passes them, and
  re-pushed again — bounded by the throttle, visible, and pointing at GRAPHDEPLOY-1. Fixing
  GRAPHDEPLOY-1 first is recommended and independent.

## 1. The surface table

| Surface | Change |
|---|---|
| `lib/graph/reconcile.ts` | two-phase landed leg: phase 1 judges every group and collects confirmations + candidate absences (no re-queue writes); phase 2 computes `landedWatermark`, then applies the REST-path re-queues (unchanged) and the lookup-path D1 rule; `requeueEligible`; `LANDED_WATERMARK_MARGIN_MS` |
| `lib/graph/run.ts`, `projection-run.ts`, `scheduler.ts` | `requeueEligible` → summary → meta (when non-zero) → log; `requeueEligible && !deepRequeueEnabled` joins the gate |
| `graphiti/verify-single-worker.py` (new) + `graphiti/Dockerfile` | build-time proof of the single-queue shape in the shipped `ingest.py` (one `AsyncWorker()`, one `create_task`, one `asyncio.Queue`, one `put` per message); a unit test runs the verifier against a fixture copy of upstream's file and against mutated copies |
| `docs/ARCHITECTURE.md`, `.env.example`, `docs/RAILWAY-TEMPLATE.md` | the rule, the margin, the rollout; single-replica as a deployment invariant |
| Schema | **NONE** |

## 2. Mechanism notes

- Group traversal is DETERMINISTIC (sorted `group_id`) — it was Postgres heap order, so throttle
  priority across groups was undefined (the TICKFIT-2 fan-out class); the tape replays in that
  order, and AC1(g2) pins it with the lexicographically-first group.
- Two phases because the watermark must see every group's present rows before any lookup-path
  verdict is applied (the external group's fresh landing can prove General's old rows lost). Phase 1
  is today's loop with BOTH paths' re-queue decisions (REST and lookup, both branches) recorded on
  ONE ordered tape in traversal order instead of written; phase 2 replays the tape in that same
  order with the watermark known — so REST-path rows keep their throttle priority and verdict
  order exactly as today (round 2 M3: deferring only the lookup writes would let later REST groups
  jump the throttle queue). The uuid backfill and `partialItems` stay in phase 1. The lease (#629)
  serializes passes.
- The held/eligible split on the lookup path: `hold()` becomes
  `hold(row) = !deep ? false : (!deepRequeue || row.projected_at + MARGIN >= watermark)`; an
  eligible-but-flag-off row is counted in BOTH `deepRequeueHeld` and `requeueEligible`.
- The re-queue write is unchanged (`content_sha256 = ''`, `first_seen_at` preserved, the
  pending-delete variant keeps its flag); errors on those writes already surface via the existing
  paths.
- A vacuous oracle (no ledger item in the REST window) is trusted as GRAPHSAT-1 D2b states; this
  slice does not change the landed oracle.

## 3. Acceptance criteria (spec-first; exact commands)

1. `npm run test:datamechanics:iso test/datamechanics/graph-landed-watermark.datamechanics.test.ts`
   exits 0 — real Postgres, `FakeGraphiti` saturated, an injected lookup, the flag ON:
   (a) two never-landed rows, one OLDER than a confirmed row by more than the margin, one NEWER
   → the older is RE-QUEUED (`content_sha256 ''`, `first_seen_at` preserved), the newer is HELD;
   `requeueEligible 1`, `deepRequeueHeld 1`; (b) the same fixture with the flag OFF → both HELD,
   `requeueEligible 1` (the count is reported either way), and the gate records it; (c) a judged
   lookup pass in which NO ledger row is present anywhere (listing saturated with foreign filler,
   lookup returns nothing for the team's items, oracle vacuous) → no watermark → every row HELD,
   `requeueEligible 0`; (c2) a WIPED graph (every listing empty) is a different path: not
   saturated → `emptyListingGroups` fires and the REST path heals it bounded, exactly as today
   (RECONULL-1 AC1(d)) — pinned so the two are not confused; (c3) a FRESH first-push landing (younger
   than the grace) anchors the watermark: the only present row is 5 minutes old → an old absent row is
   eligible, while `confirmed` does not count the fresh row (the grace gate is unchanged);
   (i) THE BLOCKER arm: an EDITED retaining item (created long ago, re-pushed minutes ago, present
   under its old episodes) does NOT anchor — with it as the only present row nothing is proven lost
   and a queued row stays held; adding a genuine first push that landed restores the verdict for
   the truly old row only; (j) a TOMBSTONED-but-present row (`''` + pending flag, fresh stamp) does
   not anchor; (k) a MIGRATION-BACKFILLED row (`first_seen_at` later than its stamp) never
   anchors; (l) CLOCK SKEW (+20 min Postgres-ahead, injected): a true first push still anchors
   after correction; a re-push whose RAW delta is 0 does not; (m) a failed skew probe → no
   anchors, nothing eligible; (c4) a PARKED row (`''`, chunk ledger non-empty) on the lookup path is neither eligible nor
   held-counted nor re-written across a second reconcile before the projector re-pushes it;
   (d) the watermark is TEAM-wide: the only confirmation is in the EXTERNAL group (REST-judged),
   newer than General's old absent row → that row is eligible; (e) the margin: an absent row
   older than the newest landing by LESS than the margin is HELD; (f) a re-queued row, once
   re-pushed by the projector and then confirmed on a later pass, is an ordinary confirmed row
   (no residue); (g) an UNREACHABLE listing pass (RECONULL-1) and a MISMATCH pass form no
   watermark from that group and re-queue nothing; (g2) ORDER: a REST-path group traversed AFTER a
   lookup-path group still takes its throttle slots first when it was traversed first — with
   `maxRequeuePerPass 1` and a REST absent row traversed before a lookup-eligible row, the REST
   row is the one re-queued (tape order preserved); (h) REST-path (small group) re-queue behaviour
   is today's (a never-landed row past the grace re-queues regardless of any watermark) — this
   fence excludes nothing: the REST path is already shipped and pinned.
2. `npx vitest run test/graph-recording-gate.test.ts test/graph-projection-run.test.ts` exits 0:
   `requeueEligible 1` with the flag OFF records alone; with the flag ON it is meta-only; absent
   from a quiet row; the margin env parse (unset/0/garbage → 10 min, `"600000"` → itself).
3. Existing graph dm suites green with TWO consciously revised GRAPHSAT-1 arms
   (`graph-saturated-heal` AC1(a,b,c): the REST pass parks `never`, and a parked row is now invisible
   to the lookup path by D5 — the fixture restores its sha before the deep pass; AC1(d): every row
   shared one `projected_at`, so nothing was proven lost — `never` is now older than the landings by
   more than the margin). Everything else (`graph-project`, `graph-unreachable-listing`, reconcile
   suites) UNCHANGED — D3/D5.
3b. `npx vitest run test/guards/graphiti-single-worker.test.ts` exits 0: the verifier accepts a
   fixture copy of upstream's `ingest.py` (committed under `test/fixtures/graphiti/`), and rejects
   copies with two `AsyncWorker()` instantiations, two `create_task`s, a bounded/second queue, or
   a handler that `put`s once per request instead of per message — each with its named reason.
4. Mutations, verdicts verbatim in the PR: (a) drop the watermark term (re-queue any held row
   when the flag is on) → AC1(a)'s "newer is HELD" and AC1(c) redden; (b) build the watermark
   from PUSHED rows instead of CONFIRMED rows → AC1(c) reddens; (c) scope the watermark to the
   group instead of the team → AC1(d) reddens; (d) drop the margin → AC1(e) reddens; (e) apply the
   rule to the REST path → AC1(h) reddens; (f) count a parked row as eligible → AC1(c4) reddens;
   (i2) anchor on ANY present row (drop the first-push slack) → AC1(i) reddens; (j2) anchor a
   tombstone → AC1(j) reddens; (k2) accept a negative delta → AC1(k) reddens; (l2) drop the skew correction → AC1(l) reddens;
   (g) collect anchors after the grace check → AC1(c3) reddens; (h) replay lookup writes before
   REST writes → AC1(g2) reddens.
5. Full tiers green (`npm test`, dm iso graph set, `npm run test:http:local`, `npm run
   check:docs`); ARCHITECTURE + `.env.example` updated; the rollout (D6) written on the ticket.

## 4. Out of scope, named

- Enabling `GRAPH_DEEP_REQUEUE` in prod — a recorded human decision after reading
  `requeueEligible` (D6).
- GRAPHDEPLOY-1 (the cause of the loss) — operator action, independent and recommended first.
- Duplicate-episode cleanup inside General (a re-pushed item whose original landed late after all
  — impossible under FIFO+drop, but a future concurrent worker would change that; GRAPHSAT-1 §4
  names the cleanup slice).
- The persisted consecutive-absence schema — DECLINED. The single-queue assumption is pinned at
  graphiti BUILD time (the verifier) and as a deployment invariant (single replica); a future
  multi-worker graphiti fails its own build before it can ship under this rule.
- Horizontal scaling of the graphiti service — forbidden by this design; an install that needs it
  needs a durable accept sequence first (a different spec).
- A lookup-based cleanup for the cleanup leg — still its own future slice (RECONULL-1 §4).
