**Decision: changes required.** F1 needs a bounded ownership correction covering rearm and recovery, not only removal of one SQL assignment. Accept F2/F3 diagnostic corrections. Preserve the long-hold policy; no override is authorized.

This is Stage 4 adjudication of `333bf6a798d75db03256ea9c17fc61f8a011f18b`, relative to R47 `151fb88e245ba380acdf9d734845d54aa7ae5bb9`, with recorded staging base `8df51664809cfc12740a39d0e98fdb9c8ad05ad8` and bundle fingerprint `124a5cfb56f87ebd2e749180ea7740646c8cf52899c833d3935ee276303ef358`. I read source through `git show` because the working tree is dirty and its HEAD differs from the recovery snapshot. No files were edited and no tests were run. Writer-reported results are evidence, not independently verified results from this adjudication.

**Root-cause check and ownership decision**

The check is triggered immediately by retry clearing durable restriction state, as well as by the accumulated recovery findings. The repository’s [architectural root-cause rule](.agents/skills/astra-spec-claude-build/SKILL.md) requires tracing all writers and recovery paths.

The shared cause is that **an observation’s retry bookkeeping also carries a provider restriction whose lifetime can exceed that observation**:

- `_fail_work` correctly records the later of local backoff and the provider deadline, including on failure eight.
- `rearm_exhausted` clears that deadline.
- `StateStore._observe_work` also resets `not_before=NULL` when installing another observation.
- `_checkpoint_progress` publishes stream and account holds, but no per-document restriction. Fresh-state recovery therefore cannot restore a document deadline and can re-enumerate/retry early.

F6’s fresh-state issue is consequently a correctness gap, not merely missing test coverage.

| Transition/state | Canonical owner and durable evidence | Readers/recovery and adjudication |
|---|---|---|
| Provider response → classified deadline | `GoogleDriveSource._provider_call` / `parse_retry_after` | Preserve valid absolute deadlines, bounded malformed-input fallback, and fail-closed unrepresentable input. |
| Document failure → attempts/exhaustion | Coordinator drain through `StateStore.fail_work`; SQLite pending obligation keyed by namespace, generation, item, action and observation revision | Exhaustion stops automatic selection but leaves an owed outcome. Rearm may reset the attempt budget; it has no authority to waive provider restrictions. |
| Document provider minimum | Currently embedded only in pending-work `not_before` | **Ownership incomplete.** Give the coordinator one durable provider-restriction record independent of observation retry counters, carried through acknowledged progress and restored before affected reads. |
| Account provider minimum | Coordinator through monotonic `hold_connection`; SQLite `connection_holds`, mirrored in acknowledged `account_hold` | Adopt matching generation/account evidence before provider admission. Shorter local/remote holds cannot shorten the standing minimum. Admin rearm does not own this state. |
| Manual run request → execution | Scheduler’s `_manual_gdrive_job` requests the ordinary coordinator with `rearm_exhausted=True` | Same queue and execution authority as polling. Request/attempt identity controls run reporting; it is not provider-override authority. |
| Enumeration/change page → owed work | Coordinator materialization and `StateStore._observe_work`; pages, membership provenance and observation revisions | New observations can supersede old content intent. They cannot independently cancel a still-applicable provider minimum. |
| Restart/rescan → reconstruction | Coordinator using acknowledged brain progress and surviving SQLite evidence | Missing local snapshot triggers controlled recovery, not assumed completion. Reconstruction must restore restrictions before re-reading affected resources. |
| Root loss/restoration | Coordinator’s verified root observations; `selection_root_bindings`, fenced `roots` evidence | Own 404 of a previously bound root can record loss. Restoration needs current access/location/membership evidence. Notification metadata alone cannot clear unavailable detail. |
| Content/removal → durable acceptance | Existing fenced brain ingest/reconciliation owners; connection claims and cleanup obligations | Preserve current-observation checks and claim-aware retirement. Other connection claims survive. |
| Partial → current | Coordinator’s all-stream completion/reconciliation gate, then acknowledged checkpoint | Terminal change token is necessary but insufficient. Owed, exhausted, deferred, unknown or unacknowledged outcomes prevent complete success and scope-wide absence. |

Execution authority remains the brain’s enabled connection, bound principal, generation, lease owner, fence and unexpired lease. Progress replacement additionally requires the expected revision; stale nonidentical writes fail. Local observation revisions prevent obsolete work from acknowledging or publishing over newer intent. **Neither fence nor revision checking repairs a logically authorized writer that clears its own restriction incorrectly.**

The existing completion and claim owners remain coherent: `_checkpoint_complete_if_clean` checks pending work and terminal-drain evidence; the coordinator additionally requires every stream and acknowledged reconciliation. Brain claim retirement is connection-scoped and checks surviving claims under the provider lock.

**F1 — Accept; bounded architectural fix required**

The early retry is confirmed. `gdrive_sync.py:1187–1189` invokes rearm for ordinary manual runs, and `state.py:1549–1556` clears the deadline recorded by `_fail_work`.

The narrow immediate correction is to **preserve `not_before` when rearming exhaustion**. Keeping even an expired value is harmless because selection already checks eligibility. No new deadline arithmetic is needed.

That correction alone does not close acceptance. The same provider minimum must survive replacement observations and fresh-state reconstruction:

- Separate provider-minimum authority from observation attempts/exhaustion, using the existing coordinator/state/progress owners.
- Identify the restriction by the verified connection/account and stable provider resource, with generation/context validation; an observation revision or new run ID must not silently replace its authority.
- Merge applicable restrictions monotonically. Carry them in the existing fenced progress protocol and restore them before affected provider reads, including direct-root/rescan paths.
- Preserve independent-document progress; do not turn every document 503 into a blanket account hold merely to avoid tracking its restriction.
- Keep local evidence if publication fails; report that remote durability is unconfirmed. An uncertain checkpoint must stop further changed publication until authority is reacquired.
- Do not use scope changes, queue replacement or rescan as an implicit override.

Manual intervention **cannot currently be distinguished as an authorized provider override**. Run now and Retry both request rearm through the same path. Calling that action “manual intervention” grants no additional authority under the deferred-override decision.

Required regressions:

1. Seven failures, then an eighth real provider-call 503 carrying a valid long deadline; repeated Run now/Retry before expiry makes no affected provider read, push or completion claim.
2. Repeat with the unrepresentable sentinel; rearm never makes it eligible.
3. Reopen the same SQLite file and separately reconstruct from acknowledged progress into a fresh file; neither bypasses the minimum.
4. Duplicate/new observation and controlled rescan retain the applicable restriction; independent documents still progress.
5. After a representable deadline passes, the rearmed obligation can complete normally. A newer removal/supersession cannot let stale upsert work restore content.
6. Lost checkpoint acknowledgment and stale-generation/revision attempts cannot erase newer restriction evidence or manufacture completion.

**F2 — Accept, with a narrowly related admission correction**

`absence_withheld` sends both “here” and “absent” observations to `settle_root`; R48’s widened setter consequently clears unavailable detail on another verified absence.

Required behavior:

- Settle only a positively verified root present in its bound drive.
- For verified absence, retain or record unavailable detail through the existing root-loss owner. Do not alter the claim/removal or partial-run gates.
- Preserve malformed/unrepresentable diagnostics when root observation defers. Count the diagnostic for the actual observation, rather than losing it while reporting only the generic category.

The architectural trace also confirms that this handler catches quota `ProviderDeferred` and returns a **stream-only** deferral. Its age does not make that routing correct: an account rate limit must reach the existing account-hold owner and stop further account calls. Route quota deferrals through that owner; preserve the stream’s unresolved page and absence withholding. This is a bounded reuse of existing authority, not a new retry system.

Required tests: duplicate tombstone after unavailable evidence is published; real provider-call malformed and unrepresentable headers on this path; and quota 403/429 with a sibling stream proving no subsequent account call. No root/claim removal may result from these deferrals.

**F3 — Accept**

A restored directly selected file can be re-ingested while its binding remains unavailable. AC-05 restoration and AC-07 truthful state require clearing that stale detail.

Clear it on the existing verified restoration path, not when a change-page hint arrives. Required evidence:

- Same stable provider ID and currently selected file root.
- Current account/generation and live provider/execution gate.
- Fresh metadata showing readable, nontrashed supported content in the currently bound drive.
- Current work observation and selected membership; no unresolved relocation.
- Fenced publication of updated root evidence.

Root availability and complete content ingestion are distinct facts: clearing unavailable detail must not itself acknowledge failed extraction or mark the run current. A successful extraction/accepted-ingestion path is a suitable conservative place to clear it.

Test file-root loss followed by change-log restoration without another baseline; verify unchanged identity, restored content and cleared published detail. Include stale hints, changed drive, failed access and superseded work as negative cases.

**F4 — Accept behavior; defer override**

A valid multi-year deadline may remain pending without a Run-now escape. An unrepresentable deadline may remain fail-closed at the sentinel. These outcomes follow the binding D2 decision.

Do not cap, shorten, relabel as successful, or exhaust-and-rearm to escape either restriction. The sentinel represents an unrepresentable restriction, not a promise that the original provider deadline expires at that instant. Preserve that distinction in restriction semantics.

A dedicated override requires a separate product/authority decision. Scope change is not an approved recovery workaround.

**F5 — Defer the proposed expansion; retain existing diagnostic obligations**

AC-07 requires truthful selected scope, account, attempts/success, counts, backlog, reconnect and run states. It does not specifically require rendering raw `progress.roots`, a document-deadline browser, or a new diagnostic API.

The originating run already records diagnostic categories through the existing run-report path. Therefore, missing dedicated root-detail UI and lack of repeated account-hold diagnostics do **not independently require a new surface in this slice**.

Required here: fix F2/F3’s false or missing evidence and preserve accurate partial/held reporting. Preserve the unrepresentable classification in any new durable document-restriction representation so recovery cannot reinterpret it as an ordinary expiring deadline. Richer persistent hold explanations and root-detail rendering remain deferred; do not claim the current UI displays those details.

**F6 — Mixed disposition**

- **Real claim reconciliation:** `_ClaimLedger` proves orchestration only. The accepted specification requires real-Postgres lifecycle/overlap evidence. Existing production `retireGdriveItemClaim` is connection-scoped, and existing Postgres tests cover surviving claims; this is not evidence of a new claim-owner defect. Map the D1 complete-snapshot payload to that real reconciliation path and its assertions. If existing coverage does not exercise that path, add one focused Postgres case. A duplicate broad end-to-end suite is unnecessary.
- **Document restart/fresh-state coverage:** **required**, with the F1 ownership correction. Fresh-state early probing contradicts D2; it is not acceptable as “the provider will repeat its deadline.”
- **Root auth/status doubles:** useful but insufficient to prove classification and admission. Add focused real `_provider_call` tests for quota versus nonquota refusal on the affected root path. No need to duplicate every combination across every phase.
- **Unused `_retry_after`:** defer cleanup. Production parser/call-path tests are the relevant proof; removing an unused compatibility helper is not required acceptance work.
- **Earlier memberships retained in an incomplete snapshot:** conservative, not a new defect. Preserve R46 F4; do not turn uncertain or failed owed outcomes into absence to accelerate cleanup.

**Bounded writer scope and preserved invariants**

Return these corrections to the existing sole implementation writer: coordinator/state/progress ownership of document restrictions, the identified root diagnostic/restoration paths, focused regressions, and corresponding architecture/acceptance documentation. No new Admin controls, provider override, competing reconciliation owner or broad queue redesign is authorized. The restriction-lifetime/progress change warrants another independent review of the resulting exact snapshot.

Preserve without exception:

- Valid provider minima are never shortened by ordinary retry, rearm, replay or recovery.
- Malformed input uses bounded fallback; unrepresentable input remains fail-closed.
- Exhaustion remains owed work, never completion.
- Only a previously bound root’s own verified 404 supplies D1 loss evidence.
- Direct/overlapping selections and other connection claims survive.
- Unknown roots and genuinely failed/exhausted obligations withhold scope-wide absence.
- Restoration requires current access and selected membership.
- Generation, lease, observation and progress-revision authority remain intact; acknowledgment uncertainty is not success.

This decision does not establish readiness. The corrections and their verification remain outstanding; earlier passing results do not attest them. Fresh-state recovery can only restore remotely acknowledged evidence—loss of both unpublished local restriction state and its storage remains an explicit durability limitation. Live Google certification, the sandbox soak, real-environment acceptance evidence and previously recorded rollout gates remain unresolved.