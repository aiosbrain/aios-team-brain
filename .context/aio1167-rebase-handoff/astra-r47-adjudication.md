# AIO-1167 — Astra R47 adjudication (D1/D2 only)

Inputs verified: frozen bundle fingerprint `f553f7de62fd4da44a822fa72c7e3b6707b3ca7c13749edaf6455bae37c43766` at `../aio1167-review-bundles/20261031-r47/20261031-100412/`; full review SHA-256 `b654ef1bb177cc7ae874bc652b4413ef775bc7253236fe5843b760ed9751be18`. Current HEAD is `5ecd2989e21fded915b41b508477bb267aaec06d` **plus the R47 working changes**, not a clean HEAD-only snapshot. Relevant coordinator/state/brain-client files match the retained `wip-r47-20261031-095924/source` checkpoint byte-for-byte; `sources/gdrive.py` is unchanged from HEAD; accepted spec matches the frozen bundle. Source paths below are relative to this task worktree.

Read-only source adjudication; no tests/builds, implementation changes, provider calls or additional workers. This ignored durable report is the only file written.

| Finding | Disposition | Writer scope |
| --- | --- | --- |
| D1 Bound root 404 wedges rescan | **ACCEPT, must fix; narrow deletion authority** | Durably complete the lost root's enumeration outcome from verified root-specific absence, preserve other roots/claims, and resume the normal fenced protocol. |
| D2 Long Retry-After / no override | **REJECT automatic cap/fallback for valid delays; DEFER override policy. ACCEPT malformed/unrepresentable input handling defect, narrowed** | Validate provider delay input and prevent arithmetic failures/invalid durable holds. Preserve valid long delays; do not silently shorten them or add a Run-now bypass. |

## D1 — verified root loss must have a resumable outcome

Evidence:

* `_bind_selected_roots` (`ingestion/aios_ingest/gdrive_sync.py:624–643`) skips already bound roots. A never-bound root's 404 remains explicitly unresolved; that case is not authority to erase an old scope.
* `_observe_root:429–454` distinguishes the bound root's own 404 (`absent`) from other unreadability (`unverified`) and relocation.
* Folder baseline `2113–2131` handles relocation/unverified but falls through on `absent`, settles the root, then still executes its traversal listing at `2228`. If that request returns 404 it reaches `1654–1660`, reports generic `provider_read`, and cannot complete the page.
* File baseline metadata at `2152` has no root-specific 404 handling and reaches the same generic catch. This directly confirms the file-root failure regardless of how Google answers a nonexistent-parent folder listing.
* A removed known folder seeds recovery from all retained active roots (`1893–1930,2006–2020`), including the deleted root. Thus replay can encounter the same failure indefinitely. The existing positive-tombstone path already uses retained root provenance to remove only final-root memberships (`1917–1928`).

Materiality: AC-05 requires removal/access-loss/restoration handling (`accepted-spec.md:240–244`); AC-03 requires resumable pages/outcomes, and AC-07 truthful state. The observed 404 is not a generic transient extraction failure. Refusing forever to represent a verified root loss wedges cursor recovery and subsequent independent updates. This differs from R46 F4: a malformed document still has an owed readable-content outcome, while positive root-specific loss supplies a legitimate removal outcome.

Bounded correction:

1. For a previously bound selected root under current account/generation authority, record its own confirmed 404 as root-specific absent/inaccessible evidence. Finish its corresponding file page or folder traversal durably without issuing pointless child-list requests. Persist enough evidence for restart and remote-progress restoration; do not equate loss with relocation or an arbitrary listing failure.
2. Keep membership provenance: loss of one folder does **not** prove every former child is globally inaccessible. Retire only that root's support; preserve direct selections, overlapping roots, other streams and other connection claims. Use existing ingest reconciliation/removal owners. Do not bypass root-coverage or execution fencing to make the run complete.
3. Publish scope-wide absence only after every other required root/stream and owed outcome has completed. If another root is unknown or a document is genuinely failed/exhausted, keep the run partial and withhold scope-wide absence, exactly as R46 F4 requires. Independently justified positive removals may still flow through the existing claim-aware path.
4. Missing scope, 401, quota 403/429, timeout/5xx, ambiguous listing 404, and never-bound unknown root remain conservative. A folder-list 404 alone must not become global emptiness; use root-specific evidence. Retain an actionable “selected root unavailable” diagnostic and support later restoration only after current provider access/membership is verified.

Tests: baseline then hard-delete a bound folder; make its metadata and attempted listing return 404, drive the actual tombstone/rescan path, and assert no child-list retry after proven absence, durable page/cursor recovery, correct final-root claim retirement, no generic provider_read, and restart-safe completion. Repeat with a selected file root disappearing before a 410 rescan. Include an overlapping/directly selected descendant and another connection claim that must survive; another unknown/failed root must prevent full absence reconciliation; quota/auth/transient errors must not remove anything. Restore access and prove the root can be re-observed without a new content identity. No live claim was made here that Google's parent-query endpoint universally returns 404: the folder stall is conditional on the response stated in the finding; the file and missing-absence-outcome paths are source-confirmed.

## D2 — valid provider backoff and invalid input are different contracts

Confirmed mechanics: `sources/gdrive.py:503–526` parses numeric input with unrestricted `float`, including non-finite numeric spellings, or an HTTP date. `_provider_call:663–675` constructs an absolute timestamp without guarding range/overflow. `_fail_work` (`gdrive_sync.py:125–136`) keeps the later retry instant; account holds are monotonically stored (`state.py:1204–1225`), adopted from authoritative progress (`gdrive_sync.py:197–215`), and checked before admission. Those mechanisms intentionally prevent a restart/manual retry from evading a standing account limit.

**The proposed test that `99999999` must be reduced to a short cap is not an accepted requirement.** It is a large, finite delay-seconds value. AC-04 explicitly says “Honor valid Retry-After, including deferring work when a provider delay exceeds the current run budget” (`accepted-spec.md:230`). “Bound exponential backoff” does not authorize truncating a valid provider minimum. The brain client's separate 3600-second parser rule (`brain_client.py:843–849`) is implementation precedent, not an exception to that specification. No maximum valid provider wait or operator override is approved here.

Accordingly, a long valid hold is a real operational limitation but **not by itself a must-fix defect**. Do not clear it on ordinary Run now/Retry, do not invent a scope change to bypass it, and do not substitute a short “conservative” fallback that actually retries earlier than the named deadline. A dedicated override requires a separate explicit product/spec decision with audited authority and concurrency semantics; defer that work. Displaying the actual retry time/reason would help operations but is not authorization to shorten it.

There is a narrower confirmed robustness defect within the reported input path: unrestricted floats can yield infinity or other non-delay inputs, and `datetime.fromtimestamp(now + delay)` can overflow. Such input must not escape as a generic provider-read exception or publish invalid progress. **Fix this in the bounded correction slice.** Validate delay-seconds/date syntax and finite arithmetic before forming durable state. Malformed/non-finite input may use the existing capped exponential fallback with jitter and an accurate diagnostic. For a syntactically valid but unrepresentable future deadline, avoid a crash and choose a fail-closed, actionable representation/refusal; do not silently interpret it as permission for an early retry. No unrelated redesign of queue/retry ownership is needed.

Tests: malformed text, non-finite numeric spellings, invalid dates and overflow-sized values never crash, emit invalid timestamps, falsely complete, or bypass a legitimate hold. Valid ordinary numeric/date delays round-trip; a valid delay longer than one hour (and the review's large finite value) is not shortened. Test root/start-token and document phases, persistence/restart/new state-file adoption, monotonic merging, and admission after the actual represented deadline. Keep invalid-header fallback bounded; no test should require valid Retry-After to expire inside an arbitrary cap. Tests here are proposed, not executed.

## Next action

The same existing Opus 5.5 HIGH writer should fix **D1** and **D2's malformed/unrepresentable-delay handling**, add the focused regressions above, and document the valid-long-hold deferral. Preserve R46 F4, provider backoff, generation/lease/progress authority, and overlapping claim protections. Then verify and review the exact resulting snapshot. Live certification and target-environment rollout gates remain separate and unproven by this adjudication.
