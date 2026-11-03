"""Provider identity binds local and remote Drive progress to the ACCOUNT, not a path (AIO-1167 R44 F3, S2).

F3 — service accounts. The credential namespace is the account the LOADED key authenticates as, read
from the very credential object provider calls use. Once the brain has verified an identity for the
connection, a run whose loaded key is another account is refused before any local or remote stream
is restored or consumed (no cursor, checkpoint or provider call under the wrong account), and the
old account's local state is left untouched for diagnosis. Rotating the SAME account's key material
keeps the namespace. Malformed key material is refused as invalid credentials.

S2 — one namespace for watch and sync. Renewal and the coordinator resolve the OAuth account the
same way — the broker's verified subject first — so a notification marks the stream the
coordinator reads, including when the connection config carries only an email.
"""

from __future__ import annotations

import pytest

from aios_ingest import watch_renewal
from aios_ingest.brain_client import GdriveExecution
from aios_ingest.config import BrainSettings, Connection
from aios_ingest.gdrive_sync import (
    ServiceAccountBindingRefused,
    _account_hash,
    oauth_account_namespace,
    run_gdrive_stream,
    service_account_namespace,
)
from aios_ingest.sources.gdrive import GoogleDriveSource
from aios_ingest.state import StateStore, StreamKey

SETTINGS = BrainSettings(base_url="http://brain", api_key="aios_a_b", team="demo")
INTEGRATION = "00000000-0000-0000-0000-0000000000f3"
A = "svc-a@project.iam.gserviceaccount.com"
B = "svc-b@project.iam.gserviceaccount.com"


class _Loaded:
    def __init__(self, identity=None, error=None):
        self.identity, self.error = identity, error

    def service_account_identity(self):
        if self.error:
            raise self.error
        return self.identity


# --- the binding rule -----------------------------------------------------------------------------

def test_the_namespace_is_the_loaded_account_and_survives_key_rotation():
    first = service_account_namespace(_Loaded(A), {"serviceAccountIdentity": A}, "verified")
    rotated = service_account_namespace(_Loaded(A.upper()), {"serviceAccountIdentity": A}, "verified")
    assert first == rotated == _account_hash(A)
    assert first != _account_hash("/local/key.json")


@pytest.mark.parametrize("status", ["verified"])
def test_a_verified_connection_refuses_another_account(status):
    with pytest.raises(ServiceAccountBindingRefused) as refused:
        service_account_namespace(_Loaded(B), {"serviceAccountIdentity": A}, status)
    assert refused.value.category == "service_account_identity_changed"


def test_a_verified_status_without_a_recorded_identity_is_not_evidence():
    with pytest.raises(ServiceAccountBindingRefused) as refused:
        service_account_namespace(_Loaded(A), {}, "verified")
    assert refused.value.category == "service_account_identity_unverified"


@pytest.mark.parametrize("loaded", [_Loaded(None), _Loaded("  "), _Loaded(error=ValueError("bad key")),
                                    _Loaded(error=KeyError("client_email"))])
def test_malformed_key_material_is_invalid_credentials(loaded):
    with pytest.raises(ServiceAccountBindingRefused) as refused:
        service_account_namespace(loaded, {"serviceAccountIdentity": A}, "verified")
    assert refused.value.category == "service_account_credentials_invalid"


def test_a_pending_connection_binds_to_the_loaded_account_without_comparing():
    assert service_account_namespace(_Loaded(B), {"serviceAccountIdentity": A}, "pending") == _account_hash(B)


def test_the_source_reads_the_identity_from_the_loaded_credential_object(monkeypatch, tmp_path):
    """The same object provider calls use — loaded once, and replacing the file's contents changes
    the answer for the NEXT source, never between the identity and the provider services."""
    import sys
    import types

    loads: list[str] = []

    class SACredentials:
        def __init__(self, email):
            self.service_account_email = email

        @staticmethod
        def from_service_account_file(path, scopes=None):
            loads.append(path)
            return SACredentials(open(path).read().strip())

    google = types.ModuleType("google")
    oauth2 = types.ModuleType("google.oauth2")
    service_account = types.ModuleType("google.oauth2.service_account")
    credentials = types.ModuleType("google.oauth2.credentials")
    service_account.Credentials = SACredentials
    credentials.Credentials = object
    google.oauth2, oauth2.service_account, oauth2.credentials = oauth2, service_account, credentials
    for name, module in {"google": google, "google.oauth2": oauth2, "google.oauth2.service_account": service_account,
                         "google.oauth2.credentials": credentials}.items():
        monkeypatch.setitem(sys.modules, name, module)

    key = tmp_path / "key.json"
    key.write_text(A)
    source = GoogleDriveSource(file_ids=["d"], service_account_key_path=str(key))
    assert source.service_account_identity() == A
    key.write_text(B)  # same path, another account's key — after this source loaded its credential
    assert source.service_account_identity() == A
    assert source._load_credentials() is source._load_credentials()
    assert GoogleDriveSource(file_ids=["d"], service_account_key_path=str(key)).service_account_identity() == B
    assert loads == [str(key), str(key)]


# --- the coordinator refuses before any progress is touched -------------------------------------

def _world(monkeypatch, loaded_identity, *, remote_progress=None):
    calls: list[str] = []

    class Client:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass

        async def acquire_gdrive_execution(self, requested, owner):
            return GdriveExecution(requested, 5, 1, owner, "later", "scope", {
                "authMode": "service_account", "serviceAccountStatus": "verified", "serviceAccountIdentity": A,
                "fileIds": ["doc"], "folderIds": [], "sharedDriveIds": [], "selectionState": "selected",
            }, progress=remote_progress or {}, progress_revision=3)

        async def broker_gdrive_access_token(self, execution):
            raise AssertionError("service-account mode never brokers")

        def gdrive_provider_gate(self, execution):
            class Gate:
                def __call__(self): calls.append("gate")
                def close(self): pass
            return Gate()

        async def checkpoint_gdrive_execution(self, execution, payload):
            calls.append("checkpoint")
            return {"progress_revision": 4, "progress": payload}

        async def reconcile_gdrive(self, execution, **kwargs):
            calls.append("reconcile")
            return {"items": 0}

        async def release_gdrive_execution(self, execution):
            calls.append("release")

    class Source:
        def __init__(self, **kwargs): self.kwargs = kwargs
        def service_account_identity(self): return loaded_identity
        def _services(self):
            calls.append("provider")
            raise AssertionError("no provider call under a refused account")

    monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)
    return calls


CONN = Connection("docs", "gdrive", options={"integration_id": INTEGRATION, "service_account_key_path": "/local/key.json"})


@pytest.mark.asyncio
async def test_a_replaced_key_for_another_account_consumes_no_local_progress(monkeypatch, tmp_path):
    state = StateStore(str(tmp_path / "local.sqlite"))
    key_a = StreamKey(SETTINGS.team, INTEGRATION, _account_hash(A), "my-drive")
    progress_a = state.begin_generation(key_a, 5, start_token="cursor-of-A")
    state.enqueue_work(progress_a.namespace, 5, "doc", "upsert", {"page": "p"})
    before = state.get_progress(progress_a.namespace)
    calls = _world(monkeypatch, B)

    summary = await run_gdrive_stream(SETTINGS, CONN, state)

    assert summary.failure_categories == {"service_account_identity_changed": 1}
    assert summary.failed == 1 and not summary.authoritative_complete
    assert "provider" not in calls and "checkpoint" not in calls and "reconcile" not in calls
    # A's state is retained untouched for diagnosis; nothing exists under B.
    after = state.get_progress(progress_a.namespace)
    assert (after.page_token, after.baseline_start_token, after.last_success_at) == (
        before.page_token, before.baseline_start_token, before.last_success_at)
    assert state.pending_count(progress_a.namespace, 5) == 1
    key_b = StreamKey(SETTINGS.team, INTEGRATION, _account_hash(B), "my-drive")
    assert state.get_progress(key_b.namespace(5)) is None
    state.close()


@pytest.mark.asyncio
async def test_with_no_local_state_the_remote_progress_of_the_old_account_is_not_restored(monkeypatch, tmp_path):
    state = StateStore(str(tmp_path / "empty.sqlite"))
    remote = {"version": 2, "streams": {"my-drive": {
        "drive_id": "my-drive", "phase": "current", "baseline_start_token": "remote-cursor-of-A",
        "page_token": "remote-cursor-of-A", "listing_complete": True,
    }}, "roots": {"generation": 5, "items": []}}
    calls = _world(monkeypatch, B, remote_progress=remote)

    summary = await run_gdrive_stream(SETTINGS, CONN, state)

    assert summary.failure_categories == {"service_account_identity_changed": 1}
    assert "provider" not in calls and "checkpoint" not in calls
    for account in (A, B):
        key = StreamKey(SETTINGS.team, INTEGRATION, _account_hash(account), "my-drive")
        assert state.get_progress(key.namespace(5)) is None
    state.close()


# --- S2: watch and sync agree on the OAuth account ---------------------------------------------

def test_the_broker_subject_wins_over_config_for_both_paths():
    config = {"authMode": "oauth", "authenticatedAccount": "person@example.com"}  # email only, no id
    grant = {"access_token": "t", "account": {"subject": "subject:google-123", "email": "person@example.com"}}
    assert oauth_account_namespace(config, grant, {}) == "subject:google-123"
    assert oauth_account_namespace(config, {"access_token": "t"}, {}) == "person@example.com"


@pytest.mark.asyncio
async def test_renewal_creates_channels_under_the_coordinators_account_namespace(monkeypatch, tmp_path):
    from test_watch_lifecycle import _Brain, _conn

    brain = _Brain()
    brain.install(monkeypatch)
    real_client = watch_renewal.brain_client.BrainClient

    class Client(real_client):
        async def acquire_gdrive_execution(self, requested, owner):
            execution = await super().acquire_gdrive_execution(requested, owner)
            # The supported fallback: a config that names only the account email.
            return GdriveExecution(
                execution.integration_id, execution.generation, execution.fence, execution.owner,
                execution.lease_expires_at, execution.scope_hash,
                {"authMode": "oauth", "authenticatedAccount": "person@example.com"},
                execution.progress, execution.progress_revision,
            )

        async def broker_gdrive_access_token(self, execution):
            return {"access_token": "memory-only", "account": {"subject": "subject:google-123"}}

    monkeypatch.setattr(watch_renewal.brain_client, "BrainClient", Client)
    seen: list[str] = []

    async def capture(run, manager, conn, budget, now, *, account_id, **kwargs):
        seen.append(account_id)

    monkeypatch.setattr(watch_renewal, "_create_where_due", capture)
    state = StateStore(str(tmp_path / "renew.sqlite"))
    await watch_renewal.renew_watches(state, object(), [_conn()], SETTINGS)
    assert seen == ["subject:google-123"]
    state.close()
