"""AIO-1167 R56 — an individually shared Shared Drive file is read through the user's change log.

Spec (Astra adjudication of the final review). Google reports a file individually shared with a
NON-member of its Shared Drive in the user's change log; a member consumes the drive's own log. The
containing (physical) drive and the consumed change log are therefore different facts:

  * an explicitly selected FILE root whose readable metadata names a Shared Drive the credential is
    provably not a member of (the drive's own ``drives.get`` answers 404) is bound to, and consumed
    by, the user log (``my-drive``) — its start token is captured before enumeration, and no start
    token is ever asked of the drive it cannot open;
  * a member's file keeps its drive stream; a mixed selection runs both;
  * a 403 (or any other inconclusive answer) is never proof of non-membership: a root bound for the
    first time keeps its physical drive, exactly as before, and a root the user log already consumes
    stays there until provider evidence moves it;
  * the route survives a restart from fresh local state (the brain's root evidence is adopted);
  * in the user log, an edit of that file is imported and a removal reconciled — it is not read as
    a move out; a membership GAINED is a route transition (relocation toward the drive's stream).
"""

from __future__ import annotations

import copy

import pytest

from aios_ingest.brain_client import BrainError, GdriveExecution, IngestResult
from aios_ingest.config import BrainSettings, Connection
from aios_ingest import gdrive_sync
from aios_ingest.engine import IngestSummary
from aios_ingest.gdrive_sync import (
    _consumed_drive,
    _observe_root,
    _run_gdrive_stream_unlocked,
    run_gdrive_stream,
)
from aios_ingest.normalize import RawDoc
from aios_ingest.state import StateStore, StreamKey

DOC = "application/vnd.google-apps.document"


class _Request:
    def __init__(self, value=None, error=None):
        self.value, self.error = value, error

    def execute(self):
        if self.error is not None:
            raise self.error
        return self.value


class _HttpError(Exception):
    def __init__(self, status):
        super().__init__(f"HTTP {status}")
        self.resp = type("Response", (), {"status": status})()
        self.content = b'{"error": {"errors": []}}'


class _Drives:
    """``drives.get`` per drive: ``member`` answers, ``nonmember`` is a 404, anything else a 403."""

    def __init__(self, membership):
        self.membership, self.asked = membership, []

    def get(self, driveId, **_kwargs):
        self.asked.append(driveId)
        verdict = self.membership.get(driveId, "forbidden")
        if verdict == "member":
            return _Request({"id": driveId})
        return _Request(error=_HttpError(404 if verdict == "nonmember" else 403))


class _Changes:
    def __init__(self, starts, unopenable=(), changes=(), changes_by_drive=None):
        self.starts, self.unopenable, self.changes = starts, set(unopenable), list(changes)
        # One-shot per-drive change pages (each drive's list is consumed by its first page read).
        self.changes_by_drive = changes_by_drive if changes_by_drive is not None else {}

    def getStartPageToken(self, **kwargs):
        drive_id = kwargs.get("driveId", "my-drive")
        self.starts.append(drive_id)
        if drive_id in self.unopenable:
            return _Request(error=_HttpError(404))
        return _Request({"startPageToken": f"start:{drive_id}"})

    def list(self, **kwargs):
        drive_id = kwargs.get("driveId", "my-drive")
        if drive_id in self.unopenable:
            return _Request(error=_HttpError(404))
        changes = self.changes + list(self.changes_by_drive.pop(drive_id, []))
        return _Request({"changes": changes, "newStartPageToken": f"terminal:{drive_id}"})


class _Files:
    """Folder and Shared Drive listings for real stream runs: every listed container is empty."""

    def list(self, **_kwargs):
        return _Request({"files": []})


class _Drive:
    def __init__(self, changes, drives):
        self._changes, self._drives = changes, drives

    def changes(self):
        return self._changes

    def drives(self):
        return self._drives

    def files(self):
        return _Files()


def _meta(file_id, drive_id=None):
    meta = {"id": file_id, "mimeType": DOC, "parents": ["parent"]}
    if drive_id:
        meta["driveId"] = drive_id
    return meta


class _Source:
    def __init__(self, drive, metas):
        self.drive, self.metas = drive, metas

    def _services(self):
        return self.drive, object()

    def _execute(self, request):
        return request.execute()

    def _metadata(self, file_id):
        return dict(self.metas[file_id])

    def _raw_doc(self, meta):
        return RawDoc(source="gdrive", external_id=meta["id"], body=meta["id"])


# ── the decision ────────────────────────────────────────────────────────────────────────────────

def _source(membership, metas=None):
    return _Source(_Drive(_Changes([]), _Drives(membership)), metas or {})


def test_a_non_members_file_is_consumed_by_the_user_log_and_a_members_by_its_drive():
    source = _source({"sd-member": "member", "sd-other": "nonmember"})
    assert _consumed_drive(source, "file", _meta("f", "sd-other")) == "my-drive"
    assert _consumed_drive(source, "file", _meta("f", "sd-member")) == "sd-member"
    assert _consumed_drive(source, "file", _meta("f")) == "my-drive"
    # Only an explicit FILE root is routed: a folder stays with the drive it is in.
    assert _consumed_drive(source, "folder", _meta("d", "sd-other")) == "sd-other"
    # One membership answer per drive per run.
    assert source.drive.drives().asked == ["sd-other", "sd-member"]


def test_an_inconclusive_answer_is_never_proof_of_non_membership():
    source = _source({})  # every drives.get answers 403
    # Bound for the first time: the physical drive, exactly as before.
    assert _consumed_drive(source, "file", _meta("f", "sd-x")) == "sd-x"
    # Already consumed by the user log: it stays there until evidence moves it.
    assert _consumed_drive(source, "file", _meta("f", "sd-x"), "my-drive") == "my-drive"

    class NoDrivesApi:
        def changes(self):
            return _Changes([])

    bare = _Source(NoDrivesApi(), {})
    assert _consumed_drive(bare, "file", _meta("f", "sd-x")) == "sd-x"


def test_route_transitions_are_relocations_between_streams():
    # Non-member, read in the user log: here.
    nonmember = _source({"sd": "nonmember"}, {"f": _meta("f", "sd")})
    assert _observe_root(nonmember, "f", "my-drive", {}, "file").state == "here"
    # Membership gained: the drive's own stream now observes it — a relocation, toward that drive.
    member = _source({"sd": "member"}, {"f": _meta("f", "sd")})
    observed = _observe_root(member, "f", "my-drive", {}, "file")
    assert (observed.state, observed.drive_id) == ("elsewhere", "sd")
    # Membership lost while bound to the drive stream: a relocation toward the user log.
    observed = _observe_root(nonmember, "f", "sd", {}, "file")
    assert (observed.state, observed.drive_id) == ("elsewhere", "my-drive")
    # Unproven membership keeps a user-log root where it is.
    unknown = _source({}, {"f": _meta("f", "sd")})
    assert _observe_root(unknown, "f", "my-drive", {}, "file").state == "here"
    # A folder root keeps the old comparison (no routing): read in sd, bound to my-drive, it moved.
    assert _observe_root(nonmember, "f", "my-drive", {}, "folder").state == "elsewhere"


# ── the coordinator: binding, streams and start tokens ──────────────────────────────────────────

INTEGRATION = "00000000-0000-0000-0000-0000000005e6"


def _client_class(file_ids, store, shared_drive_ids=(), folder_ids=()):
    class Client:
        revision = 0

        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def acquire_gdrive_execution(self, requested, owner):
            return GdriveExecution(requested, 5, 1, owner, "later", "scope", {
                "authMode": "oauth", "authenticatedAccountId": "account",
                "fileIds": list(file_ids), "folderIds": list(folder_ids), "sharedDriveIds": list(shared_drive_ids),
                "selectionState": "selected",
            }, progress=copy.deepcopy(store.get("progress") or {}), progress_revision=store.get("revision", 0))

        async def broker_gdrive_access_token(self, execution):
            return {"access_token": "memory", "account": {"subject": "account"}}

        def gdrive_token_provider(self, execution, grant):
            class Provider:
                def close(self):
                    pass
            return Provider()

        def gdrive_provider_gate(self, execution):
            class Gate:
                def __call__(self):
                    pass

                def close(self):
                    pass
            return Gate()

        async def checkpoint_gdrive_execution(self, execution, progress):
            store["checkpoint_attempts"] = store.get("checkpoint_attempts", 0) + 1
            if store.get("ack_lost"):
                raise BrainError(504, "checkpoint_acknowledgment_lost", "no acknowledgment arrived")
            if store.get("ack_lost_after_commit"):
                # The brain COMMITTED it; only the acknowledgment never arrived.
                store["revision"] = store.get("revision", 0) + 1
                store["progress"] = copy.deepcopy(progress)
                store["uncertain"] = True
                raise BrainError(504, "checkpoint_acknowledgment_lost", "no acknowledgment arrived")
            if store.get("checkpoint_error"):
                raise BrainError(503, "checkpoint_unavailable", "the brain could not take the checkpoint")
            store["revision"] = store.get("revision", 0) + 1
            store["progress"] = progress
            execution.progress.clear()
            execution.progress.update(progress)
            return {"progress_revision": store["revision"], "progress": progress}

        async def release_gdrive_execution(self, execution):
            pass

        async def push(self, payload, *, execution):
            store.setdefault("pushed", []).append(payload.frontmatter["source_id"])
            return IngestResult("updated", "item", payload.path)

        def gdrive_progress_uncertain(self, execution):
            return bool(store.get("ack_lost") or store.get("uncertain"))

        async def reconcile_gdrive(self, execution, **kwargs):
            store.setdefault("events", []).append(("reconcile", sorted((store.get("progress") or {}).get("streams") or {})))
            if store.get("reconcile_error"):
                raise BrainError(503, "reconcile_unavailable", "the brain could not reconcile")
            store.setdefault("reconciles", []).append(sorted(kwargs.get("complete_snapshot_ids") or []))
            return {"items": 0}

    return Client


async def _run(
    monkeypatch, state, file_ids, metas, membership, store, unopenable=("sd-other",),
    on_stream=None, shared_drive_ids=(), folder_ids=(), real=False, changes_by_drive=None,
):
    starts, runs = [], []
    changes = _Changes(starts, unopenable=unopenable, changes_by_drive=changes_by_drive)
    drives = _Drives(membership)

    class Source(_Source):
        def __init__(self, **_kwargs):
            super().__init__(_Drive(changes, drives), metas)

        def set_run_deadline(self, deadline):
            pass

    async def capture(_settings, _conn, _state, **kwargs):
        runs.append((kwargs["drive_id"], list(starts)))
        if on_stream is not None:
            on_stream(_state, kwargs["drive_id"], kwargs["namespace"], kwargs["generation"])
        return IngestSummary("docs", failure_categories={})

    monkeypatch.setattr(
        "aios_ingest.gdrive_sync.BrainClient", _client_class(file_ids, store, shared_drive_ids, folder_ids),
    )
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)
    if real:
        # The REAL stream run, recorded with the start tokens captured before it began.
        actual = gdrive_sync._run_gdrive_stream_unlocked

        async def recorded(*args, **kwargs):
            runs.append((kwargs["drive_id"], list(starts)))
            return await actual(*args, **kwargs)

        monkeypatch.setattr("aios_ingest.gdrive_sync._run_gdrive_stream_unlocked", recorded)
    else:
        monkeypatch.setattr("aios_ingest.gdrive_sync._run_gdrive_stream_unlocked", capture)
    summary = await run_gdrive_stream(
        BrainSettings("http://brain", "key", "team"),
        Connection("docs", "gdrive", options={"integration_id": INTEGRATION}), state,
    )
    store["last_summary"] = summary
    return starts, runs, drives


METAS = {
    "member-file": _meta("member-file", "sd-member"),
    "nonmember-file": _meta("nonmember-file", "sd-other"),
    "mydrive-file": _meta("mydrive-file"),
}


@pytest.mark.asyncio
async def test_a_mixed_selection_routes_each_file_and_captures_every_token_before_enumeration(
    tmp_path, monkeypatch,
):
    state = StateStore(str(tmp_path / "mixed.sqlite"))
    starts, runs, _drives = await _run(
        monkeypatch, state, ["member-file", "nonmember-file", "mydrive-file"], METAS,
        {"sd-member": "member", "sd-other": "nonmember"}, {},
    )
    bindings = state.root_bindings(INTEGRATION, 5)
    assert bindings == {
        ("file", "member-file"): "sd-member",
        ("file", "nonmember-file"): "my-drive",
        ("file", "mydrive-file"): "my-drive",
    }
    # The user log and the member's drive — never the drive the account cannot open.
    assert starts == ["my-drive", "sd-member"]
    assert [drive for drive, _ in runs] == ["my-drive", "sd-member"]
    assert all(snapshot == starts for _, snapshot in runs), "every token captured before any enumeration"
    state.close()


@pytest.mark.asyncio
async def test_a_403_membership_answer_keeps_the_existing_drive_routing(tmp_path, monkeypatch):
    state = StateStore(str(tmp_path / "forbidden.sqlite"))
    starts, runs, _drives = await _run(
        monkeypatch, state, ["nonmember-file"], METAS, {"sd-other": "forbidden"}, {},
    )
    assert state.root_bindings(INTEGRATION, 5) == {("file", "nonmember-file"): "sd-other"}
    # The drive stream is attempted as before — and, unopenable, is NOT run as a user-log root.
    assert starts == ["sd-other"]
    assert runs == []
    state.close()


@pytest.mark.asyncio
async def test_the_route_survives_a_restart_from_fresh_local_state(tmp_path, monkeypatch):
    store: dict = {}
    first = StateStore(str(tmp_path / "first.sqlite"))
    await _run(monkeypatch, first, ["nonmember-file"], METAS, {"sd-other": "nonmember"}, store)
    assert first.root_bindings(INTEGRATION, 5) == {("file", "nonmember-file"): "my-drive"}
    first.close()

    # Local state is lost; membership is now unanswerable (403). The brain's root evidence is
    # adopted, so the root is neither re-guessed into the drive it cannot open nor re-read.
    fresh = StateStore(str(tmp_path / "fresh.sqlite"))
    starts, runs, drives = await _run(
        monkeypatch, fresh, ["nonmember-file"], METAS, {"sd-other": "forbidden"}, store,
    )
    assert fresh.root_bindings(INTEGRATION, 5) == {("file", "nonmember-file"): "my-drive"}
    assert "sd-other" not in starts
    assert [drive for drive, _ in runs] == ["my-drive"]
    assert drives.asked == []
    fresh.close()


# ── the user log: edit, removal and a membership gained ─────────────────────────────────────────

def _user_log_stream(tmp_path, name):
    state = StateStore(str(tmp_path / name))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account", "my-drive"), 7, start_token="start", phase="current",
    )
    snapshot = state.begin_selection_snapshot(
        progress.namespace, 7, [("nm-file", "file", "my-drive", False)],
    )
    state.publish_selection_snapshot(progress.namespace, 7, snapshot)
    state.record_membership(progress.namespace, 7, "nm-file", "nm-file", "sd-other", snapshot_id=snapshot)
    state.bind_root("connection", 7, "file", "nm-file", "my-drive")
    state.update_progress(
        progress.namespace, listing_complete=True, page_token="cursor",
        last_success_at="2026-11-01T00:00:00+00:00",
    )
    return state, progress


class _StreamClient:
    def __init__(self):
        self.revision, self.pushed, self.removed = 0, [], []

    async def checkpoint_gdrive_execution(self, execution, payload):
        self.revision += 1
        return {"progress_revision": self.revision, "progress": payload}

    async def push(self, payload, *, execution):
        self.pushed.append(payload.frontmatter["source_id"])
        return IngestResult("updated", "item", payload.path)

    async def reconcile_gdrive(self, execution, **kwargs):
        self.removed.extend(kwargs.get("removed_provider_ids") or [])
        return {"items": len(kwargs.get("removed_provider_ids") or [])}


async def _drain_user_log(state, progress, changes, membership, metas):
    source = _Source(_Drive(_Changes([], changes=changes), _Drives(membership)), metas)
    client = _StreamClient()
    result = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=client, execution=GdriveExecution("connection", 7, 1, "owner", "later", "scope", {}),
        options={"credential_identity": "account", "selection_state": "selected", "file_ids": ["nm-file"]},
        source=source, drive=source.drive, generation=7, drive_id="my-drive",
        namespace=progress.namespace, max_work=3, discovery_budget=1, retry_budget=0,
        # As the coordinator passes them: the root is bound to the user log.
        root_bindings={("file", "nm-file"): "my-drive"},
    )
    return result, client


@pytest.mark.asyncio
async def test_an_edit_in_the_user_log_is_imported_not_read_as_a_move_out(tmp_path):
    state, progress = _user_log_stream(tmp_path, "edit.sqlite")
    edited = _meta("nm-file", "sd-other")
    result, client = await _drain_user_log(
        state, progress, [{"fileId": "nm-file", "file": edited}], {"sd-other": "nonmember"},
        {"nm-file": edited},
    )
    assert client.pushed == ["nm-file"] and result.updated == 1
    assert client.removed == []
    assert state.root_obligations("connection", 7)[("file", "nm-file")].status == "bound"
    state.close()


@pytest.mark.asyncio
async def test_a_removal_in_the_user_log_is_reconciled(tmp_path):
    state, progress = _user_log_stream(tmp_path, "removal.sqlite")
    trashed = {**_meta("nm-file", "sd-other"), "trashed": True}
    _result, client = await _drain_user_log(
        state, progress, [{"fileId": "nm-file", "removed": True, "file": trashed}],
        {"sd-other": "nonmember"}, {"nm-file": trashed},
    )
    assert client.pushed == []
    assert client.removed == ["nm-file"]
    state.close()


@pytest.mark.asyncio
async def test_a_membership_gained_moves_the_root_toward_the_drives_own_stream(tmp_path):
    state, progress = _user_log_stream(tmp_path, "gained.sqlite")
    edited = _meta("nm-file", "sd-other")
    _result, client = await _drain_user_log(
        state, progress, [{"fileId": "nm-file", "file": edited}], {"sd-other": "member"},
        {"nm-file": edited},
    )
    binding = state.root_obligations("connection", 7)[("file", "nm-file")]
    assert (binding.status, binding.drive_id, binding.pending_drive_id) == ("relocating", "my-drive", "sd-other")
    assert client.removed == [], "a route transition is never a removal"
    state.close()


# ── existing bindings: reclassification once non-membership is proven (R56 P2) ──────────────────

def _stream_namespace(drive_id):
    return StreamKey("team", INTEGRATION, "account", drive_id).namespace(5)


@pytest.mark.asyncio
@pytest.mark.parametrize("restart", [False, True], ids=["same-state", "fresh-state"])
async def test_a_restored_pre_r56_drive_binding_is_routed_to_the_user_log(tmp_path, monkeypatch, restart):
    store: dict = {}
    state = StateStore(str(tmp_path / "pre-r56.sqlite"))
    # Bound before routing could be proven (an unanswerable membership: the pre-R56 binding), and
    # that drive's change log cannot be opened: the stream never starts.
    starts, runs, _drives = await _run(
        monkeypatch, state, ["nonmember-file"], METAS, {"sd-other": "forbidden"}, store,
    )
    assert state.root_bindings(INTEGRATION, 5) == {("file", "nonmember-file"): "sd-other"}
    assert starts == ["sd-other"] and runs == []
    if restart:
        state.close()
        state = StateStore(str(tmp_path / "pre-r56-fresh.sqlite"))

    # Provider evidence now proves non-membership: the root is handed to the user log, whose token
    # is captured before anything is enumerated there.
    starts, runs, drives = await _run(
        monkeypatch, state, ["nonmember-file"], METAS, {"sd-other": "nonmember"}, store,
    )
    assert drives.asked == ["sd-other"]
    assert state.root_bindings(INTEGRATION, 5) == {("file", "nonmember-file"): "my-drive"}
    assert "my-drive" in starts and [drive for drive, _ in runs] == ["my-drive"]
    assert all(snapshot == starts for _, snapshot in runs)
    state.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("restart", [False, True], ids=["same-state", "fresh-state"])
async def test_a_member_who_loses_membership_is_routed_and_the_old_streams_claims_stand(
    tmp_path, monkeypatch, restart,
):
    store: dict = {}
    state = StateStore(str(tmp_path / "member.sqlite"))
    await _run(monkeypatch, state, ["member-file"], METAS, {"sd-member": "member"}, store, unopenable=())
    assert state.root_bindings(INTEGRATION, 5) == {("file", "member-file"): "sd-member"}
    old = state.get_progress(_stream_namespace("sd-member"))
    assert old is not None and old.baseline_start_token == "start:sd-member"

    # Membership is lost; the drive stream's recovery can no longer capture a token.
    blocked = "start token unavailable: drive sd-member not found or not accessible (404)"
    state.update_progress(old.namespace, recovery_required=True, last_error=blocked, phase="partial")
    store["progress"]["streams"]["sd-member"].update(recovery_required=True, last_error=blocked, phase="partial")
    if restart:
        state.close()
        state = StateStore(str(tmp_path / "member-fresh.sqlite"))

    starts, runs, drives = await _run(
        monkeypatch, state, ["member-file"], METAS, {"sd-member": "nonmember"}, store, unopenable=("sd-member",),
    )
    assert drives.asked == ["sd-member"]
    assert state.root_bindings(INTEGRATION, 5) == {("file", "member-file"): "my-drive"}
    assert "my-drive" in starts and "my-drive" in [drive for drive, _ in runs]
    # No early deletion: the old stream keeps its cursor and record (its claims stand until the
    # replacement snapshot is verified and every stream reconciles), locally and on the brain.
    if not restart:
        kept = state.get_progress(_stream_namespace("sd-member"))
        assert kept is not None and kept.baseline_start_token == "start:sd-member"
    assert store["progress"]["streams"]["sd-member"]["baseline_start_token"] == "start:sd-member"
    state.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("membership", ["forbidden", "member"])
async def test_an_unproven_or_member_answer_never_reclassifies_a_blocked_binding(tmp_path, monkeypatch, membership):
    store: dict = {}
    state = StateStore(str(tmp_path / f"control-{membership}.sqlite"))
    await _run(monkeypatch, state, ["nonmember-file"], METAS, {"sd-other": "forbidden"}, store)
    starts, runs, _drives = await _run(
        monkeypatch, state, ["nonmember-file"], METAS, {"sd-other": membership}, store,
    )
    assert state.root_bindings(INTEGRATION, 5) == {("file", "nonmember-file"): "sd-other"}
    assert state.root_obligations(INTEGRATION, 5)[("file", "nonmember-file")].status == "bound"
    assert starts == ["sd-other"] and runs == []
    state.close()


# ── the old stream after a hand-over: kept until verified, then retired (R56 orphan) ────────────
#
# Every run below is a REAL stream run (`_run_gdrive_stream_unlocked`): baselines, drains, snapshot
# publication and checkpoints happen as in production. Only the loss of membership is injected — the
# old drive stream's recovery is marked blocked on a start token, locally and on the brain.

REAL = dict(real=True)
NONMEMBER = dict(membership={"sd-member": "nonmember"}, unopenable=("sd-member",), real=True)
BLOCKED = "start token unavailable: drive sd-member not found or not accessible (404)"


async def _lose_membership(tmp_path, monkeypatch, name, store, metas=METAS, **run_options):
    """A real member run (complete, claims made through sd-member); then membership is lost."""
    state = StateStore(str(tmp_path / name))
    await _run(
        monkeypatch, state, ["member-file"], metas, {"sd-member": "member"}, store, unopenable=(),
        real=True, **run_options,
    )
    old = state.get_progress(_stream_namespace("sd-member"))
    assert old is not None and old.active_snapshot is not None and store["last_summary"].authoritative_complete
    state.update_progress(old.namespace, recovery_required=True, last_error=BLOCKED, phase="partial")
    store["progress"]["streams"]["sd-member"].update(recovery_required=True, last_error=BLOCKED, phase="partial")
    return state


def _old_claims(state):
    old = state.get_progress(_stream_namespace("sd-member"))
    return None if old is None else state.membership_ids(old.namespace, 5, snapshot_id=old.active_snapshot)


def _old_stream_kept(state, store):
    old = state.get_progress(_stream_namespace("sd-member"))
    return (
        old is not None and old.baseline_start_token == "start:sd-member"
        and _old_claims(state) == ["member-file"]
        and store["progress"]["streams"].get("sd-member", {}).get("baseline_start_token") == "start:sd-member"
    )


def _reconcile_count(store):
    return len([event for event in store.get("events", []) if event[0] == "reconcile"])


async def _hand_over(monkeypatch, state, store, metas=METAS, **options):
    """The hand-over run: reclassified, the user log's token captured, the root rebound and the user
    log really enumerated and checkpointed — while the old stream and its claims stand."""
    starts, runs, _ = await _run(monkeypatch, state, ["member-file"], metas, store=store, **NONMEMBER, **options)
    binding = state.root_obligations(INTEGRATION, 5)[("file", "member-file")]
    assert (binding.status, binding.drive_id, binding.handoff_sources) == ("bound", "my-drive", ("sd-member",))
    assert _old_stream_kept(state, store), "the old stream's claims stand before verification"
    assert store["last_summary"].authoritative_complete is False
    return starts, runs


@pytest.mark.asyncio
@pytest.mark.parametrize("restart", [False, True], ids=["same-state", "fresh-restart"])
async def test_the_old_stream_is_kept_until_the_destination_verifies_the_root_then_retired(
    tmp_path, monkeypatch, restart,
):
    store: dict = {"reconciles": []}
    state = await _lose_membership(tmp_path, monkeypatch, "orphan.sqlite", store)
    reconciled = _reconcile_count(store)
    starts, runs = await _hand_over(monkeypatch, state, store)
    # The user log's token is captured before anything is enumerated there.
    assert "my-drive" in starts
    first_run = next(snapshot for drive, snapshot in runs if drive == "my-drive")
    assert "my-drive" in first_run
    # The destination's published snapshot holds the root, locally and in the acknowledged record.
    destination = state.get_progress(_stream_namespace("my-drive"))
    assert ("file", "member-file") in {
        (str(r["root_kind"]), str(r["root_id"]))
        for r in state.list_roots(destination.namespace, 5, snapshot_id=destination.active_snapshot)
    }
    assert store["progress"]["streams"]["my-drive"]["active_snapshot"] == destination.active_snapshot
    assert _reconcile_count(store) == reconciled

    if restart:
        state.close()
        state = StateStore(str(tmp_path / "orphan-fresh.sqlite"))
        # Fresh local state: the old stream is REMOTE-ONLY, and the destination is really recovered
        # by its own run (a controlled rescan under a fresh token) before anything can retire.
        for _ in range(3):
            await _run(monkeypatch, state, ["member-file"], METAS, store=store, **NONMEMBER)
            if state.get_progress(_stream_namespace("my-drive")) is not None and _reconcile_count(store) > reconciled:
                break
            assert "sd-member" in store["progress"]["streams"], "the remote-only old stream stands meanwhile"
        assert state.root_obligations(INTEGRATION, 5)[("file", "member-file")].handoff_sources == ("sd-member",)

    if _reconcile_count(store) == reconciled:
        await _run(monkeypatch, state, ["member-file"], METAS, store=store, **NONMEMBER)
    assert state.get_progress(_stream_namespace("sd-member")) is None
    assert "sd-member" not in store["progress"]["streams"]
    # The reconciliation came only after the brain ACKNOWLEDGED a map without the old stream.
    reconcile_events = [event for event in store["events"] if event[0] == "reconcile"]
    assert "sd-member" not in reconcile_events[-1][1]
    assert store["reconciles"][-1] == ["member-file"]
    assert store["last_summary"].authoritative_complete is True
    state.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("newer", ["lacks the root", "requires recovery"])
async def test_a_newer_acquired_destination_record_overrules_an_older_local_snapshot(tmp_path, monkeypatch, newer):
    store: dict = {"reconciles": []}
    state = await _lose_membership(tmp_path, monkeypatch, f"stale-{newer.replace(' ', '-')}.sqlite", store)
    await _hand_over(monkeypatch, state, store)
    # The older LOCAL destination snapshot holds the root; the brain's newer record does not certify it.
    remote = store["progress"]["streams"]["my-drive"]
    if newer == "lacks the root":
        remote.update(active_snapshot=int(remote["active_snapshot"]) + 7, checkpoint_id="changes:newer-elsewhere")
    else:
        remote.update(recovery_required=True)
    reconciled = _reconcile_count(store)
    await _run(monkeypatch, state, ["member-file"], METAS, store=store, **NONMEMBER)
    assert _old_stream_kept(state, store), "source state and claims remain until replacement verification"
    assert _reconcile_count(store) == reconciled
    assert store["last_summary"].authoritative_complete is False
    # The destination's own real recovery then verifies a replacement, and only then does it converge.
    for _ in range(3):
        await _run(monkeypatch, state, ["member-file"], METAS, store=store, **NONMEMBER)
        if store["last_summary"].authoritative_complete:
            break
    assert store["last_summary"].authoritative_complete is True
    assert state.get_progress(_stream_namespace("sd-member")) is None
    state.close()


@pytest.mark.asyncio
async def test_a_destination_snapshot_missing_the_root_keeps_the_old_stream_and_claims(tmp_path, monkeypatch):
    store: dict = {"reconciles": []}
    state = await _lose_membership(tmp_path, monkeypatch, "missing-root.sqlite", store)
    await _hand_over(monkeypatch, state, store)
    # The acquired record matches the local snapshot exactly — but that snapshot does not hold the root.
    destination = state.get_progress(_stream_namespace("my-drive"))
    state._db.execute(
        "DELETE FROM selection_roots WHERE namespace=? AND snapshot_id=? AND root_id='member-file'",
        (destination.namespace, destination.active_snapshot),
    )
    state._db.commit()
    reconciled = _reconcile_count(store)
    await _run(
        monkeypatch, state, ["member-file"], METAS, store=store, **NONMEMBER,
        on_stream=None,
    )
    assert _old_stream_kept(state, store)
    assert _reconcile_count(store) == reconciled
    state.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("keeper", ["folder root", "explicit shared drive"])
async def test_a_drive_still_required_keeps_its_stream(tmp_path, monkeypatch, keeper):
    store: dict = {"reconciles": []}
    metas = {**METAS, "kept-folder": {**_meta("kept-folder", "sd-member"), "mimeType": "application/vnd.google-apps.folder"}}
    options = {"folder_ids": ("kept-folder",)} if keeper == "folder root" else {"shared_drive_ids": ("sd-member",)}
    state = await _lose_membership(tmp_path, monkeypatch, f"kept-{keeper.replace(' ', '-')}.sqlite", store, metas, **options)
    binding_runs = 0
    for _ in range(3):
        await _run(monkeypatch, state, ["member-file"], metas, store=store, **NONMEMBER, **options)
        binding_runs += 1
    assert state.root_obligations(INTEGRATION, 5)[("file", "member-file")].handoff_sources == ("sd-member",)
    # The ORIGINAL started stream stands — its token and the claims made through it — locally and on
    # the brain, not a stream recreated for the requirement after a retirement.
    assert _old_stream_kept(state, store), "another requirement keeps the old drive"
    assert store["last_summary"].authoritative_complete is False
    state.close()


@pytest.mark.asyncio
async def test_a_failed_reconciliation_never_false_completes(tmp_path, monkeypatch):
    store: dict = {"reconciles": []}
    state = await _lose_membership(tmp_path, monkeypatch, "reconcile-fails.sqlite", store)
    await _hand_over(monkeypatch, state, store)
    store["reconcile_error"] = True
    before = len(store["reconciles"])
    await _run(monkeypatch, state, ["member-file"], METAS, store=store, **NONMEMBER)
    # The old stream retired (published), but the reconciliation failed: not complete, nothing removed.
    assert state.get_progress(_stream_namespace("sd-member")) is None
    assert "sd-member" not in store["progress"]["streams"]
    assert len(store["reconciles"]) == before
    assert store["last_summary"].authoritative_complete is False
    store["reconcile_error"] = False
    await _run(monkeypatch, state, ["member-file"], METAS, store=store, **NONMEMBER)
    assert store["reconciles"][-1] == ["member-file"]
    assert store["last_summary"].authoritative_complete is True
    state.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("owed", ["pending work", "uncommitted page", "removal barrier"])
async def test_an_old_stream_that_still_owes_anything_is_not_retired(tmp_path, monkeypatch, owed):
    """Verified hand-over or not, a stream that still owes work, a page or a removal barrier stays."""
    store: dict = {"reconciles": []}
    state = await _lose_membership(tmp_path, monkeypatch, f"owes-{owed.replace(' ', '-')}.sqlite", store)
    await _hand_over(monkeypatch, state, store)
    old = state.get_progress(_stream_namespace("sd-member"))
    if owed == "pending work":
        state.enqueue_work(old.namespace, 5, "member-file", "upsert")
    elif owed == "uncommitted page":
        state._db.execute(
            "INSERT INTO materialized_pages(namespace,generation,page_id,page_kind,input_token) VALUES(?,?,?,?,?)",
            (old.namespace, 5, "owed-page", "changes", "cursor"),
        )
        state._db.commit()
    else:
        state._db.execute(
            "INSERT INTO removal_barriers(namespace,generation,item_key,observation_revision,peer_drive_id,barrier_seq) "
            "VALUES(?,?,?,?,?,?)",
            (old.namespace, 5, "member-file", 1, "my-drive", 1),
        )
        state._db.commit()
    reconciled = _reconcile_count(store)
    for _ in range(2):
        await _run(monkeypatch, state, ["member-file"], METAS, store=store, **NONMEMBER)
    assert _old_stream_kept(state, store), f"{owed} keeps the old stream"
    assert _reconcile_count(store) == reconciled
    assert store["last_summary"].authoritative_complete is False
    state.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["checkpoint refused", "acknowledgment lost"])
async def test_an_unpublished_retirement_never_reconciles_and_is_retried(tmp_path, monkeypatch, failure):
    """Unchanged roots, and the retiring run's checkpoint is refused or its acknowledgment lost: no
    connection-wide reconciliation at all, nothing complete, the brain's claims and record of the old
    stream unchanged — and the next acquisition retries the retirement and converges."""
    store: dict = {"reconciles": []}
    state = await _lose_membership(tmp_path, monkeypatch, f"unpublished-{failure.replace(' ', '-')}.sqlite", store)
    await _hand_over(monkeypatch, state, store)
    roots_before = copy.deepcopy(store["progress"].get("roots"))
    reconciled = _reconcile_count(store)

    store["checkpoint_error" if failure == "checkpoint refused" else "ack_lost"] = True
    attempts = store.get("checkpoint_attempts", 0)
    await _run(monkeypatch, state, ["member-file"], METAS, store=store, **NONMEMBER)
    if failure == "acknowledgment lost":
        # The revision is unknown after it: no further changed checkpoint is sent this run.
        assert store["checkpoint_attempts"] == attempts + 1
    assert _reconcile_count(store) == reconciled, "no reconciliation before the source-removed map is acknowledged"
    assert store["last_summary"].authoritative_complete is False
    assert store["progress"]["streams"]["sd-member"]["baseline_start_token"] == "start:sd-member"
    assert store["progress"].get("roots") == roots_before, "unchanged roots"
    assert state.get_progress(_stream_namespace("sd-member")) is None, "retired locally; retried from handoff_sources"

    store["checkpoint_error"] = False
    store["ack_lost"] = False
    await _run(monkeypatch, state, ["member-file"], METAS, store=store, **NONMEMBER)
    assert "sd-member" not in store["progress"]["streams"]
    reconcile_events = [event for event in store["events"] if event[0] == "reconcile"]
    assert len(reconcile_events) == reconciled + 1 and "sd-member" not in reconcile_events[-1][1]
    assert store["reconciles"][-1] == ["member-file"]
    assert store["last_summary"].authoritative_complete is True
    state.close()


# ── chained relocations: every predecessor stream is kept until the CURRENT destination verifies ─

C_META = _meta("member-file", "sd-next")
CHAIN_MEMBERSHIP = {"sd-member": "nonmember", "sd-next": "member"}


def _chain_metas():
    return {**METAS, "member-file": C_META}


def _owe_work(state, drive_id, owed=True):
    """A source stream that still owes work (held), or no longer does (released)."""
    namespace = _stream_namespace(drive_id)
    if owed:
        state.enqueue_work(namespace, 5, "member-file", "upsert")
    else:
        state._db.execute("DELETE FROM pending_work WHERE namespace=?", (namespace,))
        state._db.commit()


async def _relocate_to_c(monkeypatch, state, store):
    """A=sd-member → B=my-drive (verified), A held by owed work, then the file MOVES to C=sd-next: B's
    real change page reports it, it relocates, and the next run hands it to C with {A, B} recorded."""
    await _hand_over(monkeypatch, state, store)
    _owe_work(state, "sd-member")
    # The move, observed once in the user log's change feed.
    await _run(
        monkeypatch, state, ["member-file"], _chain_metas(), store=store, membership=CHAIN_MEMBERSHIP,
        unopenable=("sd-member",), real=True,
        changes_by_drive={"my-drive": [{"fileId": "member-file", "file": C_META}]},
    )
    binding = state.root_obligations(INTEGRATION, 5)[("file", "member-file")]
    assert (binding.status, binding.drive_id, binding.pending_drive_id) == ("relocating", "my-drive", "sd-next")
    # The hand-over to C: its token first, then the rebind recording BOTH predecessors.
    starts, runs, _ = await _run(
        monkeypatch, state, ["member-file"], _chain_metas(), store=store, membership=CHAIN_MEMBERSHIP,
        unopenable=("sd-member",), real=True,
    )
    assert "sd-next" in starts and "sd-next" in next(snapshot for drive, snapshot in runs if drive == "sd-next")
    binding = state.root_obligations(INTEGRATION, 5)[("file", "member-file")]
    assert (binding.status, binding.drive_id, binding.handoff_sources) == ("bound", "sd-next", ("my-drive", "sd-member"))
    assert store["progress"]["roots"]["items"][0]["handoff_sources"] == ["my-drive", "sd-member"]


def _source_kept(state, store, drive_id):
    return state.get_progress(_stream_namespace(drive_id)) is not None and drive_id in store["progress"]["streams"]


CHAIN_RUN = dict(membership=CHAIN_MEMBERSHIP, unopenable=("sd-member",), real=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [None, "checkpoint refused", "acknowledgment lost before commit",
                                     "acknowledgment lost after commit"])
async def test_a_to_b_to_c_retires_both_ancestors_only_after_c_verifies(tmp_path, monkeypatch, failure):
    store: dict = {"reconciles": []}
    state = await _lose_membership(tmp_path, monkeypatch, f"chain-{failure or 'ok'}.sqlite", store)
    await _relocate_to_c(monkeypatch, state, store)
    # Both ancestors stand: A still owes work, and B is never retired by A's retirement either.
    assert _source_kept(state, store, "sd-member") and _source_kept(state, store, "my-drive")
    reconciled = _reconcile_count(store)
    _owe_work(state, "sd-member", owed=False)

    if failure is not None:
        store[{"checkpoint refused": "checkpoint_error", "acknowledgment lost before commit": "ack_lost",
               "acknowledgment lost after commit": "ack_lost_after_commit"}[failure]] = True
        await _run(monkeypatch, state, ["member-file"], _chain_metas(), store=store, **CHAIN_RUN)
        assert _reconcile_count(store) == reconciled, "no reconciliation before the source-removed map is acknowledged"
        assert store["last_summary"].authoritative_complete is False
        if failure == "acknowledgment lost after commit":
            # The brain holds the map without either ancestor; this run never learned it.
            assert {"sd-member", "my-drive"}.isdisjoint(store["progress"]["streams"])
        else:
            assert {"sd-member", "my-drive"} <= set(store["progress"]["streams"]), "the brain's record is unchanged"
        for flag in ("checkpoint_error", "ack_lost", "ack_lost_after_commit", "uncertain"):
            store[flag] = False

    # Reacquisition: both ancestors leave the brain's record in an ACKNOWLEDGED checkpoint, and only
    # then is the connection reconciled — with C's document retained.
    await _run(monkeypatch, state, ["member-file"], _chain_metas(), store=store, **CHAIN_RUN)
    for source in ("sd-member", "my-drive"):
        assert state.get_progress(_stream_namespace(source)) is None
        assert source not in store["progress"]["streams"]
    reconcile_events = [event for event in store["events"] if event[0] == "reconcile"]
    assert len(reconcile_events) == reconciled + 1
    assert {"sd-member", "my-drive"}.isdisjoint(reconcile_events[-1][1])
    assert store["reconciles"][-1] == ["member-file"]
    assert store["last_summary"].authoritative_complete is True
    # The history is monotonic for the generation: deleting the streams does not clear it.
    assert state.root_obligations(INTEGRATION, 5)[("file", "member-file")].handoff_sources == ("my-drive", "sd-member")
    state.close()


@pytest.mark.asyncio
async def test_an_unverified_current_destination_keeps_every_ancestor(tmp_path, monkeypatch):
    store: dict = {"reconciles": []}
    state = await _lose_membership(tmp_path, monkeypatch, "chain-unverified.sqlite", store)
    await _relocate_to_c(monkeypatch, state, store)
    _owe_work(state, "sd-member", owed=False)
    store["progress"]["streams"]["sd-next"].update(recovery_required=True)
    reconciled = _reconcile_count(store)
    await _run(monkeypatch, state, ["member-file"], _chain_metas(), store=store, **CHAIN_RUN)
    assert _source_kept(state, store, "sd-member") and _source_kept(state, store, "my-drive")
    assert _reconcile_count(store) == reconciled
    state.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("restart", ["reopened", "fresh", "stale-local"])
async def test_the_chain_survives_restart_and_unions_acknowledged_history(tmp_path, monkeypatch, restart):
    import shutil
    store: dict = {"reconciles": []}
    path = tmp_path / f"chain-restart-{restart}.sqlite"
    state = await _lose_membership(tmp_path, monkeypatch, path.name, store)
    await _hand_over(monkeypatch, state, store)
    _owe_work(state, "sd-member")
    await _run(
        monkeypatch, state, ["member-file"], _chain_metas(), store=store, **CHAIN_RUN,
        changes_by_drive={"my-drive": [{"fileId": "member-file", "file": C_META}]},
    )
    stale = tmp_path / "stale-before-second-rebind.sqlite"
    state.close()
    shutil.copy(path, stale)  # local history {A} only: taken before the second rebind
    state = StateStore(str(path))
    await _run(monkeypatch, state, ["member-file"], _chain_metas(), store=store, **CHAIN_RUN)
    assert state.root_obligations(INTEGRATION, 5)[("file", "member-file")].handoff_sources == ("my-drive", "sd-member")
    _owe_work(state, "sd-member", owed=False)
    state.close()

    if restart == "reopened":
        state = StateStore(str(path))
    elif restart == "fresh":
        state = StateStore(str(tmp_path / "chain-fresh.sqlite"))  # exclusively the brain's evidence
    else:
        state = StateStore(str(stale))  # an older local history; the brain's newer one is unioned
        # The stale copy still owes A's work: release it so only the history is under test.
        _owe_work(state, "sd-member", owed=False)
    reconciled = _reconcile_count(store)
    for _ in range(4):
        await _run(monkeypatch, state, ["member-file"], _chain_metas(), store=store, **CHAIN_RUN)
        binding = state.root_obligations(INTEGRATION, 5)[("file", "member-file")]
        assert set(binding.handoff_sources) >= {"sd-member", "my-drive"}, "acknowledged history is unioned"
        if store["last_summary"].authoritative_complete:
            break
        assert {"sd-member", "my-drive"} <= set(store["progress"]["streams"]) or _reconcile_count(store) == reconciled
    assert store["last_summary"].authoritative_complete is True
    assert {"sd-member", "my-drive"}.isdisjoint(store["progress"]["streams"])
    assert store["reconciles"][-1] == ["member-file"]
    state.close()


@pytest.mark.asyncio
async def test_a_to_b_to_a_protects_the_current_source_while_b_retires(tmp_path, monkeypatch):
    store: dict = {"reconciles": []}
    state = await _lose_membership(tmp_path, monkeypatch, "aba.sqlite", store)
    await _hand_over(monkeypatch, state, store)
    # Membership is regained and the file is reported back in sd-member through the user log.
    back = _meta("member-file", "sd-member")
    await _run(
        monkeypatch, state, ["member-file"], METAS, store=store, membership={"sd-member": "member"},
        unopenable=(), real=True, changes_by_drive={"my-drive": [{"fileId": "member-file", "file": back}]},
    )
    for _ in range(4):
        await _run(monkeypatch, state, ["member-file"], METAS, store=store, membership={"sd-member": "member"},
                   unopenable=(), real=True)
    binding = state.root_obligations(INTEGRATION, 5)[("file", "member-file")]
    assert (binding.status, binding.drive_id) == ("bound", "sd-member")
    assert binding.handoff_sources == ("my-drive", "sd-member")
    # A, the current owner, is protected — its stream and claims stand; B retired.
    current = state.get_progress(_stream_namespace("sd-member"))
    assert current is not None and "sd-member" in store["progress"]["streams"]
    assert state.membership_ids(current.namespace, 5, snapshot_id=current.active_snapshot) == ["member-file"]
    assert state.get_progress(_stream_namespace("my-drive")) is None and "my-drive" not in store["progress"]["streams"]
    assert store["last_summary"].authoritative_complete is True
    state.close()


def test_a_legacy_scalar_is_a_one_drive_set_and_rebinding_unions_it_idempotently(tmp_path):
    from aios_ingest.connector_state import parse_roots_section, roots_section
    from aios_ingest.state import RootBinding

    # Remote evidence: an older checkpoint's scalar reads as a set; the set round-trips; generations are strict.
    legacy = {"roots": {"generation": 5, "items": [
        {"kind": "file", "id": "f", "status": "bound", "drive_id": "c", "handoff_from": "a"},
    ]}}
    assert parse_roots_section(legacy, 5)[("file", "f")].handoff_sources == ("a",)
    assert parse_roots_section(legacy, 6) == {}
    written = roots_section(5, {("file", "f"): RootBinding("c", handoff_sources=("b", "a"))})
    assert written["items"][0]["handoff_sources"] == ["b", "a"]
    assert parse_roots_section({"roots": written}, 5)[("file", "f")].handoff_sources == ("a", "b")

    # Local state: a legacy scalar row is unioned by the next rebind, and the scalar is folded away.
    state = StateStore(str(tmp_path / "legacy.sqlite"))
    state.bind_root("conn", 5, "file", "f", "a")
    state._db.execute("UPDATE selection_root_bindings SET handoff_from='z' WHERE root_id='f'")
    state._db.commit()
    assert state.root_obligations("conn", 5)[("file", "f")].handoff_sources == ("z",)
    state.mark_root_relocating("conn", 5, "file", "f", "a", destination="b")
    assert state.rebind_root("conn", 5, "file", "f", "b") is True
    assert state.root_obligations("conn", 5)[("file", "f")].handoff_sources == ("a", "z")
    assert state._db.execute("SELECT handoff_from FROM selection_root_bindings WHERE root_id='f'").fetchone()[0] is None
    # Idempotent: a repeated rebind is refused and changes nothing.
    assert state.rebind_root("conn", 5, "file", "f", "b") is False
    assert state.root_obligations("conn", 5)[("file", "f")] == RootBinding("b", handoff_sources=("a", "z"))
    # A→B→C keeps both ancestors.
    state.mark_root_relocating("conn", 5, "file", "f", "b", destination="c")
    state.rebind_root("conn", 5, "file", "f", "c")
    assert state.root_obligations("conn", 5)[("file", "f")].handoff_sources == ("a", "b", "z")
    # Restore unions the brain's history into a NEWER local transition without overwriting it.
    state.restore_root_obligation("conn", 5, "file", "f", RootBinding("b", "relocating", "c", handoff_sources=("q",)))
    restored = state.root_obligations("conn", 5)[("file", "f")]
    assert (restored.drive_id, restored.status, restored.handoff_sources) == ("c", "bound", ("a", "b", "q", "z"))
    state.close()
