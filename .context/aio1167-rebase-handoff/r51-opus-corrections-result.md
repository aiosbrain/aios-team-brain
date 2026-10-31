# AIO-1167 R51 Opus writer result

- Existing sole writer session: Claude Opus 5.5 HIGH, `628402d5-a1c6-42b7-b736-e84358c1a749`.
- CLI terminal result: success, exit 0, 102 turns, about 18m37s; `apiKeySource=none`, first-party subscription authentication had been verified immediately before dispatch.
- The writer made source, test, documentation, and acceptance-map edits only. It ran no tests, typecheck, lint, build, migration, or shell command. Every R51 result remains `NOT RUN — coordinator` until independent verification.

## Changed scope

Production behavior changed only in `ingestion/aios_ingest/gdrive_sync.py`; supporting state/schema/TypeScript/Postgres production owners were untouched. The writer also added `docs/ARCHITECTURE.md` guidance, new R51 Python regressions, edits to existing restriction/checkpoint tests, and `.context/aio1167-rebase-handoff/r51-acceptance-mapping.md`.

The corrections cover deferred nested-root removal holds, immediate journaling of provider Retry-After observations, separate unpublished hold/resource diagnostics and recovery, one bounded deferred-root probe per poll, provider-versus-local deadline provenance, and exact dispatch/run deadline labels. Non-exhausted Run now behavior is preserved; R49 F6 remains deferred.

## Regression inventory

New modules:
- `ingestion/tests/test_deferred_root_scope.py`: seven cases covering nested edits under deferred roots, a restriction expiring between admission and classification, persistent state/overlap/no scope widening, verified recovery/move-out, bounded probes, named minimums, and quota.
- `ingestion/tests/test_restriction_publication_recovery.py`: multi-root Retry-After ordering across quota, BrainError, authority and local-deadline short-circuits; journal-before-next-read ordering; drain hold publication failure and reacquisition.

Added/changed cases:
- `ingestion/tests/test_checkpoint_acknowledgment.py`: real BrainClient uncertainty-latch lost-ack hold case.
- `ingestion/tests/test_document_restrictions.py`: timeout/malformed Retry-After local fallback provenance, non-exhausted backoff negative control, dispatch/run deadline categories at drain and start-token paths.

Exact test identifiers and requirement mappings are in `r51-acceptance-mapping.md`.

## Remaining coverage limits and unresolved behavior

A held nested edit waits until verified enumeration. Explicit provider tombstones retain existing behavior. No recovery is claimed if both brain and local journal lose the observation. Existing R48–R50 tests, not new R51 tests, cover verified root loss/restoration, duplicate removal, stale upsert and cross-connection claims. Terminal authority refusal without a prior error remains raised when publishing. Fable must still review the omitted R47 Admin/grant-policy paths and the root-coverage/acknowledgment/claim-retirement interaction alongside direct removal and overlap. This is not whole-branch coverage or readiness.

## Writer-reported token accounting

CLI turn counters: uncached input 126; cache-creation input 447,925; cache-read input 20,020,699; output 90,780, including 38,717 thinking tokens. These are per-turn counters, not subscription percentages or cost evidence. Fresh interactive `/usage` after the writer, at about 15:24 UTC, showed session 12%, all-model week 30%, Fable week 35%, credits off.
