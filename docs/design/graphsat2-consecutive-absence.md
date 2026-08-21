---
access: team
---

# GRAPHSAT-2 — the saturated-group re-queue becomes safe to enable: per-row consecutive-absence evidence

Deps: GRAPHSAT-1 (merged #633 — the per-item lookup path, the REST-window oracle, the hold) and
RECONULL-1 (merged #636 — a failed listing is counted, never judged). Build-with: fable / high
(schema + the one irreversible action in the graph leg). Reviewers: Codex gpt-5.6-sol on the spec
and the diff; Fable on the diff.

## 0. What and why

**The stuck state, measured (prod, read-only, 2026-08-21).** Since GRAPHSAT-1 deployed, two deep
passes have judged General (11:51 and 14:52): both **held 247 rows** as never-landed, with **197
past the 50-row enumerable bound**; the oldest-50 sample is IDENTICAL across the two passes;
`reconciled` 2,605 → 2,616, `partialItems` 116 → 115. So: a stable set of 247 items whose ledger
row says "pushed" and whose Episodic node Neo4j does not hold. The mechanism is known:
the graphiti service's worker queue is in-memory and the service restarts on every brain merge
(GRAPHDEPLOY-1) — every accepted-but-unprocessed episode at restart time is lost, and the ledger
never learns. Those 247 items' content is NOT in the graph today, and under GRAPHSAT-1's rules it
**cannot heal**: `GRAPH_DEEP_REQUEUE` stays ineligible while the population is non-enumerable
(`deepRequeueElided 197`), and the rule exists because the 1-hour grace cannot tell a row QUEUED
behind the serial worker from one that was LOST.

**What GRAPHSAT-1 D4 named as the structural fix.** Persist, per row, how long it has been judged
absent — then re-queue requires K consecutive absent passes by construction, and the ledger itself
becomes the enumeration surface (a query, not a 50-row sample). This slice is that fix.

**Why "consecutive absent passes" discriminates queued from lost.** The serial worker processes
~1 episode/minute (measured; `extraction-health.ts:581`); a queued episode lands within the
backlog's drain time — minutes to a few hours — and the NEXT deep pass confirms it, which resets
the counter. A LOST episode never lands: it is absent on every pass, forever. K passes spaced an
hour apart, with the first absence at least `ABSENT_MIN_AGE` old, is a bound no backlog reaches
while being a bound every lost row crosses in K hours. The number K is not fitted to one
observation: it is a count of independent judgements, each separated by a full projection
interval, and the age floor covers the worst measured backlog (175 queued in the first prod hour
≈ 3 h at ~1/min) with margin.

## 0b. Decidables — defaults stated for the design round to attack

- **D1 — two additive columns on `graph_episodes`, written ONLY by reconcile.**
  `absent_since timestamptz null` (set on the FIRST pass a row is judged never-landed on the
  lookup path; never moved while absence continues) and `absent_passes int not null default 0`
  (incremented once per pass the row is judged absent). Both RESET (`null` / `0`) on the pass
  that confirms the row (the REST or the lookup path — any confirmation), and on the re-queue
  write itself (the row becomes a fresh reservation; its clock restarts when the re-push's own
  verdict comes). Migration `postgres/migrations/<ts>_graph_episodes_absence.sql` (`add column if
  not exists` ×2) + mirrored into `schema.sql` per the README; a partial index
  `(team_id, absent_passes) where absent_passes > 0` so the enumeration query is cheap. Writer
  discipline: the guard that pins `lib/graph/project` as `graph_episodes`' writer is extended to
  name reconcile as the SOLE writer of these two columns (the projector's upsert never names them,
  so `ON CONFLICT DO UPDATE` leaves them alone — the `first_seen_at` precedent).
- **D2 — the verdict rule, by construction.** On the lookup path a never-landed row is RE-QUEUED
  iff `absent_passes >= K` AND `absent_since <= now() - ABSENT_MIN_AGE` AND the pass's oracle
  held (not unreachable, not mismatched — GRAPHSAT-1's and RECONULL-1's rules, which this slice
  keeps and sits beneath) AND `GRAPH_DEEP_REQUEUE`
  is on; otherwise it is HELD (counted, as today) and its counter advances. Defaults
  `K = 3` (`GRAPH_ABSENT_PASSES`), `ABSENT_MIN_AGE = 6h` (`GRAPH_ABSENT_MIN_AGE_MS`) — both
  `resolvePositiveInt`, garbage → default. WHY both terms: K alone could be satisfied by three
  passes 15 minutes apart (the scheduler interval is env-tunable; the manual button can run a
  pass any time); age alone could be satisfied by one judgement. The throttle
  (`REQUEUE_MAX_PER_PASS`) still bounds the rate.
- **D3 — the flag's meaning narrows, and stays.** `GRAPH_DEEP_REQUEUE` remains the master switch
  (off in prod today). With this slice its enable criterion changes from "inspect every held
  candidate by hand" to "the ledger's own evidence": an operator enables it once
  `select count(*) from graph_episodes where absent_passes >= K and absent_since <= now() -
  ABSENT_MIN_AGE` is a number they are willing to re-push at 20/pass — and that query IS the
  enumeration GRAPHSAT-1 could not provide. `deepRequeueSample` / `deepRequeueElided` stay (cheap,
  still useful at a glance) but are no longer the evidence.
- **D4 — REST-path verdicts are untouched.** The REST path (small groups) re-queues as it always
  has (bounded, oracle-free by nature since it IS the truth listing). The columns are only
  written on the lookup path's held/absent verdict and reset on any confirmation. A row that
  moves between paths (a group crossing the depth) carries its counter; confirmation on either
  path resets it.
- **D5 — what the counters make visible.** New meta: `absentRows` (rows with
  `absent_passes > 0` after this pass, per team — the live held population, exact, not sampled),
  `requeueEligible` (rows meeting D2 this pass, whether or not the flag was on). Both ride
  summary → meta → the log line; `requeueEligible > 0` with the flag OFF is a recording-gate
  signal (work is ready and waiting on a human). The first pass after deploy writes
  `absent_passes = 1` for the 247 and `requeueEligible 0`; three hours later, if they are truly
  lost, `requeueEligible 247` — the operator reads that, not a sample.
- **D6 — the prod rollout is explicit.** Deploy (migration applies via `pg:schema` in the
  preDeploy hook — additive, zero rows change). Watch `absentRows` / `requeueEligible` for ≥ K
  passes. Then — a human decision, recorded on the ticket — set `GRAPH_DEEP_REQUEUE=true`. The
  247 re-push at 20/pass ≈ 13 passes ≈ 13 hours of extraction at the measured ~27 calls/item
  (GRAPHCOST-8 era number; cite the current per-item cost from `llm_usage` at enable time, not
  here). If the re-pushed items land, the counters reset and `absentRows` falls to ~0; if they
  keep vanishing, `absent_passes` climbs again and the re-queue fires again after K more passes
  — bounded, visible, and pointing at GRAPHDEPLOY-1, not at the brain.

## 1. The surface table

| Surface | Change |
|---|---|
| `postgres/migrations/<ts>_graph_episodes_absence.sql` (new) + `postgres/schema.sql` | `absent_since timestamptz`, `absent_passes int not null default 0`, partial index |
| `lib/graph/reconcile.ts` | the lookup-path verdict: advance / reset the columns; the D2 rule gates the re-queue; `absentRows`, `requeueEligible`; `GRAPH_ABSENT_PASSES` / `GRAPH_ABSENT_MIN_AGE_MS` |
| `lib/graph/run.ts`, `projection-run.ts`, `scheduler.ts` | the two counters → summary → meta (when non-zero) → log; `requeueEligible && !deepRequeueEnabled` joins the gate |
| `test/guards/graph-episodes-*.test.ts` | the single-writer guard names reconcile as the sole writer of the two columns (the projector's upsert payloads must never name them) |
| `docs/ARCHITECTURE.md`, `.env.example` | the columns, the rule, the rollout |
| Schema | **ADDITIVE** (two nullable/defaulted columns + a partial index) |

## 2. Mechanism notes

- Writes per pass on the lookup path: one `update … set absent_passes = absent_passes + 1,
  absent_since = coalesce(absent_since, now()) where id = any($ids)` for the absent rows (ONE
  statement per group, not per row — 247 rows is one round trip), one `update … set
  absent_passes = 0, absent_since = null where id = any($ids) and absent_passes > 0` for the
  confirmed rows that had a counter (usually zero rows — the `absent_passes > 0` predicate keeps
  it a no-op). The reconcile lease (#629) serializes passes, so the increment cannot race
  itself.
- Eligibility is evaluated from the row's values AS LOADED at the top of the pass plus this
  pass's absence (i.e. `absent_passes + 1 >= K`), so the Kth absent pass itself may re-queue —
  stated, so "K = 3" means three absent judgements, not four.
- The REST-window oracle (GRAPHSAT-1 D2b) and the unreachable rule (RECONULL-1) sit ABOVE this:
  a pass that cannot judge does not advance anyone's counter — an unjudged pass is not an absence.
- A row re-queued resets to `(null, 0)`; the re-push creates a fresh verdict cycle. A row that
  is purged/tombstoned (`''` sentinel with a pending flag) is never judged absent (it is the
  never-pushed discriminator's sibling — `chunk_shas` non-empty but the row is leaving) — stated
  and pinned.

## 3. Acceptance criteria (spec-first; exact commands)

1. `npm run test:datamechanics:iso test/datamechanics/graph-absence-evidence.datamechanics.test.ts`
   exits 0 — real Postgres, `FakeGraphiti` saturated, an injected lookup, `K = 3` injected, an
   injectable clock for `ABSENT_MIN_AGE`: (a) a never-landed row across three deep passes with
   the flag ON: pass 1 → `absent_passes 1`, `absent_since` set, HELD; pass 2 → `2`, HELD; pass 3
   (age past the floor) → RE-QUEUED (`content_sha256 ''`, `first_seen_at` preserved), counters
   RESET; (b) the same three passes with the flag OFF → HELD on all three, counters advance to
   3, `requeueEligible 1` on pass 3, and the gate records it; (c) a row absent on pass 1 and
   CONFIRMED on pass 2 → counters reset to `(null, 0)`; absent again on pass 3 → `1` (the clock
   restarted — a queued-then-landed row never accumulates); (d) age floor: three absent passes
   within the floor (clock not advanced) → HELD, `requeueEligible 0`; (e) an UNREACHABLE pass
   (RECONULL-1's `failListFor`) between two absent passes does not advance the counter; a
   MISMATCH pass (wrong-graph lookup) does not either; (f) a REST-path confirmation (group below
   the depth) resets a counter a prior lookup pass set; (g) `absentRows` equals the exact count
   of rows with `absent_passes > 0` after the pass (pinned against a direct query); (h) the
   projector's upsert on a re-push does NOT touch the columns (project an item whose row carries
   `absent_passes 2`, re-push it with changed content → the columns are unchanged; only
   reconcile moves them).
2. `npx vitest run test/graph-recording-gate.test.ts test/graph-projection-run.test.ts
   test/guards/graph-episodes-absence-writer.test.ts` exits 0: `requeueEligible 1` with the flag
   OFF records alone; with the flag ON it is meta-only; `absentRows` is meta-only; both absent
   from a quiet row; the writer guard: no file outside `lib/graph/reconcile.ts` names
   `absent_passes` / `absent_since` in a write payload (source scan of `lib/`, with a non-vacuity
   arm); the env parses: `GRAPH_ABSENT_PASSES` unset/0/garbage → 3, `"5"` → 5;
   `GRAPH_ABSENT_MIN_AGE_MS` unset/0/garbage → 6h.
3. Migration: `npm run db:test:up` (from-zero replay) + `npm run test:migrate-from-existing`
   green; the partial index present in both from-zero and migrated catalogs.
4. Mutations, verdicts verbatim in the PR: (a) drop the age term → AC1(d) reddens; (b) drop the
   K term (re-queue on first absence) → AC1(a) pass-1 reddens; (c) skip the reset on confirm →
   AC1(c) reddens; (d) advance the counter on an unreachable pass → AC1(e) reddens; (e) name the
   columns in the projector's upsert → the writer guard reddens AND AC1(h) reddens.
5. Full tiers green (`npm test`, dm iso graph set, `npm run test:http:local`, `npm run
   check:docs`); ARCHITECTURE + `.env.example` updated; the rollout (D6) written on the ticket.

## 4. Out of scope, named

- Enabling `GRAPH_DEEP_REQUEUE` in prod — a recorded human decision after ≥ K passes (D6).
- GRAPHDEPLOY-1 (the cause of the loss) — operator action.
- Duplicate-episode cleanup inside General (a re-pushed item whose original DID land late
  creates a duplicate — reconcile's existing cleanup semantics; GRAPHSAT-1 §4 names it).
- A lookup-based cleanup for the cleanup leg — still its own future slice (RECONULL-1 §4 named it;
  it changes an access-control latch). This slice does not touch the cleanup leg at all.
