"""HTTP client for the brain's sync API.

The brain owns dedup, versioning, audit, and tier enforcement; this client just
authenticates and POSTs ItemPayloads, throttling under the 120 POST/min/key limit and
backing off on 429. It is the only thing in the sidecar that talks to the brain.
"""

from __future__ import annotations

import asyncio
import math
import os
import random
import time
import uuid
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

import httpx

from .payload import ItemPayload

IngestStatus = Literal["created", "updated", "unchanged"]

# Brain limit is 120/min/key; stay safely under it. Tokens refill continuously.
_DEFAULT_MAX_PER_MIN = 100
_MAX_RETRIES = 5
_GDRIVE_CHECKPOINT_MAX_ATTEMPTS = 6
_GDRIVE_CHECKPOINT_DEADLINE_SECONDS = 45.0
# Provider ids one source-reconcile request may carry (the brain's GDRIVE_SNAPSHOT_PAGE_LIMIT).
_GDRIVE_SNAPSHOT_PAGE = 10_000
_SCAN_RATE_LIMIT_WINDOW_SECONDS = 60
# A codebase scan push is the heaviest single request: the brain projects every recent commit into
# searchable items (with embeddings) synchronously before responding, which can far exceed the 30s
# default. The scan runs in CI (latency-insensitive) and the endpoint is idempotent, so we give this
# one call a generous read timeout — otherwise the client raises httpx.ReadTimeout and the job goes
# RED even though the server finished the write. Override via AIOS_SCAN_TIMEOUT.
_SCAN_TIMEOUT = float(os.environ.get("AIOS_SCAN_TIMEOUT", "300"))


@dataclass(frozen=True)
class IngestResult:
    status: IngestStatus
    id: str
    path: str


@dataclass(frozen=True)
class GdriveExecution:
    integration_id: str
    generation: int
    fence: int
    owner: str
    lease_expires_at: str
    scope_hash: str
    config: dict[str, Any]
    progress: dict[str, Any] = field(default_factory=dict)
    progress_revision: int = 0


@dataclass(frozen=True)
class GdriveRunRequest:
    id: str
    integration_id: str
    name: str
    trigger: str
    created_at: str


class BrainError(RuntimeError):
    """Non-retryable brain rejection (4xx other than 429)."""

    def __init__(self, status_code: int, code: str, message: str):
        self.status_code = status_code
        self.code = code
        super().__init__(f"{status_code} {code}: {message}")


class GdriveProviderGate:
    """Synchronous live-authority assertion used immediately before Google client requests."""

    def __init__(self, base_url: str, headers: dict[str, str], execution: GdriveExecution):
        self._url = f"{base_url}/api/v1/integrations/gdrive/execution"
        self._headers = headers
        self._execution = execution
        self._client = httpx.Client(timeout=15.0)

    def __call__(self) -> None:
        execution = self._execution
        try:
            response = self._client.post(self._url, json={
                "action": "authorize_provider", "integration_id": execution.integration_id,
                "generation": execution.generation, "fence": execution.fence, "owner": execution.owner,
            }, headers=self._headers)
        except httpx.HTTPError as exc:
            # An unavailable authority service is not permission to continue with provider reads.
            raise BrainError(503, "authority_unavailable", "provider authority check failed") from exc
        if response.status_code != 200:
            raise BrainError(response.status_code, *_error_fields(response))

    def close(self) -> None:
        self._client.close()


class GdriveTokenProvider:
    """Memory-only broker grant with expiry-aware replacement under the same execution fence."""

    def __init__(
        self,
        base_url: str,
        headers: dict[str, str],
        execution: GdriveExecution,
        grant: dict[str, Any],
        *,
        refresh_margin_seconds: float = 60.0,
        now_fn: Callable[[], float] = time.time,
    ):
        self._url = f"{base_url}/api/v1/integrations/gdrive/token"
        self._headers = headers
        self._execution = execution
        self._refresh_margin = max(0.0, refresh_margin_seconds)
        self._now = now_fn
        self._client = httpx.Client(timeout=15.0)
        self._credentials: list[Any] = []
        config = execution.config
        account = grant.get("account") or {}
        self._expected_subject = str(config.get("authenticatedAccountId") or account.get("subject") or "")
        self._expected_email = str(config.get("authenticatedAccount") or account.get("email") or "").lower()
        configured_scopes = config.get("scopeSet") or []
        self._required_scopes = {str(scope) for scope in configured_scopes}
        self._token = ""
        self._expires_at = 0.0
        self._accept(grant)

    @staticmethod
    def _grant_expiry(value: Any) -> float:
        if not isinstance(value, str) or not value:
            raise BrainError(502, "invalid_token_grant", "broker returned no token expiry")
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise BrainError(502, "invalid_token_grant", "broker returned an invalid token expiry") from exc
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()

    def _accept(self, grant: dict[str, Any]) -> None:
        token = grant.get("access_token")
        account = grant.get("account") or {}
        subject = str(account.get("subject") or "")
        email = str(account.get("email") or "").lower()
        scopes = {str(scope) for scope in (grant.get("scopes") or [])}
        if not isinstance(token, str) or not token:
            raise BrainError(502, "invalid_token_grant", "broker returned no access token")
        if self._expected_subject and subject != self._expected_subject:
            raise BrainError(409, "credential_mismatch", "brokered Google account changed")
        if self._expected_email and email != self._expected_email:
            raise BrainError(409, "credential_mismatch", "brokered Google account changed")
        if self._required_scopes and not self._required_scopes.issubset(scopes):
            raise BrainError(409, "credential_mismatch", "brokered Google scopes changed")
        if not self._required_scopes:
            self._required_scopes = scopes
        self._token = token
        self._expires_at = self._grant_expiry(grant.get("expires_at"))
        for credential in self._credentials:
            credential.token = token

    def bind(self, credential: Any) -> None:
        self._credentials.append(credential)
        credential.token = self._token

    @property
    def scopes(self) -> list[str]:
        return sorted(self._required_scopes)

    @property
    def access_token(self) -> str:
        self.ensure_valid()
        return self._token

    def ensure_valid(self) -> None:
        if self._now() + self._refresh_margin >= self._expires_at:
            self.force_refresh()

    def force_refresh(self) -> None:
        execution = self._execution
        try:
            response = self._client.post(self._url, json={
                "integration_id": execution.integration_id,
                "generation": execution.generation,
                "fence": execution.fence,
                "owner": execution.owner,
            }, headers=self._headers)
        except httpx.HTTPError as exc:
            raise BrainError(503, "authority_unavailable", "token broker unavailable") from exc
        if response.status_code != 200:
            raise BrainError(response.status_code, *_error_fields(response))
        self._accept(dict(response.json()))

    def close(self) -> None:
        self._client.close()


class _RateLimiter:
    """Simple async token bucket so concurrent posts respect the per-minute cap."""

    def __init__(self, max_per_min: int):
        self._capacity = max_per_min
        self._tokens = float(max_per_min)
        self._refill_per_sec = max_per_min / 60.0
        self._last = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        while True:
            async with self._lock:
                now = time.monotonic()
                self._tokens = min(
                    self._capacity, self._tokens + (now - self._last) * self._refill_per_sec
                )
                self._last = now
                if self._tokens >= 1:
                    self._tokens -= 1
                    return
                wait = (1 - self._tokens) / self._refill_per_sec
            await asyncio.sleep(wait)


class BrainClient:
    """Async client. Use as an async context manager."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        team: str,
        *,
        max_per_min: int = _DEFAULT_MAX_PER_MIN,
        timeout: float = 30.0,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        random_fn: Callable[[], float] = random.random,
        monotonic_fn: Callable[[], float] = time.monotonic,
    ):
        if not api_key.startswith("aios_"):
            raise ValueError("api_key must look like aios_<key_id>_<secret>")
        self._base = base_url.rstrip("/")
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "X-AIOS-Team": team,
            "Content-Type": "application/json",
        }
        self._limiter = _RateLimiter(max_per_min)
        self._client = httpx.AsyncClient(timeout=timeout)
        self._sleep = sleep
        self._random = random_fn
        self._monotonic = monotonic_fn
        self._gdrive_progress_revisions: dict[tuple[str, int, int, str], int] = {}

    async def __aenter__(self) -> "BrainClient":
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    @staticmethod
    def _execution_headers(execution: GdriveExecution) -> dict[str, str]:
        return {
            "X-AIOS-Integration-Id": execution.integration_id,
            "X-AIOS-Execution-Generation": str(execution.generation),
            "X-AIOS-Execution-Fence": str(execution.fence),
            "X-AIOS-Execution-Owner": execution.owner,
        }

    async def push(self, item: ItemPayload, *, execution: GdriveExecution | None = None) -> IngestResult:
        """POST one item. Retries on 429 (honoring backoff) and 5xx; raises BrainError
        on a definitive 4xx so a bad mapping fails loudly instead of silently dropping."""
        url = f"{self._base}/api/v1/items"
        body = item.to_json()
        last_status = 503
        last_code = "retry_exhausted"
        last_message = "provider unavailable"
        for attempt in range(_MAX_RETRIES):
            await self._limiter.acquire()
            headers = {**self._headers, **(self._execution_headers(execution) if execution else {})}
            resp = await self._client.post(url, json=body, headers=headers)
            if resp.status_code in (200, 201):
                data = resp.json()
                return IngestResult(status=data["status"], id=data["id"], path=item.path)
            if resp.status_code == 429 or resp.status_code >= 500:
                last_status = resp.status_code
                last_code, last_message = _error_fields(resp)
                backoff = _retry_after(resp) or min(2**attempt, 30)
                await self._sleep(backoff + _bounded_jitter(self._random()))
                continue
            raise BrainError(resp.status_code, *_error_fields(resp))
        raise BrainError(last_status, last_code, f"{last_message}; gave up after {_MAX_RETRIES} attempts")

    async def fetch_integration_selections(self, *, include_disabled: bool = False) -> list[dict]:
        """GET /api/v1/integrations → the team's ENABLED integration selections
        (non-secret: type, name, config). Returns [] on 404 (older brain). Same auth
        headers as push(). Raises BrainError on a definitive 4xx (other than 404)."""
        url = f"{self._base}/api/v1/integrations"
        if include_disabled:
            url += "?include_disabled=1"
        for attempt in range(_MAX_RETRIES):
            await self._limiter.acquire()
            resp = await self._client.get(url, headers=self._headers)
            if resp.status_code == 200:
                return resp.json().get("integrations", [])
            if resp.status_code == 404:
                # Brain too old / route absent — backward-compat: no selections.
                return []
            if resp.status_code == 429 or resp.status_code >= 500:
                backoff = _retry_after(resp) or min(2**attempt, 30)
                await asyncio.sleep(backoff)
                continue
            raise BrainError(resp.status_code, *_error_fields(resp))
        raise BrainError(429, "rate_limited", f"gave up after {_MAX_RETRIES} retries")

    async def acquire_gdrive_execution(self, integration_id: str, owner: str) -> GdriveExecution:
        resp = await self._client.post(
            f"{self._base}/api/v1/integrations/gdrive/execution",
            json={"action": "acquire", "integration_id": integration_id, "owner": owner},
            headers=self._headers,
        )
        if resp.status_code != 200:
            raise BrainError(resp.status_code, *_error_fields(resp))
        data = resp.json()
        execution = GdriveExecution(
            integration_id=data["integration_id"], generation=int(data["generation"]),
            fence=int(data["fence"]), owner=data["owner"],
            lease_expires_at=data["lease_expires_at"], scope_hash=data["scope_hash"],
            config=dict(data.get("config") or {}),
            progress=dict(data.get("progress") or {}),
            progress_revision=int(data.get("progress_revision") or 0),
        )
        self._gdrive_progress_revisions[
            (execution.integration_id, execution.generation, execution.fence, execution.owner)
        ] = execution.progress_revision
        return execution

    async def claim_gdrive_run_request(self) -> GdriveRunRequest | None:
        resp = await self._client.get(
            f"{self._base}/api/v1/integrations/gdrive/runs", headers=self._headers,
        )
        if resp.status_code != 200:
            raise BrainError(resp.status_code, *_error_fields(resp))
        row = resp.json().get("request")
        if not isinstance(row, dict):
            return None
        return GdriveRunRequest(
            id=str(row["id"]), integration_id=str(row["integration_id"]),
            name=str(row["name"]), trigger=str(row["trigger"]), created_at=str(row["created_at"]),
        )

    async def complete_gdrive_run_request(
        self, request: GdriveRunRequest, summary: Any, *, status: str, error: str | None = None,
    ) -> None:
        payload = {
            "requestId": request.id, "status": status,
            "created": int(getattr(summary, "created", 0)),
            "updated": int(getattr(summary, "updated", 0)),
            "unchanged": int(getattr(summary, "unchanged", 0)),
            "removed": int(getattr(summary, "removed", 0)),
            "failed": int(getattr(summary, "failed", 0)),
            "skipped": int(getattr(summary, "skipped", 0)),
            "backlog": getattr(summary, "backlog", None),
            "cursorAgeSeconds": getattr(summary, "cursor_age_seconds", None),
            "authoritativeComplete": bool(getattr(summary, "authoritative_complete", False)),
        }
        # ``optional`` and ``nullable`` are different on the TS wire boundary. Omit absent error
        # instead of serializing JSON null, which previously turned a successful run into a 422.
        if error is not None:
            payload["error"] = error
        resp = await self._client.post(
            f"{self._base}/api/v1/integrations/gdrive/runs",
            json=payload,
            headers=self._headers,
        )
        if resp.status_code != 200:
            raise BrainError(resp.status_code, *_error_fields(resp))

    async def report_scheduled_gdrive_run(
        self, report_id: str, integration_id: str, started_at: str, summary: Any,
        *, status: str, error: str | None = None,
    ) -> None:
        payload = {
            "reportId": report_id, "integrationId": integration_id, "trigger": "scheduler",
            "startedAt": started_at, "status": status,
            "created": int(getattr(summary, "created", 0)),
            "updated": int(getattr(summary, "updated", 0)),
            "unchanged": int(getattr(summary, "unchanged", 0)),
            "removed": int(getattr(summary, "removed", 0)),
            "failed": int(getattr(summary, "failed", 0)),
            "skipped": int(getattr(summary, "skipped", 0)),
            "backlog": getattr(summary, "backlog", None),
            "cursorAgeSeconds": getattr(summary, "cursor_age_seconds", None),
            "authoritativeComplete": bool(getattr(summary, "authoritative_complete", False)),
        }
        if error is not None:
            payload["error"] = error
        resp = await self._client.post(
            f"{self._base}/api/v1/integrations/gdrive/runs", json=payload, headers=self._headers,
        )
        if resp.status_code != 200:
            raise BrainError(resp.status_code, *_error_fields(resp))

    async def checkpoint_gdrive_execution(
        self, execution: GdriveExecution, progress: dict[str, Any]
    ) -> dict[str, Any]:
        key = (execution.integration_id, execution.generation, execution.fence, execution.owner)
        revision = self._gdrive_progress_revisions.setdefault(key, execution.progress_revision)
        deadline = self._monotonic() + _GDRIVE_CHECKPOINT_DEADLINE_SECONDS
        last_response: httpx.Response | None = None
        for attempt in range(_GDRIVE_CHECKPOINT_MAX_ATTEMPTS):
            remaining_before_call = deadline - self._monotonic()
            if remaining_before_call <= 0:
                break
            resp = await self._client.post(
                f"{self._base}/api/v1/integrations/gdrive/execution",
                json={
                    "action": "checkpoint", "integration_id": execution.integration_id,
                    "generation": execution.generation, "fence": execution.fence,
                    "owner": execution.owner, "progress_revision": revision,
                    "progress": progress,
                },
                headers=self._headers,
                timeout=max(0.1, min(15.0, remaining_before_call)),
            )
            if resp.status_code == 200:
                result = dict(resp.json())
                self._gdrive_progress_revisions[key] = int(result.get("progress_revision") or revision)
                return result
            last_response = resp
            if resp.status_code != 429 and resp.status_code < 500:
                raise BrainError(resp.status_code, *_error_fields(resp))
            remaining = deadline - self._monotonic()
            if attempt + 1 >= _GDRIVE_CHECKPOINT_MAX_ATTEMPTS or remaining <= 0:
                break
            server_delay = _retry_after(resp)
            delay = server_delay if server_delay is not None else min(2**attempt, 8)
            delay = min(delay + _bounded_jitter(self._random()), remaining)
            if delay <= 0:
                break
            await self._sleep(delay)
        if last_response is None:
            raise BrainError(503, "checkpoint_deadline", "Google Drive checkpoint deadline expired")
        raise BrainError(last_response.status_code, *_error_fields(last_response))

    async def verify_gdrive_service_account(
        self, execution: GdriveExecution, identity: str,
    ) -> None:
        resp = await self._client.post(
            f"{self._base}/api/v1/integrations/gdrive/execution",
            json={
                "action": "verify_service_account", "integration_id": execution.integration_id,
                "generation": execution.generation, "fence": execution.fence,
                "owner": execution.owner, "identity": identity,
            },
            headers=self._headers,
        )
        if resp.status_code != 200:
            raise BrainError(resp.status_code, *_error_fields(resp))

    async def release_gdrive_execution(self, execution: GdriveExecution) -> None:
        resp = await self._client.post(
            f"{self._base}/api/v1/integrations/gdrive/execution",
            json={
                "action": "release", "integration_id": execution.integration_id,
                "generation": execution.generation, "fence": execution.fence,
                "owner": execution.owner,
            },
            headers=self._headers,
        )
        if resp.status_code not in (200, 409):
            raise BrainError(resp.status_code, *_error_fields(resp))

    async def broker_gdrive_access_token(self, execution: GdriveExecution) -> dict[str, Any]:
        resp = await self._client.post(
            f"{self._base}/api/v1/integrations/gdrive/token",
            json={
                "integration_id": execution.integration_id, "generation": execution.generation,
                "fence": execution.fence, "owner": execution.owner,
            },
            headers=self._headers,
        )
        if resp.status_code != 200:
            raise BrainError(resp.status_code, *_error_fields(resp))
        return dict(resp.json())

    def gdrive_provider_gate(self, execution: GdriveExecution) -> GdriveProviderGate:
        return GdriveProviderGate(self._base, self._headers, execution)

    def gdrive_token_provider(
        self, execution: GdriveExecution, grant: dict[str, Any], *, refresh_margin_seconds: float = 60.0
    ) -> GdriveTokenProvider:
        return GdriveTokenProvider(
            self._base, self._headers, execution, grant,
            refresh_margin_seconds=refresh_margin_seconds,
        )

    async def reconcile_gdrive(
        self,
        execution: GdriveExecution,
        *,
        removed_provider_ids: list[str] | None = None,
        complete_snapshot_ids: list[str] | None = None,
        reason: str,
    ) -> dict:
        """Route verified removals through the brain's shared ingest cleanup owner.

        A complete snapshot larger than one request is staged on the brain in pages that all name
        one snapshot; only the last page is marked complete, and it carries the removals and the
        snapshot's total so the brain applies the whole set atomically or not at all.
        """
        base: dict = {
            "source": "gdrive",
            "integration_id": execution.integration_id,
            "generation": execution.generation,
            "fence": execution.fence,
            "owner": execution.owner,
            "reason": reason,
        }
        removed = removed_provider_ids or []
        if complete_snapshot_ids is None:
            return await self._post_gdrive_reconcile({**base, "removed_provider_ids": removed})
        if len(complete_snapshot_ids) <= _GDRIVE_SNAPSHOT_PAGE:
            return await self._post_gdrive_reconcile({
                **base, "removed_provider_ids": removed,
                "snapshot": {"complete": True, "provider_ids": complete_snapshot_ids},
            })
        members = list(dict.fromkeys(complete_snapshot_ids))
        snapshot_id = str(uuid.uuid4())
        pages = [
            members[start:start + _GDRIVE_SNAPSHOT_PAGE]
            for start in range(0, len(members), _GDRIVE_SNAPSHOT_PAGE)
        ]
        for page in pages[:-1]:
            await self._post_gdrive_reconcile({
                **base, "removed_provider_ids": [],
                "snapshot": {"complete": False, "provider_ids": page, "snapshot_id": snapshot_id},
            })
        return await self._post_gdrive_reconcile({
            **base, "removed_provider_ids": removed,
            "snapshot": {
                "complete": True, "provider_ids": pages[-1],
                "snapshot_id": snapshot_id, "total": len(members),
            },
        })

    async def _post_gdrive_reconcile(self, body: dict) -> dict:
        url = f"{self._base}/api/v1/items/source-reconcile"
        last_status = 503
        last_code = "retry_exhausted"
        last_message = "provider unavailable"
        for attempt in range(_MAX_RETRIES):
            await self._limiter.acquire()
            resp = await self._client.post(url, json=body, headers=self._headers)
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code == 429 or resp.status_code >= 500:
                last_status = resp.status_code
                last_code, last_message = _error_fields(resp)
                backoff = _retry_after(resp) or min(2**attempt, 30)
                await self._sleep(backoff + _bounded_jitter(self._random()))
                continue
            raise BrainError(resp.status_code, *_error_fields(resp))
        raise BrainError(last_status, last_code, f"{last_message}; gave up after {_MAX_RETRIES} attempts")

    async def push_codebase_scan(self, payload: dict) -> dict:
        """POST one codebase scan (RAW metrics) to /api/v1/codebases. The brain computes
        scores, audits, and upserts idempotently. Uses the codebase-specific six-attempt
        fixed-window retry policy and a longer
        read timeout (_SCAN_TIMEOUT) because the server projects commits→items synchronously."""
        url = f"{self._base}/api/v1/codebases"
        for attempt in range(_MAX_RETRIES + 1):
            await self._limiter.acquire()
            resp = await self._client.post(url, json=payload, headers=self._headers, timeout=_SCAN_TIMEOUT)
            if resp.status_code in (200, 201):
                return resp.json()
            if resp.status_code == 429 or resp.status_code >= 500:
                if attempt == _MAX_RETRIES:
                    raise BrainError(resp.status_code, *_error_fields(resp))
                server_delay = _retry_after_delta_seconds(resp) if resp.status_code == 429 else None
                backoff = server_delay or min(2 ** (attempt + 1), 32)
                await self._sleep(backoff + _bounded_jitter(self._random()))
                continue
            raise BrainError(resp.status_code, *_error_fields(resp))
        raise AssertionError("unreachable retry loop")


def _retry_after_delta_seconds(resp: httpx.Response) -> int | None:
    raw = resp.headers.get("retry-after")
    if not raw or not raw.isascii() or not raw.isdecimal():
        return None
    seconds = int(raw)
    return seconds if 1 <= seconds <= _SCAN_RATE_LIMIT_WINDOW_SECONDS else None


def _bounded_jitter(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return min(1.0, max(0.0, value))


def _retry_after(resp: httpx.Response) -> float | None:
    raw = resp.headers.get("retry-after")
    if not raw:
        return None
    try:
        delay = float(raw)
        return delay if 0 < delay <= 3600 else None
    except ValueError:
        try:
            target = parsedate_to_datetime(raw)
            if target.tzinfo is None:
                target = target.replace(tzinfo=timezone.utc)
            delay = (target - datetime.now(timezone.utc)).total_seconds()
            return delay if 0 < delay <= 3600 else None
        except (TypeError, ValueError, OverflowError):
            return None


def _error_fields(resp: httpx.Response) -> tuple[str, str]:
    try:
        err = resp.json().get("error", {})
        return err.get("code", "error"), err.get("message", resp.text[:200])
    except Exception:
        return "error", resp.text[:200]
