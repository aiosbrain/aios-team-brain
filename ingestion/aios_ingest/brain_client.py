"""HTTP client for the brain's sync API.

The brain owns dedup, versioning, audit, and tier enforcement; this client just
authenticates and POSTs ItemPayloads, throttling under the 120 POST/min/key limit and
backing off on 429. It is the only thing in the sidecar that talks to the brain.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Literal

import httpx

from .payload import ItemPayload

IngestStatus = Literal["created", "updated", "unchanged"]

# Brain limit is 120/min/key; stay safely under it. Tokens refill continuously.
_DEFAULT_MAX_PER_MIN = 100
_MAX_RETRIES = 5


@dataclass(frozen=True)
class IngestResult:
    status: IngestStatus
    id: str
    path: str


class BrainError(RuntimeError):
    """Non-retryable brain rejection (4xx other than 429)."""

    def __init__(self, status_code: int, code: str, message: str):
        self.status_code = status_code
        self.code = code
        super().__init__(f"{status_code} {code}: {message}")


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

    async def __aenter__(self) -> "BrainClient":
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    async def push(self, item: ItemPayload) -> IngestResult:
        """POST one item. Retries on 429 (honoring backoff) and 5xx; raises BrainError
        on a definitive 4xx so a bad mapping fails loudly instead of silently dropping."""
        url = f"{self._base}/api/v1/items"
        body = item.to_json()
        for attempt in range(_MAX_RETRIES):
            await self._limiter.acquire()
            resp = await self._client.post(url, json=body, headers=self._headers)
            if resp.status_code in (200, 201):
                data = resp.json()
                return IngestResult(status=data["status"], id=data["id"], path=item.path)
            if resp.status_code == 429 or resp.status_code >= 500:
                backoff = _retry_after(resp) or min(2**attempt, 30)
                await asyncio.sleep(backoff)
                continue
            raise BrainError(resp.status_code, *_error_fields(resp))
        raise BrainError(429, "rate_limited", f"gave up after {_MAX_RETRIES} retries")


def _retry_after(resp: httpx.Response) -> float | None:
    raw = resp.headers.get("retry-after")
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def _error_fields(resp: httpx.Response) -> tuple[str, str]:
    try:
        err = resp.json().get("error", {})
        return err.get("code", "error"), err.get("message", resp.text[:200])
    except Exception:
        return "error", resp.text[:200]
