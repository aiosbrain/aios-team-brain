"""The sidecar's absence boundary has exactly one door per kind of absence (AIO-1167 R41).

* A COMPLETE snapshot (connection-wide absence) is submitted only by
  ``gdrive_sync._submit_complete_snapshot``, which re-derives selected-root coverage itself.
* A per-document REMOVAL is submitted only by ``gdrive_sync._drain_pending``, after
  ``_cross_stream_removal`` returned ``absent`` (which withholds membership-inferred absence while
  any root is unresolved or uncertain, but honors the provider's own not-found/trash — AC-05).

The guard reads the package's syntax trees, so a new caller anywhere fails the build instead of
quietly bypassing either rule. ``brain_client`` is the transport and is excluded.
"""

from __future__ import annotations

import ast
import asyncio
from pathlib import Path

import pytest

from aios_ingest.brain_client import GdriveExecution
from aios_ingest.gdrive_sync import IncompleteRootCoverage, _submit_complete_snapshot
from aios_ingest.state import StateStore

PACKAGE = Path(__file__).resolve().parents[1] / "aios_ingest"
DOORS = {
    "complete_snapshot_ids": {("gdrive_sync.py", "_submit_complete_snapshot")},
    "removed_provider_ids": {("gdrive_sync.py", "_drain_pending")},
}


def _callers(keyword: str) -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    for path in sorted(PACKAGE.rglob("*.py")):
        if path.name == "brain_client.py":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))

        def visit(node: ast.AST, function: str) -> None:
            for child in ast.iter_child_nodes(node):
                name = child.name if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) else function
                if isinstance(child, ast.Call) and any(kw.arg == keyword for kw in child.keywords):
                    found.add((path.name, name))
                visit(child, name)

        visit(tree, "<module>")
    return found


@pytest.mark.parametrize("keyword", sorted(DOORS))
def test_only_the_typed_boundary_submits_absence(keyword):
    assert _callers(keyword) == DOORS[keyword]


def test_the_guard_sees_a_call_it_must_refuse():
    """Negative control: the scanner finds keyword calls in a tree, nested functions included."""
    tree = ast.parse(
        "async def sneaky(client):\n"
        "    async def inner():\n"
        "        await client.reconcile_gdrive(x, complete_snapshot_ids=[])\n"
    )
    calls = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call) and any(kw.arg == "complete_snapshot_ids" for kw in node.keywords)
    ]
    assert len(calls) == 1


def test_the_complete_snapshot_door_refuses_an_unresolved_roster_before_any_request(tmp_path):
    state = StateStore(str(tmp_path / "door.sqlite"))
    state.bind_root("connection", 4, "file", "known", "my-drive")
    state.mark_root_unresolved("connection", 4, "file", "unknown", detail="selected root not found")
    sent = []

    class Client:
        async def reconcile_gdrive(self, execution, **kwargs):
            sent.append(kwargs)
            return {"items": 0}

    execution = GdriveExecution("connection", 4, 1, "owner", "later", "scope", {})
    options = {"file_ids": ["known", "unknown"], "selection_state": "selected"}
    with pytest.raises(IncompleteRootCoverage) as refused:
        asyncio.run(_submit_complete_snapshot(Client(), execution, state, options, [], reason="r"))
    assert refused.value.code == "root_coverage_incomplete"
    assert sent == []

    # A selected root with no obligation at all is unknown too.
    with pytest.raises(IncompleteRootCoverage):
        asyncio.run(_submit_complete_snapshot(
            Client(), execution, state, {"file_ids": ["known", "never-bound"]}, [], reason="r",
        ))
    assert sent == []

    # Resolved: the same door submits.
    state.bind_root("connection", 4, "file", "unknown", "shared-x")
    asyncio.run(_submit_complete_snapshot(Client(), execution, state, options, ["doc"], reason="r"))
    assert sent == [{"complete_snapshot_ids": ["doc"], "reason": "r"}]
    state.close()


def test_the_door_publishes_current_root_evidence_before_the_brain_judges_it(tmp_path):
    """The brain gates a complete snapshot on the root evidence it last acknowledged. When a root
    settled without any other checkpoint this run, the door republishes first — exactly once, before
    the reconcile — and does nothing extra when the acknowledged evidence is already current."""
    from aios_ingest.connector_state import roots_section
    from aios_ingest.state import StreamKey

    state = StateStore(str(tmp_path / "republish.sqlite"))
    state.begin_generation(StreamKey("team", "connection", "account", "my-drive"), 4, start_token="start")
    state.bind_root("connection", 4, "file", "f", "my-drive")
    events = []

    class Client:
        async def checkpoint_gdrive_execution(self, execution, payload):
            events.append(("checkpoint", payload["roots"]))
            return {"progress_revision": 2, "progress": payload}

        async def reconcile_gdrive(self, execution, **kwargs):
            events.append(("reconcile", kwargs["complete_snapshot_ids"]))
            return {"items": 0}

    stale = {"generation": 4, "items": [{"kind": "file", "id": "f", "status": "relocating",
                                          "drive_id": "my-drive", "pending_drive_id": "x", "detail": None}]}
    execution = GdriveExecution("connection", 4, 1, "owner", "later", "scope", {},
                                progress={"version": 2, "streams": {}, "roots": stale}, progress_revision=1)
    options = {"file_ids": ["f"], "selection_state": "selected"}
    asyncio.run(_submit_complete_snapshot(Client(), execution, state, options, ["doc"], reason="r"))

    current = roots_section(4, state.root_obligations("connection", 4))
    assert events == [("checkpoint", current), ("reconcile", ["doc"])]

    events.clear()
    asyncio.run(_submit_complete_snapshot(Client(), execution, state, options, ["doc"], reason="r"))
    assert events == [("reconcile", ["doc"])]
    state.close()
