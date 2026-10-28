# AIO-1167 current handoff

Updated: 2026-10-28 (Asia/Kolkata)

## Objective and policy

Continue the user-authorized AIO-1167 / PR #743 Drive connector work on the rebased feature branch. One coordinator owns checks, reviews, checkpoints, pushes and handoff; one existing Claude Opus 5.5 HIGH session is the sole writer. Subscription-authenticated Claude only. No merge, deployment, API billing or permission bypass. User resolved the Drive metadata boundary: ordinary/external keys cannot read Drive account or selection metadata; only the live bound connector key receives its own authorized connection metadata.

Resolved current implementation questions: retain source-supported credit for a deactivated member when an existing stable identity mapping resolves it; deactivation blocks new links/authentication, not attribution of newly discovered historical work. Keep the production Google token endpoint fixed; the real-HTTP test may use a test-harness-only interception/injection to reach its loopback fixture, with no production environment override.

## Source and checkpoint

- Worktree: `/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree`
- Branch: `codex/aio-1167-google-docs-connector-rebased`, based on recorded `origin/staging` `8df51664809cfc12740a39d0e98fdb9c8ad05ad8`.
- Current local HEAD: `670a77b4ca7c74fefeac10d72322467768d45e3b` (`test(tierret): repair identity after variant principals`), pushed and verified on `origin/codex/aio-1167-checkpoint-20261027`.
- Recovery branch: `origin/codex/aio-1167-checkpoint-20261027`. Push and remote readback verified exact SHA `63dd3f115deac26ec37b1aa65218d7566b479cc2`; pre-push docs/skill checks passed. PR #743's divergent branch was not modified or force-pushed.
- The prior detailed history and results are preserved in `ARCHIVE-current-state-through-20261027-before-8e960b85.md`. Load only that archive/evidence needed for a specific decision.

## Writer and admission

- Sole writer: existing Claude session `628402d5-a1c6-42b7-b736-e84358c1a749`, displayed as `aio1167-r30-opus-writer`; terminal `exec` session `57820`. It was interrupted at its 10-minute deadline and its edits were checkpointed at `0495f63d`; terminal output has been quiet. Resume this same session; do not create a replacement or second writer.
- Fresh exact-session `/usage` (2026-10-28 about 7:41 a.m. Asia/Kolkata, after session reset): session 0%, all-model week 3%, Fable week 0%, credits off. Weekly reset Nov 3 at 5:30 p.m. All applicable limits remain below pause threshold. Full-user CLI verified `loggedIn:true`, `authMethod:claude.ai`, first-party Max subscription. Continue only the existing Opus session; do not create another run. Recheck at phase boundaries and every 20 minutes while active.
- No credentials, tokens or account secrets belong in the handoff.

## Current implementation state

The coordinator resumed the same writer from `517696e55e6c8eabc46c8cc72cf44700064f2fd4`. The current corrections are captured in checkpoints `8e960b85`, `816bcd62`, `5dca28fe`, `aec84213`, `73607a26`, `1b6db8e5`, `01b30267`, `3be6faca`, `e734fd24`, `50e652f6`, `8b420f26`, `04b31665`, `90da2ef6` and `3f912f46`:

- `ingestion/aios_ingest/gdrive_sync.py`: derive OAuth namespace consistently; bind service-account runs to identity from loaded credentials and refuse verified-identity mismatches before progress restoration/use.
- `ingestion/aios_ingest/sources/gdrive.py`: expose identity from the same loaded service-account credential used by provider calls.
- `ingestion/aios_ingest/watch_renewal.py`: use the shared OAuth/service-account namespace so watch and sync address the same account.
- `ingestion/tests/test_provider_identity_binding.py`, `ingestion/tests/test_connection_binding.py`: new identity and ID/name conflict coverage; existing polling/upgrade fixtures updated.
- `ingestion/aios_ingest/scheduler.py`, `selections.py`: route polling, hints and manual requests by immutable integration ID; refuse explicit local name/ID conflicts.
- `lib/identity/resolve.ts`, `authority.ts`, `dashboard/work-timeline.ts`, `ingest/gdrive-contribution-store.ts`, `ingest/reattribute.ts`: preserve established attribution for deactivated members while keeping new linking/authentication restricted; datamechanics regression coverage added.
- `ingestion/aios_ingest/brain_client.py`: checkpoint retry is bounded by the run budget and defers waits that do not fit.
- `ingestion/aios_ingest/gdrive_sync.py`, `state.py`, `scheduler.py`: persisted capped/jittered retries and exhaustion state, provider Retry-After admission, and per-stream access refusal isolation while retaining owed work.
- `ingestion/aios_ingest/watch_renewal.py`: renew early enough for the configured sweep plus run budget and skew.
- New targeted tests cover checkpoint deferral, sibling checkpoints, stream-access isolation, retry exhaustion/recovery and watch overlap.
- The T2 token fixture is test-only: product code uses Google's fixed URL; `test/http/google-token-intercept.mjs` rewrites that exact request to the loopback fixture only in the spawned HTTP test server. No production URL override remains.
- `lib/integrations/gdrive-identity-discovery.ts`, `member-identities.ts`, and item-ingest route: under a live fenced Drive execution only, link a never-reviewed stable permission ID when exactly one active member's verified email matches; preserve manual mappings and unlink tombstones. Conflicts do not transfer credit.
- `lib/ingest/gdrive-ledger.ts` and consumers: coalesce email-only and stable-ID observations only for the same unique email, role and timestamp; tests cover ledger/display/evidence behavior.
- Added multi-process revocation, real HTTP broker, identity discovery and generation-transition tests. T1 now fixes child startup handling (drains stderr, pins cwd/tsx config, propagates startup/exit errors); a separate test covers unlink winning against concurrent identity discovery. These remain unverified until coordinator tests run.
- `ingestion/tests/test_scheduler.py` now asserts name-only local jobs bind to immutable integration IDs without mutating config, and explicit manual requests re-arm exhausted work.
- `test/datamechanics/gdrive-identity-discovery-route.datamechanics.test.ts` exercises real fenced item ingest end-to-end: the first unambiguous permission/email observation links and credits the member in the same push; replay with another member's email does not transfer the stable identity's credit.
- `coalesceStoredGdriveEvidence` now applies the same S4 email/stable-ID coalescing rule per item to already-stored evidence read by the Timeline; regression cases cover row order, item boundaries and ambiguous multiple stable IDs. The identity-discovery route test now primes the Timeline cache and verifies repair fencing plus uncached/cached attribution after repair.
- The T2 HTTP harness now answers the exact Google userinfo endpoint as well as token exchange in its test-only preload; a new real HTTP start → callback → broker test verifies the exchanged credential, single-use OAuth state and secret non-disclosure. Production endpoints remain fixed.
- C13 repair-attempt accounting now increments only on a failed repair, not each healthy batch; the new real-Postgres test covers multiple healthy batches, first/repeated failure delays, and cursor-preserving restart. This was captured at `50e652f6`; it remains unverified.
- `ingestion/aios_ingest/sources/gdrive_docs.py` now renders header/footer segments with provenance, fails extraction on malformed segments, and applies the current-content (`PREVIEW_WITHOUT_SUGGESTIONS`) policy to chips, inline objects, footnotes, paragraphs and table/row/cell suggestions. Regression coverage was expanded in `ingestion/tests/test_docs_segments_chips_suggestions.py`; still unverified.
- The Docs extractor now treats footnotes referenced only from an omitted proposed table/row/cell as proposed too; parameterized coverage verifies no orphan note or reference leaks into current-content extraction. Captured at `04b31665`; unverified.
- Sidecar retries now persist a distinct failure count: an item withheld while waiting for other streams increments its ordering attempts but spends no retry budget, so the first actual failure receives the first backoff. New tests cover repeated waits beyond the retry limit, first-failure delay, re-observation reset, and migration of legacy state. Captured at `90da2ef6`; unverified.
- `ingestion/tests/test_generation_transition.py` now asserts a queued pre-return stream hint remains pending through A→B and is consumed only by A’s fresh generation on return, with no stale-generation queue inference. Captured at `3f912f46`; unverified.
- `lib/identity/resolve.ts` now keeps deactivated members’ mapped emails separate and lets them fill only addresses no active member holds; stable provider IDs continue resolving to the deactivated member. The new datamechanics regression proves reassigned email attribution goes to the active holder while stable historical identity remains attributed to the offboarded member. Captured at `0495f63d`; unverified.
- Added U3 sidecar restart/acknowledgment coverage, S1 stale-sibling/budget/restart coverage, C8 refused-renewal coverage, and F2 malformed-header/footer extraction coverage that ensures incomplete text cannot overwrite a complete stored document. These tests remain unverified.

Coordinator verification at `0495f63d` found the pre-return Drive-A hint test asserted acknowledgment in a harness that stubbed the real per-stream drain. The correction at `a3551ac1` keeps that fixture explicit and adds three real-drain controls: pre-return hint consumed by generation 8, a hint arriving during the drain remains pending, and a partial drain preserves the hint. The generation-transition file passed 4/4; the combined Docs/recovery/generation subset passed 54/54. The deactivated-member identity datamechanics suite passed 2/2 in isolated Postgres, and related identity/ledger/observation/Timeline unit suites passed 58/58. `git diff --check` and push hooks passed. These are targeted checks only; full verification and independent reviews remain open.

The writer confirmed C14's sanitized successful `graph.query` audit is restored and C15 rejects service-account brokerage and requires reconnect for a legacy OAuth grant without a conservative ceiling. Three legacy-scope cases cover broad, absent and malformed recorded scopes. Coordinator adjudication: make successful `gdrive.token_issued` recording required before releasing the access token. Accepted spec AC-07 requires sanitized audit metadata for bounded token issuance (accepted-spec.md:154), and the implementation comment promises the token is withheld if the audit record fails, but generic `audit()` is best-effort inside the transaction. The implementation now writes required evidence on the ambient transaction connection, returns a sanitized retryable `issuance_unrecorded` response on refusal, and has real-Postgres failure coverage. The revocation-race test now holds the required-audit seam and confirms the real write commits before token release.

Coordinator verification at `63dd3f11`: combined grant-mode + issuance-race isolated Postgres suites passed 25/25; graph-query audit, authority lock-order and grant policy unit suites passed 79/79. The earlier generation-transition subset at `a3551ac1` passed 54/54; deactivated-member Postgres suite passed 2/2; identity/ledger/observation/Timeline unit suites passed 58/58. These are targeted checks, not complete verification. Full required test suites and fresh independent reviews remain open.

At `d1c9d4aa`, corrected the identity-discovery real-Postgres fixture after its first isolated failure: the trigger intentionally finishes a newly created mapping immediately when there are no pre-existing attribution rows, so the test now first ingests an unresolved stable-ID observation and primes the cached Timeline before linking the member. Its repair-fence assertion remains intact; isolated real-Postgres test passed 1/1.

At `ba2b2603` and `670a77b4`, corrected the TIERRET timeline fixture to complete identity repair after creating/deleting/updating principals with existing attributed content. The isolated 25-test suite then passed 25/25. Full isolated data-mechanics rerun (`bash scripts/dm-isolated.sh --exclude '**/.context/**'`) completed 314 files passed, 2 skipped, 2 failed (2577 passed, 4 skipped, 2 failed): `graph-tier.datamechanics.test.ts` requires unconfigured Neo4j; `staging-coordinator-lock-lifetime.datamechanics.test.ts` refused its controlled capture because the live lock-owning Postgres backend does not match the canonical target. Both failures are environment-gated and unrelated to the changed fixture files. Push hooks passed; recovery branch exact SHA verified as `670a77b4ca7c74fefeac10d72322467768d45e3b`.

At `670a77b4`, `npm run typecheck`, changed-file ESLint for both edited data-mechanics tests, and `npm run check:docs` all passed. The focused identity-discovery test passed 1/1; the focused TIERRET member-read suite passed 25/25. The only full data-mechanics failures are the two environment gates above.

The exact failure was sent to the existing Opus session; do not create a replacement. Full-user CLI authentication is verified as first-party Max; sandboxed status cannot see that session. Latest `/usage` is 4% session / 2% all-model week / 0% Fable, credits off.

## Next action

1. Obtain fresh Fable 5.1, blind Astra HIGH and blind GPT-6.1 Sol HIGH reviews on the exact final snapshot, adjudicate, and rerun invalidated checks. Full Python suite previously passed 700/28 skipped; the full TypeScript unit run at the prior production-code snapshot had environment/archive and unchanged graph CDC failures; targeted AIO guards passed 242/242. Avoid repeating unchanged costly suites unless code changes or a specific unresolved finding warrants it.
2. Then prepare the authorized staging PR/checkpoint. Existing PR branch is divergent: do not force-push or overwrite it. No merge/deployment authorization.

## Review and rollout gates

R44 reviews cover only baseline `2c7dd5c3bca25d0a806678644a63da2528398a76`, not current code. The complete remaining must-fix scope and tests are in `r44-review/writer-scope.md`. Live Google certification (25 documents and 24-hour soak), opt-in/runner proof and canary comparison remain release gates. An earlier broad unit run had three failures in unchanged `test/gdrive-obligation-provenance.test.ts` from a stale SQL-alias matcher; see archived history. No merge or deployment is authorized.
