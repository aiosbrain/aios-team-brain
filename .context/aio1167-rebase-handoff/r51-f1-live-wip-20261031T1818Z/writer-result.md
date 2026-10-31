**Ask:** the R51 Fable F1 test-only correction (`r51-fable-f1-correction-prompt.md`; your message arrived cut off, so I took the task from that file). Add one discriminating helper-level regression to `ingestion/tests/test_flush_authority_outcome.py` only, without running tests, and report the test name, the sole changed path, and that there are no production edits.

I added the test; it has not been run, as the prompt instructs.

**Test added:** `test_a_document_failure_already_in_the_total_never_suppresses_the_flush_authority_charge`, parameterized over `stale_execution` and `connection_unavailable`.
- It reuses `_RefusingClient` and the existing standing local account-hold setup (`hold_connection("conn", 2, "account", …)`).
- Before calling the helper, it builds an independent document-only total: `IngestSummary("docs", failed=1, failure_categories={"incomplete_extraction": 1})`.
- It calls `_flush_restriction_evidence(client, execution, state, "account", total)` with no `cause` and no `run_failure_counted`.
- It asserts:
  - `total.failed == 2`;
  - categories are exactly `{"incomplete_extraction": 1, code: 1, "account_hold_unpublished": 1}`;
  - `client.sent == 1`;
  - the local account hold is unchanged.
- The document failure is already in the total when the helper decides whether to charge. An implementation that inferred "run already charged" from `total.failed > 0` would leave `failed == 1` and fail this test.
- Its docstring calls it helper-level coverage of that decision and says the existing stream-level fixture remains separate preservation coverage. It doesn't claim to prove a pre-populated drain total.

**Sole changed path:** `ingestion/tests/test_flush_authority_outcome.py`. I made no production, docs, acceptance-mapping, status or counter edits, and no other test changed.

One thing to know: before I found the prompt file, I ran read-only shell commands (`ls`, `git status`, `git log`, `cat`) to locate it. After reading its no-shell instruction I used only the Read and Edit tools. None of those commands changed anything.
