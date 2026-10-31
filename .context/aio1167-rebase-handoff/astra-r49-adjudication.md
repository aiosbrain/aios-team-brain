**Decision: changes required.** Accept findings 1–5 and 7 as bounded corrections. Defer finding 6 behind a specific operational gate. R49 does not satisfy restriction lifetime or independent-progress requirements.

I verified `HEAD`, the tracked-diff hash, the complete-patch hash and the report hash against the supplied identities. All 12 added test files match the reviewed patch. This adjudication was read-only: no edits or tests were performed. Reported test results remain writer evidence.

| Finding | Decision | Verified trigger and evidence | Exact next action |
|---|---|---|---|
| **1. Generation changes waive minima** | **Accepted — blocker** | `gdrive_sync.py:200–299` adopts/selects restrictions only for the current generation; `state.py:1237–1317` keys both stores by generation. Additionally, `postgres/schema.sql:2753` clears **all progress** on scope or credential changes. | Make provider restrictions survive selection-generation changes, including brain-side progress reset and fresh-state recovery. Retain execution fencing. |
| **2. Rearm retains local backoff** | **Accepted** | `_fail_work` combines local backoff and the named deadline; `rearm_exhausted` resets counters but retains the combined `not_before` (`state.py:1622`). Thus an unrestricted exhausted document remains ineligible immediately after Retry. | Reset the local exponential-backoff component with the exhausted attempt budget. Preserve independently owned provider and applicable control-plane minima. |
| **3. Pre-stream nonquota becomes account hold** | **Accepted** | `_open_account_hold` excludes only local deadline categories (`gdrive_sync.py:301–341`); root binding, relocation, identity and start-token callers route other deferrals there. `_provider_call` classifies ordinary 503 as `provider_unavailable`, not quota. | Classify by the affected operation/resource. Root 503 remains root-scoped; start-token 503 remains stream-scoped. Persist their deadlines and continue independent work. |
| **4. Restricted file root freezes recovery** | **Accepted, with constrained design** | `_enumerate_baseline` leaves the restricted root unmaterialized (`2286–2307`), returns incomplete (`2466`), and the caller returns before changes consumption (`1787` vicinity). Already-enumerated siblings can progress once, but subsequent edits are stranded. | Support bounded independent discovery/draining while the restricted root remains a durable unresolved obligation. Preserve claims; do not fabricate baseline completeness or absence. |
| **5. Tombstone precedes owner conflict** | **Accepted — narrow defensive correction** | `member-identities.ts:148` returns tombstoned before the different-owner conflict branch. An inconsistent legacy/raw row plus `unlinked` state therefore avoids the OAuth conflict refusal. | For automatic publication, detect an existing different owner before the tombstone early return; preserve ordinary tombstones and explicit revision-fenced correction behavior. |
| **6. Permanent checkpoint refusal repeats pushes** | **Deferred with a specific gate** | `_push_doc` leaves accepted content owed after nondated checkpoint refusal (`gdrive_sync.py:2667–2681`); subsequent polls can replay indefinitely. This is bounded polling, not a demonstrated unbounded inner loop. | Track a separate control-plane retry/diagnostic correction. Before unattended rollout, prove bounded repeated-refusal behavior and actionable reporting without spending the document failure budget or dropping the obligation. |
| **7. Diagnostic gaps** | **Accepted** | Change-page absence records root-unavailable detail without incrementing its category (`1971–1978`); new document restrictions have no explicit unpublished diagnostic when checkpointing fails. | Count verified root-unavailable observations consistently and report unconfirmed restriction durability through the existing run-report path. No new UI/API. |

**Restriction ownership and the R48 contradiction**

R48’s explicit prohibition on scope changes as an override governs. Its “generation/context validation” wording was ambiguous and must be corrected:

- **Execution, cursor, membership and publication authority remain generation-bound.**
- **Provider-minimum lifetime is bound to the verified tenant/connection/account and, for a resource restriction, stable provider ID.** Generation records observation context; it does not expire that restriction.
- A current worker may carry applicable prior-generation restriction evidence forward. An obsolete worker still cannot publish, ingest, reconcile or replace current progress.

The coordinator remains the sole logical restriction writer. SQLite is its local durable journal; the brain’s acknowledged, fenced restriction section is the recovery authority. No second retry or reconciliation owner is warranted.

Fable’s proposed Python-only carry-forward is insufficient. The current [authority trigger](/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/postgres/schema.sql:2753) clears progress before a fresh-state worker can adopt it. The correction therefore includes the existing brain transition owner: reset generation-specific progress while retaining applicable provider-minimum evidence. Use a forward migration and matching schema representation if changing the trigger; do not rewrite migration history alone.

Required boundaries:

- Preserve restrictions through add/remove-root changes, empty-selection transitions, deselection/reselection, and same-account credential replacement/reconnect.
- Retain a deselected resource’s standing restriction without treating it as selected backlog. Reselecting it must not permit early access.
- Account identity controls applicability: another account must neither inherit the hold nor erase retained evidence for the original account.
- Merge monotonically; preserve unrepresentable classification. Ordinary scope edits, rearm and rescan cannot shorten deadlines.
- Apply admission before **every affected direct read**, including initial binding and relocation—not only pending-work selection.
- Preserve current generation/lease/fence/revision checks and renewal’s section ownership. `checkpointGdriveExecution` already rejects stale nonidentical progress while acknowledging identical older-revision replay; retain that behavior.

This follows AC-03/04 and R48 F1/F4. No provider override is authorized.

**Rearm and pre-stream classification**

For finding 2, R48’s immediate instruction to retain combined `not_before` was a protective interim measure while provider minima lacked their own owner. With ownership separated, Admin Retry/Run now should reset exhausted attempts **and local exponential backoff**, making otherwise unrestricted work eligible immediately. Automatic polling still backs off and exhausts normally.

Do not simply null every deadline: legacy combined rows and brain-named retry minima need provenance-preserving handling. Unknown legacy deadlines cannot safely be assumed to contain only local backoff. The writer must demonstrate that resetting local delay cannot waive a surviving external minimum. Replace the test that encodes unconditional retention of a synthetic year-2099 `not_before` with tests distinguishing these owners.

For finding 3, timing before stream creation does not establish account-wide scope:

- **429 / recognized quota 403:** existing account-hold owner; stop subsequent account calls and retain the named minimum.
- **Root metadata or relocation 503, including Retry-After:** affected root/resource restriction; retain unresolved/uncertain state and its deadline. Continue readable roots and streams.
- **Start-token/change-log 503 or timeout:** affected stream operation; no enumeration without its start token, but independent streams remain runnable.
- **Service-account identity verification failure:** blocks the connection’s required identity prerequisite. A 503 may defer that account-level prerequisite, but is not evidence that a document or stream response established a universal outage.
- **Authentication refusal:** existing terminal/reconnect handling.
- **Local dispatch/run deadline:** local budget stop, not a provider hold or document failure.

A Retry-After header supplies duration, not evidence of broader outage scope. Preserve malformed-input diagnostics and bounded fallback; preserve valid and unrepresentable minima at their actual scope. This completes R48 F2’s admission rule without adding outage inference.

**Independent progress during recovery**

Finding 4 violates AC-04 and R48’s explicit independent-document requirement. The existing [file-root regression](/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/ingestion/tests/test_document_restrictions.py:286) proves no early restricted read and one sibling metadata read; it does not prove later sibling edits flow.

Authorize a bounded continuation within the existing coordinator/snapshot/pending-work owners:

1. Keep the restricted root and its owed verification durable.
2. Retain previously proven membership/claims conservatively when available. This is retained evidence, **not newly verified membership**.
3. Let independently verified roots/documents continue bounded discovery and changes processing from a correctly captured token, with durable obligations before cursor advancement.
4. Keep the overall run partial and withhold complete-snapshot absence reconciliation until unresolved roots and owed outcomes are resolved.
5. On fresh local state, do not invent missing membership from a root binding or snapshot ID. Reconstruct readable roots independently and retain uncertainty for the restricted root.

Simply copying membership and declaring the baseline complete is rejected. Freezing the whole stream indefinitely is also rejected. This does not authorize a broad queue redesign or weakening stale-observation, relocation, overlap or claim-retirement protections.

**Identity, checkpoint refusal and diagnostics**

Finding 5 is a conditional integrity edge, not evidence that normal writers create inconsistent rows or that credentials are stolen. Nevertheless, AC-08 and the current OAuth publication comment explicitly require a different existing owner to produce a visible refusal. The existing transaction can enforce this with a small ordering correction. Test that the inconsistent shape returns the existing conflict response and rolls back credential publication, mappings, revisions and repair effects. Ordinary unlink tombstones must still permit credential publication without relinking.

Finding 6 remains separate because R48 correctly adjudicated accepted-content checkpoint failure by **stage**. Reclassifying it as document failure would regress that decision. The follow-up must address repeated deterministic control-plane refusal with a persisted bounded delay or equivalent admission policy and a clear diagnostic; it must never exhaust away an acknowledgment obligation. Before rollout, demonstrate recovery after the refusal is repaired, idempotent content replay and no false completion. No retry cap that discards owed work is authorized.

Finding 7 belongs here because it completes existing R48 diagnostic obligations. Count actual verified unavailability with run-level deduplication, rather than counting every retained historical detail. For restrictions, emit an existing-style category such as `document_restriction_unpublished` when newly learned/extended evidence lacks acknowledgment, alongside the checkpoint error. Retain local evidence. The [client uncertainty latch](/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/ingestion/aios_ingest/brain_client.py:551) must still prohibit further changed checkpoint publication until reacquisition.

**Exact writer scope**

Return findings **1–5 and 7** to the existing sole writer. Scope is limited to:

- Restriction identity, persistence, migration/carry-forward, adoption and admission in the existing state/coordinator/progress/authority owners.
- Local-backoff reset on exhaustion rearm.
- Resource/stream-scoped pre-stream deferrals and independent recovery progress.
- Automatic identity conflict ordering.
- Existing diagnostic categories, focused regressions, architecture documentation and corrected acceptance mapping.

Do not add Admin override controls, new diagnostic surfaces, generic outage detection, competing state owners, or finding 6’s broader retry machinery. Coordinate migration ownership/reservation before adding the necessary transition migration.

**Minimum meaningful verification before another review**

The coordinator must verify the resulting exact snapshot, not inherit R49’s green claims:

1. **Restriction transitions:** long and unrepresentable document/account minima across real selection-generation changes, empty/reselected scope, same-account reconnect, reopened SQLite and fresh-state recovery. Include a real-Postgres authority-trigger test; merely changing a double’s generation misses the progress reset. Verify account isolation, monotonic merging and stale-writer rejection.
2. **Rearm:** real nonzero exponential backoff; exhausted unrestricted work retries immediately after explicit rearm, automatic polling remains bounded, and provider/control-plane minima survive.
3. **Admission:** real `_provider_call` 429/quota-403 versus root 503 with long Retry-After; readable same-drive roots and sibling streams progress. Cover start-token deferral, relocation and identity-prerequisite handling. No early retry or inferred absence.
4. **Recovery liveness:** after 410 rescan and separately fresh-state recovery, edit an independent document **after its baseline page has committed**. Its new content must flow while the restricted file remains unread, unresolved and partial. Include same-drive and cross-drive controls, then expiry/restoration and superseded-removal behavior.
5. **Acknowledgment interaction:** combine newly recorded restriction evidence with the actual `BrainClient` uncertainty latch. Verify no changed publication after lost acknowledgment, local retention, truthful unpublished reporting, reacquisition and recovery. Existing separate doubles do not prove this interaction.
6. **Identity/claims:** the inconsistent tombstone-owner case, existing tombstone/concurrency behavior, and real complete-snapshot overlap reconciliation.
7. **Run the unexecuted TypeScript coverage:** `gdrive-admin-grant-policy`, `gdrive-identity-tombstone-email`, `gdrive-authority` including the OAuth 409 callback, `identity-discovery-conflicts` including migration seeding, and edited `gdrive-admin-credential-race`, `gdrive-admin-test`, and `gdrive-oauth-lock-order` data-mechanics suites. Include `identity-conflicts-view` and the complete-snapshot overlap suite. Typechecking alone does not execute these assertions.
8. Run the affected Python regressions and full sidecar suite; affected TypeScript checks, lint and docs checks; applicable authority/migration and HTTP acceptance checks. Verify `json_each` support in the actual supported sidecar image. Record skips/environment failures explicitly.

Update the acceptance map with exact commands/results and snapshot hashes; then obtain fresh Fable coverage and the required fresh blind Astra/Sol reviews. Earlier reviews do not attest the corrected snapshot.

Remaining limitations remain explicit: loss of both unpublished local restriction evidence and its storage cannot be repaired from acknowledged progress alone; no operator override exists; rich persistent restriction UI remains deferred. H2 repair-runner/drain evidence, M-b production Neo4j configuration, M-c contention evidence, M-d production-sized repair/resume/cache evidence, live Google certification, the 24-hour soak, opt-in runner proof and canary/rollback gates remain open. This adjudication establishes neither publication nor deployment readiness.