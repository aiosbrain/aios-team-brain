"""A stale local sibling never overwrites newer acknowledged progress (AIO-1167 R44 S1).

Spec (AC-03, addendum). Two lease owners alternate with SEPARATE local stores. Owner 2 advanced
stream B on the brain. Owner 1 acquires again — its local B is older — and checkpoints stream A
first. The checkpoint must carry the brain's newer B unchanged (not owner 1's stale copy) and must
not stamp the stale local B as current, so B is still restored from the brain at its own turn. Once
restored, B's local copy is published normally. Streams of another account are never this
coordinator's to publish.
"""

from __future__ import annotations

import pytest

from aios_ingest.brain_client import GdriveExecution
from aios_ingest.gdrive_sync import _checkpoint_progress
from aios_ingest.state import StateStore, StreamKey

GEN = 4


class _Client:
    def __init__(self, revision):
        self.revision, self.payloads = revision, []

    async def checkpoint_gdrive_execution(self, execution, payload):
        self.payloads.append(payload)
        self.revision += 1
        return {"progress_revision": self.revision, "progress": payload}


def _store(tmp_path, name, *, b_token, revision):
    state = StateStore(str(tmp_path / name))
    for drive, token in (("drive-a", "a-local"), ("drive-b", b_token)):
        key = StreamKey("team", "conn", "acct", drive)
        state.begin_generation(key, GEN, start_token="start")
        state.update_progress(key.namespace(GEN), page_token=token, server_revision=revision)
    return state


def _ns(drive, account="acct"):
    return StreamKey("team", "conn", account, drive).namespace(GEN)


@pytest.mark.asyncio
async def test_owner_one_checkpointing_a_first_keeps_owner_twos_newer_b(tmp_path):
    # Owner 1 last saw revision 3; owner 2 since advanced B and the brain is at revision 7.
    owner_one = _store(tmp_path, "one.sqlite", b_token="b-stale", revision=3)
    remote = {"version": 2, "streams": {
        "drive-a": {"drive_id": "drive-a", "page_token": "a-remote"},
        "drive-b": {"drive_id": "drive-b", "page_token": "b-newer", "listing_complete": True},
    }}
    execution = GdriveExecution("conn", GEN, 2, "owner-1", "later", "scope", {}, progress=remote, progress_revision=7)
    client = _Client(7)

    await _checkpoint_progress(client, execution, owner_one, _ns("drive-a"), page_token="a-next")

    sent = client.payloads[-1]["streams"]
    assert sent["drive-a"]["page_token"] == "a-next"
    assert sent["drive-b"] == remote["streams"]["drive-b"]  # the newer acknowledged B, untouched
    # The stale local B is NOT stamped current: it will still be restored before use.
    assert owner_one.get_progress(_ns("drive-b")).server_revision == 3
    assert owner_one.get_progress(_ns("drive-a")).server_revision == 8

    # B's turn restores it from the brain; from then on its local copy is published.
    owner_one.update_progress(_ns("drive-b"), page_token="b-newer", server_revision=7)
    await _checkpoint_progress(client, execution, owner_one, _ns("drive-a"))
    assert client.payloads[-1]["streams"]["drive-b"]["page_token"] == "b-newer"
    assert owner_one.get_progress(_ns("drive-b")).server_revision == 9
    owner_one.close()


@pytest.mark.asyncio
async def test_a_current_sibling_and_a_new_stream_are_still_published(tmp_path):
    state = _store(tmp_path, "current.sqlite", b_token="b-current", revision=5)
    execution = GdriveExecution("conn", GEN, 2, "owner", "later", "scope", {}, progress={
        "version": 2, "streams": {"drive-b": {"drive_id": "drive-b", "page_token": "b-older"}},
    }, progress_revision=5)
    client = _Client(5)
    await _checkpoint_progress(client, execution, state, _ns("drive-a"))
    sent = client.payloads[-1]["streams"]
    assert sent["drive-b"]["page_token"] == "b-current"  # local is as new as what was acquired
    assert sent["drive-a"]["page_token"] == "a-local"  # absent remotely: nothing to protect
    state.close()


@pytest.mark.asyncio
async def test_another_accounts_streams_are_not_published(tmp_path):
    state = _store(tmp_path, "accounts.sqlite", b_token="b", revision=5)
    other = StreamKey("team", "conn", "old-account", "drive-z")
    state.begin_generation(other, GEN, start_token="start")
    execution = GdriveExecution("conn", GEN, 2, "owner", "later", "scope", {}, progress={"version": 2, "streams": {}},
                                progress_revision=5)
    client = _Client(5)
    await _checkpoint_progress(client, execution, state, _ns("drive-a"))
    assert "drive-z" not in client.payloads[-1]["streams"]
    state.close()
