# AIO-1170 AC-09 — inactive aggregate Slack pagination specification

Status: READY for implementation of the bounded inactive slice. Fresh Opus round 2 returned READY with no blocker/major; its four MEDIUM contract amendments and applicable LOW precision are incorporated below. No third review is required by that review. NOT READY for active integration or AC-09 completion.

This revision adjudicates `opus55-ac09-spec-review-r1.findings.md` (SHA-256 `1e81e95f7e82bf6df5847f14177d56db6a3bbeadf382085d5ea2e5729637cf4f`) against original specification SHA-256 `ad0938a09219a72d250bf2ad35f0f7817fa3b0733fed98caec6abe153e52535b`, source at HEAD `82f8fabcfddec1913ead628b5e730edb6719f296`, and the accepted parent contract in `docs/design/slack-timeline-reliability.md`, especially lines 90–108 and 138–150. Round 2 reviewed specification SHA-256 `92fd5bf43fe34243c3510038ec5b53a25a6d98c74aba61ee9dd1a89e4e83b2af` (50,947 bytes); its persisted result is in `opus55-ac09-spec-review-r2.jsonl`. This amendment is a specification edit only; no implementation or implementation-test execution is claimed.

The locally resolved `origin/staging` is **`c5e832c2ff179ee5c99f95966fba1ed9ce77ae3e`**, verified by `git rev-parse origin/staging` as 40 hexadecimal characters. The earlier one-short identifier was documentation precision, not a product issue; do not invent a missing digit or change the base because of it. This records a local ref, not a fresh remote fetch.

## Scope and ownership

Current item pagination is insufficient: `slack-source-page-read.ts` groups by item/latest message, then `slack-source-evidence-page-read.ts` loads that item's evidence. One item can expand past page size, cannot be resumed within its member/day groups, and cannot establish global aggregate order. Retain these inactive discovery primitives; never relabel their item cursor as an aggregate cursor.

Add an inactive, read-only aggregate paging module, an authenticated snapshot-bound continuation contract, and an inactive complete-drain adapter. Reuse `lookupSlackAccount`, `composeSlackEvidence` and its shared credit oracle/projector, plus `mergeTimelineSlackContinuation`. Suggested files:

- `lib/ingest/slack-person-day-page-read.ts`
- `lib/dashboard/slack-timeline-page-contract.ts`
- `lib/dashboard/slack-timeline-drain.ts`
- New, path-disjoint unit and real-Postgres tests.

Narrow supporting changes may expose session helpers from existing Slack snapshot readers without changing their behavior. An in-session variant may reuse already-complete mapping/roster inputs from the **same transaction** to avoid rereading them per candidate batch. No active route, cache, UI composition, identity writer, shared ingest transaction, schema or migration changes. No production caller imports this service. No second implementation owner for PR743 behavior. The mechanical path boundary below applies even to test helpers.

The public service owns a fresh `REPEATABLE READ, READ ONLY` evidence transaction per page. Reject an ambient transaction unless the transaction helper demonstrably opens a fresh correctly configured transaction; do not modify `lib/db/pg/tx.ts`. All access, source-admission, mappings, roster, item metadata, correction locks, provenance, presentation inputs and messages for that page use that transaction's executor. After it ends, use a separate fresh read-only validation transaction to recompute current authorization and bindings before publishing. No independently prefetched metadata may masquerade as part of either snapshot. This is optimistic validation at the validation snapshot; it does not claim a lock preventing a commit after the final check.

## Server-only dependency boundary

The inactive service accepts trusted server-only dependencies; they are never accepted from a client. They must return complete collections or throw, respect budgets, use the supplied executor, and copy/freeze returned inputs. Tests may supply these dependencies. Implementing a production adapter is a later integration gate, not permission to bypass this contract.

`loadAdmission(query, {teamId, principal, requestedView})` returns:

- `teamId`, canonical stable `principalKey`, the current snapshot `admission: ContentAdmission`, and a canonical `admissionBinding` describing the current principal's admission (including role/grants and eligibility); failure or loss of admission throws.
- `slackItems`: exactly the currently authorized, source-admitted same-team items whose source is Slack. Each entry contains `itemId` and `provenance: {status:'verified', workspaceId, channelId, rootTs, workspaceUrl:string|null} | {status:'unverified'}`. All UUIDs are normalized lowercase. No duplicate/missing item rows. `workspaceUrl` must be a separately verified Slack HTTPS workspace URL, never synthesized from team ID or trusted from frontmatter.
- Source admission must be decided explicitly by the trusted adapter, before candidate limits. Excluded items are not inputs to the evidence query. Read failure is unavailable, never an empty authorized set. Return a canonical `sourceAdmissionBinding` for the current decisions/proofs relevant to these Slack items, so a permission/provenance decision changing between pages cannot reuse old data.

After resolving admission, the service derives `viewKey` server-side from canonical `(teamId, principalKey, admission.kind, requested view mode and filters, locale, presentation-policy version)`; it is never an arbitrary client authorization assertion. Grants/eligibility belong to admissionBinding and are recomputed independently. The key identifies the same logical view across pages; the separate authenticated window/asOf fields identify its snapshot.

The **packet-owned** session reader must select `(id, member_id, member_id_locked)` directly from same-team Slack items for every authorized Slack ID, through the supplied evidence executor and again through the fresh validation executor. It checks exact ID coverage, populates `currentMemberId`/`locked`, and feeds the digest and shared credit composition. These values are not accepted from loadAdmission, a fake metadata dependency, pooled query or cache. The packet also reads the complete current human roster through the in-session shared reader; real correction and roster falsifiers must traverse this production packet code. Missing/foreign/non-Slack rows are unavailable or a detected authorization change, never silently omitted.

The item visibility component must call the real `visibleItemIdsForProjects` with a transaction-bound `DbClient` and current admission, then intersect with same-team Slack items. A session-bound adapter may be implemented in a new module using existing DB facilities, but cannot alter PR743 files. Its real-Postgres test must prove the access query shares the evidence snapshot. No project-set hash substitutes for reading current memberships. A membership change can alter item visibility without changing grants.

`visibleItemIdsForProjects` is not a Slack source-revocation oracle. `isSlackBinderValid` checks enabled verified integration/channel selection, not the complete viewer/source private-channel access policy. This slice must not call that sufficient AC-11 proof. For inactive tests, an explicitly injected source-admission dependency can model revocation and failure. A named, reviewed production source-admission/provenance adapter and real private/channel/credential revocation tests remain activation-blocking AC-11 work; no new production authorization policy is invented here.

`loadPresentation(query, {teamId, principal, admission, slackItems, asOf, windowDays, viewKey})` returns an immutable, complete JSON-safe presentation bundle for **all authorized Slack items**, their relevant task associations and member display fields (not only current candidates). Bundle content must include every field used to render Slack evidence: item title, verified link context, task IDs/titles/status/source/assignee displays, member name/handle/avatar, association metadata, locale and label policy version. The principal and admission must be those resolved in that same snapshot. Filter tasks, associations and their assignee/display fields through the existing provenance owner (`contentReaderFor`, `provenanceCtxForReader` and `rowVisibleByProvenanceCtx` / corresponding SQL owner), using the current real-oracle visible IDs in that executor. Visibility of a Slack thread does not grant access to its linked task or task fields. Only authorized associations enter the bundle/digest; task visibility changes are therefore observed by rereading and filtering the complete relevant bundle. No credentials, private excluded items or unrelated non-Slack inventory. The service computes its canonical digest; a caller-supplied assertion of freshness is insufficient.

`composeSlackPage({aggregates, presentation, asOf, windowDays}) -> TimelineDay[]` is pure and synchronous: no clock, database, authorization calls or mutation. Every input aggregate must appear in output at least once, under its member/day and stable evidence ID; task associations may duplicate that ID. No invented/omitted Slack IDs, no non-Slack evidence, no synopsis or signals. `at`, root/reply wording, count and bounded link selection must reflect the aggregates; a locked owner with no messages cannot be rendered. Day labels derive from the fixed `asOf` UTC day and bound locale/policy, never ambient today. The service validates returned ID/member/day/at coverage and the normal page/merger shape; invalid composer output is unavailable. This slice tests the contract with deterministic injected composers. Reusing/extracting the real `work-timeline.ts` presentation path and end-to-end title/link/association proof is deferred to coordinated integration, not a second Slack production composer.

The first-page factory additionally loads existing non-Slack days once, through the same authorized evidence transaction using a trusted `loadInitialNonSlack(query, {teamId, principal, admission, viewKey, asOf, windowDays}) -> {days: TimelineDay[], sourceItemIds: readonly string[]}` dependency. The complete deduplicated sourceItemIds cover every source-backed evidence row, citation, signal and synopsis dependency returned; genuinely unsourced authorized rows retain their existing provenance rules. Missing backing-ID coverage is an incomplete dependency result. Its labels use the same bound asOf/locale as the Slack composer. The service traverses all returned groups and rejects any Slack-source group as unavailable before merging, including legacy Slack rows from a reused active builder. Continuations do not call it. This data is frozen for the attempt; its existing source semantics remain the dependency's responsibility. Carry these immutable backing IDs as internal first-page/drain metadata, not in the v1 DTO or a growing cursor payload. First-page publication and the final drain validation must require this set to remain a subset of the current **real** visibleItemIdsForProjects result under current admission. Removal is restart_required; read failure is unavailable. Do not replace the IDs with an all-visible-items fingerprint: unrelated additions do not restart. The drain must perform this check in a fresh validation transaction before returning, including a one-page drain; the fresh validator also checks the complete Slack binding. No global non-Slack inventory fingerprint or refresh is introduced. A fresh whole-drain attempt obtains a fresh authorized initial page, omitting revoked items.

## Aggregate contract and order

One aggregate is `(itemId, memberId, UTC day)`. Multiple qualified accounts for the same person merge; task associations never affect cursor or credit identity.

Emitted `SlackAggregate` is a compact projection of the authoritative `SlackPersonDay`:

- `id = JSON.stringify([itemId, memberId, day])`, `sourceItemId`, `workspaceId`, `channelId`, `rootTs`, `memberId`, `day`.
- `at`: exact six-digit-microsecond UTC maximum surviving eligible in-window occurrence.
- Full deduplicated `messageCount` and `rootAuthored` for **in-window** messages, including on boundary days.
- `linkMessage: {messageTs, occurredAt}` only. If `rootAuthored`, select the surviving root actually authored by this member on this day; otherwise select the latest surviving message in this group, tie-broken by messageTs ascending. A deleted root never supplies this link. Preserve rootTs separately for thread context.

Do not expose the projector's unbounded `messages[]` on the page/cursor. Compute the compact record only after complete shared projection/validation. With verified workspace URL, future presentation uses the selected message's Slack permalink (`/archives/<channel>/p<messageTs without dot>`, with thread context as needed). Otherwise use authenticated `/library/<sourceItemId>` plus the selected source message details. Never embed secrets. Provider identity strings in the compact record are at most 256 UTF-8 bytes each; compact aggregate serialization must be at most 2048 bytes. Invalid oversized source identity is unavailable (no truncation). Count remains exact, with safe-integer overflow rejected. Internal full-ledger cost still has a budget; compact output alone does not solve arbitrarily large input cost.

Order is exactly:

```text
day DESC, at DESC, itemId ASC, memberId ASC
```

Cursor stores all four fields. SQL comparisons for IDs are `uuid`-typed; output and cursor IDs are canonical lowercase, making SQL order agree with the projector's lexical order. Group the UTC day using `occurred_at AT TIME ZONE 'UTC'`, never session-local `occurred_at::date`.

```text
day < last.day
OR (day = last.day AND at < last.at)
OR (day = last.day AND at = last.at AND itemId > last.itemId)
OR (day = last.day AND at = last.at
    AND itemId = last.itemId AND memberId > last.memberId)
```

Apply this to completed aggregates after `GROUP BY`. Never push `occurred_at <= cursor.at` into the message input: it would reaggregate a previously emitted group with a different maximum/count. Only a whole-UTC-day exclusion proven not to split any group may be pushed down, in addition to fixed inclusive since/asOf filters. Page size is an integer 1–512, default 128; it is not a corpus cap.

## Read algorithm and strict provenance

1. Capture/validate mutable inputs and configuration before first await; copy dates/sets. Read complete admission, team mappings (including collision-relevant provider/case variants), current human roster and durable generations in the evidence transaction.
2. Use the packet-owned session reader for correction lock/owner inputs; read provenance/presentation inputs for the complete authorized Slack set; compute bindings below. Canonical serialization means fixed field order, sorted UUID/item/roster rows, explicit null/absent markers and recursively sorted object keys. SHA-256 binds the canonical bytes, not iteration order.
3. **Before candidate filtering/limiting**, validate provenance completeness/conflicts over authorized source-ledger items. Any eligible nondeleted ledger author requires verified item workspace matching all such authors, even authors outside the requested window or unresolved by identity. Check complete ledger thread binding as well. Missing proof or contradictory workspace/channel/root fails the page as unavailable; a WHERE/JOIN that silently drops conflicting rows is forbidden. Query an existence/conflict check over the full authorized set or bounded complete scans; propagate every read failure. Empty/absent ledgers are explicitly represented and produce no source group, as the shared oracle permits; legacy items with no source authors do not require invented verification. Unverified provenance is distinct from a deliberate source-admission denial.
4. Build canonical resolved `(workspace,user,member)` relation with `lookupSlackAccount` and the complete live mappings/human roster. Omit unresolved/ambiguous/nonhuman accounts. Never implement a second permissive SQL resolver. Parameterize this relation in the SQL join.
5. SQL joins ledger messages to same-team Slack items, authorized IDs and the canonical account relation. Apply eligibility, deletion, fixed inclusive since/asOf and visibility/source admission before grouping. Provenance has already been validated, so a matching verified join cannot hide a conflict. Group by `(item,member,UTC day)` and keyset-page candidate groups, never a capped item set.
6. Load each candidate item's full ledger and complete in-window messages in bounded internal batches through the same executor. Reuse `composeSlackEvidence` and shared credit composition. Minimum metadata: `teamId`, `itemId`, `source:'slack'`, `currentMemberId`, `locked`, verified workspace. For this **verified-ledger-only** slice, `frontmatter:null`, `legacyVersionMemberIds:[]`, `legacyLatestWorkerId:null` may be explicit empties and historical legacy discovery omitted, because no absent-ledger fallback is emitted. Never use such empties to disguise a failed read.
7. The shared projector is authoritative for emitted ID/at/count/root flag/thread identity. Before credit filtering, compare complete unscoped `projectSlackPersonDays` output using the same resolver/roster with SQL candidates **in both directions** for every loaded candidate item and the batch's scanned keyset interval. In the specified traversal order, the interval is strictly after the prior scan frontier and through the current batch's last scanned tuple inclusive; the initial frontier is before all groups, and proven SQL exhaustion extends the interval through the end of the window. Projected groups and SQL groups in that interval must have exactly equal sets of IDs, with identical tuple, count, root flag and thread identity. Track loaded items/projected group tuples across internal batches so a missing later group is detected when the frontier advances or exhaustion is claimed, even if that item is absent from a later batch. This state is budgeted. Extra or missing groups in either direction are unavailable; do not merely test returned SQL rows. Items SQL never surfaces are outside this per-loaded-item check; full account-relation completeness and saturation tests remain mandatory and this check is not a claim to detect every possible discovery bug. Then emit only groups surviving `composeSlackEvidence` with `verified_message_ledger_present` credit. Legitimate lock suppression is not a SQL mismatch; an unexplained missing/different candidate is unavailable. Locks suppress other authors and never transfer messages to the owner.
8. Continue scanning until `pageSize + 1` **deliverable** groups exist or candidate exhaustion is proven. Rejected groups consume budget, not external page slots. Additional group is lookahead only. Emit at most pageSize, and resume from last **emitted** tuple, not last scanned/lookahead tuple. Preserve complete group counts across every internal batch.
9. Compact message-link payload, compose/validate days, perform fresh external binding validation, then return or throw atomically. No partially accumulated page is consumable on failure.

Complete mappings/roster and provenance scans occur at least once per page and again for external validation. Existing credit snapshot helper repeats mappings/roster when called per candidate batch; either avoid that with same-session reuse or meter/document every repeat. The initial implementation may reread a large item's ledger while advancing across its groups; measure and record the cost. No optimization may create a second credit policy. This revision retains whole-authorized-Slack-scope digests/preflight regardless of requested window, twice per page. Measure their row/byte/runtime cost and record that an out-of-window Slack title, task presentation or roster change can restart in-window traversal. Narrowing that scope is a later reviewed optimization, not a builder discretion or a change made by this amendment.

## Binding, cursor authentication and failure

The continuation binds:

```text
schemaVersion = 1
teamId, principalKey, viewKey, admissionBindingDigest, sourceAdmissionBindingDigest
authorizedSlackItemFingerprint
windowDays, since, asOf, issuedAt, expiresAt
pageSize
dataGeneration, identityGeneration, presentationGeneration
creditInputDigest, presentationInputDigest
lastAggregateTuple
```

Store canonical admission and source-admission bindings as SHA-256 digests (`admissionBindingDigest`, `sourceAdmissionBindingDigest`) in the authenticated cursor; recompute them from complete current input, never store grant arrays or proof inventories in the token. Hash canonical viewKey similarly for its cursor representation. Cursor encoding overflow is budget_exhausted with no consumable page; decoding an oversized untrusted token is invalid_request. No truncation or unsigned spillover.

Use a server-only injected 32-byte `slackTimelineCursorKey`, AES-256-GCM authenticated encryption, a fresh cryptographic 12-byte nonce per encoding, a 16-byte auth tag, and versioned fixed AAD `aios/slack-timeline-cursor/v1`. Cursor wire form is an opaque base64url token with version/nonce/ciphertext/tag; max encoded size 16 KiB. Do not log or place the key in source; no new environment/production configuration is wired in this slice. Key rotation invalidates existing tokens as invalid_request because authentication cannot establish their former binding. Shared secure key provisioning/rotation across workers and the principal-bound cursor versus shared first-page cache policy are named later integration gates. Authenticate before trusting payload, then strict schema/size validation. Missing key/config is unavailable. Tests inject a key; use the runtime crypto library, not custom cryptography.

TTL is **15 minutes from the initial request**, with injected wall clock `now(): Date`. Allowed windowDays are **7, 14, 21, 28, 30**; v1 permits 7 only. `asOf = initial now`, `since = asOf - windowDays * 86_400_000ms`, inclusive. `issuedAt = asOf`; `expiresAt = issuedAt + 900_000ms`. Continuations retain these values exactly and never extend TTL. Canonical instants for these request fields are millisecond UTC strings; aggregate tuple at remains six-digit microseconds. Validate actual calendar validity (round-trip), since/asOf formula, finite dates, safe-integer millisecond arithmetic without overflow, tuple day agreement and tuple in-window bounds. An authenticated payload with issuedAt later than the current wall clock is invalid_request (zero tolerated future skew); tests inject clocks explicitly. A valid signed cursor's item must still be in the current authorized Slack set. Current pageSize/window/team/principal/view must match the authenticated binding. Injected monotonic clock controls elapsed budgets independently of wall-clock expiry.

In-lifetime replay is permitted and returns equivalent evidence/order/completeness under unchanged complete bindings. It is not a one-time nonce. Opaque token bytes may differ because encryption uses a fresh nonce; progress/replay checks compare authenticated tuples and bindings, never ciphertext equality alone. Any changed bound state requires restart. Expiry at `now >= expiresAt` requires restart, checked both on admission and immediately before page/final-drain publication; expiry during a successful read therefore returns restart_required. Recheck future-issuedAt at publication too; backward wall-clock movement before issuedAt fails invalid_request. Replayed expired tokens never slide expiry.

| Mutable input | Detection before continuation and again before publication |
|---|---|
| Ledger content, eligible/deleted state, source occurrence/root/author | Existing `dataGeneration` maintained by supported ledger writers; real writer tests, no manual test stamp. Unsupported direct SQL mutations are not an alternative production writer. |
| Live mapping/remap/unlink/collision rows | Existing `identityGeneration`; also include complete canonical live mapping rows in `creditInputDigest` so read-only binding detects unstamped relevant inputs. |
| Item `member_id` and `member_id_locked` | `creditInputDigest` over **every authorized Slack item's** `(id,currentMemberId,locked)`; the real correction writer does not bump Slack generation. |
| Human/nonhuman/connector roster eligibility | Same digest includes sorted complete current human member ID set (`kind='human' AND is_connector=false`). |
| Verified workspace/channel/root proof and workspace URL | Same digest includes each item's explicit provenance status/fields; `sourceAdmissionBinding` plus strict validation prevents silent conflicts. |
| Viewer admission, grants, actual item memberships and source-admission decisions | Fresh admission/read oracle plus admission/source binding and sorted **Slack-only** item-ID fingerprint; not merely project hash. |
| Slack item title/actor/author/channel | Existing `presentationGeneration` plus complete `presentationInputDigest`. |
| Task associations/status/title/assignee, member name/handle/avatar, link inputs, locale/label policy | Canonical complete `presentationInputDigest`; these are not certified by Slack presentationGeneration alone. |
| Window/asOf/expiry/page size/sort tuple | Authenticated token and strict value validation; labels use bound asOf. |
| Initial non-Slack evidence/signals/synopsis | Initial snapshot frozen once per attempt; complete backing source IDs must still be a subset of the real-oracle visible set at first-page and final-drain publication. Revocation restarts; unrelated additions do not. Existing rules govern genuinely unsourced rows. |

Digest covers all authorized Slack items, not just candidates/emitted rows; otherwise a lock change on an already-emitted group is invisible. Include canonical mapping rows with exact provider/external spelling and state; do not normalize away collision evidence. Read/recompute all bindings in a **single fresh validation snapshot**, including credit/presentation digests, not solely generation counters. Compare against the evidence snapshot and, for continuation, its original binding. Never attach newer stamps to older evidence.

Failure classes:

- `invalid_request`: malformed/tampered/unverifiable/oversized cursor, invalid caller bounds, unsupported schema. No partial output.
- `restart_required`: authentic expired cursor, valid cursor bound to changed request view/window/principal/team/pageSize, loss/change of authorization, changed generation/digest/visibility, tuple item no longer authorized; also a valid-shape cross-page presentation/evidence conflict detected by the merger.
- `unavailable`: core DB/identity/ledger/provenance/access read failure; invalid/incomplete trusted dependency result; SQL/projector inconsistency; malformed composer/page shape or terminal/progress protocol violation.
- `budget_exhausted`: configured runtime, candidate, row, byte or page budget exceeded; complete result unavailable, never successful truncation.

Failure precedence is staged: reject malformed/unverifiable requests before database work. During reads, stop promptly for observed budget/timeout or core failures; do not continue probing solely to collect a preferred error. If complete validation observes multiple conditions together, core invalid/incomplete/provenance/SQL-consistency failures are unavailable before budget_exhausted, and both outrank restart_required. Thus a provenance conflict is never downgraded to a digest restart. Only valid, complete, within-budget snapshots reach binding/expiry checks and merge-conflict handling. A detected loss of authorized ID coverage is restart_required; unexplained incomplete packet-owned metadata is unavailable.

These internal errors do not prescribe current HTTP changes. Future dashboard transport must expose actionable restart semantics; v1 preserves its existing error envelope. A first-page caller may retry an overtaken initial page once. Continuation never silently switches snapshots. The drain owns one whole-attempt retry as specified below, without nested first-page retries.

## Deterministic budgets and terminal invariants

All budgets are positive, injectable server-only configuration, with these conservative initial defaults:

| Scope | Unit/default |
|---|---|
| Internal candidate fetch | At most 512 groups/query, reduced to remaining candidate allowance plus one detection row. |
| One external page | 100,000 candidate groups examined, including rejected/lookahead groups; 2,000,000 DB result rows across all dependency/read/validation queries, counting rereads; 128 MiB cumulative UTF-8 JSON bytes of those rows/bundles; 4 MiB serialized complete page including initial non-Slack days, Slack days and internal envelope metadata; 30 seconds elapsed. |
| Whole v1 drain, including restart | 1,000 page requests including first-page calls; 64 MiB normalized accumulated output; 120 seconds elapsed. |

Count actual materialized result rows/bytes, not pretend that SQL's internal execution work is measurable as returned rows. SQL timeout/cancellation must enforce remaining wall runtime; opaque callbacks must honor the deadline/AbortSignal and reject on timeout. Query batches and dependency collections must be bounded/metered while loading, rather than first materializing unbounded inputs then checking size. One explicit compatibility carve-out applies to the mandatory existing visibleItemIdsForProjects oracle: its query materializes the full result, so meter those executor result rows/bytes immediately after return and before any use, and enforce the SQL timeout. This does not claim a hard peak-memory bound for that query and does not authorize modifying the shared oracle; record/measure that limitation at the activation capacity gate. Test injected clocks/deadlines deterministically. Fail the whole page/drain before returning when any budget is exceeded; reaching an exact maximum without exceeding it is allowed. The additional row used to detect overrun counts. Defaults are resource ceilings, not an accepted corpus cap or performance certification.

A long deterministic rejected run or a single enormous ledger can repeatedly exceed a budget from the same emitted cursor. Report counters and reason in sanitized diagnostics, never skip the run or return empty/complete. Measuring representative saturated-team completion and resolving persistent nonprogress (with an independently reviewed read optimization or operational budget change) is an **activation-blocking capacity gate**. Do not claim this inactive packet solves unbounded input cost or the parent's active retrievability acceptance by returning errors.

For every successful page:

- `slackComplete === (nextSlackCursor === null)`.
- Empty Slack aggregates implies terminal; an initial terminal page may still contain non-Slack days.
- A nonterminal page has exactly pageSize aggregates, because scanning must fill it or fail; terminal page has 0..pageSize.
- Groups are unique and strictly in aggregate tuple order. Every emitted tuple is after the request cursor. An authenticated next cursor equals the last emitted tuple and is strictly after the previous cursor.
- A terminal page still carries the same complete window/view/generation/digest binding, even with no rows; final publication validation is mandatory.

Validate aggregate-level metadata before presentation expansion; do not infer page size or progress from number of TimelineDay rows or task associations. The drain rejects repeated, regressing, cycling or skipped-last-emitted cursors, contradictory terminal flags, empty nonterminal pages, foreign source continuation content and binding changes. Duplicate network page delivery may be idempotently merged by client-style tests, but never counts as advancing a drain.

## Page composition and complete drain

The inactive envelope contains `days`, `window_days`, `asOf`, complete binding, `nextSlackCursor`, `slackComplete`, and internal aggregate IDs/tuples sufficient for validation. These internal fields are not a promise to add fields to v1 or the active HTTP routes.

Normalize initial composition by `mergeTimelineSlackContinuation(nonSlackDays, firstSlackDays)`; continuations contain only their newly returned Slack groups. No repeated other-source evidence/signals/synopsis. The merger unions by day/member/task-or-unlinked/source/evidence ID and computes person totals using unique Slack evidence IDs; task counts may count associations. Always invoke the merger even on empty Slack pages and **normalize an already assembled first page with `mergeTimelineSlackContinuation(first.days, [])`** before any drain return. This gives identical counts for single- and multi-page drain paths. Later active `groupTimeline` and card-total fixes remain deferred.

A valid-shape merger conflict between pages is `restart_required` for the whole attempt; malformed shape is unavailable. Use a packet-owned wrapper that validates both input shapes, duplicate day/person/task structure (evidence-row dedup remains the merger's job), continuation-only constraints and ID/time coverage before invoking the unchanged merger. Any throw in that narrow merger call after those validations is treated as a merge conflict (restart_required); exceptions from loaders, validation or other code are not caught as conflicts. Do not rely on mutable English Error message prefixes and do not change the merger solely to add error types in this packet. Binding checks should detect changing task/member inputs earlier, but defensive conflict classification is still required. No accumulated synopsis is retained for a person whose evidence changed. Future UI must label partial totals “loaded so far”; browser behavior remains deferred.

The inactive v1 drain takes `startPage({windowDays:7, pageSize})`, `nextPage(cursor)`, and `validateFinal({binding, initialNonSlackSourceItemIds})` factories, the cursor validator and budgets, rather than an unrecoverable externally cached first page. Drain pageSize defaults to 128 and is server-configurable as an integer 1–512; it remains fixed across every page and both attempts. Tests may inject smaller values. validateFinal owns the fresh read-only final check of Slack bindings, expiry and the non-Slack backing-ID subset through the real oracle; it does not trust a caller's earlier assertion. Final validation uses the same per-page read-row/read-byte/runtime ceilings and the remaining shared drain deadline, and its resource costs are recorded even though it is not another evidence page. It:

1. Obtains one authorized first page, pins one seven-day asOf/binding, validates and normalizes it.
2. Validates each continuation's complete binding and tuple/terminal invariants, merges with the shared pure merger, and retains no partial-return path.
3. Returns exactly `{window_days:7, days}` only after verified terminal exhaustion, including fresh final validation of non-Slack source visibility, the complete Slack binding and expiry. No continuation/freshness metadata in returned v1 DTO; never treat dashboard initial cache as complete.
4. On `restart_required`, discards **all** accumulated days, cursor and initial non-Slack evidence, then allows **one** fresh whole attempt from startPage with a fresh clock/asOf. All attempts share the total drain budgets. A second restart, any invalid/unavailable/budget/protocol failure or timeout throws; it never returns old or mixed partial data. Whole-drain retry suppresses nested first-page retry, so maximum attempts is two.

An unrelated non-Slack item arriving between pages must not alter Slack-only item fingerprint or presentation bundle, so must not restart this drain. Slack publication still changes its generation and may overtake it; two overtakes fail as designed. Busy-team throughput under this strict snapshot policy is an activation capacity concern, not a reason to weaken consistency. Actual `/api/v1/timeline` and dashboard wiring remains deferred.

## Required falsifiers

Implement these in new path-disjoint test files; use real PostgreSQL for SQL grain, actual supported writers and snapshot/access races. No manually bumped stamp may stand in for the writer being tested. Explicit server-only test seams may pause between discovery and projection and between evidence and validation transactions, inject SQL candidate/relation corruption, and set session TimeZone after transaction configuration; all remain inactive/test-only, preserve read-only enforcement and cannot alter production authorization policy.

| Area | Exact falsifier and expected outcome |
|---|---|
| Discovery saturation | More than ITEM_LIMIT old/unchanged items with misleading synced_at, old root/recent replies, and more than ITEM_LIMIT newer invisible messages/items. Complete traversal emits every and only visible in-window aggregate with unaffected counts. |
| Aggregate grain/global order | One thread spans >pageSize members/days and interleaves with other threads. Pages at sizes 1, 2 and 128 respect global tuple order, never exceed bound, and enumerate each aggregate once. >6 same-day groups survive merger. |
| Reaggregation trap | Same day group A messages at 10:00 and 11:00; group B at 10:30; pageSize=1. First page emits A(count=2,at=11:00), next emits B, and A never reappears at 10:00. |
| UTC/time boundaries | Set transaction TimeZone to a non-UTC zone; messages on both sides of UTC midnight, including DST dates, still split by UTC. Equal six-digit instants with item/member ties advance exactly once. since/asOf boundary-day counts include only in-window messages; future/deleted/ineligible rows excluded. |
| Complete count/link | A group crossing several internal message batches, with thousands of replies, has exact count, correct root flag and one defined linkMessage; compact serialized record <=2048 bytes. Deleted root plus surviving replies chooses latest actual reply. rootAuthored true selects actual surviving root. |
| Identity | Same person multiple accounts merge; unmapped root/mapped replier works; ambiguous aliases/case/provider collisions, cross-team and nonhuman mappings get no credit. Actual remap writer invalidates continuation; complete mapping digest catches relevant unstamped fixture mutation. |
| Real correction B1 / N3 | Run through the packet-owned lock/roster reader (no fake admission metadata). PageSize=1; X has A on day D and B on D-1. Call real applyAttributionCorrection to C between pages, no hand stamp. Page 2 returns restart_required; drain discards attempt and either restarts to fully corrected output or throws on a second overtake. Repeat cleared lock and owner-with-own-message cases. First attempt must never return stale A as complete. Commit a correction mid-evidence-transaction: its digest still sees old owner/lock; fresh validation sees the real changed row and restarts. |
| Roster/provenance B1 | Change human to connector without manual generation change: digest causes restart. Change valid workspace provenance between pages: restart if newly consistent; conflicting/missing eligible-author proof causes unavailable. Repeat after evidence transaction but before external validation. |
| Provenance M1 | Authorized item has eligible ledger T2 but verified T1, and separate missing-proof fixture; both fail even if the identity resolver would omit author or messages are outside window. Empty verified ledger returns no group. Invalid thread binding fails. Inject SQL/projector ID/at/count/root disagreement: unavailable, not lock suppression. |
| Snapshot races | Commit real ledger/mapping/correction writes between candidate discovery and shared projection: evidence transaction remains internally consistent, fresh validation detects overtake. Repeat correction/roster/provenance change after evidence transaction. No new stamp attached to old evidence. |
| Access | Use real visibleItemIdsForProjects on the page transaction. Revoke actual item membership without changing project grants between pages or before validation: restart/no unauthorized return. Access-read failure: unavailable. Inject source-admission revocation/failure with same outcomes; label these seam tests, not production AC-11 proof. |
| Non-Slack revocation N1 | Real Postgres: first page includes GitHub item G; close its actual membership with unchanged grants between pages. Final real-oracle subset check restarts the drain; fresh attempt omits G and returns no old title. Repeat revocation after first-page evidence read before validation. Unrelated non-Slack additions cause no restart. Missing backing-ID coverage fails unavailable. |
| Presentation access N2 | Viewer can see Slack X but not associated task T: existing provenance owner removes T and its associations/assignee display from bundle, digest and composed output. Change a relevant task's visibility between pages: rebuilt filtered bundle changes and requires restart. Assert the loader received the actual principal and evidence-snapshot admission, not an arbitrary viewKey. |
| Two-way projection N4 | Fault-inject a dropped group from an otherwise surfaced multi-group item; separately omit U2 from relation where M maps from U1 Monday/U2 Tuesday. The complete projector has the missing group in scanned interval; both yield unavailable. Also omit a later group and exhaust SQL: retained item comparison at terminal frontier detects it. SQL-only extra group fails likewise. Explicitly retain tests for items never surfaced, outside this comparison's coverage. |
| Cursor M2 | Flip encrypted bytes representing asOf/since/expiry/window/tuple (or any ciphertext byte): authentication yields invalid_request. Validly encrypted malformed calendar/day/UUID/formula/schema payloads fail strict validation. Changed legitimate request team/principal/window/view/pageSize or authorized item set requires restart. At expiry exactly under injected clock: restart. Unchanged replay yields equivalent evidence; no sliding expiry. Key change fails authentication as invalid_request. Cursor encoding beyond 16 KiB is budget_exhausted; large admission/proof collections stay fixed-size through digests. Future issuedAt, backward clock before issuedAt and arithmetic overflow fail invalid_request. Crossing expiry between evidence read and publication, including final drain check, requires restart. |
| Presentation M3 | Deterministic composer renders same-date multi-task groups with exact IDs. Missing/extra IDs, non-Slack/synopsis/signals or wrong member/day/at fails contract. Change task status/member name/title/association after first page: digest restart. Inject valid-shape conflicting days despite unchanged binding: classified restart, never raw merger error. Advance clock across UTC midnight within TTL: labels stay based on asOf and merge successfully. |
| Classification/initial source | Inject malformed merge shape: unavailable before merge; valid-shape merger throw: restart_required; loader throw: unavailable, not merge conflict. Observe provenance conflict together with changed digest: unavailable wins. Return legacy Slack groups from initial non-Slack loader: service rejects unavailable before composition. |
| Budget D1 | Configure maxCandidates=N; N rejected candidates plus a deliverable requiring N+1 throws budget_exhausted, never empty/complete. With N-1 rejected plus deliverable and provable exhaustion within N, succeeds. Exercise rows, bytes, output, elapsed, drain page/count limits and exact-limit boundaries with injected clocks. Meter the real-oracle result immediately after its one materialized query; over-limit result fails before use. Include large initial non-Slack days in the 4 MiB page limit. Large ledger deterministic refusal is recorded as an activation capacity gate. |
| Churn D2 | Add unrelated non-Slack item during drain: no restart. Two successive Slack overtakes across the two attempts: error; one overtake then stable attempt returns only fresh attempt's data/non-Slack snapshot. Shared budgets cannot reset on retry. |
| Terminal/progress D3 | true+nonnull cursor, false+null cursor, empty nonfinal page, false page shorter than pageSize, repeated/regressing cursor, A→B→A cycle, cursor not matching last emitted tuple, terminal binding mismatch: all throw with no partial result. Valid empty terminal normalized result succeeds. |
| Totals D4 | Same Slack ID under two tasks plus another Slack ID and non-Slack evidence. Drain page sizes yielding one vs two pages produces identical normalized output and contribution count; per-task displayed associations remain. Empty final merge still normalizes. |
| Replacement D5 | Existing expansion reducer tests prove replacement/failed-late-response handling only. New pure binding comparator rejects an old continuation after window/asOf replacement. Do not claim the reducer has a continuation action; live client append/restart/expansion proof is deferred. |
| Drain/error shape | Multi-page exhaustion yields exact legacy DTO. Failure at any page/final validation, malformed composer output, timeout/byte overrun never returns partial success. It cannot reuse an initial dashboard cache as complete. |
| Ownership/reachability D7 | Changed-path intersection gate fails if test/datamechanics/helpers.ts or setup.ts is inserted into packet changes. New guarded modules remain unreachable from route/page/action/script/root instrumentation via alias, relative, dynamic and re-export imports; negative controls prove detection. |

Focused suites, typecheck, targeted lint, docs checks and guards are required after implementation. Preserve the build record's known broad-suite failures/hang; do not call the full suite green. Actual dashboard browser traversal, real production presentation/provenance/revocation adapters, HTTP v1 complete-or-error, cache integration (including principal-bound cursor/shared-cache policy and secure shared cursor-key provisioning), representative saturated-team capacity and full AC-09 completion remain later gates.

## Finding dispositions and independently checked evidence

| Finding | Disposition | Independent evidence and decision |
|---|---|---|
| B1 | ACCEPT | attribution-correction.ts updates member_id/locked directly without Slack generation bump. Roster filtering in slack-credit-input-snapshot.ts is live kind/human/connector state. Bind complete read-only credit-input digest; do not edit correction/identity writers or weaken snapshot claim. |
| M1 | ACCEPT, refine proposed remedy | composeSlackCreditBatch requires proof for nonempty authors; composeSlackCreditSelection throws workspace conflict; adapter verifies visible messages. Simply dropping the provenance join is insufficient because unresolved/no-window candidates could still hide conflicts. Preflight full authorized eligible ledger/provenance scope, then SQL/projector equality and shared credit filtering. Empty/absent ledger exception preserves actual helper contract. |
| M2 | ACCEPT | Original envelope had no authenticity mechanism or TTL choice. Choose injected authenticated opaque AES-GCM token, fixed 15-minute TTL, strict schema, explicit replay and clocks. No production secret wiring. |
| M3 | ACCEPT | work-timeline.ts owns active Slack wording; merger compares labels/person/task fields; presentation-generation writer compares actor/title/author/channel only. Specify pure injected composer plus complete input digest, asOf labels and conflict taxonomy. Real production composition stays deferred. |
| D1 | ACCEPT | Rejected candidates are stable under same binding; real correction cap is 5000 and can cause a long run. Specify metered defaults/injection and error; unresolved persistent capacity is an explicit activation blocker, not successful truncation. |
| D2 | ACCEPT with limit | timeline-cache.ts fingerprints all visible item IDs. This new reader uses Slack-only scope without modifying cache. One whole-drain restart helps one overtake, but cannot guarantee availability during sustained Slack churn; record that limit. |
| D3 | ACCEPT | Current spec lacked terminal equivalence; token equality cannot establish tuple progress. Require terminal equivalence, emitted tuple equality, strict order and drain rejection. |
| D4 | ACCEPT as an implementation risk | groupTimeline sums association evidenceCount; merger finishPerson uses unique Slack IDs. No new drain exists yet, so claimed one-page bug is a plausible unspecified path, not an observed implemented defect. Always normalize, including first-page-only path. |
| D5 | ACCEPT with scope correction | Aggregate-max cursor pushed into raw rows demonstrably re-emits A; source reader formats UTC but new aggregate SQL needs explicit UTC. Real membership oracle required. Expansion reducer has start/success/failure only; obsolete continuation testing belongs in pure binding contract now and client integration later. Source revocation remains injected seam plus explicit AC-11 gate. |
| D6 | ACCEPT with limit | SlackPersonDay retains all messages, so direct export scales with activity. Emit one deterministic message link after complete projection. This bounds external aggregate payload, not full-ledger input cost; large-ledger budget remains capacity gate. |
| D7 | ACCEPT | Parsed saved PR743 current-files readback: 226 unique paths including helpers/setup, tx.ts, resolve.ts and authorization-epoch.ts. Attach exact list below and require mechanical intersection check. |
| Low: UUID/boundary/metadata | ACCEPT | SQL UUID ordering and projector string ordering agree after lowercase normalization; since/asOf applies before groups. Explicit metadata/legacy empties only for verified ledger projection. |
| Low: repeated reads/guard/status | ACCEPT | Existing credit helper rereads mappings/roster per call. Account for cost or same-session reuse. Keep old guard behavior and add separate aggregate reachability guard. Duplicate status and stale first-person no-edit statement removed. |
| N1 (round 2) | ACCEPT | Real oracle reads current memberships; a frozen non-Slack body otherwise survives revocation. Require complete backing IDs and first/final subset checks; removal restarts, unrelated additions do not. |
| N2 (round 2) | ACCEPT | work-timeline.ts uses contentReader/provenance context for task windows and defense-in-depth. Pass snapshot principal/admission explicitly, apply the same owner and define server-derived viewKey. |
| N3 (round 2) | ACCEPT | PgClient supports a bound executor and the item correction fields are directly readable. Packet-owned lock/owner reader plus in-session roster is required; real-writer and same-snapshot tests cannot be delegated to a fake. |
| N4 (round 2) | ACCEPT | Per-SQL-row checks miss a projected group omitted by an incomplete account relation. Require two-way sets over each scanned interval for every loaded item, including terminal tail; explicitly limit this check's coverage to surfaced items. |
| Round 2 LOW precision | ACCEPT | Specify staged failure precedence, narrow validated merger wrapper, initial Slack rejection, digest cursor bindings/overflow, publication expiry/skew, key-change classification and provisioning gate, real-oracle post-hoc metering exception, total initial page byte scope, fixed drain pageSize, explicit test seams and whole-scope cost/churn. Retain whole-scope digest; advisory narrowing is deferred. |
| Short staging SHA | RESOLVED DOCUMENTATION ONLY | Local git rev-parse yields the exact 40-character SHA above. No product change or base switch. |

## PR743 mechanical do-not-touch boundary

Saved current readback records PR743 open/draft/unmerged at `e1ba30c4c55cc9aee9c7781394c01546c27830bc`, branch `codex/aio-1167-google-docs-connector-rebased`. This is saved evidence, not an assertion of fresh remote status. The attached list below is taken from `.context/aio-1170-resume/pr743-current-files-20261006.json`; its raw-file SHA-256 and all 226 unique paths are recorded below. Preserve original readback as review evidence.

Before implementation and again before publication, refresh PR743 metadata/complete paginated file list through authorized read access and compare with this pinned list. The do-not-touch set is their union until an explicit verified ownership decision changes it. Fail closed if a refreshed list is incomplete. No migration reservation is needed because this slice may not add one.

Define packet baseline as reviewed HEAD `82f8fabcfddec1913ead628b5e730edb6719f296` (record a new exact baseline only after an authorized rebase). Gate the union of `git diff --name-only <packet-base>...HEAD`, staged, unstaged and task-owned untracked paths against the do-not-touch set. Check both old and new names for renames/copies. Do not compare the entire historical AIO branch against staging as though earlier changes were this packet. Save path lists and empty intersection as evidence. A fixture helper touched in helpers.ts/setup.ts fails just as production files do; place new helpers in new paths. Missing Git/readback evidence fails the gate.

Keep `test/guards/slack-source-not-wired.test.ts` unchanged and passing. Add a separate new `test/guards/slack-aggregate-not-wired.test.ts` with equivalent entrypoint/import-graph coverage, explicitly guarding all three new modules and any new coordinator/composer/contract helper. Pure modules are guarded as inactive capabilities too. Do not edit PR743-owned entry-surface-graph.ts or other helpers to achieve it; a new local test helper or self-contained guard is permitted. Negative controls cover alias/relative/static/dynamic/re-export/root entry reachability. Guarding just the existing source pipeline is insufficient.

PR743's saved patch adds complete Google Drive source-ledger pagination and reserves its cache payload version. Preserve that non-Slack initial-response leg and payload version at eventual integration. Its saved Astra adjudication assigns shared-ingest lock-order/migration work to the PR743 writer; this read-only packet does not need those writes. At integration, revalidate `lib/db/pg/tx.ts` fresh transaction behavior, `lib/identity/resolve.ts` contract, and `lib/access/authorization-epoch.ts` implications. Coordinate shared active cache/timeline ownership explicitly, run both branches' contract suites, and resolve by behavior rather than whole-file selection.

Excluded throughout: source activation, publisher/runner wiring, deleting or weakening not-wired guards, identity cutover, repair apply, merging, deployment and production changes.

### Pinned PR743 path list

Readback SHA-256: `4abc33feea21cea9c5c318c9b597ba7534b1fc583fa87f4744d57fd6b3d66f20`.

```text
.env.example
README.md
app/api/auth/gdrive/callback/route.ts
app/api/auth/gdrive/start/route.ts
app/api/brain/arcs/recompute/route.ts
app/api/brain/arcs/route.ts
app/api/brain/events/route.ts
app/api/brain/facts/route.ts
app/api/v1/graph-query/route.ts
app/api/v1/integrations/gdrive/execution/route.ts
app/api/v1/integrations/gdrive/runs/route.ts
app/api/v1/integrations/gdrive/token/route.ts
app/api/v1/integrations/route.ts
app/api/v1/items/route.ts
app/api/v1/items/source-reconcile/route.ts
app/t/[team]/admin/integrations/actions.ts
app/t/[team]/admin/integrations/page.tsx
app/t/[team]/admin/members/actions.ts
app/t/[team]/admin/members/page.tsx
components/admin/integrations-manager.tsx
components/admin/member-identities.tsx
components/admin/provider-identity-link.tsx
components/dashboard/person-work-card.tsx
docs/ARCHITECTURE.md
docs/OPS.md
docs/design/google-docs-connector-upgrade.md
docs/design/staging-workflow-hardening.md
ingestion/README.md
ingestion/aios_ingest/brain_client.py
ingestion/aios_ingest/cli.py
ingestion/aios_ingest/engine.py
ingestion/aios_ingest/gdrive_sync.py
ingestion/aios_ingest/scheduler.py
ingestion/aios_ingest/selections.py
ingestion/aios_ingest/sources/gdrive.py
ingestion/aios_ingest/sources/gdrive_docs.py
ingestion/aios_ingest/sources/gdrive_watch.py
ingestion/aios_ingest/state.py
ingestion/aios_ingest/webhook_app.py
ingestion/connections.yaml.example
ingestion/pyproject.toml
ingestion/tests/test_brain_client.py
ingestion/tests/test_gdrive_upgrade.py
ingestion/tests/test_scheduler.py
ingestion/tests/test_selections.py
instrumentation.ts
lib/access/authorization-epoch.ts
lib/admin/aliases.ts
lib/admin/members.ts
lib/api/auth.ts
lib/api/schemas.ts
lib/attribution/resolve-authors.ts
lib/auth/gdrive-oauth-state.ts
lib/auth/pg-login.ts
lib/codebases/commits-to-items.ts
lib/codebases/github-api-scan.ts
lib/codebases/ingest.ts
lib/costs/ingest.ts
lib/dashboard/gdrive-contributions.ts
lib/dashboard/timeline-cache.ts
lib/dashboard/timeline-group.ts
lib/dashboard/work-timeline.ts
lib/db/pg/bounded-lock.ts
lib/db/pg/client.ts
lib/db/pg/pool.ts
lib/db/pg/query-builder.ts
lib/db/pg/tx-outcome.ts
lib/db/pg/tx.ts
lib/db/types.ts
lib/graph/arc-cache.ts
lib/graph/arc-continuity.ts
lib/graph/arc-corrections.ts
lib/graph/arc-fusion.ts
lib/graph/arc-input-authorization.ts
lib/graph/arcs.ts
lib/graph/learning.ts
lib/graph/provenance-read.ts
lib/identity/authority.ts
lib/identity/list.ts
lib/identity/member-identities.ts
lib/identity/provider-sync.ts
lib/identity/resolve.ts
lib/ingest/attribution-correction.ts
lib/ingest/attribution-repair-report.ts
lib/ingest/attribution-repair-scheduler.ts
lib/ingest/gdrive-commit-locks.ts
lib/ingest/gdrive-contribution-store.ts
lib/ingest/gdrive-ledger.ts
lib/ingest/gdrive-reconcile.ts
lib/ingest/identity-repair.ts
lib/ingest/index.ts
lib/ingest/item-attribution-lock.ts
lib/ingest/leg-ledger.ts
lib/ingest/pipeline-health.ts
lib/ingest/purge.ts
lib/ingest/reattribute.ts
lib/ingest/reconcile-attribution.ts
lib/ingest/repair-eligibility.ts
lib/ingest/run.ts
lib/ingest/scheduler.ts
lib/ingest/source-reconcile.ts
lib/integrations/build-config.ts
lib/integrations/gdrive-authority.ts
lib/integrations/gdrive-oauth.ts
lib/integrations/gdrive-runs.ts
lib/integrations/manage.ts
lib/meetings/from-items.ts
lib/metrics/individual-maturity-ingest.ts
lib/projects/context/backfill-candidates.ts
lib/projects/context/gdrive-claims.ts
lib/projects/context/memberships.ts
lib/projects/context/units.ts
lib/projects/project-row-locks.ts
lib/query/retrieve.ts
lib/subscriptions/ingest.ts
postgres/migrations/20260922090000_integrations_gdrive_type.sql
postgres/migrations/20260922110000_gdrive_execution_authority.sql
postgres/migrations/20260922130000_gdrive_audience_claims.sql
postgres/migrations/20260922135000_gdrive_legacy_context_suppression.sql
postgres/migrations/20260922140000_gdrive_canonical_item_path.sql
postgres/migrations/20260922150000_arc_input_authorization_barrier.sql
postgres/migrations/20260922160000_arc_correction_source_dependencies.sql
postgres/migrations/20260922170000_arc_correction_immutable_revisions.sql
postgres/migrations/20260922180000_gdrive_identity_repair_ledger.sql
postgres/migrations/20260922190000_identity_snapshot_fence.sql
postgres/migrations/20260922200000_identity_mutation_lock_owner.sql
postgres/migrations/20260922210000_gdrive_run_requests.sql
postgres/migrations/20260922220000_gdrive_run_reporting.sql
postgres/migrations/README.md
postgres/schema.sql
scripts/dm-isolated.sh
scripts/dm-pg-client.sh
scripts/migrate-from-existing.mjs
scripts/migration-replay-plan.mjs
scripts/pg-load-schema.mjs
scripts/seed-demo.ts
scripts/staging-ops/credential-classification.json
scripts/staging-ops/pg-sanitize.mjs
scripts/staging-refresh-decision.mjs
test/arc-input-authorization.test.ts
test/arcs-correction-scope.test.ts
test/arcs-degraded-skips-model.test.ts
test/arcs-stability.test.ts
test/attribution-repair-report.test.ts
test/attribution-repair-scheduler.test.ts
test/attribution-repair-turn.test.ts
test/auth-wrapper-evidence.test.ts
test/build-integration-config.test.ts
test/datamechanics/access-enforce-arcs.datamechanics.test.ts
test/datamechanics/access-enforce-timeline.datamechanics.test.ts
test/datamechanics/arc-corrections.datamechanics.test.ts
test/datamechanics/arcs-unified-read.datamechanics.test.ts
test/datamechanics/attribution-propagation.datamechanics.test.ts
test/datamechanics/attribution-repair-continuation.datamechanics.test.ts
test/datamechanics/attribution-repair-copied-staging.datamechanics.test.ts
test/datamechanics/codebase-identity.datamechanics.test.ts
test/datamechanics/commit-items.datamechanics.test.ts
test/datamechanics/enfb-graph-query-scope.datamechanics.test.ts
test/datamechanics/gdrive-admin-test.datamechanics.test.ts
test/datamechanics/gdrive-audience-claims.datamechanics.test.ts
test/datamechanics/gdrive-authority.datamechanics.test.ts
test/datamechanics/gdrive-claim-placement.datamechanics.test.ts
test/datamechanics/gdrive-claims-replay.datamechanics.test.ts
test/datamechanics/gdrive-common-repair.datamechanics.test.ts
test/datamechanics/gdrive-connector-unbind.datamechanics.test.ts
test/datamechanics/gdrive-identity-repair.datamechanics.test.ts
test/datamechanics/gdrive-lifecycle.datamechanics.test.ts
test/datamechanics/gdrive-lock-order.datamechanics.test.ts
test/datamechanics/gdrive-oauth-lock-order.datamechanics.test.ts
test/datamechanics/gdrive-obligation-provenance.datamechanics.test.ts
test/datamechanics/gdrive-paired-restore.datamechanics.test.ts
test/datamechanics/gdrive-timeline-pagination.datamechanics.test.ts
test/datamechanics/graph-read-cutover.datamechanics.test.ts
test/datamechanics/graph-tier.datamechanics.test.ts
test/datamechanics/helpers.ts
test/datamechanics/ingest-attribution-serialization.datamechanics.test.ts
test/datamechanics/item-context-serialization.datamechanics.test.ts
test/datamechanics/items-author-attribution.datamechanics.test.ts
test/datamechanics/items-route-tier-guard.datamechanics.test.ts
test/datamechanics/membership-leak-suite.datamechanics.test.ts
test/datamechanics/pparc-fusion-cutover.datamechanics.test.ts
test/datamechanics/reattribute.datamechanics.test.ts
test/datamechanics/setup.ts
test/datamechanics/tierret1-admission.datamechanics.test.ts
test/datamechanics/timeline-cache.datamechanics.test.ts
test/datamechanics/timeline-synopsis-salvage.datamechanics.test.ts
test/datamechanics/transaction-truthfulness.datamechanics.test.ts
test/datamechanics/work-timeline.datamechanics.test.ts
test/fixtures/migration-replay-populated.sql
test/gdrive-authority-lock-order.test.ts
test/gdrive-common-repair.test.ts
test/gdrive-lock-order.test.ts
test/gdrive-oauth-state.test.ts
test/gdrive-obligation-provenance.test.ts
test/gdrive-reconcile.test.ts
test/gdrive-timeline.test.ts
test/graph-arcs-parse.test.ts
test/graph-events-provenance-gate.test.ts
test/graph-provenance-read.test.ts
test/guards/api-route-auth.test.ts
test/guards/context-hook-callsites.test.ts
test/guards/enforce-retrieve-callsites.test.ts
test/guards/entry-surface-graph.ts
test/guards/enum-check-replay.test.ts
test/guards/graph-cutover-callsites.test.ts
test/guards/helpers/api-route-auth.ts
test/guards/identity-mutation-boundary.test.ts
test/guards/integrations-type-check-replay.test.ts
test/guards/migration-replay-plan.test.ts
test/guards/source-item-mapping-stability.test.ts
test/guards/timeline-payload-shape.test.ts
test/http/dev-login-dev-setup.ts
test/http/fake-providers.ts
test/http/gdrive-authority.http.test.ts
test/identity-provider-sync.test.ts
test/identity-resolve.test.ts
test/integration-config.test.ts
test/items-route-meeting-backfill.test.ts
test/pg-ambient-transaction.test.ts
test/pg-transaction-protocol.test.ts
test/pparc-cost-checks.test.ts
test/pparc-partition-scope.test.ts
test/staging-model-feature-callers.test.ts
test/staging-pg-policy.test.ts
test/timeline-meetings.test.ts
test/timeline-synopsis-salvage.test.ts
```
