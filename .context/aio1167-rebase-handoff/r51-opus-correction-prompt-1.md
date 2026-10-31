# AIO-1167 R51 follow-up — one stale expected category

Resume only the existing Claude Opus 5.5 HIGH writer session `628402d5-a1c6-42b7-b736-e84358c1a749`; do not start a new writer. Fresh subscription usage is below threshold (last interactive reading ~2026-10-31 15:25 UTC: session 12%, all-model week 30%, Fable week 35%, credits off). The coordinator owns checks and recorded the first attempt in `.context/aio1167-rebase-handoff/r51-coordinator-verification.md`.

One full-suite failure is a stale assertion, not a source behavior defect: `ingestion/tests/test_drain_recovery.py::test_budget_expiry_between_metadata_and_docs_is_local_and_untouched` injects `ProviderDeferred(... category="dispatch_deadline")` but expects `{"run_deadline": 1}`. Astra R50 finding 7 requires preserving the actual local deadline category; the R51 implementation does so, and the new `test_document_restrictions.py` parameterized controls cover both exact categories.

Change only that existing assertion to expect `{"dispatch_deadline": 1}`. Keep the separate `run_deadline` regression unchanged. Do not edit production code, do not change any other assertions, do not run tests/commands, and do not commit/push. Return the changed path and exact edit. The coordinator will rerun checks.

For context, the R51 correction result/map are `r51-opus-corrections-result.md` and `r51-acceptance-mapping.md`; no tests ran in your previous turn. Preserve the same sole-writer boundary and all user changes.
