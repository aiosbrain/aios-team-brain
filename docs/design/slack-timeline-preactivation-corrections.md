# AIO-1170 — pre-activation corrections (P1-01, P4-01, P4-07, P4-02, P2-02)

Status: **revised after two Fable spec reviews (2026-09-21). PA-1, PA-3 and PA-5 were judged ready for an Opus builder by the second review. PA-4 was revised a second time and a third review judged it ready once its refresh-spacing finding and three clarifications were folded, which they now are. PA-2 was not ready after a third review and has been SIMPLIFIED (three-condition predicate, known limitation recorded and pinned); the simplified PA-2 has NOT been re-reviewed.** Author: Sonnet 5 (coordinating session), design prose only, no code. Reviewer: Fable 5.1. Builder for the code: Opus 5, because four of the five items are concurrency, retry or authorization semantics (repo routing: uncertain, cross-owner state, privacy). Date: 2026-09-21.

Basis: draft PR 714 at `fad7da96`. The interim Fable review of `9e3cb400` found nine MEDIUM findings; four were fixed and verified (build record, "Interim Fable review … and its corrections"). These five remain. Every one is in code that is **inactive today** (`test/guards/slack-source-not-wired.test.ts` proves nothing reaches it from an entry point), which is why they are not a live defect, and why they must be resolved **before the publisher is activated**: activation is what turns each of them from a latent contract flaw into behavior on a real workspace.

This document decides how each is corrected and what would show the decision wrong. It does not activate anything, delete the guard, or change a migration. All paths below are under `lib/ingest/` unless a directory is given.

## Ground rules for all five

- **No schema change.** Every correction is application logic. If building one turns out to need a column or a table, stop, reserve a migration number across active branches (`AGENTS.md`), and amend this document first.
- **Red test first**, in the tier that catches the failure: real Postgres for anything about leases, budgets, generations or visibility (use `npm run test:datamechanics:iso`); unit only for pure predicates.
- **The not-wired guard stays.** Nothing here wires a runner, route or scheduler.
- **One owner per file, sequentially.** PA-1, PA-2 and PA-3 all change `slack-source-discovery.ts`, so one builder does them in that order; PA-1 also touches the transport, PA-2 also owns `slack-source-binding.ts` (the validity read) and PA-3 also touches `slack-channel-state.ts` only if the query needs it. PA-4 is `lib/dashboard/timeline-cache.ts`; PA-5 is `lib/identity/member-identities.ts`.

## What was verified, and how (do not skip)

| Item | Verified | Not verified |
| --- | --- | --- |
| P4-01 | Read: `beginSlackChannelMetadata` bumps the attempt generation and takes ownership unconditionally (`slack-channel-state.ts:322-343`); discovery calls it before `request()` reserves any budget (`slack-source-discovery.ts:567` begin, `:570` request, `:581` delay); `delaySlackChannel` clears ownership (`slack-channel-state.ts:431`). Fable also found that a budget-`blocked` reservation is written as an `unverifiable` verdict with zero HTTP (`slack-source-discovery.ts` `refusedChannel`, `:692`; classify at `:244-246`). | That a real two-worker run starves a channel: AC-PA-01. |
| P4-07 | Read: `needsSlackPublicProof` (`slack-source-discovery.ts:639`), the re-record (`:605`), and **three** fences that exclude a non-binding integration: the history-lane selection (`:723`), `claimSlackChannelPage` (`slack-channel-state.ts:550`, `binding_integration_id = $4`), and the acceptance lock. | The request count of a real two-integration run: AC-PA-04. |
| P4-02 | Read: the newest anchor is frozen at the database clock (`slack-channel-state.ts:162-165, 527`), the next scan's lower bound is exactly the previous anchor (`:533`), and an existing test pins `oldest` equal to it with `inclusive=true` (`test/datamechanics/slack-source-discovery.datamechanics.test.ts:567-585`). | That a root is really missed: needs a skewed fake provider, AC-PA-07. |
| P2-02 | Read: `removeMemberIdentity` throws when more than one row matches case-insensitively (`lib/identity/member-identities.ts:229-231`). Fable found the suppression check runs before the existing-row branch (`:160-165`). | That an admin can reach the state through the UI. |
| P1-01 | Read: spec line 112 says a data-only mismatch "is STALE, not a cold MISS" and line 114 makes only an **identity** mismatch a cold rebuild; the code throws after two overtaken builds (`lib/dashboard/timeline-cache.ts:523-537, 633-662`). `freshness()` is age-only (`lib/freshness.ts:63-74`). Nothing outside the ledger bumps `data_generation`, so it is dormant. | Behavior under a busy channel (needs the publisher). |

## PA-1 (P4-01) — reserve before you own

**Problem.** The metadata stage opens its ordering attempt before it asks for budget. A sibling worker whose reservation is *deferred* or *blocked* sends nothing, yet has already taken ownership and bumped the generation, so a real in-flight `conversations.info` answer is refused when it lands. With more than one process a channel's public proof can be starved indefinitely. Separately, a *blocked* reservation (a durable marker on a shared bucket, zero HTTP) is today written as a definitive `unverifiable` verdict on the channel.

**Decision.** An attempt is opened only for a request that will be sent.
- The transport (`sources/slack-page-request.ts`, `slackReservedRequest`) gains an optional `beforeSend(): Promise<void>` hook, called after the budget reservation has committed and before the HTTP request. Contract: the hook runs to completion before the fetch; if it throws, **no request is sent**, the promise **rejects** (no new `SlackRequestResult` variant: `classifySlackCall` is exhaustive), the reservation stays consumed (requests are never refunded), and no channel state is written.
- The metadata stage opens `beginSlackChannelMetadata` inside the hook. If it returns `null` (the channel row is gone), the hook throws a typed abort and nothing is sent.
- A **deferred or blocked** reservation opens no attempt and writes **no channel state** (no owner, no generation bump, no `unverifiable` verdict, no error code). The stage reports the step and the channel stays due for a later wake. A blocked bucket stays observable in the **step report** (the pass outcome) and on the **budget row** (`blocked_reason`), not on the channel, which stays `unknown` with no error code. This replaces the current behavior of writing a verdict from a budget marker.
- "The generation commits before the request" is kept: the hook runs its own short transaction and completes before the fetch.

**Assumption, and what would falsify it.** A granted reservation always results in a sent request unless the hook aborts it. Falsified if any path grants a slot, runs the hook, and neither sends nor aborts while another attempt is in flight; AC-PA-03 covers the failure branches.

**Acceptance.**
- AC-PA-01: worker A has begun an attempt with a granted reservation and its response pending; worker B's reservation is deferred. A's owner and generation are unchanged and A's answer, when it lands, is applied.
- AC-PA-02: worker B's reservation is granted instead. B supersedes A and A's late answer is refused (the ordering fence still works).
- AC-PA-03: a transport error or a hook failure releases only the attempt that opened it, leaves no owner behind, and writes no public state.
- AC-PA-03b: a budget-`blocked` reservation leaves the channel row unchanged: the public state stays as it was (not `unverifiable`), no owner, no generation change.

**Tests.** Real Postgres, real budget rows (extend the fences suite). The hook is pinned at the call site: deleting the hook argument from the metadata stage must redden AC-PA-01.

## PA-2 (P4-07) — a coalesced channel is read only by its binder; the other integration stands down while the binder is valid

**Problem.** Two enabled integrations selecting one channel share one frontier row (by design). Each pass by the non-binding integration reads the recorded binding as "not mine", re-proves the channel, and re-records it under itself, so the 30-minute cadence is defeated, the shared `conversations.info` allowance is spent every wake, and the row flips owner each time.

**Decision.** The integration named in `binding_integration_id` (the **binder**) is the only one that reads the channel. Three fences already enforce that (`slack-source-discovery.ts:723`, `slack-channel-state.ts:550`, the acceptance lock) and this design **keeps them**. The other integration **stands down** while the binder is valid: no `conversations.info`, no history request, no rebind. The binder keeps re-proving itself at one observation interval exactly as today, including after its own configuration edit (its own `needsSlackPublicProof` handles the revision).

The binder is **valid** iff all three hold, from stored rows, in a **lock-free, token-free** read in its own transaction that lives in `slack-source-binding.ts`:
1. its integration row is `enabled`;
2. its `slack_integration_bindings` state is verified;
3. the channel is still among the channel IDs its configuration selects.

When the binder is **not** valid, the other integration proves the channel and takes the binding **immediately**, exactly as a first proof does today. A deleted binder is already a first proof (`binding_integration_id` goes null by foreign key). There is no proof-age rule, no takeover throttle and no revision recomputation: the binder's own revision, age and cadence are its own business, and nothing about it is inferred by the other integration.

`lockSlackSelection` is **not** used for the read: it takes the integration row `for update` and decrypts the token, which would serialize the two integrations and expose a token that is not this integration's.

**Why "disabled" and "de-selected" need their own check.** Disabling an integration updates only `integrations.status` and `updated_at` (`lib/integrations/manage.ts`); the binding row keeps its verified state and old revision forever, because a disabled integration never runs again. Removing a channel from the binder's selection likewise leaves the binder's binding row untouched. Reading the binding row alone would keep treating either as valid.

**Known limitation, decided, not solved.** Whether a channel is **public** is a property of the channel; whether it is **readable** is a property of a token, and nothing records which integration's token can read which channel. A valid binder whose token cannot read a channel another integration's token can (`not_in_channel`, `channel_not_found`, `is_archived`, or an auth error) is therefore **not** detected: the channel stays unread until an operator deselects it on the binder or disables the binder. The refusal is visible on the channel row (`last_error_code`) and in the pass step report. Three review rounds showed that every attempt to infer this from existing state fails, because the binder's own re-proof rewrites the evidence (`public_checked_at`, `last_error_code`) and any hand-back protocol loops at the shared `conversations.info` rate. Solving it needs per-integration reachability state, which is a schema change and out of scope here (ground rule 1); it is a separate follow-up design. Today's production selection is one enabled integration on one channel (spec line 78, read 2026-09-09), so the exposure is a configuration that does not exist yet. Falsified by that configuration appearing in production or in the soak.

**Acceptance.**
- AC-PA-04: two integrations, one channel, both passes run, elapsed less than the interval: `conversations.info` for that channel is called once and `binding_integration_id` does not change.
- AC-PA-04b: while the binder is valid, the other integration issues **zero** history requests and **zero** `conversations.info` requests for that channel.
- AC-PA-05: after the binder's own configuration revision changes, the **binder** re-proves exactly once and the other integration issues nothing.
- AC-PA-06: after the binder is disabled, or deleted, or stops selecting the channel, the other integration proves the channel and takes the binding on its next pass, exactly once.
- AC-PA-06b: the validity read takes no `for update` lock on, and never decrypts, the other integration's row (assert on the statements issued).
- AC-PA-06c: the known limitation is pinned with `it.fails`: a valid binder whose history read is refused with a reachability code is not taken over. When someone solves it, this test flips red on purpose.

**Tests.** Real Postgres, extending the coalescing test in the bootstrap suite (it currently asserts one row, not the request count). **Existing test changed on purpose:** `test/datamechanics/slack-source-fences.datamechanics.test.ts` builds a fixture on the current binding behavior around lines 243-310; the builder re-reads it and amends what changes, listing each change in the commit.

## PA-3 (P4-02) — the newest-lane seam gets a margin

**Problem.** A starting newest catch-up reads from exactly the previous scan's database-clock anchor, inclusive, so the overlap is one message wide. If the database clock runs ahead of Slack's by more than the claim-to-response latency, a root posted after the previous top page was served but with a timestamp below that anchor is read by neither lane, and it lies inside an interval later treated as certified. The spec requires an overlap that deduplicates exact message IDs.

**Decision.** The `oldest` sent for a newest catch-up is the stored `newest_lower_ts` **minus a skew allowance**, default **60 seconds** and configurable like the other cadences, inclusive, clamped at zero, and keeping the six-digit microsecond string form Slack expects.
- The subtraction is computed once, in `fetchAndAccept` (`slack-source-discovery.ts`), from the stored `newest_lower_ts`, so **every page of one scan sends the same `oldest`**. `newest_lower_ts` itself and all `completed_*` bookkeeping are unchanged: only the request parameter moves.
- The overlap is harmless because thread enqueue is idempotent on the exact key (`on conflict do nothing`).
- There is no "historical floor" clamp: no such timestamp exists (`historical_floor_reached` is a boolean and the historical lane has no lower bound). Only zero bounds it.

**Assumption, and what would falsify it.** Database-to-Slack clock skew plus request latency stays under the allowance. The allowance is 60 s rather than a larger figure because the overlap costs real budget on a shared bucket (a busy channel re-reads its overlap at one request per interval): 300 s on a channel at one message per second would add about 20 history requests per catch-up. The live soak (AC-14) records the observed skew and treats more than half of the allowance (30 s) as a defect. Falsified by a measured skew above the allowance.

**Acceptance.**
- AC-PA-07: with a fake provider whose timestamps lag the database clock by 2 seconds, a root whose `ts` is one second below the previous anchor, posted after the prior top page was served, is discovered by the next catch-up.
- AC-PA-08: the catch-up request's `oldest` equals `newest_lower_ts` minus the allowance, clamped at zero, in six-digit microsecond form; every page of a multi-page scan carries the same value. This replaces the assertion in the existing seam test (`overlaps the certified boundary…`), which is changed on purpose and says so.
- AC-PA-09: a root read twice inside the overlap produces one queued thread row.
- AC-PA-09b: a catch-up over a quiet channel whose overlap holds one message issues exactly one history request, as it does today.

## PA-4 (P1-01) — identity is the only cold miss; a data or presentation change serves stale

**Problem.** A change to the Slack data generation alone is treated as a cold miss, and the inline rebuild throws after two overtaken attempts, so on a busy channel a timeline read can fail outright. Presentation changes fare no better: the ledger bumps the presentation generation for every new scoped item (`bumpSlackPresentationIfChanged`, `slack-message-ledger.ts:176`), so a backfill of several hundred roots is several hundred bumps, and a design that left presentation as a cold miss would not fix the failure it names. The spec is explicit: only an identity-generation mismatch is a cache MISS (line 114); "actual display-only changes use data/presentation invalidation, not an identity cold rebuild" (line 112). The inline cold path also `continue`s on **any** counter change and throws after two attempts (`timeline-cache.ts:643-662`), so even the legitimate cold rebuild after an identity correction fails during a backfill (the AC-14 soak scenario).

**Decision.** The timeline cache serves the persisted row as **stale** when **all** of these hold, and falls back to a cold rebuild when any fails:
1. the identity generation equals the row's (an identity mismatch is a cold rebuild);
2. the live item-visibility fingerprint equals the row's (read before every hit and re-checked in the publish compare-and-set);
3. the Slack **source is current** for the team: at least one integration of the team is enabled with a verified binding, from a lock-free, token-free read (a sibling of PA-2's read, per team rather than per prover, not the same read). It **fails, and the read rebuilds cold, when no such integration exists**; it must never pass vacuously. Effect: `lib/dashboard/work-timeline.ts` does not filter evidence by integration status, so this check refuses the prior **row** after the source is gone; it does not filter evidence.

Data and presentation generations **may lag**. The response carries an explicit `stale: true` on this branch (the freshness envelope is age-only, `lib/freshness.ts:63-74`, so a young row with a mismatched generation would otherwise report fresh); the in-memory entry is retained under the fingerprint check; a background refresh is started. `freshness()` gains an explicit override (`opts.stale`) rather than the branch hand-building the envelope. Only the team-work route puts freshness on the wire today; the timeline route, the v1 route and the panel strip it, so a lagging row is **not shown as stale in the UI**: recorded here, not solved.

**Refresh spacing.** A stale-branch refresh is started at most once per **refresh spacing** per key (configurable, default the cache TTL). Without it a generation-lag serve on every read of a polling dashboard would start a refresh, and one model summary pass (`timeline-cache.ts:126`), per read; today the stale branch fires once per TTL.

**Summaries on a stale serve.** On **any** generation-lag serve (data or presentation) the `summary` (model prose) fields are **omitted**, honouring spec line 112, "dropping unverifiable summaries": the row serves facts only, and the refreshed build restores prose. `summary` is optional on `PersonDay`, so omission is shape-safe. `salvageSummaries` stays **strict** (same generations required) and its item-fingerprint gate becomes a **required** argument, not an optional trailing one (closing review finding P1-02). It shares the `sameGenerations` helper with the publish compare-and-set (`timeline-cache.ts:212-220`); relaxing the compare-and-set must not relax it, so the two are separated.

**One publish rule for both paths** (the cold inline build and the background refresh): **identity and fingerprint are strict**, an overtake by either discards the build; **data and presentation are tolerated**, and the build is published **stamped with the generations read before it built**, so the next read sees the mismatch, serves stale and refreshes again, and the sequence converges the moment ingestion pauses. The cold path keeps its retry and its actionable error only for repeated identity or fingerprint overtakes (spec line 114: repeated remaps preventing a consistent snapshot return an actionable error).

**DEVIATION FOR ADJUDICATION.** Spec line 114 says "CAS cache publication rejects any overtaken data or identity generation". Tolerating data and presentation overtakes departs from that letter so that reads converge under sustained ingestion. It is safe because every reader compares a row's stamp against a live generation read and serves a lagging row only through the stale branch, so a lagging row cannot be presented as fresh (the second Fable review confirmed this for all four consumers, which go through `getCachedWorkTimeline`). It is recorded here so it is adjudicated before it ships, and goes into the build record when built.

**Bounded staleness.** A **maximum stale age** (configurable, default 15 minutes, an assumption) bounds the worst case under sustained ingestion: past it, a read falls back to the cold rebuild.

**Assumption, and what would falsify it.** Bounded staleness (cache TTL, refresh cadence and the maximum stale age) is acceptable; the spec chose it. Falsified by any path where a principal who has lost access to an item still receives it. Check 2 and the strict salvage are what cover the build record's open gate, "same-hash membership revocation": a same-hash membership close is caught by the item fingerprint read before every hit, which is an item-ID fingerprint, not a hash of the visible set.

**Acceptance.**
- AC-PA-10: after a semantic data-generation bump, a read resolves with the prior row marked `stale: true`, its summaries omitted, and starts exactly one background refresh. All of AC-PA-10 to 10c need a fixture with one enabled integration with a verified binding, or check 3 makes them unsatisfiable.
- AC-PA-10b: the same holds for a presentation-generation bump (the backfill case): a run of many presentation bumps never turns a read into a cold rebuild or an error.
- AC-PA-10c: repeated reads inside the refresh spacing start no additional refresh; a read after it starts exactly one.
- AC-PA-11: a visibility change between publication and read (fingerprint mismatch) yields a cold rebuild, never a stale serve.
- AC-PA-12: with no enabled integration with a verified binding (source disabled or binding revoked), a read yields a cold rebuild, never a stale serve.
- AC-PA-13: a background refresh overtaken **only** by data or presentation bumps publishes its build (stamped with the earlier generations) and the read keeps resolving, never rejecting.
- AC-PA-13b: after ingestion quiesces, the next refresh publishes a build whose stamps equal the live generations, and the row is no longer stale.
- AC-PA-13c: a row older than the maximum stale age is not served stale; the read rebuilds cold.
- AC-PA-13d: a refresh overtaken by an identity or fingerprint change is discarded, and the next read rebuilds cold (the inverse of AC-PA-13).
- AC-PA-14: a same-hash membership close (existing `closeMembershipInto` fixtures) does not leak through a stale serve.
- AC-PA-14b: an identity-generation mismatch rebuilds cold and never serves the old credit.
- AC-PA-14c: an identity correction during a backfill (many presentation bumps in flight) yields a successful cold rebuild, not an error.

**Existing test changed on purpose:** the cache-generations suite currently asserts that a data mismatch is a miss (`test/datamechanics/timeline-cache-generations.datamechanics.test.ts`, around line 350); it is amended to the behavior above and the commit says so. Making the fingerprint argument of `salvageSummaries` required also changes `test/timeline-synopsis-salvage.test.ts` (nine four-argument calls, not type-checked); the builder amends it and lists it.

**Tests.** Real Postgres, extending the timeline-cache generations suite (second-worker warm hits, in-flight overtaken builds). Open watch items: the per-hit latency of the stale path; the UI does not render a lagging row as stale (see above).

## PA-5 (P2-02) — unlink the row you name, and fence only when nothing live remains

**Problem.** A team can hold `U0ABC` and `u0abc` as two live rows (the unique key is case-sensitive and the pre-PR writer matched exactly). Unlinking either throws, and linking returns a conflict, so an admin has no path out except SQL.

**Decision.** For Slack, when several rows match case-insensitively, `removeMemberIdentity` removes the one whose stored `external_id` equals the caller's spelling exactly, if exactly one does, and throws only when none is exact.
- The suppression fence is written **only when no live variant remains after the removal**. If another variant is still live, no new fence is written: the surviving row keeps its mapping and stays refreshable by auto-sync. (The suppression check runs before the existing-row branch, so a fence written while a variant is live would make that variant's own metadata refresh return `conflict` forever.)
- `setMemberIdentity` is unchanged: linking still refuses on multiple variants, and an admin resolves by unlinking exact variants first.

**Assumption, and what would falsify it.** The Admin UI passes the stored spelling because it renders stored rows. Falsified if any caller passes a normalized spelling; that case still throws, as today.

**Acceptance.**
- AC-PA-15: rows `U0ABC` and `u0abc`; removing `u0abc` removes only that row and bumps the identity generation once.
- AC-PA-16: removing a spelling with no exact match still throws.
- AC-PA-17a: removing the **last** live variant writes the fence, and auto-sync then refuses to recreate either spelling.
- AC-PA-17b: removing one of two variants writes no new fence, and auto-sync's metadata refresh of the surviving variant is not reported as a conflict.

## Order, and what this document does not decide

Order: PA-1, PA-2, PA-3 (one builder, `slack-source-discovery.ts`), then PA-5 (small, independent), then PA-4 (largest, security-sensitive, last so its review is not rushed). Each is red-first, reviewed by Fable on its own diff, and pushed as its own commit.

Not decided here, and not to be assumed: **activation** (deleting the guard, wiring a runner, scheduler or manual sync), the attended identity cutover and repair, and the live acceptance evidence (AC-01, AC-13, AC-14). Those need a person, a real workspace, or authorization, and remain merge blockers on the PR; see `slack-timeline-activation-runbook.md`.

## Review record: Fable spec review, 2026-09-21

Verdict on the first draft: not ready for a builder. Two BLOCKER and seven MAJOR findings were folded as follows; the reviewer's premises (every cited line) resolved correctly, and I re-checked SD-01, SD-02, SD-04, SD-05, SD-06 and SD-09 against the code and spec before accepting them.

| ID | Sev | Finding | Folded as |
| --- | --- | --- | --- |
| SD-01 | BLOCKER | PA-2 said "no rebind" and "B reads history" at once; three fences exclude B. | PA-2: only the prover reads; B does nothing while it is valid; AC-PA-04b. |
| SD-02 | BLOCKER | PA-4 left presentation as a cold miss, so backfill still failed; spec line 114 says only identity is a miss. | PA-4: identity mismatch alone rebuilds cold; AC-PA-10b. |
| SD-03 | MAJOR | "Keep serving stale and retry" is unbounded staleness. | PA-4: tolerated-counter publish stamped with `before`; maximum stale age; AC-PA-13b, 13c. |
| SD-04 | MAJOR | `freshness()` is age-only, so "marked stale" was unsatisfiable. | PA-4: explicit `stale: true`; memory entry retained; AC-PA-13 observable is "resolves". |
| SD-05 | MAJOR | A sibling's revision is not readable from stored state; `lockSlackSelection` locks and decrypts. | PA-2: lock-free, token-free join; disabled handled explicitly; AC-PA-06b. |
| SD-06 | MAJOR | A budget-`blocked` reservation is written as an `unverifiable` verdict. | PA-1: deferred and blocked write no channel state; hook contract; AC-PA-03b. |
| SD-07 | MAJOR | "Never below the historical floor" is undefined. | PA-3: zero-only clamp, computed once in `fetchAndAccept`. |
| SD-08 | MAJOR | 300 s costs real budget. | PA-3: 60 s default; AC-PA-09b. |
| SD-09 | MAJOR | A fence written while a variant is live freezes it. | PA-5: fence only when none remains; AC-PA-17a, 17b. |
| SD-10, 11, 12 | MINOR | Directory-less paths; check 3 needed a stated purpose; ownership labels. | Paths qualified; purpose stated; PA-3 ownership corrected to the discovery file. |

Still open after this revision: whether the real-Postgres harness can drive two real workers for AC-PA-01 and AC-PA-02 (use the isolated tier), the per-hit latency of the stale path, and whether the UI renders a data-stale row as stale. The PA-2 and PA-4 text above is the third revision; the round 2 and round 3 tables below say what changed. The simplified PA-2 has **not** been re-reviewed.

## Review record: Fable spec review, round 2 (2026-09-21)

Verdict: **PA-1, PA-3 and PA-5 ready for an Opus builder; PA-2 and PA-4 need one more short revision, no re-architecture.** I re-checked SR-01, SR-03, SR-06 and SR-09 against the code and spec before accepting them.

| ID | Sev | Finding | Folded as |
| --- | --- | --- | --- |
| SR-01 | MAJOR | A valid prover whose token cannot read the channel keeps it unreadable; readability is per token, public-ness per channel. | PA-2 condition 4 (reachability error code), AC-PA-06c. |
| SR-02 | MAJOR | Proof age was not in the validity definition; a non-prover re-proving at one interval would refuse the prover's in-flight acceptance and idle the channel. | PA-2: prover re-proves at one interval, takeover only when invalid or older than twice the interval; AC-PA-05b. |
| SR-03 | MAJOR | The tolerated-counter publish deviates from spec line 114's letter; prose over deleted messages undecided; `salvageSummaries` shares a helper with the compare-and-set. | PA-4: recorded as a deviation for adjudication; summaries omitted on a data-lag serve; salvage stays strict, helpers separated. |
| SR-04 | MAJOR | AC-PA-13 was unsatisfiable under the revision. | Rewritten; AC-PA-13d is its inverse. |
| SR-05 | MAJOR | The cold inline path still throws on any counter, so an identity correction during a backfill fails. | PA-4: one publish rule for both paths; AC-PA-14c. |
| SR-06 | MAJOR | PA-2 retires behavior the fences suite builds a fixture on. | Listed as an existing test changed on purpose. The exact assertion in that region is not verified by me; the builder re-reads it. |
| SR-07 | MINOR | The recomputed revision only matches with the binding module's microsecond rendering. | PA-2: the read lives in `slack-source-binding.ts`; AC-PA-06d. |
| SR-08 | MINOR | Hook failure semantics and where a blocked bucket is observable. | PA-1: promise rejects, no new result variant; step report and budget row named. |
| SR-09 | MINOR | Runbook said 300 s; two steps needed OPEN markers. | Runbook corrected. |
| SR-10 | MINOR | PA-4 check 3 is a sibling of PA-2's read and must fail, not pass vacuously, when no integration exists. | PA-4 check 3 rewritten. |

## Review record: Fable spec review, round 3 (2026-09-21), PA-2 and PA-4 only

Verdict: **PA-4 ready after TR-05 and the three clarifications; PA-2 not ready.** The PA-2 blocker (TR-01) was not patched a fourth time: it showed that inferring a prover's health from stored state cannot work, because the prover's own re-proof rewrites the evidence. PA-2 was simplified and the limitation it cannot solve without a schema change is recorded and pinned.

| ID | Sev | Finding | Folded as |
| --- | --- | --- | --- |
| TR-01 | BLOCKER | The takeover throttle and the age rule key on `public_checked_at`, which the prover's own failed re-proof rewrites, so takeover can starve in exactly the cases the conditions were added for. | PA-2 simplified: no age rule, no throttle, no reachability inference. Validity is three stored facts; the readability gap is a recorded limitation, pinned by `it.fails` (AC-PA-06c). |
| TR-02 | MAJOR | Condition 4 named three codes, five exist, plus auth errors; attribution to "that prover" was by inference. | Removed with the condition; the codes are listed in the limitation. |
| TR-03 | MAJOR | With a 1/min `conversations.info` allowance a proof cannot stay under twice the interval for an integration with more than 60 selected channels. | Removed with the age rule. |
| TR-04 | MAJOR | After the binder's own config edit both it and the sibling would act; AC-PA-05 depended on ordering. | The binder alone re-proves after its own edit; the sibling takes over only when the binder is disabled, deleted or de-selects the channel; AC-PA-05, 06 rewritten. |
| TR-05 | MAJOR | A stale serve starts a refresh on every read, each running the model summary pass. | PA-4 refresh spacing (default the TTL); AC-PA-10c. |
| TR-06 | MINOR | Summaries are omitted on any generation lag, not only data; AC-PA-10 needs an integration fixture. | PA-4 text and AC preconditions. |
| TR-07 | MINOR | `stale: true` reaches the wire only on the team-work route; `freshness()` has no override. | PA-4: `freshness()` override; the UI gap recorded, not solved. |
| TR-08 | MINOR | Required-fingerprint `salvageSummaries` changes an untyped test file. | Listed as changed on purpose. |
