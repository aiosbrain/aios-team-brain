"""AIO-1167 R60 — root transition identity through the PRODUCTION publication path.

Spec (Astra R60 adjudication). Root transitions are made and acknowledged exactly as the coordinator
makes them — `StateStore.mark_root_relocating` / `rebind_root`, reconciliation of the acquired root
document (`_adopt_remote_root_evidence`), its serialization into the cursor checkpoint
(`roots_section` inside `_checkpoint_progress`) and the acknowledgement (`acknowledge_roots`) — by
two workers with SEPARATE file-backed SQLite stores against one brain. Identities are read from the
brain's acknowledged root documents, never computed by the test:

  * every acknowledged change of a root's state advances its transition identity; an unchanged or
    unrelated checkpoint keeps it; close/reopen keeps state and identity;
  * returning to an earlier state (A→B→A) — even with predecessor history already {A, B} — is a NEW
    identity, so a stale worker's unpublished A→B from the older A is never republished: it adopts
    the canonical root conservatively (no completeness, no retirement) until a fresh observation;
  * the A→B→C counterpart keeps the canonical current owner and every predecessor obligation;
  * a checkpoint acknowledged with a different state OR a different identity than submitted advances
    no local baseline (nor after reopen); an exact acknowledgement advances both.
"""

from __future__ import annotations

import copy
import json

import pytest

from aios_ingest.brain_client import GdriveExecution
from aios_ingest.gdrive_sync import (
    _adopt_remote_root_evidence,
    _checkpoint_progress,
    _reobserve_conflicted_roots,
    _retire_handed_over_streams,
    _root_coverage_complete,
)
from aios_ingest.state import ROOT_AUTHORITY_CONFLICT_DETAIL, StateStore, StreamKey

CONN, GEN, ROOT = "conn", 5, ("file", "f")
OPTIONS = {"selection_state": "selected", "file_ids": ["f"], "credential_identity": "account"}


class _Brain:
    """The canonical record. ``respond`` may alter what an acknowledgement says was stored."""

    def __init__(self):
        self.progress: dict = {}
        self.revision = 0
        self.respond = None


class _Client:
    def __init__(self, brain: _Brain):
        self.brain = brain

    async def checkpoint_gdrive_execution(self, execution, payload):
        self.brain.revision += 1
        acknowledged = copy.deepcopy(payload)
        if self.brain.respond is not None:
            acknowledged = self.brain.respond(acknowledged)
        self.brain.progress = copy.deepcopy(acknowledged)
        return {"progress_revision": self.brain.revision, "progress": copy.deepcopy(acknowledged)}


class _Worker:
    """One coordinator with its own file-backed store: acquire (reconcile) and publish (checkpoint)."""

    def __init__(self, path, brain: _Brain):
        self.path, self.brain = str(path), brain
        self.state = StateStore(self.path)
        key = StreamKey("team", CONN, "account", "my-drive")
        self.namespace = key.namespace(GEN)
        if self.state.get_progress(self.namespace) is None:
            self.state.begin_generation(key, GEN, start_token="start")
        self.execution: GdriveExecution | None = None

    def acquire(self):
        self.execution = GdriveExecution(
            CONN, GEN, 1, "owner", "later", "scope", {},
            progress=copy.deepcopy(self.brain.progress), progress_revision=self.brain.revision,
        )
        _adopt_remote_root_evidence(self.state, self.execution, CONN, GEN)
        return self

    async def publish(self):
        await _checkpoint_progress(_Client(self.brain), self.execution, self.state, self.namespace)
        return self.brain_root()

    def brain_root(self):
        items = (self.brain.progress.get("roots") or {}).get("items") or []
        return copy.deepcopy(items[0]) if items else None

    def binding(self):
        return self.state.root_obligations(CONN, GEN)[ROOT]

    def baseline(self):
        row = self.state._db.execute(
            "SELECT ack_baseline FROM selection_root_bindings WHERE root_id='f'").fetchone()
        return json.loads(row[0]) if row and row[0] else None

    def reopen(self):
        self.state.close()
        self.state = StateStore(self.path)
        return self

    def close(self):
        self.state.close()


async def _move(worker: _Worker, source: str, destination: str) -> tuple[dict, dict]:
    """One acknowledged relocation then one acknowledged hand-over, through the production writers."""
    worker.state.mark_root_relocating(CONN, GEN, *ROOT, source, destination=destination)
    relocating = await worker.publish()
    assert worker.state.rebind_root(CONN, GEN, *ROOT, destination)
    bound = await worker.publish()
    return relocating, bound


def _state(item):
    return (item["status"], item["drive_id"], item.get("pending_drive_id"), item.get("detail"))


class _Observer:
    """A fresh observation of the root (the provider read `_reobserve_conflicted_roots` makes)."""

    def __init__(self, drive_id=None):
        self.drive_id = drive_id

    def _services(self):
        return object(), object()

    def _execute(self, request):
        return request.execute()

    def _metadata(self, file_id):
        if self.drive_id is None:
            raise RuntimeError("root metadata unavailable")
        return {"id": file_id, "driveId": self.drive_id, "mimeType": "application/vnd.google-apps.document"}


# ── 1. identities advance on acknowledged change, hold otherwise, survive reopen ──────────────────

@pytest.mark.asyncio
@pytest.mark.parametrize("end", ["A", "C"], ids=["A-B-A", "A-B-C"])
async def test_acknowledged_root_documents_carry_a_chained_transition_identity(tmp_path, end):
    brain = _Brain()
    w2 = _Worker(tmp_path / "w2.sqlite", brain).acquire()
    w2.state.bind_root(CONN, GEN, *ROOT, "A")
    first = await w2.publish()
    assert first["transition"] and _state(first) == ("bound", "A", None, None)
    # An unchanged checkpoint keeps the identity; the revision still moves.
    revision = brain.revision
    assert (await w2.publish())["transition"] == first["transition"] and brain.revision > revision

    relocating, at_b = await _move(w2, "A", "B")
    back_relocating, final = await _move(w2, "B", end)
    documents = [first, relocating, at_b, back_relocating, final]
    identities = [document["transition"] for document in documents]
    assert len(set(identities)) == len(identities), "every acknowledged state change is a new identity"
    if end == "A":
        assert _state(final) == _state(first), "the same state as the first A …"
        assert final["transition"] != first["transition"], "… under a NEW identity"
    assert final["handoff_sources"] == sorted({"A", "B"} if end == "A" else {"A", "B"})

    # Close/reopen keeps state and identity: the local row is published under the same identity.
    w2.reopen().acquire()
    assert w2.binding().transition == final["transition"]
    assert w2.baseline() == {"state": dict(zip(("status", "drive_id", "pending_drive_id", "detail"), _state(final))),
                             "transition": final["transition"]}
    assert (await w2.publish())["transition"] == final["transition"]
    w2.close()


# ── 2/3. a stale unpublished A→B against a newer A→B→A (saturated) or A→B→C ───────────────────────

async def _saturated_history(tmp_path):
    """W2 establishes acknowledged history {A, B}: bound(A) after one full A→B→A."""
    brain = _Brain()
    w2 = _Worker(tmp_path / "w2.sqlite", brain).acquire()
    w2.state.bind_root(CONN, GEN, *ROOT, "A")
    await w2.publish()
    await _move(w2, "A", "B")
    await _move(w2, "B", "A")
    canonical = w2.brain_root()
    assert canonical["handoff_sources"] == ["A", "B"]
    return brain, w2, canonical


@pytest.mark.asyncio
@pytest.mark.parametrize("end", ["A", "C"], ids=["saturated A-B-A", "A-B-C"])
async def test_a_stale_unpublished_relocation_never_overwrites_a_newer_canonical_cycle(tmp_path, end):
    brain, w2, canonical = await _saturated_history(tmp_path)
    # Stale W1 holds that canonical baseline, then makes a LOCAL A→B it never publishes.
    w1 = _Worker(tmp_path / "w1.sqlite", brain).acquire()
    assert w1.baseline()["transition"] == canonical["transition"]
    w1.state.mark_root_relocating(CONN, GEN, *ROOT, "A", destination="B")
    # Streams W1 knows — the old drive among them — so a premature retirement would be visible.
    for drive in ("A", "B"):
        key = StreamKey("team", CONN, "account", drive)
        w1.state.begin_generation(key, GEN, start_token=f"start:{drive}")

    # W2 completes ANOTHER acknowledged A→B→end through the production path.
    w2.reopen().acquire()
    await _move(w2, "A", "B")
    await _move(w2, "B", end)
    newer = w2.brain_root()
    if end == "A":
        assert _state(newer) == _state(canonical) and newer["handoff_sources"] == canonical["handoff_sources"]
        assert newer["transition"] != canonical["transition"], "identical state and saturated history, NEW identity"
    w2.close()

    # W1 is reopened BEFORE reacquiring, then acquires with the root unobservable.
    w1.reopen().acquire()
    adopted = w1.binding()
    assert (adopted.status, adopted.drive_id, adopted.detail) == ("uncertain", end, ROOT_AUTHORITY_CONFLICT_DETAIL)
    assert {"A", "B"} <= set(adopted.handoff_sources), "every predecessor obligation survives"
    _reobserve_conflicted_roots(_Observer(None), w1.state, CONN, GEN)
    assert w1.binding().status == "uncertain", "an unavailable observation settles nothing"
    published = await w1.publish()
    assert published["status"] != "relocating", "the stale relocation is never republished"
    assert (published["status"], published["drive_id"]) == ("uncertain", end), "the canonical current owner"
    assert not _root_coverage_complete(w1.state, CONN, GEN, OPTIONS), "no false completeness"
    assert _retire_handed_over_streams(w1.state, w1.execution, "team", CONN, GEN, OPTIONS, set()) == set()
    for drive in ("A", "B"):
        assert w1.state.get_progress(StreamKey("team", CONN, "account", drive).namespace(GEN)) is not None

    # A fresh observation where the canonical binding says: settled, published, covered.
    w1.reopen().acquire()
    _reobserve_conflicted_roots(_Observer(end), w1.state, CONN, GEN)
    assert (w1.binding().status, w1.binding().drive_id) == ("bound", end)
    converged = await w1.publish()
    assert (converged["status"], converged["drive_id"]) == ("bound", end)
    assert converged["transition"] not in {canonical["transition"], published["transition"]}
    assert _root_coverage_complete(w1.state, CONN, GEN, OPTIONS)
    w1.close()


# ── 4. the acknowledgement must be EXACTLY what was submitted ────────────────────────────────────

@pytest.mark.asyncio
@pytest.mark.parametrize("response", ["same state, different identity", "different state, same identity", "exact"])
async def test_only_an_exactly_acknowledged_root_advances_the_baseline(tmp_path, response):
    brain = _Brain()
    w1 = _Worker(tmp_path / "w1.sqlite", brain).acquire()
    w1.state.bind_root(CONN, GEN, *ROOT, "A")
    await w1.publish()
    prior = w1.baseline()
    assert prior["state"]["status"] == "bound"

    def alter(document):
        item = document["roots"]["items"][0]
        if response == "same state, different identity":
            item["transition"] = "0" * 64
        elif response == "different state, same identity":
            item["detail"] = "a different acknowledged state"
        return document

    brain.respond = alter
    w1.state.mark_root_relocating(CONN, GEN, *ROOT, "A", destination="B")
    submitted_identity = w1.binding().transition
    await w1.publish()
    brain.respond = None
    if response == "exact":
        advanced = w1.baseline()
        assert advanced["state"]["status"] == "relocating" and advanced["transition"] == submitted_identity
    else:
        assert w1.baseline() == prior, "a mismatched acknowledgement advances neither state nor identity"
        w1.reopen()
        assert w1.baseline() == prior, "nor after reopen"
    w1.close()
