"""Two sidecar OS PROCESSES, separate state files, lease replacement and stale commits (AIO-1167).

Spec (accepted spec, addendum AC-03/AC-04/AC-07: "separate sidecar processes/state files, lease
replacement and stale sink/progress commits"). Two sidecars run as separate OS processes, each with
its OWN SQLite state file and the real coordinator + real `BrainClient` over HTTP. The brain is the
only authority: its execution lease and fence decide who may commit.

  * Sidecar A acquires the connection and commits part of the work, then stalls mid-document (after
    that read's authority check) while still holding a lease.
  * The lease is replaced: sidecar B — a different process, with an empty state file of its own —
    acquires (a NEW fence), restores from the brain's acknowledged checkpoint, and completes.
  * When A resumes, its next sink commit carries the old fence and is refused as stale. A stops: it
    makes no further brain commit, and nothing it holds overwrites B's acknowledged progress.

The fake brain below implements the HTTP execution contract the sidecar speaks (acquire, checkpoint
with revision, authorize_provider, token, items with execution headers, release, source-reconcile)
and enforces generation, fence and progress revision exactly as the brain's execution authority does;
the brain-side fence itself is proven against real Postgres and real HTTP in the TypeScript tiers.
Google is faked inside each sidecar process, behind the real `GoogleDriveSource` request path.
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from aios_ingest.state import StateStore, StreamKey

INTEGRATION = "00000000-0000-0000-0000-0000000000d1"
DRIVE = "drive-a"
DOCS = ["doc-1", "doc-2", "doc-3"]
DRIVER = Path(__file__).with_name("two_process_sidecar_driver.py")
INGESTION_ROOT = Path(__file__).resolve().parents[1]


class FakeBrain:
    """The brain's execution authority, over HTTP. One connection, one lease, one fence."""

    def __init__(self):
        self.lock = threading.Lock()
        self.generation = 1
        self.fence = 0
        self.owner: str | None = None
        self.lease_until = 0.0
        self.progress: dict = {}
        self.revision = 0
        self.seq = 0
        self.log: list[dict] = []  # every commit attempt, accepted or refused, in order

    def config(self) -> dict:
        return {"authMode": "oauth", "authenticatedAccountId": "account", "fileIds": [], "folderIds": [],
                "sharedDriveIds": [DRIVE], "selectionState": "selected"}

    def current(self, body: dict) -> bool:
        return (int(body.get("generation", -1)) == self.generation and int(body.get("fence", -1)) == self.fence
                and body.get("owner") == self.owner and time.monotonic() < self.lease_until)

    def record(self, kind: str, fence, owner, accepted: bool, **extra) -> None:
        self.seq += 1
        self.log.append({"seq": self.seq, "kind": kind, "fence": int(fence), "owner": owner,
                         "accepted": accepted, **extra})

    def handle(self, path: str, body: dict, headers) -> tuple[int, dict]:
        stale = (409, {"error": {"code": "stale_execution", "message": "Google Drive execution is stale"}})
        with self.lock:
            if path == "/api/v1/integrations/gdrive/execution":
                action = body.get("action")
                if action == "acquire":
                    if self.owner and self.owner != body["owner"] and time.monotonic() < self.lease_until:
                        return 409, {"error": {"code": "execution_busy", "message": "busy"}}
                    if self.owner != body["owner"] or time.monotonic() >= self.lease_until:
                        self.fence += 1
                    self.owner, self.lease_until = body["owner"], time.monotonic() + 600
                    self.record("acquire", self.fence, self.owner, True)
                    return 200, {"integration_id": INTEGRATION, "generation": self.generation, "fence": self.fence,
                                 "owner": self.owner, "lease_expires_at": "later", "scope_hash": "scope",
                                 "config": self.config(), "progress": self.progress,
                                 "progress_revision": self.revision}
                if action == "checkpoint":
                    if not self.current(body):
                        self.record("checkpoint", body.get("fence", -1), body.get("owner"), False)
                        return stale
                    if int(body["progress_revision"]) != self.revision:
                        self.record("checkpoint", body["fence"], body["owner"], False, reason="stale_progress")
                        return 409, {"error": {"code": "stale_progress", "message": "stale progress"}}
                    self.progress, self.revision = body["progress"], self.revision + 1
                    self.record("checkpoint", body["fence"], body["owner"], True, revision=self.revision)
                    return 200, {"progress_revision": self.revision, "progress": self.progress,
                                 "lease_expires_at": "later"}
                if action in ("authorize_provider", "verify_service_account"):
                    return (200, {}) if self.current(body) else stale
                if action == "release":
                    if self.current(body):
                        self.owner, self.lease_until = None, 0.0
                    return 200, {}
            if path == "/api/v1/integrations/gdrive/token":
                if not self.current(body):
                    return stale
                expires = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
                return 200, {"access_token": "memory", "expires_at": expires,
                             "scopes": ["https://www.googleapis.com/auth/drive.file"],
                             "account": {"subject": "account", "email": "owner@example.com"}}
            if path == "/api/v1/items":
                claimed = {"generation": headers.get("X-AIOS-Execution-Generation"),
                           "fence": headers.get("X-AIOS-Execution-Fence"),
                           "owner": headers.get("X-AIOS-Execution-Owner")}
                source_id = (body.get("frontmatter") or {}).get("source_id")
                if not self.current(claimed):
                    self.record("push", claimed["fence"] or -1, claimed["owner"], False, doc=source_id)
                    return stale
                self.record("push", claimed["fence"], claimed["owner"], True, doc=source_id)
                return 201, {"status": "created", "id": f"item-{source_id}", "path": body.get("path")}
            if path == "/api/v1/items/source-reconcile":
                return 200, {"items": 0, "snapshot": None}
        return 404, {"error": {"code": "not_found", "message": path}}


@pytest.fixture
def brain():
    fake = FakeBrain()

    class Handler(BaseHTTPRequestHandler):
        def _reply(self, status: int, payload: dict) -> None:
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            length = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            self._reply(*fake.handle(self.path.split("?")[0], body, self.headers))

        def do_GET(self):
            self._reply(404, {"error": {"code": "not_found", "message": self.path}})

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    fake.url = f"http://127.0.0.1:{server.server_address[1]}"
    yield fake
    server.shutdown()


def sidecar(brain: FakeBrain, state_path: Path, **extra) -> subprocess.Popen:
    """Start one sidecar as its own OS process."""
    config = {"brain_url": brain.url, "integration_id": INTEGRATION, "drive_id": DRIVE, "docs": DOCS,
              "state_path": str(state_path), **extra}
    return subprocess.Popen(
        [sys.executable, str(DRIVER), json.dumps(config)], cwd=str(INGESTION_ROOT),
        env={"PYTHONPATH": str(INGESTION_ROOT), "PATH": "/usr/bin:/bin"},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )


def finish(process: subprocess.Popen) -> dict:
    out, err = process.communicate(timeout=120)
    assert process.returncode == 0, f"sidecar failed:\n{err[-4000:]}"
    return json.loads(out.strip().splitlines()[-1])


def _accepted(brain: FakeBrain, kind: str, owner: str | None = None) -> list[dict]:
    return [e for e in brain.log if e["kind"] == kind and e["accepted"] and (owner is None or e["owner"] == owner)]


def test_a_replaced_sidecar_process_cannot_commit_after_another_process_takes_over(brain, tmp_path):
    state_a, state_b = tmp_path / "sidecar-a.sqlite", tmp_path / "sidecar-b.sqlite"
    paused, resume = tmp_path / "a.paused", tmp_path / "a.resume"

    # Sidecar A: its own process and state file; stalls inside doc-2, after that read's authority check.
    process_a = sidecar(brain, state_a, pause_doc="doc-2", pause_marker=str(paused), resume_marker=str(resume))
    deadline = time.monotonic() + 60
    while not paused.exists():
        assert process_a.poll() is None, f"sidecar A exited early:\n{process_a.stderr.read()[-4000:]}"
        assert time.monotonic() < deadline, "sidecar A never reached its pause"
        time.sleep(0.02)
    with brain.lock:
        fence_a, owner_a = brain.fence, brain.owner
        revision_at_takeover = brain.revision
        brain.lease_until = 0.0  # A's lease lapses while it is stalled
    assert [e["doc"] for e in _accepted(brain, "push", owner_a)] == ["doc-1"]

    # Sidecar B: a different process, an EMPTY state file of its own. It takes the lease (new fence),
    # restores from the brain's acknowledged checkpoint and completes the connection.
    result_b = finish(sidecar(brain, state_b))
    with brain.lock:
        fence_b, owner_b = brain.fence, [e for e in brain.log if e["kind"] == "acquire"][-1]["owner"]
        revision_after_b = brain.revision
    assert fence_b > fence_a and owner_b != owner_a
    assert "stale_execution" not in result_b["failure_categories"]
    assert {e["doc"] for e in _accepted(brain, "push", owner_b)} == set(DOCS)
    assert revision_after_b > revision_at_takeover

    # A resumes: its next sink commit carries the old fence and is refused; A stops.
    resume.write_text("go")
    result_a = finish(process_a)
    assert result_a["failure_categories"].get("stale_execution") == 1
    assert result_a["authoritative_complete"] is False
    refused = [e for e in brain.log if not e["accepted"]]
    assert refused and all(e["fence"] == fence_a for e in refused)
    assert refused[0]["kind"] == "push" and refused[0].get("doc") == "doc-2"
    # Nothing of A's was accepted after B took over, and A attempted nothing further after its refusal.
    takeover = next(e["seq"] for e in brain.log if e["kind"] == "acquire" and e["owner"] == owner_b)
    assert [e for e in brain.log if e["owner"] == owner_a and e["accepted"] and e["seq"] > takeover] == []
    assert [e for e in brain.log if e["owner"] == owner_a and e["seq"] > refused[0]["seq"]] == []
    # The brain's acknowledged progress is B's, unregressed.
    assert brain.revision == revision_after_b

    # Separate state files: A's file still owes doc-2 (never acknowledged), and holds no progress
    # revision beyond what the brain acknowledged before the takeover; B's file finished the stream.
    key = StreamKey("team", INTEGRATION, "account", DRIVE)
    a_state, b_state = StateStore(str(state_a)), StateStore(str(state_b))
    try:
        a_progress, b_progress = a_state.get_progress(key.namespace(1)), b_state.get_progress(key.namespace(1))
        assert a_progress.server_revision <= revision_at_takeover
        assert "doc-2" in [w.item_key for w in a_state.list_pending(key.namespace(1), 1, limit=50)]
        assert b_state.pending_count(key.namespace(1), 1) == 0
        assert b_progress.server_revision == revision_after_b
    finally:
        a_state.close()
        b_state.close()


def test_one_sidecar_process_without_a_takeover_completes(brain, tmp_path):
    """Control: the same harness with no lease replacement runs to completion — so the refusal above
    is the takeover's doing, not the harness's."""
    result = finish(sidecar(brain, tmp_path / "solo.sqlite"))
    assert result["failure_categories"].get("stale_execution") is None
    assert {e["doc"] for e in _accepted(brain, "push")} == set(DOCS)
    assert [e for e in brain.log if not e["accepted"]] == []
