# GPT-6.1 Sol blind final review — PR743 candidate `1a9ca615`

**Verdict: CHANGES REQUIRED.** Two confirmed implementation findings remain.

Reviewed source base `5ecd2989e21fded915b41b508477bb267aaec06d` → candidate `1a9ca6151a4ad98fe704476382f0bfd1170ea253`, covering the supplied 65-path diff and affected ingestion, identity, authority, claim, reconciliation, repair and timeline callers.

The supplied patch SHA-256 matches `7e0407dfcebfa0faf0f076e94382b38141eef6fd1cab9b2064c97c5a865374ee`. All 231 destination hunks match the working files. The worktree ref is later evidence commit `9e42d5e2144dd33415af547cd3f178e1a94d2977`; the coordinator independently confirmed that subsequent paths are exclusively `.context/` evidence.

## 1. [P1 / High] Explicit trash is discarded after local-membership recovery, leaving retained brain content accessible

Location: `ingestion/aios_ingest/gdrive_sync.py:2625`.

**Trigger:** A connection has already imported `file-x`, then loses its SQLite state while `file-x` or its selected root is under a provider restriction. Fresh recovery preserves the brain’s claim but intentionally reconstructs no local membership for the unreadable selection. After recovery starts draining changes, Google emits `file.trashed=true` for `file-x`.

**Expected:** Persist that positive document-loss evidence and retire this connection’s claim through the claim-aware sink without reading the restricted document/root. Other connections’ claims must survive.

**Actual:** `selected` comes exclusively from local membership at line 2589. Both the new explicit-trash branch at lines 2625–2635 and the fallback removal branch at lines 2646–2650 require `selected`. With recovered membership absent, the coordinator consumes the event without creating any removal obligation. The deferred root prevents complete-snapshot reconciliation, so the brain’s previous claim and content remain until the restriction expires and enumeration recovers—potentially indefinitely for an unrepresentable minimum.

**Evidence:** `ingestion/tests/test_restricted_root_recovery.py:110` explicitly establishes fresh recovery with retained brain state and no local membership. `ingestion/tests/test_explicit_trash_evidence.py:69` exercises trash only with retained local membership. Their combination is missing. The server removal owner already limits retirement to the reporting connection’s active claims in `lib/ingest/source-reconcile.ts:205–225`.

This violates AC-05/06’s verified removal and suppression requirements. Local membership loss must not discard explicit trash evidence for a retained server claim.

## 2. [P2 / Medium] Automatic permission-ID discovery bypasses the new Google email attribution hold

Locations: `lib/integrations/gdrive-identity-discovery.ts:59`, `lib/identity/resolve.ts:232`.

**Trigger:** `author-email:alice@example.com` has an applicable unlink tombstone or ambiguous equivalent history. Alice’s roster/alias email still exists. A real incoming Drive contribution provides a previously unreviewed `permission:P` together with that email.

**Expected:** The held email bridge must not create new attribution authority. An independently established permission mapping can retain its own decision; a new mapping derived solely from the held email must remain unresolved.

**Actual:** The real items endpoint invokes `discoverGdriveContributorIdentities` before attribution (`app/api/v1/items/route.ts:158–167`). Discovery checks only the permission ID’s mapping state, then calls `resolveConfirmedEmail`. That helper reads `byEmail` without checking `googleEmailAttributionHeld`, so discovery persists `permission:P → Alice`. Subsequent author, contribution-store and timeline readers prefer that provider-ID mapping and therefore never reach their new email-hold checks. Automatic ingestion restores credit through a newly minted durable mapping despite the deliberate email hold.

**Evidence:** `lib/identity/provider-sync.ts:31–34` resolves the roster email regardless of Google email authority; `lib/integrations/gdrive-identity-discovery.ts:59–69` uses that result to create the mapping. The new email-reader tests exercise email-only identities and repair/projection paths, without this production discovery boundary.

This violates AC-08/09’s preservation of deliberate attribution decisions. Apply the shared Google email authority rule when admitting email-derived automatic discovery, while preserving already established permission-ID authority.

## Scope and limits

The remaining reviewed changes cover durable page/cursor acknowledgment, root-loss/recovery gates, restriction lifetime and retry provenance, watch quota handling, Admin grant policy, identity equivalence, schema parity and regression assertions. No additional confirmed blockers were found in the inspected paths.

This was a blind, read-only static review. No commands or tests were run and no edits were made. No prior review, adjudication, handoff or writer reports were consulted. Runtime test results, authenticated provider behavior and the separate live sandbox/24-hour certification gate remain unverified. No merge or deployment readiness is claimed.
