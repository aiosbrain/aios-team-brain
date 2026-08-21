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
- **D2 — the watermark is a LANDING, not a push.** It is built only from rows the pass CONFIRMED
  (a uuid found — REST or lookup), never from rows merely pushed; a pass that confirms nothing has
  no watermark and re-queues nothing. A row confirmed this pass whose `projected_at` is the newest
  anchors it; `projected_at` is bumped on every re-push, so a confirmed row's stamp is the time of
  the push that landed — exactly the accept time the queue ordered by.
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
- **D5 — REST-path verdicts are untouched.** Small groups re-queue after the grace as they always
  have (the listing IS the truth for them). Only the lookup path's held/re-queue decision changes.
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
| `docs/ARCHITECTURE.md`, `.env.example` | the rule, the margin, the rollout |
| Schema | **NONE** |

## 2. Mechanism notes

- Two phases because the watermark must see every group's confirmations before any lookup-path
  verdict is applied (the external group's fresh landing can prove General's old rows lost). Phase 1
  is today's loop minus the two re-queue writes (which become deferred decisions in a list);
  phase 2 replays those decisions with the watermark known. The uuid backfill and `partialItems`
  stay in phase 1 (they do not depend on the watermark). The lease (#629) serializes passes.
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
   `requeueEligible 1` (the count is reported either way), and the gate records it; (c) a pass
   that confirms NOTHING in any group (everything absent) → no watermark → every row HELD,
   `requeueEligible 0` — a wiped-and-restarted graph cannot trigger a mass re-push by itself;
   (d) the watermark is TEAM-wide: the only confirmation is in the EXTERNAL group (REST-judged),
   newer than General's old absent row → that row is eligible; (e) the margin: an absent row
   older than the newest landing by LESS than the margin is HELD; (f) a re-queued row, once
   re-pushed by the projector and then confirmed on a later pass, is an ordinary confirmed row
   (no residue); (g) an UNREACHABLE listing pass (RECONULL-1) and a MISMATCH pass form no
   watermark from that group and re-queue nothing; (h) REST-path (small group) re-queue behaviour
   is today's (a never-landed row past the grace re-queues regardless of any watermark) — this
   fence excludes nothing: the REST path is already shipped and pinned.
2. `npx vitest run test/graph-recording-gate.test.ts test/graph-projection-run.test.ts` exits 0:
   `requeueEligible 1` with the flag OFF records alone; with the flag ON it is meta-only; absent
   from a quiet row; the margin env parse (unset/0/garbage → 10 min, `"600000"` → itself).
3. Existing graph dm suites green UNCHANGED (`graph-project`, `graph-saturated-heal`,
   `graph-unreachable-listing`, reconcile suites) — D3/D5.
4. Mutations, verdicts verbatim in the PR: (a) drop the watermark term (re-queue any held row
   when the flag is on) → AC1(a)'s "newer is HELD" and AC1(c) redden; (b) build the watermark
   from PUSHED rows instead of CONFIRMED rows → AC1(c) reddens; (c) scope the watermark to the
   group instead of the team → AC1(d) reddens; (d) drop the margin → AC1(e) reddens; (e) apply the
   rule to the REST path → AC1(h) reddens.
5. Full tiers green (`npm test`, dm iso graph set, `npm run test:http:local`, `npm run
   check:docs`); ARCHITECTURE + `.env.example` updated; the rollout (D6) written on the ticket.

## 4. Out of scope, named

- Enabling `GRAPH_DEEP_REQUEUE` in prod — a recorded human decision after reading
  `requeueEligible` (D6).
- GRAPHDEPLOY-1 (the cause of the loss) — operator action, independent and recommended first.
- Duplicate-episode cleanup inside General (a re-pushed item whose original landed late after all
  — impossible under FIFO+drop, but a future concurrent worker would change that; GRAPHSAT-1 §4
  names the cleanup slice).
- The persisted consecutive-absence schema — DECLINED; if a future graphiti worker is not
  FIFO-serial, the watermark assumption must be re-derived first (a guard pins the assumption in
  prose on `patch-resilient-worker.py`'s single-consumer loop; it cannot be pinned in code from
  the brain).
- A lookup-based cleanup for the cleanup leg — still its own future slice (RECONULL-1 §4).
