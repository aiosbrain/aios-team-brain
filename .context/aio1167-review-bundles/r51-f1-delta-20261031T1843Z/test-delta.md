# F1 regression excerpt

Exact source is pinned by `manifest.json` and available in `untracked-source.tar.gz`. This excerpt is copied from the changed test file for focused review:

```python
async def test_a_document_failure_already_in_the_total_never_suppresses_the_flush_authority_charge(
    tmp_path, code,
):
    """R51 Fable F1 / control #3, at the helper's own charge decision: the total ALREADY holds an
    independent document failure (no run charge, no authority category) when the flush is refused,
    and the caller passes no ``cause`` and no ``run_failure_counted`` (default false). The refusal
    is still this run's one charge, so ``failed`` goes from 1 to 2. A charge inferred from
    ``total.failed > 0`` would leave it at 1. This is helper-level coverage of that decision; the
    stream-level fixture below remains separate preservation coverage."""
    state = StateStore(str(tmp_path / f"flush-document-failure-{code}.sqlite"))
    held = state.hold_connection("conn", 2, "account", "2099-01-01T00:00:00+00:00", "rate_limited")
    execution = GdriveExecution("conn", 2, 1, "owner", "later", "scope", {}, progress={})
    client = _RefusingClient(code)
    total = IngestSummary("docs", failed=1, failure_categories={"incomplete_extraction": 1})

    await _flush_restriction_evidence(client, execution, state, "account", total)

    assert total.failed == 2
    assert total.failure_categories == {"incomplete_extraction": 1, code: 1, "account_hold_unpublished": 1}
    assert client.sent == 1
    assert state.connection_hold("conn", 2, "account") == held  # the local hold is retained
    state.close()

```
