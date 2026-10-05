# AIO-1170 — pre-activation corrections (P1-01, P4-01, P4-07, P4-02, P2-02)

Status: **revised after two Fable spec reviews (2026-09-21). PA-1, PA-3 and PA-5 were judged ready for an Opus builder by the second review. PA-4 was revised a second time and a third review judged it ready once its refresh-spacing finding and three clarifications were folded, which they now are. PA-2 now has a four-condition stored-state predicate and a retained, pinned token-readability limitation. Two fresh independent Opus 5.5 reviews on 2026-10-05 returned NOT READY; Astra has resolved the second review’s N1–N8 in the text below. PA-2 is awaiting its third independent readiness re-review and is NOT READY for implementation.** Original author: Sonnet 5 (coordinating session); current PA-2 author: GPT-6 Astra. Design prose only, no code. Reviewer: Fable 5.1. Builder for the code: Opus 5, because four of the five items are concurrency, retry or authorization semantics (repo routing: uncertain, cross-owner state, privacy). Date: 2026-09-21.

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
| P4-07 | Read: `needsSlackPublicProof` (`slack-source-discovery.ts:707`), the re-record (`:680`), and **three** fences that exclude a non-binding integration: the history-lane selection (`:798`), `claimSlackChannelPage` (`slack-channel-state.ts:550`, `binding_integration_id = $4`), and the acceptance lock. | The request count of a real two-integration run: AC-PA-04. |
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

**Decision.** The integration named in `binding_integration_id` (the **binder**) is the only integration permitted to claim or accept a history page for that channel. Preserve the binding checks in `readOnePage`, `claimSlackChannelPage`, and `lockSlackChannelForAcceptance`, and preserve metadata-attempt ordering.

Before a foreign-bound channel is chosen for metadata proof, perform a lock-free, token-free validity read in `slack-source-binding.ts` in a short caller-owned transaction. Scope it to the channel's team and recorded binder ID; the integration must be `type = 'slack'`, and its binding joins on both team and integration ID. A missing integration or binding is invalid. A cross-team or non-Slack binder ID matches no row in this scoped lookup and is invalid; never perform an unscoped lookup to distinguish these cases. The binder is **valid** iff all four stored facts hold:
1. its integration row is `enabled`;
2. its `slack_integration_bindings` state is `verified`;
3. the channel ID belongs to canonical selected IDs from the integration's current `integrations.config`, using `canonicalSlackChannelIds` semantics (never the binding's cached `selected_channel_ids`); and
4. its binding `workspace_id` equals the channel row's `workspace_id`.

The read selects no secret or token fingerprint, resolves no environment token, decrypts nothing, recomputes no configuration revision, and takes no row lock. Database errors propagate; they never make a binder invalid and permit takeover. `lockSlackSelection` is not used because it locks and decrypts the other integration.

A valid foreign-bound channel is skipped: no metadata reservation/attempt, `conversations.info`, history request, or rebind. Skip and continue in the metadata candidate loop so a coalesced channel cannot block another eligible one. Emit a metadata step with `result: "skipped"`, category `bound_to_valid_integration`, static detail “Another enabled, verified Slack integration selects this channel in this workspace,” the channel ID, and no method; it consumes no request allowance. Exclude only skipped steps with category `bound_to_valid_integration` from the deferred rollup in `finish()`: a warmed pass containing only these stand-down steps has `outcome: "idle"`. All other outcome precedence remains unchanged, including other skipped steps contributing to `deferred`, successful work contributing to `progressed`, and blocked/inactive outcomes retaining their existing precedence.

Keep `needsSlackPublicProof` pure and unchanged; foreign-binding validity is a separate candidate filter. An invalid binder takes the ordinary first-proof/takeover path without a proof-age delay. Existing budget, provider-verdict, configuration-revalidation, metadata-attempt, and acceptance fences still control requests and acceptance; “immediate” adds no takeover delay.

The binder applies its existing cadence and revision checks while it remains binder. After a config change retaining this channel and before the binder’s next pass, a still-verified binding remains valid under the four conditions and the sibling stands down; a stored revision mismatch is not an additional validity input. The binder’s next pass invalidates and reboots its identity. While that identity is `pending_auth`, `pending_app`, or `blocked`, another eligible integration may prove and take binding. Once takeover succeeds and remains valid, the former binder stands down on later candidate reads, including after it finishes bootstrap. This is a stored-state decision, not exclusive ownership: an already admitted request can finish through existing fences. PA-2 adds no cross-integration lock, hand-back protocol, proof-age rule, takeover throttle, or global one-flip guarantee.

**Why "disabled" and "de-selected" need their own check.** Disabling an integration updates only `integrations.status` and `updated_at` (`lib/integrations/manage.ts`); the binding row keeps its verified state and old revision forever, because a disabled integration never runs again. Removing a channel from current `integrations.config` likewise leaves the binder's binding row untouched. Reading the binding row alone would keep treating either as valid.

**Known limitation, decided, not solved.** Whether a channel is **public** is a property of a channel; whether it is **readable** is a property of a token, and nothing records which integration's token can read which channel. A valid binder whose token cannot read a channel another token can (`not_in_channel`, `channel_not_found`, `is_archived`, or an auth error) is therefore not detected: it remains binder until an operator deselects or disables it, or one of the four stored validity conditions otherwise ceases to hold. The same limitation includes a binder with no usable token: `no_token` returns before `bindSlackSelection`, and a secret-decryption exception rejects before that call, leaving an existing verified binding valid. The former is observable as the binder’s selection step `blocked:no_token`; the latter is an ordinary rejected binder pass, not a promised `no_token` diagnostic. Neither makes the sibling infer token health. Public status, proof age, and `last_error_code` are not validity inputs: a valid binder remains binder after metadata `private` or `unverifiable`, and history remains prohibited while non-public. A channel-level history/auth refusal does not itself make the stored identity unverified; if bootstrap independently does so, ordinary invalid-binder takeover applies. The refusal is observable in the binder's pass report and, when the existing failure path writes it, `last_error_code`; the sibling reports `bound_to_valid_integration` and makes no token-reachability inference. Channel errors are current state, not durable history. Three review rounds showed every inference from existing state fails because the binder re-proof overwrites evidence and a hand-back protocol loops at the shared rate. A fix needs per-integration reachability state, a schema change out of scope here. The historical assertion that production had one enabled integration on one channel is explicitly dated 2026-09-09; this review does not verify it today.

**Acceptance.**
- AC-PA-04: two integrations select one scoped channel; sequential passes while the initial binder is valid produce exactly one `conversations.info` across initial proof/subsequent passes, one frontier, and no binding change.
- AC-PA-04b: after warm-up, repeated non-binder passes make zero channel requests, produce the static skipped diagnostic with `outcome: "idle"` when no other work occurs, and leave its channel row unchanged; binder cadence remains governed by the existing predicate.
- AC-PA-04c: a valid foreign-bound channel before another eligible candidate is skipped while the latter is proven; the former consumes neither allowance nor metadata attempt.
- AC-PA-05: after a binder config change retaining the channel, complete its bootstrap/proof before the sibling pass; it re-proves once and the sibling makes no request or rebind. This intentionally specifies ordering.
- AC-PA-05b: leave the binder `pending_app` through a deferred real `bots.info`; a previously verified sibling with budget proves/takes binding. After former-binder bootstrap completes, it makes zero shared-channel requests and does not take binding back while the new binder stays valid. Assert intermediate states and exact counts.
- AC-PA-05c: edit binder config while retaining the selected channel, then run a warmed sibling before the binder runs. With the binding still verified and workspace unchanged, assert zero sibling provider requests, the static skipped diagnostic, `outcome: "idle"`, and the entire channel row unchanged. Then run the binder with sufficient budget through bootstrap and assert exactly one `conversations.info` re-proof at its new revision. A revision mismatch alone must never admit sibling takeover.
- AC-PA-06: independently cover disabled, deleted, deselected, missing-binding, `pending_auth`, and `blocked` binders. For each case, use an already verified eligible sibling with budget and a channel with stored partial historical progress. A pass with one request allowance sends exactly one sibling `conversations.info` and zero history HTTP requests. It is not a metadata-only state transition: the existing reader may claim and release a lane after exhausting the allowance. After the pass, assert binding equals the sibling and its current revision and one frontier row remains. Assert preservation of both cursors and scan generations, the existing historical anchor and oldest-seen timestamp, historical-floor status, completed interval bounds, provisional catch-up upper bound, and `last_read_at`; preserve any already initialized newest anchor/lower bound as well. Allow ordinary no-send claim/release bookkeeping (`next_lane`, due/error/lease fields, lease generation, attempts, update time) and initialization of previously unset newest anchor/lower bound. For deterministic historical resumption, start this partial-history fixture with `next_lane = 'newest'` and no live lease: the no-send newest claim/release leaves `next_lane = 'historical'`. Then allow history with budget and assert the next history request sends the saved historical cursor and anchor (`latest`); normal accepted history may subsequently advance progress. Do not add a production pre-claim allowance guard for this test. For deselection, change current config and run the sibling before cached selection refresh. These takeover/progress assertions also apply to the invalid-binder takeover cases in AC-PA-06b.
- AC-PA-06b: directly call the exported foreign-validity function with a recording session, independently of pass-level own-selection reads. Assert team and recorded binder ID parameters, the Slack-type predicate, the join on both team and integration ID, and statement text without `for update`, `secret_ciphertext`, or `token_fingerprint`; inspect the helper to confirm no environment-token resolution, decryption, or revision computation. In a pass-level test, give an otherwise valid foreign binder an undecryptable `secret_ciphertext` and assert clean sibling stand-down, zero requests, and an unchanged channel row. Independently exercise cross-team and wrong-type binder IDs: each matches no scoped row, returns invalid, and permits the sibling’s ordinary proof path with AC-PA-06’s exact request/binding/frontier/resumption assertions. Workspace mismatch likewise returns invalid (AC-PA-06e). Separately inject a SQL failure into the validity read in a warmed sibling pass: the pass rejects, sends zero provider requests, and leaves the channel row unchanged; it must not convert the error to invalid/takeover.
- AC-PA-06c: a normal test establishes a valid binder, causes a real history reachability refusal, and asserts persisted refusal/binder report before later writes. Repeated sibling passes leave binding unchanged, make zero requests, and report stand-down. Pair it with `it.fails` whose only expected failing assertion is sibling takeover; setup/preconditions occur outside its body.
- AC-PA-06d: metadata `unverifiable` and `private` valid binders retain binding, show binder verdict/category, and make the sibling stand down with no history request.
- AC-PA-06e: a binder verified for `(W1,C)` reboots into W2 while retaining C; a verified W1 sibling takes W1's frontier, while W2 remains separate. Removing workspace equality fails this test.

**Tests.** Real Postgres, extending bootstrap coalescing and preserving existing fences. Existing tests intentionally change: the late-public fence uses two passes of the same binder, ages the shared metadata budget with `elapse` while the first response is held so the second can actually reserve, and distinguishes the two responses by call order rather than token/authorization. It retains its two-attempt/private-wins/refused-late-public assertions; the in-flight-history privacy fence uses the reader's same integration for overlapping metadata. Age the public proof inside the held history handler, before invoking the nested metadata pass (not before the outer reader pass), with the metadata budget available; assert that revocation really occurred and retain refused-page/refused-claim assertions; the binding-column deletion fixture starts with the deleted integration as binder and retains paired-null/progress/survivor-resumption assertions. The bootstrap coalescing test retains one-row/two-selection assertions and adds request/binding stability. `needsSlackPublicProof` stays unchanged, including its foreign-binding unit assertion. AC-PA-02’s two-integration ordering fixture on an unbound channel remains valid and retains its coverage. Record each fixture change and reason; do not weaken metadata ordering, privacy revocation, claim, or acceptance fences.

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

Still open after this revision: whether the real-Postgres harness can drive two real workers for AC-PA-01 and AC-PA-02 (use the isolated tier), the per-hit latency of the stale path, and whether the UI renders a data-stale row as stale. The round 2 and round 3 tables below record the historical September revisions. PA-2’s current four-condition text has since received two fresh independent Opus 5.5 reviews on 2026-10-05 and the author corrections below; it awaits the third independent readiness re-review and is not ready for implementation.

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

## Author adjudication: PA-2 material revision (2026-10-05)

A fresh independent Opus 5.5 review found the simplified PA-2 not ready. Astra accepted the workspace-validity gap, retained-fence fixture scope, and reference drift, and accepted the remaining findings with qualifications. The resulting PA-2 rule has four scoped stored conditions: enabled Slack integration, verified binding, current canonical selection, and binding workspace equality. It also makes the bootstrap window explicit: a `pending_auth`, `pending_app`, or `blocked` binder may be taken over, but the design promises no global one-flip result under concurrent calls.

The design now requires skip-and-continue with a static stand-down diagnostic, preserves `needsSlackPublicProof` as a pure predicate, makes the known token-readability limitation observable and non-vacuously pinned, and enumerates the security/order/deletion fixtures that must retain their original fences. No schema, activation, publisher, or token-reachability work was accepted. The per-token readability limitation remains decided and scoped out.

This supersedes the earlier TR-04 wording that implied the binder alone re-proves after every configuration edit, and the earlier three-fact validity description. PA-2 awaits a fresh independent re-review; it is not ready for implementation.


## Author disposition: PA-2 N1–N8 after independent Opus round 2 (2026-10-05)

GPT-6 Astra accepts N1–N8 from the successful terminal result of independent Opus 5.5 session `25480971-1d63-4f30-b7c7-48bce0d5f07a` (reviewed checkpoint `8c65fd4b`). These are bounded specification/acceptance corrections; the four stored conditions and decided per-token readability limitation remain the contract.

| Finding | Disposition and exact decision |
| --- | --- |
| N1 | Accepted. Cross-team and wrong-type IDs are absent/invalid under the scoped read and use ordinary re-proof takeover. Only SQL failure rejects the read/pass. Decision and AC-PA-06b agree. |
| N2 | Accepted. Only `bound_to_valid_integration` skipped steps are excluded from the deferred rollup; an otherwise idle warmed pass is `idle`. Existing other outcome precedence remains. AC-PA-04b asserts it. |
| N3 | Accepted. AC-PA-05c pins sibling-before-binder ordering after an edit retaining the channel: still-verified binder means stand-down, then exactly one binder re-proof. Revision mismatch is not a fifth condition. |
| N4 | Accepted. Same-binder late-public fixture ages the shared budget while the first response is held and distinguishes responses by call order. History-revocation fixture ages proof inside the in-flight handler. All original security/order assertions remain. |
| N5 | Accepted. Direct recording-session helper assertions isolate SQL properties; an undecryptable foreign secret pins pass-level non-decryption. Own-selection reads remain legitimate. |
| N6 | Accepted. Current status and historical-review summary now say four conditions, two fresh NOT READY reviews, and pending third readiness review; the three P4-07 source references are corrected. Historical decision tables remain dated history, superseded by current text. |
| N7 | Accepted with diagnostic precision. No-token and decryption-failure binders are included in the retained limitation; only no-token promises `blocked:no_token`, while decryption failure rejects. No reachability/schema work is added. |
| N8 | Accepted; clarified after pre-push review on 2026-10-05. One request allowance limits HTTP, not channel claims. AC-PA-06 pins one metadata request, zero history sends, binding/revision, retained cursors/scan generations and existing progress, while allowing ordinary no-send claim/release bookkeeping and initialization of an unset newest anchor/lower bound. A deterministic newest-to-historical lane transition then pins resumption with the saved historical cursor and anchor. No production pre-claim behavior is added; later accepted history may advance progress. |

**Readiness: awaiting the third fresh independent Opus 5.5 readiness re-review; NOT READY for implementation.** This author disposition is not an independent review pass. The coordinator must refresh and verify the exact accepted Linear material under the workflow gate before implementation once readiness is established. No code, tests, schema, activation, publisher wiring, merge or deployment changes are part of this correction.
