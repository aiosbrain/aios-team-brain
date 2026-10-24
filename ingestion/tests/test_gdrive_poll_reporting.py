"""The scheduled Drive poll's REPORTING path, end to end through the real HTTP client (AIO-1167 r37).

Spec.
  · BUSY. An ``execution_busy`` refusal of the brain's authority acquisition becomes a coordinator
    summary, then a ``_poll_job`` report, serialized by the real ``BrainClient``: exactly
    ``status=deferred``, ``error=execution_busy``, zero work, zero failures, ``skipped=1``, unknown
    backlog and cursor age, ``authoritativeComplete=false`` — and the stream's pending hint and its
    durable progress are untouched, so the coordinator that holds the lease (or the next wake) drains it.
  · PAUSED. A paused or disconnected connection is not polled and reports nothing: its pause is not a
    failure. A pause landing between the preflight and the brain's authority check is re-read and
    reports nothing either. But an ENABLED connection's authority refusal is actionable and is
    reported as a failure (never as healthy progress).
  · RESOLVED. Once the immutable integration id is resolved — including by name, for a local
    configuration — every early failure (broker refusal, missing service-account credentials, a
    service-account identity Drive did not name, the brain refusing to verify it, Drive deferring
    the identity read) is reported against it, with ``failed=1``, the exact category and
    ``authoritativeComplete=false``. A failure before resolution is a local diagnostic only: no id
    is invented.

Only the boundaries are replaced — the network (an ``httpx.MockTransport`` behind the real client)
and, for the identity cases, the Google Drive source; the coordinator, ``_poll_job`` and the payload
serialization are the production code.
"""
from __future__ import annotations

import json
import logging

import httpx
import pytest

from aios_ingest.brain_client import BrainClient
from aios_ingest.config import BrainSettings, Connection
from aios_ingest.scheduler import _poll_job
from aios_ingest.sources.gdrive import ProviderDeferred
from aios_ingest.state import StateStore, StreamKey

SETTINGS = BrainSettings(base_url="http://brain", api_key="aios_key1_secret", team="demo")
INTEGRATION = "00000000-0000-0000-0000-0000000000d1"


class Brain:
    """A scripted brain: answers by route and records every request it saw."""

    def __init__(self, *, rows, acquire=None, token=None, verify=None):
        self.rows = rows  # a list, or a list of lists consumed one per selection read
        self.acquire = acquire or (lambda: (409, {"error": {"code": "execution_busy", "message": "busy"}}))
        self.token = token
        self.verify = verify or (lambda: (200, {"ok": True}))
        self.requests: list[tuple[str, str, dict | None]] = []

    def selections(self):
        if self.rows and isinstance(self.rows[0], list):
            return self.rows.pop(0) if len(self.rows) > 1 else self.rows[0]
        return self.rows

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.requests.append((request.method, request.url.path, body))
        path = request.url.path
        if path == "/api/v1/integrations":
            return httpx.Response(200, json={"integrations": self.selections()})
        if path == "/api/v1/integrations/gdrive/execution":
            action = (body or {}).get("action")
            if action == "acquire":
                status, payload = self.acquire()
                return httpx.Response(status, json=payload)
            if action == "verify_service_account":
                status, payload = self.verify()
                return httpx.Response(status, json=payload)
            return httpx.Response(200, json={"ok": True})  # release
        if path == "/api/v1/integrations/gdrive/token":
            status, payload = self.token()
            return httpx.Response(status, json=payload)
        if path == "/api/v1/integrations/gdrive/runs":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404, json={"error": {"code": "not_found", "message": path}})

    def reports(self) -> list[dict]:
        return [body for method, path, body in self.requests
                if method == "POST" and path == "/api/v1/integrations/gdrive/runs"]

    def acquired(self) -> int:
        return sum(1 for method, path, body in self.requests
                   if path == "/api/v1/integrations/gdrive/execution" and (body or {}).get("action") == "acquire")


@pytest.fixture
def brain(monkeypatch):
    holder: dict[str, Brain] = {}

    class MockBrainClient(BrainClient):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._client = httpx.AsyncClient(transport=httpx.MockTransport(holder["brain"]))

    def install(instance: Brain) -> Brain:
        holder["brain"] = instance
        return instance

    monkeypatch.setattr("aios_ingest.brain_client.BrainClient", MockBrainClient)
    monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", MockBrainClient)
    return install


def row(status="enabled", *, name="local-docs", auth_mode="oauth", integration_id=INTEGRATION):
    return {
        "id": integration_id, "type": "gdrive", "name": name, "status": status,
        "config": {"authMode": auth_mode, "fileIds": ["Doc"], "selectionState": "selected",
                   "authenticatedAccountId": "account"},
    }


def acquired_execution(auth_mode="oauth", **config):
    return lambda: (200, {
        "integration_id": INTEGRATION, "generation": 4, "fence": 2, "owner": "owner",
        "lease_expires_at": "2099-01-01T00:00:00+00:00", "scope_hash": "scope",
        "config": {"authMode": auth_mode, "fileIds": ["Doc"], "selectionState": "selected",
                   "authenticatedAccountId": "account", **config},
        "progress": {}, "progress_revision": 1,
    })


def drive_identity(about):
    """The Google Drive provider boundary, and nothing else: ``about`` is what Drive answers for the
    service account's identity — a payload, or an exception the source raises."""

    class Source:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def _execute(self, request):
            if isinstance(about, Exception):
                raise about
            return about

        def _services(self):
            class About:
                def get(self, **kwargs):
                    return ("about.get", kwargs)

            class Drive:
                def about(self):
                    return About()

            return Drive(), object()

    return Source


async def test_busy_refusal_is_reported_exactly_as_a_neutral_deferral_and_keeps_hint_and_progress(tmp_path, brain):
    state = StateStore(str(tmp_path / "busy.sqlite"))
    key = StreamKey(SETTINGS.team, INTEGRATION, "account", "my-drive")
    progress = state.begin_generation(key, 4, start_token="start")
    state.update_progress(progress.namespace, page_token="cursor-before")
    state.record_stream_hint(key)
    before = state.get_progress(progress.namespace)
    b = brain(Brain(rows=[row()]))
    conn = Connection("local-docs", "gdrive", options={"integration_id": INTEGRATION})

    await _poll_job(SETTINGS, conn, state)

    assert b.acquired() == 1
    [report] = b.reports()
    assert report["integrationId"] == INTEGRATION and report["trigger"] == "scheduler"
    assert {key: report[key] for key in (
        "status", "error", "created", "updated", "unchanged", "removed", "failed", "skipped",
        "backlog", "cursorAgeSeconds", "authoritativeComplete",
    )} == {
        "status": "deferred", "error": "execution_busy", "created": 0, "updated": 0, "unchanged": 0,
        "removed": 0, "failed": 0, "skipped": 1, "backlog": None, "cursorAgeSeconds": None,
        "authoritativeComplete": False,
    }
    # Nothing was acknowledged or advanced: the hint stays pending, the cursor where it was.
    assert state.pending_stream_hint(key) == 1
    after = state.get_progress(progress.namespace)
    assert (after.page_token, after.last_success_at, after.last_attempt_at) == (
        before.page_token, before.last_success_at, before.last_attempt_at,
    )
    state.close()


@pytest.mark.parametrize("status", ["disabled"])
async def test_a_paused_local_connection_is_not_polled_and_reports_nothing(tmp_path, brain, status):
    state = StateStore(str(tmp_path / "paused.sqlite"))
    b = brain(Brain(rows=[row(status)]))
    await _poll_job(SETTINGS, Connection("local-docs", "gdrive", options={"integration_id": INTEGRATION}), state)
    assert b.acquired() == 0
    assert b.reports() == []
    state.close()


async def test_a_pause_between_preflight_and_authority_check_reports_nothing(tmp_path, brain):
    state = StateStore(str(tmp_path / "race.sqlite"))
    b = brain(Brain(
        rows=[[row("enabled")], [row("disabled")]],
        acquire=lambda: (409, {"error": {"code": "connection_unavailable", "message": "paused"}}),
    ))
    await _poll_job(SETTINGS, Connection("local-docs", "gdrive", options={"integration_id": INTEGRATION}), state)
    # The brain's fence refused it (the race is real), and the re-read explained it: no report.
    assert b.acquired() == 1
    assert b.reports() == []
    state.close()


OTHER_INTEGRATION = "00000000-0000-0000-0000-0000000000d2"


@pytest.mark.parametrize("paused_mid_run", [True, False])
async def test_a_pause_after_the_execution_was_acquired_is_not_a_failure_but_stale_authority_otherwise_is(
    tmp_path, brain, paused_mid_run,
):
    """Enabled at the preflight, acquired, then a fenced request answers ``stale_execution``.

    Whether that is a pause or an actionable authority loss is decided by THIS connection's current
    Admin state alone: another Drive connection of the team stays enabled throughout, so neither the
    scheduler's re-read nor the Admin banner's orphan suppression can be satisfied by "some Drive
    connection is still enabled".
    """
    state = StateStore(str(tmp_path / f"mid-run-{paused_mid_run}.sqlite"))
    key = StreamKey(SETTINGS.team, INTEGRATION, "account", "my-drive")
    progress = state.begin_generation(key, 4, start_token="start")
    state.update_progress(progress.namespace, page_token="cursor-before")
    state.record_stream_hint(key)
    before = state.get_progress(progress.namespace)
    other = row(name="other-docs", integration_id=OTHER_INTEGRATION)
    b = brain(Brain(rows=[row("enabled"), other], acquire=acquired_execution()))

    def token():
        # The fenced request that follows a pause or disconnect: the pause advanced the fence, so
        # the brain refuses this run's execution. Admin state changes in the same moment.
        if paused_mid_run:
            b.rows = [row("disabled"), other]
        return 409, {"error": {"code": "stale_execution", "message": "execution is no longer current"}}

    b.token = token
    await _poll_job(SETTINGS, Connection("local-docs", "gdrive", options={"integration_id": INTEGRATION}), state)

    assert b.acquired() == 1
    if paused_mid_run:
        assert b.reports() == []
    else:
        [report] = b.reports()
        assert report["integrationId"] == INTEGRATION and report["error"] == "stale_execution"
        assert report["failed"] == 1 and report["authoritativeComplete"] is False
    # Either way nothing was acknowledged: the hint stays pending and the cursor where it was, so a
    # resumed connection drains it (the pause policy keeps generation and progress).
    assert state.pending_stream_hint(key) == 1
    after = state.get_progress(progress.namespace)
    assert (after.page_token, after.last_success_at) == (before.page_token, before.last_success_at)
    state.close()


@pytest.mark.parametrize("code", [
    "connection_unavailable", "stale_execution", "reconnect_required", "connector_principal_required",
])
async def test_an_enabled_connections_authority_refusal_is_reported_as_a_failure(tmp_path, brain, code):
    state = StateStore(str(tmp_path / f"refused-{code}.sqlite"))
    b = brain(Brain(
        rows=[row("enabled")],  # still enabled when re-read
        acquire=lambda: (409, {"error": {"code": code, "message": "refused"}}),
    ))
    await _poll_job(SETTINGS, Connection("local-docs", "gdrive", options={"integration_id": INTEGRATION}), state)
    [report] = b.reports()
    assert report["integrationId"] == INTEGRATION
    assert report["error"] == code
    # Counted as failed work: it can never pass for healthy partial progress.
    assert report["failed"] == 1 and report["status"] != "deferred"
    assert report["authoritativeComplete"] is False
    state.close()


@pytest.mark.parametrize("case", ["broker_refused", "service_account_credentials_missing"])
async def test_a_failure_after_name_resolution_is_reported_against_the_resolved_id(tmp_path, brain, case):
    """A LOCAL configuration (no id in its options) is resolved by name; its failures still report."""
    state = StateStore(str(tmp_path / f"resolved-{case}.sqlite"))
    auth_mode = "oauth" if case == "broker_refused" else "service_account"
    b = brain(Brain(
        rows=[row(auth_mode=auth_mode)],
        acquire=acquired_execution(auth_mode),
        token=lambda: (409, {"error": {"code": "reconnect_required", "message": "reconnect"}}),
    ))
    await _poll_job(SETTINGS, Connection("local-docs", "gdrive", options={}), state)
    [report] = b.reports()
    assert report["integrationId"] == INTEGRATION
    assert report["failed"] == 1 and report["authoritativeComplete"] is False
    assert report["error"] == ("reconnect_required" if case == "broker_refused" else "service_account_credentials_missing")
    state.close()


async def test_a_local_connection_with_no_admin_row_is_a_local_diagnostic_and_reports_nothing(tmp_path, brain, caplog):
    state = StateStore(str(tmp_path / "unresolved.sqlite"))
    b = brain(Brain(rows=[row(name="someone-else")]))
    with caplog.at_level(logging.WARNING):
        await _poll_job(SETTINGS, Connection("local-docs", "gdrive", options={}), state)
    assert b.acquired() == 0
    assert b.reports() == []
    assert any("local-docs" in record.getMessage() and "nothing reported" in record.getMessage()
               for record in caplog.records)
    state.close()


@pytest.mark.parametrize("case, about, verify, category", [
    # Drive answered, but named no identity to verify.
    ("identity_missing", {"user": {}}, None, "service_account_identity_unverified"),
    # Drive named an identity; the brain's authority refused to verify it.
    ("verification_refused", {"user": {"emailAddress": "svc@example.com"}},
     lambda: (409, {"error": {"code": "wrong_connection", "message": "not service-account mode"}}),
     "wrong_connection"),
    # Drive deferred the identity read itself (rate limit) inside the bounded run.
    ("provider_deferred", ProviderDeferred("drive rate limited", category="rate_limited"), None,
     "rate_limited"),
])
async def test_a_service_account_identity_failure_after_resolution_is_reported_against_the_resolved_id(
    tmp_path, brain, monkeypatch, case, about, verify, category,
):
    """A LOCAL service-account configuration, resolved by name, failing while its identity is verified."""
    state = StateStore(str(tmp_path / f"identity-{case}.sqlite"))
    b = brain(Brain(
        rows=[row(auth_mode="service_account")],
        acquire=acquired_execution("service_account", serviceAccountStatus="pending"),
        verify=verify,
    ))
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", drive_identity(about))

    await _poll_job(SETTINGS, Connection(
        "local-docs", "gdrive", options={"service_account_key_path": "/local/key.json"},
    ), state)

    [report] = b.reports()
    assert report["integrationId"] == INTEGRATION
    assert report["error"] == category
    assert report["failed"] == 1 and report["authoritativeComplete"] is False
    verified = [body for method, path, body in b.requests
                if path == "/api/v1/integrations/gdrive/execution"
                and (body or {}).get("action") == "verify_service_account"]
    # Only the case whose identity Drive actually named reaches the brain's verification.
    assert [body["identity"] for body in verified] == (["svc@example.com"] if case == "verification_refused" else [])
    state.close()


SECRET_MARKER = "do-not-leak-key-material"


def raising_setup(message: str):
    """A Drive source whose setup raises with text that must never reach the brain."""

    class Source:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def _services(self):
            raise RuntimeError(message)

    return Source


@pytest.mark.parametrize("setup", ["real_missing_key_file", "setup_raises"])
async def test_a_stream_setup_exception_on_an_enabled_connection_is_one_sanitized_failure_report(
    tmp_path, brain, monkeypatch, setup,
):
    """A configured service-account key path passes the presence check, then stream setup raises.

    ``real_missing_key_file`` runs the production ``GoogleDriveSource`` against a key file that does
    not exist; ``setup_raises`` pins the same outcome independently of which Google libraries are
    installed, with exception text that names the secret path.
    """
    state = StateStore(str(tmp_path / f"setup-{setup}.sqlite"))
    key = StreamKey(SETTINGS.team, INTEGRATION, "account", "my-drive")
    progress = state.begin_generation(key, 4, start_token="start")
    state.update_progress(progress.namespace, page_token="cursor-before")
    state.record_stream_hint(key)
    before = state.get_progress(progress.namespace)
    key_path = str(tmp_path / f"{SECRET_MARKER}" / "service-account.json")  # never created
    other = row(name="other-docs", integration_id=OTHER_INTEGRATION)
    b = brain(Brain(rows=[row(auth_mode="service_account"), other], acquire=acquired_execution("service_account")))
    if setup == "setup_raises":
        monkeypatch.setattr(
            "aios_ingest.gdrive_sync.GoogleDriveSource",
            raising_setup(f"[Errno 2] No such file or directory: '{key_path}'"),
        )

    await _poll_job(SETTINGS, Connection(
        "local-docs", "gdrive", options={"integration_id": INTEGRATION, "service_account_key_path": key_path},
    ), state)

    [report] = b.reports()
    assert report["integrationId"] == INTEGRATION
    assert report["error"] == "coordinator_error"
    assert report["failed"] == 1 and report["authoritativeComplete"] is False
    assert report["status"] not in {"complete", "deferred"} and report["backlog"] is None
    # Nothing about the exception leaves the process: no path, no marker, no class name, no text.
    wire = json.dumps(report)
    for leak in (key_path, SECRET_MARKER, "Errno", "No such file", "FileNotFoundError", "RuntimeError"):
        assert leak not in wire
    # The coordinator's own cleanup ran, and nothing was acknowledged: the hint and cursor stand.
    assert any(path == "/api/v1/integrations/gdrive/execution" and (body or {}).get("action") == "release"
               for _method, path, body in b.requests)
    assert state.pending_stream_hint(key) == 1
    after = state.get_progress(progress.namespace)
    assert (after.page_token, after.last_success_at) == (before.page_token, before.last_success_at)
    state.close()


async def test_a_stream_setup_exception_after_a_pause_reports_nothing(tmp_path, brain, monkeypatch):
    """The same exception, but this connection was paused by the time it surfaced: not a failure."""
    state = StateStore(str(tmp_path / "setup-paused.sqlite"))
    other = row(name="other-docs", integration_id=OTHER_INTEGRATION)
    b = brain(Brain(
        rows=[[row("enabled", auth_mode="service_account"), other],
              [row("disabled", auth_mode="service_account"), other]],
        acquire=acquired_execution("service_account"),
    ))
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", raising_setup("provider gone"))

    await _poll_job(SETTINGS, Connection(
        "local-docs", "gdrive",
        options={"integration_id": INTEGRATION, "service_account_key_path": "/local/key.json"},
    ), state)

    assert b.acquired() == 1
    assert b.reports() == []
    state.close()


async def test_cancellation_during_the_stream_is_never_converted_into_a_report(tmp_path, brain, monkeypatch):
    import asyncio

    state = StateStore(str(tmp_path / "setup-cancelled.sqlite"))
    b = brain(Brain(rows=[row(auth_mode="service_account")], acquire=acquired_execution("service_account")))

    class Cancelled:
        def __init__(self, **kwargs):
            pass

        def _services(self):
            raise asyncio.CancelledError()

    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Cancelled)
    with pytest.raises(asyncio.CancelledError):
        await _poll_job(SETTINGS, Connection(
            "local-docs", "gdrive",
            options={"integration_id": INTEGRATION, "service_account_key_path": "/local/key.json"},
        ), state)
    assert b.reports() == []
    state.close()
