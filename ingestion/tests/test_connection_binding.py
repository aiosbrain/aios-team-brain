"""Drive jobs run by IMMUTABLE integration id; a name/id contradiction runs nothing (AIO-1167 R44 C11).

Spec (AC-03/07). Manual, notification-hint, remote-poll and watch-renewal jobs choose the local
configuration for an Admin row by the row's immutable id. A documented legacy name-only entry is
bound once by name and then carries the row's id. A local entry that names the row's NAME with a
DIFFERENT explicit id contradicts the row: no execution or provider call happens for either id, and
a claimed manual request is completed as a failure for ITS OWN integration — never reported as
another integration's run.
"""

from __future__ import annotations

import pytest

from aios_ingest import scheduler, watch_renewal
from aios_ingest.brain_client import GdriveRunRequest
from aios_ingest.config import BrainSettings, Connection
from aios_ingest.selections import bind_local_gdrive
from aios_ingest.state import StateStore

SETTINGS = BrainSettings(base_url="http://brain", api_key="aios_a_b", team="demo")
REAL = "00000000-0000-0000-0000-0000000000c1"
WRONG = "00000000-0000-0000-0000-0000000000c2"


def _gd(name, **options):
    return Connection(name, "gdrive", options=options)


def test_explicit_id_wins_and_may_carry_its_own_local_label():
    local = _gd("my-label", integration_id=REAL, service_account_key_path="/k.json")
    assert bind_local_gdrive([local], REAL, "docs") == (local, False)


def test_a_legacy_name_only_entry_is_bound_once_and_carries_the_row_id():
    local = _gd("docs", service_account_key_path="/k.json")
    bound, conflict = bind_local_gdrive([local], REAL, "docs")
    assert not conflict and bound.options["integration_id"] == REAL
    assert bound.options["service_account_key_path"] == "/k.json"
    assert "integration_id" not in local.options  # the configured entry itself is not mutated


def test_same_name_with_another_explicit_id_is_a_contradiction():
    assert bind_local_gdrive([_gd("docs", integration_id=WRONG)], REAL, "docs") == (None, True)


def test_no_entry_is_a_remote_only_connection():
    assert bind_local_gdrive([_gd("other")], REAL, "docs") == (None, False)


CONFLICTING = [_gd("docs", integration_id=WRONG, service_account_key_path="/wrong.json")]
ROW = {"id": REAL, "type": "gdrive", "name": "docs", "status": "enabled",
       "config": {"authMode": "oauth", "fileIds": ["d"], "selectionState": "selected"}}


class _Brain:
    def __init__(self, rows=(ROW,), request=None):
        self.rows, self.request, self.completed = list(rows), request, []

    def install(self, monkeypatch):
        brain = self

        class Client:
            def __init__(self, *args, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def fetch_integration_selections(self, **kwargs): return brain.rows
            async def claim_gdrive_run_request(self): return brain.request
            async def complete_gdrive_run_request(self, request, summary, *, status, error=None):
                brain.completed.append((request.integration_id, summary.integration_id, status, error))

        monkeypatch.setattr("aios_ingest.brain_client.BrainClient", Client)
        return self


@pytest.fixture()
def runs(monkeypatch):
    seen: list[tuple[str, str]] = []

    async def fake_run(settings, conn, state, **kwargs):
        seen.append((conn.name, str(conn.options.get("integration_id") or "")))
        raise AssertionError("a contradicted binding must not run")

    async def fake_poll(settings, conn, state):
        seen.append((conn.name, str(conn.options.get("integration_id") or "")))

    monkeypatch.setattr(scheduler, "run_gdrive_stream", fake_run)
    monkeypatch.setattr(scheduler, "_poll_job", fake_poll)
    return seen


@pytest.mark.asyncio
async def test_manual_request_with_a_contradicting_local_entry_fails_for_its_own_integration(tmp_path, monkeypatch, runs):
    request = GdriveRunRequest("req-1", REAL, "docs", "manual", "2026-10-27T00:00:00+00:00", "token")
    brain = _Brain(request=request).install(monkeypatch)
    state = StateStore(str(tmp_path / "manual.sqlite"))
    await scheduler._manual_gdrive_job(SETTINGS, CONFLICTING, state)
    assert runs == []
    assert brain.completed == [(REAL, REAL, "failed", "connection_binding_conflict")]
    state.close()


@pytest.mark.asyncio
async def test_hint_for_a_contradicted_row_wakes_nothing(tmp_path, monkeypatch, runs):
    _Brain().install(monkeypatch)
    state = StateStore(str(tmp_path / "hint.sqlite"))
    monkeypatch.setattr(state, "pending_hint_connections", lambda team: {REAL: 1})
    await scheduler._gdrive_hint_job(SETTINGS, CONFLICTING, state, {})
    assert runs == []
    state.close()


@pytest.mark.asyncio
async def test_remote_poll_skips_a_contradicted_row_and_never_runs_the_other_id(tmp_path, monkeypatch, runs):
    _Brain().install(monkeypatch)
    state = StateStore(str(tmp_path / "remote.sqlite"))
    await scheduler._remote_gdrive_poll_job(SETTINGS, CONFLICTING, state)
    assert runs == []
    state.close()


@pytest.mark.asyncio
async def test_a_valid_name_only_entry_is_woken_under_the_row_id(tmp_path, monkeypatch, runs):
    _Brain().install(monkeypatch)
    state = StateStore(str(tmp_path / "valid.sqlite"))
    monkeypatch.setattr(state, "pending_hint_connections", lambda team: {REAL: 1})
    await scheduler._gdrive_hint_job(SETTINGS, [_gd("docs", service_account_key_path="/k.json")], state, {})
    assert runs == [("docs", REAL)]
    state.close()


@pytest.mark.asyncio
async def test_renewal_binds_by_id_and_skips_a_contradiction(tmp_path, monkeypatch):
    _Brain().install(monkeypatch)
    renewed: list[tuple[str, str, str]] = []

    async def fake_renew(settings, conn, row, state, manager, budget, now):
        renewed.append((conn.name, str(conn.options.get("integration_id") or ""), str(row["id"])))

    monkeypatch.setattr(watch_renewal, "_renew_connection", fake_renew)
    state = StateStore(str(tmp_path / "renew.sqlite"))
    await watch_renewal.renew_watches(state, object(), CONFLICTING, SETTINGS)
    assert renewed == []
    await watch_renewal.renew_watches(state, object(), [_gd("docs", webhook_url="https://x/watch")], SETTINGS)
    assert renewed == [("docs", REAL, REAL)]
    state.close()
