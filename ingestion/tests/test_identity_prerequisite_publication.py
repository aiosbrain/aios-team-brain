"""A standing service-account identity prerequisite retries its publication (AIO-1167 R51 blind-final 4).

Spec (accepted-spec AC-03/04/07; Astra R51 blind-final adjudication). When a fresh acquisition finds
the service-account identity prerequisite still under a provider minimum, the coordinator builds the
held summary and calls the existing ``_flush_restriction_evidence`` exactly once before returning —
never reading the identity again while the restriction stands. Through the real coordinator:

  * a restriction whose first publication failed is published by the next acquisition before it
    expires, and a fresh state file then honours it from the brain's progress;
  * a publication that fails again is reported ``document_restriction_unpublished``;
  * a terminal authority refusal keeps the local evidence, reports its code, and sends nothing more;
  * under the uncertainty latch nothing is sent and the evidence stays truthfully unpublished.
"""

from __future__ import annotations

import copy
from types import SimpleNamespace

import pytest

from aios_ingest.brain_client import BrainError, GdriveExecution
from aios_ingest.config import BrainSettings, Connection
from aios_ingest.connector_state import parse_restriction_evidence
from aios_ingest.gdrive_sync import run_gdrive_stream
from aios_ingest.state import StateStore
from test_root_evidence_r49 import real_deferral

INTEGRATION = "00000000-0000-0000-0000-0000000000f4"
GEN = 6
LONG = "99999999"
PREREQUISITE = "prerequisite:service-account-identity"
SETTINGS = BrainSettings("http://brain", "key", "team")
CONNECTION = Connection(
    "docs", "gdrive", options={"integration_id": INTEGRATION, "service_account_key_path": "/local/key.json"},
)
CONFIG = {
    "authMode": "service_account", "serviceAccountStatus": "pending", "fileIds": ["Doc"],
    "folderIds": [], "sharedDriveIds": [], "selectionState": "selected",
}


def world(monkeypatch):
    """Drive answers the identity read with ``w.identity_error``; the brain stores wire copies and
    can refuse checkpoints (``w.checkpoint_error``) or be latched uncertain (``w.uncertain``)."""
    w = SimpleNamespace(
        progress={}, revision=0, fence=0, identity_reads=0, sent=0,
        identity_error=None, checkpoint_error=None, uncertain=False,
    )

    class Source:
        def __init__(self, **kwargs): pass
        def set_run_deadline(self, deadline): pass

        def service_account_identity(self):
            return "svc@example.com"

        def _services(self):
            class About:
                def get(self, **kwargs): return ("about.get", kwargs)

            class Drive:
                def about(self): return About()

            return Drive(), object()

        def _execute(self, request):
            w.identity_reads += 1
            if w.identity_error is not None:
                raise w.identity_error
            return {"user": {"emailAddress": "svc@example.com"}}

    class Gate:
        def __call__(self): pass
        def close(self): pass

    class Client:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass

        async def acquire_gdrive_execution(self, requested, owner):
            w.fence += 1
            return GdriveExecution(
                requested, GEN, w.fence, owner, "later", "scope", dict(CONFIG),
                progress=copy.deepcopy(w.progress), progress_revision=w.revision,
            )

        def gdrive_provider_gate(self, execution): return Gate()
        def gdrive_progress_uncertain(self, execution): return w.uncertain

        async def checkpoint_gdrive_execution(self, execution, payload):
            w.sent += 1
            if w.checkpoint_error is not None:
                raise w.checkpoint_error
            w.revision += 1
            w.progress = copy.deepcopy(payload)
            return {"progress_revision": w.revision, "progress": copy.deepcopy(payload)}

        async def verify_gdrive_service_account(self, execution, identity): pass
        async def release_gdrive_execution(self, execution): pass

    monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)
    return w


def _local_restrictions(state: StateStore) -> set[str]:
    return {
        provider_id
        for account in state.restriction_credentials(INTEGRATION)
        for provider_id in state.document_restrictions(INTEGRATION, GEN, account)
    }


def _published(w) -> set[str]:
    return {
        provider_id
        for entry in parse_restriction_evidence(w.progress).values()
        for provider_id in (entry.get("resources") or {})
    }


async def _first_publication_fails(w, state):
    w.identity_error = real_deferral(503, LONG)
    w.checkpoint_error = BrainError(503, "server_error", "brain unavailable")
    first = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert w.identity_reads == 1
    assert first.failure_categories.get("provider_unavailable") == 1
    assert first.failure_categories.get("document_restriction_unpublished") == 1
    assert PREREQUISITE in _local_restrictions(state) and _published(w) == set()
    return first


@pytest.mark.asyncio
async def test_the_next_acquisition_publishes_the_standing_restriction_and_a_fresh_state_honours_it(
    tmp_path, monkeypatch,
):
    w = world(monkeypatch)
    state = StateStore(str(tmp_path / "sa.sqlite"))
    await _first_publication_fails(w, state)
    sent_before = w.sent

    w.checkpoint_error = None
    second = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert w.identity_reads == 1  # the identity is not read again while restricted
    assert w.sent == sent_before + 1  # exactly one publication attempt
    assert _published(w) == {PREREQUISITE}
    assert second.failure_categories == {"provider_restricted_resource": 1}
    state.close()

    fresh = StateStore(str(tmp_path / "fresh.sqlite"))
    third = await run_gdrive_stream(SETTINGS, CONNECTION, fresh)
    assert w.identity_reads == 1
    assert PREREQUISITE in _local_restrictions(fresh)
    assert third.failure_categories == {"provider_restricted_resource": 1}
    fresh.close()


@pytest.mark.asyncio
async def test_a_repeated_publication_failure_stays_reported_unpublished(tmp_path, monkeypatch):
    w = world(monkeypatch)
    state = StateStore(str(tmp_path / "sa-repeat.sqlite"))
    await _first_publication_fails(w, state)
    sent_before = w.sent

    again = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert w.identity_reads == 1 and w.sent == sent_before + 1
    assert again.failure_categories == {
        "provider_restricted_resource": 1, "document_restriction_unpublished": 1,
    }
    assert PREREQUISITE in _local_restrictions(state) and _published(w) == set()
    state.close()


@pytest.mark.parametrize("code", ["stale_execution", "connection_unavailable"])
@pytest.mark.asyncio
async def test_an_authority_refusal_keeps_the_evidence_and_sends_nothing_more(tmp_path, monkeypatch, code):
    w = world(monkeypatch)
    state = StateStore(str(tmp_path / f"sa-{code}.sqlite"))
    await _first_publication_fails(w, state)
    sent_before = w.sent

    w.checkpoint_error = BrainError(409, code, "refused")
    refused = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert w.identity_reads == 1 and w.sent == sent_before + 1  # one refused attempt, nothing after
    assert refused.failure_categories.get(code) == 1
    assert refused.failure_categories.get("document_restriction_unpublished") == 1
    assert refused.failure_categories.get("provider_restricted_resource") == 1
    assert "coordinator_error" not in refused.failure_categories
    assert PREREQUISITE in _local_restrictions(state)
    state.close()


@pytest.mark.asyncio
async def test_under_an_uncertain_acknowledgment_nothing_is_sent_and_it_stays_unpublished(tmp_path, monkeypatch):
    w = world(monkeypatch)
    state = StateStore(str(tmp_path / "sa-uncertain.sqlite"))
    await _first_publication_fails(w, state)
    sent_before = w.sent

    w.checkpoint_error = None
    w.uncertain = True
    held = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert w.identity_reads == 1 and w.sent == sent_before  # nothing sent under the latch
    assert held.failure_categories == {
        "provider_restricted_resource": 1, "document_restriction_unpublished": 1,
    }
    assert PREREQUISITE in _local_restrictions(state)
    state.close()
