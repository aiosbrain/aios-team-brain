import json
from datetime import datetime, timezone

import httpx
import pytest

from aios_ingest.brain_client import (
    BrainClient, BrainDeferred, BrainError, GdriveExecution, GdriveRunRequest,
)
from aios_ingest.engine import IngestSummary
from aios_ingest.payload import ItemPayload

ITEM = ItemPayload.build(project="p", path="github/o/r/x.md", kind="deliverable", body="b")


async def test_gdrive_completion_omits_absent_error_and_reports_explicit_outcome():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.update(json.loads(req.content))
        return httpx.Response(200, json={"ok": True})

    summary = IngestSummary(
        "drive", unchanged=2, skipped=1, authoritative_complete=True,
        backlog=0, cursor_age_seconds=12.5,
    )
    request = GdriveRunRequest(
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222", "drive", "manual", "now",
    )
    async with _client(httpx.MockTransport(handler)) as client:
        await client.complete_gdrive_run_request(request, summary, status="complete")

    assert "error" not in seen
    assert seen == {
        "requestId": request.id, "status": "complete", "created": 0, "updated": 0,
        "unchanged": 2, "removed": 0, "failed": 0, "skipped": 1,
        "backlog": 0, "cursorAgeSeconds": 12.5, "authoritativeComplete": True,
    }


def _client(transport: httpx.MockTransport) -> BrainClient:
    c = BrainClient("http://brain", "aios_abc_def", "demo", max_per_min=10_000)
    c._client = httpx.AsyncClient(transport=transport)  # inject mock transport
    return c


async def test_push_created_returns_status_and_id():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.headers["authorization"] == "Bearer aios_abc_def"
        assert req.headers["x-aios-team"] == "demo"
        return httpx.Response(201, json={"status": "created", "id": "item-1"})

    async with _client(httpx.MockTransport(handler)) as c:
        result = await c.push(ITEM)
    assert result.status == "created"
    assert result.id == "item-1"


async def test_push_retries_on_429_then_succeeds():
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"retry-after": "0"}, json={"error": {}})
        return httpx.Response(200, json={"status": "unchanged", "id": "item-2"})

    async with _client(httpx.MockTransport(handler)) as c:
        result = await c.push(ITEM)
    assert calls["n"] == 2
    assert result.status == "unchanged"


async def test_push_raises_brainerror_on_422():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"error": {"code": "forbidden_tier", "message": "nope"}})

    async with _client(httpx.MockTransport(handler)) as c:
        with pytest.raises(BrainError) as ei:
            await c.push(ITEM)
    assert ei.value.status_code == 422
    assert ei.value.code == "forbidden_tier"


def test_rejects_non_aios_key():
    with pytest.raises(ValueError):
        BrainClient("http://brain", "badkey", "demo")


async def test_fetch_integration_selections_parses_list_and_sends_auth():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.method == "GET"
        assert req.url.path == "/api/v1/integrations"
        assert req.headers["authorization"] == "Bearer aios_abc_def"
        assert req.headers["x-aios-team"] == "demo"
        return httpx.Response(
            200,
            json={
                "integrations": [
                    {
                        "id": "i1",
                        "type": "slack",
                        "name": "eng-slack",
                        "config": {"channelIds": ["C1"]},
                        "status": "enabled",
                    }
                ]
            },
        )

    async with _client(httpx.MockTransport(handler)) as c:
        sels = await c.fetch_integration_selections()
    assert len(sels) == 1
    assert sels[0]["type"] == "slack"
    assert sels[0]["config"]["channelIds"] == ["C1"]


async def test_fetch_integration_selections_returns_empty_on_404():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": {"code": "not_found", "message": "no route"}})

    async with _client(httpx.MockTransport(handler)) as c:
        sels = await c.fetch_integration_selections()
    assert sels == []


async def test_fetch_integration_selections_raises_on_definitive_4xx():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": {"code": "forbidden", "message": "nope"}})

    async with _client(httpx.MockTransport(handler)) as c:
        with pytest.raises(BrainError) as ei:
            await c.fetch_integration_selections()
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_gdrive_execution_then_broker_never_sends_or_persists_refresh_secret():
    seen = []

    def handler(request: httpx.Request):
        seen.append((request.url.path, request.content.decode()))
        if request.url.path.endswith("/execution"):
            return httpx.Response(200, json={
                "integration_id": "11111111-1111-1111-1111-111111111111",
                "generation": 7, "fence": 3,
                "owner": "22222222-2222-2222-2222-222222222222",
                "lease_expires_at": "2099-01-01T00:00:00Z", "scope_hash": "scope",
                "config": {"authMode": "oauth", "fileIds": ["DocA"]},
            })
        return httpx.Response(200, json={
            "access_token": "short-lived-access", "expires_at": "2099-01-01T00:00:00Z",
            "scopes": ["drive.file"],
            "account": {"subject": "subject:123", "email": "docs@example.com"},
        }, headers={"cache-control": "no-store"})

    async with _client(httpx.MockTransport(handler)) as c:
        execution = await c.acquire_gdrive_execution(
            "11111111-1111-1111-1111-111111111111",
            "22222222-2222-2222-2222-222222222222",
        )
        grant = await c.broker_gdrive_access_token(execution)
    assert grant["access_token"] == "short-lived-access"
    assert all("refresh" not in body and "client_secret" not in body for _, body in seen)


def test_gdrive_provider_gate_sends_complete_fence_and_fails_closed():
    execution = GdriveExecution(
        "11111111-1111-1111-1111-111111111111", 7, 3,
        "22222222-2222-2222-2222-222222222222", "later", "scope", {},
    )
    client = BrainClient("http://brain", "aios_abc_def", "demo")
    gate = client.gdrive_provider_gate(execution)
    seen = []

    def handler(request: httpx.Request):
        seen.append(request)
        return httpx.Response(409, json={
            "error": {"code": "stale_execution", "message": "replaced"},
        })

    gate._client.close()
    gate._client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(BrainError) as exc:
        gate()
    assert exc.value.code == "stale_execution"
    payload = json.loads(seen[0].content)
    assert payload == {
        "action": "authorize_provider",
        "integration_id": execution.integration_id,
        "generation": 7,
        "fence": 3,
        "owner": execution.owner,
    }
    assert seen[0].headers["authorization"] == "Bearer aios_abc_def"
    gate.close()


@pytest.mark.asyncio
async def test_gdrive_checkpoint_retries_429_with_revision_stable_and_retry_after():
    calls = []
    sleeps = []
    clock = [100.0]

    async def sleep(delay):
        sleeps.append(delay)
        clock[0] += delay

    def handler(request: httpx.Request):
        payload = json.loads(request.content)
        calls.append(payload)
        if len(calls) == 1:
            return httpx.Response(429, headers={"retry-after": "3"}, json={
                "error": {"code": "rate_limited", "message": "wait"},
            })
        return httpx.Response(200, json={
            "progress_revision": payload["progress_revision"] + 1,
            "progress": payload["progress"],
        })

    client = BrainClient(
        "http://brain", "aios_abc_def", "demo", sleep=sleep,
        random_fn=lambda: 0, monotonic_fn=lambda: clock[0],
    )
    await client._client.aclose()
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    execution = GdriveExecution(
        "11111111-1111-1111-1111-111111111111", 2, 4,
        "22222222-2222-2222-2222-222222222222", "later", "scope", {},
        progress_revision=9,
    )
    async with client:
        first = await client.checkpoint_gdrive_execution(execution, {"page_token": "next"})
        await client.checkpoint_gdrive_execution(execution, {"page_token": "terminal"})

    assert first["progress_revision"] == 10
    assert [call["progress_revision"] for call in calls] == [9, 9, 10]
    assert sleeps == [3.0]


@pytest.mark.asyncio
async def test_gdrive_checkpoint_retry_is_bounded_by_deadline():
    calls = 0
    sleeps = []
    clock = [100.0]

    async def sleep(delay):
        sleeps.append(delay)
        clock[0] += delay

    def handler(_request: httpx.Request):
        nonlocal calls
        calls += 1
        return httpx.Response(503, headers={"retry-after": "60"}, json={
            "error": {"code": "unavailable", "message": "down"},
        })

    client = BrainClient(
        "http://brain", "aios_abc_def", "demo", sleep=sleep,
        random_fn=lambda: 0, monotonic_fn=lambda: clock[0],
    )
    await client._client.aclose()
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    execution = GdriveExecution(
        "11111111-1111-1111-1111-111111111111", 2, 4,
        "22222222-2222-2222-2222-222222222222", "later", "scope", {},
    )
    async with client:
        with pytest.raises(BrainError) as exc:
            await client.checkpoint_gdrive_execution(execution, {"page_token": "next"})

    assert exc.value.code == "unavailable"
    assert calls == 1
    assert sleeps == [45.0]


def _scan_client(
    transport: httpx.MockTransport,
    sleeps: list[float],
    *,
    random_value: float = 0.0,
) -> BrainClient:
    async def sleep(delay: float) -> None:
        sleeps.append(delay)

    c = BrainClient(
        "http://brain",
        "aios_abc_def",
        "demo",
        max_per_min=10_000,
        sleep=sleep,
        random_fn=lambda: random_value,
    )
    c._client = httpx.AsyncClient(transport=transport)
    return c


async def test_codebase_scan_honors_valid_retry_after_then_succeeds():
    calls = 0
    sleeps: list[float] = []

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(
                429,
                headers={"retry-after": "17"},
                json={"error": {"code": "rate_limited", "message": "wait"}},
            )
        return httpx.Response(201, json={"status": "ok"})

    async with _scan_client(httpx.MockTransport(handler), sleeps, random_value=0.25) as c:
        result = await c.push_codebase_scan({"scan": "payload"})

    assert result == {"status": "ok"}
    assert calls == 2
    assert sleeps == [17.25]


@pytest.mark.parametrize(
    "retry_after",
    [None, "", "garbage", "-1", "0", "1.5", "NaN", "61", "600000"],
)
async def test_codebase_scan_invalid_or_missing_retry_after_uses_conservative_fallback(retry_after):
    calls = 0
    sleeps: list[float] = []

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls <= 5:
            headers = {} if retry_after is None else {"retry-after": retry_after}
            return httpx.Response(
                429,
                headers=headers,
                json={"error": {"code": "rate_limited", "message": "wait"}},
            )
        return httpx.Response(201, json={"status": "ok"})

    async with _scan_client(httpx.MockTransport(handler), sleeps) as c:
        result = await c.push_codebase_scan({"scan": "payload"})

    assert result == {"status": "ok"}
    assert calls == 6
    assert sleeps == [2, 4, 8, 16, 32]
    assert sum(sleeps) > 60


async def test_codebase_scan_adds_at_most_one_second_of_jitter_per_wait():
    calls = 0
    sleeps: list[float] = []

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls <= 2:
            return httpx.Response(429, json={"error": {"code": "rate_limited", "message": "wait"}})
        return httpx.Response(201, json={"status": "ok"})

    async with _scan_client(httpx.MockTransport(handler), sleeps, random_value=1.0) as c:
        await c.push_codebase_scan({"scan": "payload"})

    assert sleeps == [3, 5]


async def test_codebase_scan_persistent_429_caps_at_six_attempts_without_terminal_sleep():
    calls = 0
    sleeps: list[float] = []

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            429,
            headers={"retry-after": "7"},
            json={"error": {"code": "rate_limited", "message": "still limited"}},
        )

    async with _scan_client(httpx.MockTransport(handler), sleeps) as c:
        with pytest.raises(BrainError) as exc:
            await c.push_codebase_scan({"scan": "payload"})

    assert calls == 6
    assert sleeps == [7, 7, 7, 7, 7]
    assert exc.value.status_code == 429
    assert exc.value.code == "rate_limited"
    assert "still limited" in str(exc.value)


async def test_codebase_scan_terminal_5xx_keeps_actual_final_error_class():
    calls = 0
    sleeps: list[float] = []

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            503,
            json={"error": {"code": "upstream_unavailable", "message": "brain unavailable"}},
        )

    async with _scan_client(httpx.MockTransport(handler), sleeps) as c:
        with pytest.raises(BrainError) as exc:
            await c.push_codebase_scan({"scan": "payload"})

    assert calls == 6
    assert sleeps == [2, 4, 8, 16, 32]
    assert exc.value.status_code == 503
    assert exc.value.code == "upstream_unavailable"


async def test_codebase_scan_non_429_4xx_is_immediate_and_never_sleeps():
    calls = 0
    sleeps: list[float] = []

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            422,
            json={"error": {"code": "invalid_payload", "message": "bad scan"}},
        )

    async with _scan_client(httpx.MockTransport(handler), sleeps) as c:
        with pytest.raises(BrainError) as exc:
            await c.push_codebase_scan({"scan": "payload"})

    assert calls == 1
    assert sleeps == []
    assert exc.value.status_code == 422
    assert exc.value.code == "invalid_payload"


# ——— AUDITFIX-17 / AIO-1136, AC17-09: the two admission rejections reach the operator ———
#
# The brain now bounds POST /api/v1/codebases at 100 `metrics.recent_commits` (422) and
# 2,400,000 request bytes (413). Neither is transient: a retry of the identical scan fails
# identically, so retrying only delays the operator seeing a message they must act on.
#
# The scanner appends at most 20 recent commits (analyzers/codebase.py), so it cannot itself
# trip the count bound today — these cases are about what a caller DOES with the rejection, not
# about characterizing the scanner. A future scanner may widen its window inside the admitted
# 100 without touching this behaviour.
#
# These assert PRESERVED behaviour and are expected green at the AUDITFIX-17 baseline. Their job
# is to fail if the enforcement work, or a later retry-policy change, turns a diagnosis the
# operator needs into silent backoff — or drops the ceiling out of the message.

_COUNT_MESSAGE = (
    "metrics.recent_commits: at most 100 entries per scan; send a complete scan with a "
    "smaller recent-commit window; do not split a snapshot across pushes"
)
_BYTES_MESSAGE = (
    "body: at most 2400000 bytes per scan; reduce the scan payload and retry; do not split "
    "a snapshot across pushes"
)


@pytest.mark.parametrize(
    "status,code,message",
    [
        (422, "invalid_payload", _COUNT_MESSAGE),
        (413, "payload_too_large", _BYTES_MESSAGE),
    ],
)
async def test_codebase_scan_admission_rejection_surfaces_verbatim_without_retry(
    status, code, message
):
    calls = 0
    sleeps: list[float] = []

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(status, json={"error": {"code": code, "message": message}})

    async with _scan_client(httpx.MockTransport(handler), sleeps) as c:
        with pytest.raises(BrainError) as exc:
            await c.push_codebase_scan({"scan": "payload"})

    # One attempt, no backoff: the recovery is a smaller complete scan, not patience.
    assert calls == 1
    assert sleeps == []
    assert exc.value.status_code == status
    assert exc.value.code == code
    # The ceiling and the recovery must survive into what the operator reads. A BrainError that
    # says only "422" tells them nothing they can act on.
    assert message in str(exc.value)


async def test_codebase_scan_retry_behaviour_survives_the_new_admission_statuses():
    """A 413 must not join the retryable set that 429/5xx are in — and they must stay in it."""
    attempts: list[int] = []
    sleeps: list[float] = []

    def handler(req: httpx.Request) -> httpx.Response:
        attempts.append(len(attempts) + 1)
        if len(attempts) == 1:
            return httpx.Response(
                503, json={"error": {"code": "upstream_unavailable", "message": "down"}}
            )
        return httpx.Response(201, json={"status": "ok"})

    async with _scan_client(httpx.MockTransport(handler), sleeps) as c:
        assert await c.push_codebase_scan({"scan": "payload"}) == {"status": "ok"}

    assert len(attempts) == 2
    assert sleeps == [2]


_RECONCILE_EXECUTION = GdriveExecution(
    "11111111-1111-1111-1111-111111111111", 2, 4,
    "22222222-2222-2222-2222-222222222222", "later", "scope", {},
)


async def test_gdrive_snapshot_within_one_request_is_sent_whole():
    bodies: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(req.content))
        return httpx.Response(200, json={"items": 0})

    ids = [f"doc-{n}" for n in range(10_000)]
    async with _client(httpx.MockTransport(handler)) as c:
        await c.reconcile_gdrive(
            _RECONCILE_EXECUTION, complete_snapshot_ids=ids, reason="complete scope",
        )

    assert len(bodies) == 1
    assert bodies[0]["snapshot"] == {"complete": True, "provider_ids": ids}


async def test_gdrive_snapshot_above_one_request_is_staged_in_pages_and_finalized_once():
    """A selection of more than 10,000 documents must reconcile, not fail validation forever."""
    bodies: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/v1/items/source-reconcile"
        bodies.append(json.loads(req.content))
        return httpx.Response(200, json={"items": 3 if bodies[-1]["snapshot"]["complete"] else 0})

    ids = [f"doc-{n}" for n in range(25_001)]
    async with _client(httpx.MockTransport(handler)) as c:
        result = await c.reconcile_gdrive(
            _RECONCILE_EXECUTION, complete_snapshot_ids=ids, removed_provider_ids=["gone"],
            reason="complete scope",
        )

    assert result == {"items": 3}
    # The upload first asks what the brain already holds for this snapshot — nothing, here.
    inspection, *pages = bodies
    snapshots = [body["snapshot"] for body in pages]
    assert inspection["snapshot"] == {
        "complete": False, "provider_ids": [], "snapshot_id": snapshots[0]["snapshot_id"],
        "inspect": True,
    }
    assert inspection["removed_provider_ids"] == []
    # No request exceeds the brain's per-request bound, and together they are exactly the set.
    assert [len(s["provider_ids"]) for s in snapshots] == [10_000, 10_000, 5_001]
    assert [pid for s in snapshots for pid in s["provider_ids"]] == ids
    # Every page names the one snapshot, under the one execution.
    assert len({s["snapshot_id"] for s in snapshots}) == 1
    assert {(b["integration_id"], b["generation"], b["fence"], b["owner"]) for b in bodies} == {
        (_RECONCILE_EXECUTION.integration_id, 2, 4, _RECONCILE_EXECUTION.owner),
    }
    # Only the last page claims completeness; it alone states the total and carries the removals.
    assert [s["complete"] for s in snapshots] == [False, False, True]
    assert ["total" in s for s in snapshots] == [False, False, True]
    assert snapshots[-1]["total"] == 25_001
    assert [b["removed_provider_ids"] for b in pages] == [[], [], ["gone"]]
    # Nothing was held, so nothing is claimed as a continuation.
    assert not any("resume" in s for s in snapshots)


# ——— AIO-1167: a staged snapshot upload spans runs ———
#
# Spec. More than 10,000 selected documents reconcile through many requests against a route limited
# to 30 a minute, inside a run with an absolute deadline. So the upload must be able to stop between
# pages and continue in a LATER run, under a new execution fence, without starting over and without
# ever letting pages of two different memberships add up to one total:
#   · the snapshot is named from its own membership — the same after a restart, different for any
#     other membership;
#   · a continuation states exactly which prefix it believes is held (count + digest), and the
#     brain decides; a refusal means "stage it afresh", never "finalize anyway".

_STAGED_IDS = [f"doc-{n:05d}" for n in range(25_001)]


def _digest(ids):
    import hashlib

    return hashlib.sha256("\n".join(sorted(ids)).encode("utf-8")).hexdigest()


class _StagingBrain:
    """The reconcile route's staging rules, in memory, as a MockTransport handler.

    It holds one snapshot. A page under another name, or under another fence without a proof,
    replaces what is held; a proof is honoured only if it describes exactly what is held.
    """

    def __init__(self):
        self.name: str | None = None
        self.fence: int | None = None
        self.held: list[str] = []
        self.applied: list[str] | None = None
        self.bodies: list[dict] = []
        # Responses that pre-empt the rules, in order; and the route's rate limit, as a count of
        # admitted requests after which every further one is answered 429.
        self.scripted: list[httpx.Response] = []
        self.rate_limited_after: int | None = None

    def __call__(self, req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/v1/items/source-reconcile"
        body = json.loads(req.content)
        self.bodies.append(body)
        if self.scripted:
            return self.scripted.pop(0)
        if self.rate_limited_after is not None and len(self.bodies) > self.rate_limited_after:
            return httpx.Response(429, headers={"retry-after": "45"}, json={
                "error": {"code": "rate_limited", "message": "30 reconciliations/min per key"},
            })
        snapshot = body["snapshot"]
        held = self.held if snapshot["snapshot_id"] == self.name else []
        if snapshot.get("inspect"):
            return httpx.Response(200, json={"snapshotStaged": len(held)})
        resume = snapshot.get("resume")
        if resume is not None:
            if resume != {"members": len(held), "digest": _digest(held)}:
                return httpx.Response(409, json={
                    "error": {"code": "snapshot_resume_mismatch", "message": "not the expected membership"},
                })
        elif body["fence"] != self.fence:
            held = []
        self.name, self.fence = snapshot["snapshot_id"], body["fence"]
        self.held = [*held, *snapshot["provider_ids"]]
        if not snapshot["complete"]:
            return httpx.Response(200, json={"snapshotStaged": len(self.held)})
        if len(set(self.held)) != snapshot["total"]:
            return httpx.Response(409, json={
                "error": {"code": "snapshot_incomplete", "message": "short"},
            })
        self.applied, self.held, self.name = sorted(self.held), [], None
        return httpx.Response(200, json={"items": 1, "snapshotApplied": True})


def _execution(*, fence=4, generation=2, run_deadline=None) -> GdriveExecution:
    return GdriveExecution(
        "11111111-1111-1111-1111-111111111111", generation, fence,
        "22222222-2222-2222-2222-222222222222", "later", "scope", {},
        run_deadline=run_deadline,
    )


def _clocked_client(transport: httpx.MockTransport, *, max_per_min: int = 10_000):
    """A client on a fake clock: time passes only when the client itself sleeps."""
    sleeps: list[float] = []
    clock = [100.0]

    async def sleep(delay: float) -> None:
        sleeps.append(delay)
        clock[0] += delay

    c = BrainClient(
        "http://brain", "aios_abc_def", "demo", max_per_min=max_per_min,
        sleep=sleep, random_fn=lambda: 0, monotonic_fn=lambda: clock[0],
    )
    c._client = httpx.AsyncClient(transport=transport)
    return c, sleeps, clock


async def test_gdrive_snapshot_is_named_from_its_membership_and_keeps_that_name_across_restarts():
    names = []
    for ids, generation in (
        (_STAGED_IDS, 2), (list(reversed(_STAGED_IDS)), 2),      # the same membership, twice
        (_STAGED_IDS[:-1] + ["doc-other"], 2),                    # one document differs
        (_STAGED_IDS, 3),                                         # the scope generation differs
    ):
        brain = _StagingBrain()
        async with _client(httpx.MockTransport(brain)) as c:      # a fresh client: nothing remembered
            await c.reconcile_gdrive(
                _execution(generation=generation), complete_snapshot_ids=ids, reason="complete scope",
            )
        (name,) = {body["snapshot"]["snapshot_id"] for body in brain.bodies}
        names.append(name)

    assert names[0] == names[1]
    assert len({names[0], names[2], names[3]}) == 3


async def test_gdrive_staged_snapshot_deferred_by_the_route_limit_continues_in_the_next_run():
    brain = _StagingBrain()
    brain.rate_limited_after = 3  # the inspection and two pages are admitted; then the limit bites
    first, sleeps, _clock = _clocked_client(httpx.MockTransport(brain))

    async with first:
        with pytest.raises(BrainDeferred) as deferred:
            await first.reconcile_gdrive(
                _execution(fence=4, run_deadline=130.0), complete_snapshot_ids=_STAGED_IDS,
                reason="complete scope",
            )

    # 45 seconds of Retry-After do not fit the 30 the run has left: the call is neither slept on
    # nor retried, and it says when the route will admit it again.
    assert (deferred.value.status_code, deferred.value.code) == (429, "rate_limited")
    assert deferred.value.not_before is not None
    assert sleeps == []
    assert len(brain.bodies) == 4
    # Nothing was applied, and the two pages the brain admitted are still held.
    assert brain.applied is None and brain.held == _STAGED_IDS[:20_000]
    name = brain.name

    # The next run: a new client with nothing remembered, under the next fence.
    brain.rate_limited_after = None
    brain.bodies.clear()
    async with _client(httpx.MockTransport(brain)) as second:
        result = await second.reconcile_gdrive(
            _execution(fence=5), complete_snapshot_ids=_STAGED_IDS, removed_provider_ids=["gone"],
            reason="complete scope",
        )

    assert result == {"items": 1, "snapshotApplied": True}
    inspection, final = brain.bodies
    assert inspection["snapshot"] == {
        "complete": False, "provider_ids": [], "snapshot_id": name, "inspect": True,
    }
    # Only the page that was never staged is sent, with the proof of everything before it.
    assert final["snapshot"] == {
        "complete": True, "provider_ids": _STAGED_IDS[20_000:], "snapshot_id": name, "total": 25_001,
        "resume": {"members": 20_000, "digest": _digest(_STAGED_IDS[:20_000])},
    }
    assert final["removed_provider_ids"] == ["gone"] and final["fence"] == 5
    assert brain.applied == sorted(_STAGED_IDS)


async def test_gdrive_staged_snapshot_restarts_from_the_first_page_when_its_proof_is_refused():
    brain = _StagingBrain()
    # The brain reports one page held, but it is not this upload's first page.
    brain.scripted = [
        httpx.Response(200, json={"snapshotStaged": 10_000}),
        httpx.Response(409, json={
            "error": {"code": "snapshot_resume_mismatch", "message": "not the expected membership"},
        }),
    ]

    async with _client(httpx.MockTransport(brain)) as c:
        result = await c.reconcile_gdrive(
            _execution(fence=5), complete_snapshot_ids=_STAGED_IDS, reason="complete scope",
        )

    assert result == {"items": 1, "snapshotApplied": True}
    snapshots = [body["snapshot"] for body in brain.bodies]
    # The inspection, the refused continuation, then the whole upload from its first page.
    assert [len(s["provider_ids"]) for s in snapshots] == [0, 10_000, 10_000, 10_000, 5_001]
    assert snapshots[1]["provider_ids"] == _STAGED_IDS[10_000:20_000]
    assert snapshots[1]["resume"] == {"members": 10_000, "digest": _digest(_STAGED_IDS[:10_000])}
    assert [pid for s in snapshots[2:] for pid in s["provider_ids"]] == _STAGED_IDS
    assert not any("resume" in s for s in snapshots[2:])
    assert brain.applied == sorted(_STAGED_IDS)


@pytest.mark.parametrize("reported", [12_345, 25_001, 30_000])
async def test_gdrive_staged_snapshot_treats_a_held_count_that_is_not_its_prefix_as_nothing(reported):
    brain = _StagingBrain()
    brain.scripted = [httpx.Response(200, json={"snapshotStaged": reported})]

    async with _client(httpx.MockTransport(brain)) as c:
        await c.reconcile_gdrive(
            _execution(fence=5), complete_snapshot_ids=_STAGED_IDS, reason="complete scope",
        )

    snapshots = [body["snapshot"] for body in brain.bodies[1:]]
    assert [len(s["provider_ids"]) for s in snapshots] == [10_000, 10_000, 5_001]
    assert not any("resume" in s for s in snapshots)
    assert brain.applied == sorted(_STAGED_IDS)


# ——— AIO-1167: Drive sink and reconcile calls observe the run's absolute deadline ———
#
# Spec. A Drive run has one absolute deadline (it holds a fenced lease). The limiter wait, the
# request and every retry of a sink or reconcile call are bounded by it: a call that cannot fit is
# DEFERRED — raised as BrainDeferred, never slept through — and a deferral the brain timed carries
# that time. A caller with no deadline keeps the unbounded retry policy unchanged.


async def test_gdrive_reconcile_waits_out_a_retry_after_that_fits_the_run_deadline():
    calls = 0

    def handler(_req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(429, headers={"retry-after": "3"}, json={
                "error": {"code": "rate_limited", "message": "wait"},
            })
        return httpx.Response(200, json={"items": 1})

    client, sleeps, _clock = _clocked_client(httpx.MockTransport(handler))
    async with client:
        result = await client.reconcile_gdrive(
            _execution(run_deadline=130.0), removed_provider_ids=["gone"], reason="removal",
        )

    assert result == {"items": 1}
    assert calls == 2 and sleeps == [3.0]


async def test_gdrive_push_defers_instead_of_sleeping_past_the_run_deadline():
    calls = 0

    def handler(_req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(429, headers={"retry-after": "120"}, json={
            "error": {"code": "rate_limited", "message": "wait"},
        })

    client, sleeps, _clock = _clocked_client(httpx.MockTransport(handler))
    before = datetime.now(timezone.utc)
    async with client:
        with pytest.raises(BrainDeferred) as deferred:
            await client.push(ITEM, execution=_execution(run_deadline=130.0))

    assert calls == 1 and sleeps == []
    assert (deferred.value.status_code, deferred.value.code) == (429, "rate_limited")
    # The time the brain named survives into the deferral, for the durable retry time.
    retry_at = datetime.fromisoformat(deferred.value.not_before)
    assert 119 <= (retry_at - before).total_seconds() <= 125


async def test_gdrive_push_after_the_run_deadline_sends_nothing():
    calls = 0

    def handler(_req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(201, json={"status": "created", "id": "item-1"})

    client, sleeps, _clock = _clocked_client(httpx.MockTransport(handler))
    async with client:
        with pytest.raises(BrainDeferred) as deferred:
            await client.push(ITEM, execution=_execution(run_deadline=100.0))  # the clock reads 100

    assert calls == 0 and sleeps == []
    assert deferred.value.code == "run_deadline" and deferred.value.not_before is None


async def test_gdrive_limiter_wait_cannot_outlive_the_run_deadline():
    calls = 0

    def handler(_req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(201, json={"status": "created", "id": "item-1"})

    # One token a second, and the bucket is empty: the next token is a full second away.
    client, sleeps, _clock = _clocked_client(httpx.MockTransport(handler), max_per_min=60)
    client._limiter._tokens = 0.0
    async with client:
        with pytest.raises(BrainDeferred) as deferred:
            await client.push(ITEM, execution=_execution(run_deadline=100.5))  # half a second left

    assert calls == 0 and sleeps == []
    assert deferred.value.code == "run_deadline" and deferred.value.not_before is None


async def test_gdrive_limiter_wait_that_fits_the_run_deadline_is_honoured():
    calls = 0

    def handler(_req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(201, json={"status": "created", "id": "item-1"})

    client, sleeps, clock = _clocked_client(httpx.MockTransport(handler), max_per_min=60)
    client._limiter._tokens = 0.0
    async with client:
        result = await client.push(ITEM, execution=_execution(run_deadline=130.0))

    assert result.status == "created"
    assert calls == 1 and sleeps == [1.0] and clock[0] == 101.0


async def test_gdrive_request_that_times_out_under_the_run_deadline_is_a_classified_failed_attempt():
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("the brain did not answer", request=req)

    client, sleeps, _clock = _clocked_client(httpx.MockTransport(handler))
    async with client:
        with pytest.raises(BrainError) as failed:
            await client.push(ITEM, execution=_execution(run_deadline=130.0))

    # Sent and unanswered: a real attempt that failed — not a raw transport exception that ends
    # the run, and not a deferral that would leave the document untouched at the head of the queue.
    assert (failed.value.status_code, failed.value.code) == (504, "brain_timeout")
    assert not isinstance(failed.value, BrainDeferred)
    assert sleeps == []


async def test_gdrive_retries_exhausted_inside_a_deadline_stay_an_ordinary_failure():
    calls = 0

    def handler(_req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(503, json={"error": {"code": "upstream_unavailable", "message": "down"}})

    client, sleeps, _clock = _clocked_client(httpx.MockTransport(handler))
    async with client:
        with pytest.raises(BrainError) as failed:
            await client.reconcile_gdrive(
                _execution(run_deadline=10_000.0), removed_provider_ids=["gone"], reason="removal",
            )

    # Every wait fitted the deadline, so the deadline deferred nothing: the brain really was down.
    assert calls == 5 and sleeps == [1, 2, 4, 8, 16]
    assert (failed.value.status_code, failed.value.code) == (503, "upstream_unavailable")
    assert not isinstance(failed.value, BrainDeferred)


async def test_gdrive_backoff_that_would_cross_the_run_deadline_is_deferred_mid_retry():
    calls = 0

    def handler(_req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(503, json={"error": {"code": "upstream_unavailable", "message": "down"}})

    client, sleeps, clock = _clocked_client(httpx.MockTransport(handler))
    async with client:
        with pytest.raises(BrainDeferred) as deferred:
            # Six seconds: the 1s and 2s backoffs fit (103), the 4s one would end at 107.
            await client.reconcile_gdrive(
                _execution(run_deadline=106.0), removed_provider_ids=["gone"], reason="removal",
            )

    assert calls == 3 and sleeps == [1, 2] and clock[0] == 103.0
    assert (deferred.value.status_code, deferred.value.code) == (503, "upstream_unavailable")
    assert deferred.value.not_before is not None


async def test_gdrive_reconcile_without_a_deadline_keeps_the_unbounded_retry_policy():
    calls = 0

    def handler(_req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(429, headers={"retry-after": "120"}, json={
                "error": {"code": "rate_limited", "message": "wait"},
            })
        return httpx.Response(200, json={"items": 1})

    client, sleeps, _clock = _clocked_client(httpx.MockTransport(handler))
    async with client:
        result = await client.reconcile_gdrive(
            _execution(), removed_provider_ids=["gone"], reason="removal",
        )

    assert result == {"items": 1}
    assert calls == 2 and sleeps == [120.0]
