"""Google Drive watch-channel provider calls (creation and stop) for the fenced lifecycle.

Drive push notifications use channels that expire (max ~1 week). The scheduler's renewal sweep
(``watch_renewal``) owns the whole lifecycle; this module only performs ONE bounded provider
request per call — :meth:`GoogleDriveWatchManager.dispatch` or ``stop`` — always from a
renewal-owned worker thread. There is no other creation path (AIO-1167 R41). Lazy-imports
google-api-python-client (the 'gdrive' extra). Requires credentials and a publicly reachable
webhook address (the FastAPI receiver's /webhooks/gdrive URL).
"""

from __future__ import annotations

import json
import time
from typing import Any

from ..watch_lifecycle import WatchNotDispatched, WatchRecord, WatchRefused, parse_instant
from .base import MissingExtraError

# Default bound for one provider request when the caller supplies no absolute deadline.
_REQUEST_SECONDS = 20.0


def _status_of(exc: Exception) -> int | None:
    response = getattr(exc, "resp", None)
    value = getattr(response, "status", None) or getattr(exc, "status_code", None)
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _remaining(deadline: float | None) -> float:
    if deadline is None:
        return _REQUEST_SECONDS
    return min(_REQUEST_SECONDS, deadline - time.monotonic())


class GoogleDriveWatchManager:
    def __init__(
        self,
        *,
        service_account_key_path: str | None = None,
        credential_json: str | dict | None = None,
        webhook_url: str,
        access_token: str | None = None,
        provider_gate=None,
        drive_id: str | None = None,
    ):
        # A creation's channel identity, cursor, expiry and verification token come from its
        # lifecycle record on each ``dispatch`` call — never from manager state.
        self._key_path = service_account_key_path
        self._credential_json = credential_json
        self._webhook_url = webhook_url
        self._access_token = access_token
        self._provider_gate = provider_gate
        self._drive_id = drive_id or "my-drive"

    def _service(self, deadline: float | None = None):
        """A Drive client whose every HTTP call — credential refresh included — is bounded.

        With ``deadline`` (a ``time.monotonic`` instant) the established deadline-aware transports
        of the Drive source are reused: a brokered OAuth token gets a timeout-bounded transport that
        never refreshes on its own, and a local service account gets the absolute-deadline
        transport, which bounds its credential refresh too.
        """
        try:
            from google.oauth2 import service_account  # type: ignore
            from google.oauth2.credentials import Credentials  # type: ignore
            from googleapiclient.discovery import build  # type: ignore
        except ImportError as e:  # pragma: no cover - requires the extra
            raise MissingExtraError("gdrive", "google-api-python-client") from e
        scopes = ["https://www.googleapis.com/auth/drive.readonly"]
        if self._access_token:
            creds = Credentials(token=self._access_token, scopes=scopes)
        elif self._key_path:
            creds = service_account.Credentials.from_service_account_file(self._key_path, scopes=scopes)
        else:
            raw = json.loads(self._credential_json) if isinstance(self._credential_json, str) else (self._credential_json or {})
            if raw.get("type") == "service_account":
                creds = service_account.Credentials.from_service_account_info(raw, scopes=scopes)
            else:
                raise ValueError("Google Drive watch credentials must be a local service account or brokered access token")
        if deadline is None:
            if self._provider_gate:
                self._provider_gate()
            return build("drive", "v3", credentials=creds, cache_discovery=False)
        from .gdrive import _broker_authorized_http, _credential_authorized_http
        timeout = max(0.1, _remaining(deadline))
        if self._access_token:
            http = _broker_authorized_http(creds, timeout_seconds=timeout)
        else:
            http = _credential_authorized_http(creds, timeout_seconds=timeout)
            http.http.set_deadline(deadline)
        return build("drive", "v3", http=http, cache_discovery=False)

    def dispatch(
        self, record: WatchRecord, *, page_token: str, verification_token: str,
        deadline: float | None = None,
    ) -> dict[str, Any]:
        """Send ONE creation request for exactly ``record``'s channel and return Google's answer.

        Runs in a worker thread (blocking I/O); it never touches local state and never publishes.
        Raises :class:`WatchNotDispatched` for every failure before the request is sent (client
        construction, credential refresh, the authority check made immediately before dispatch, an
        exhausted deadline) and :class:`WatchRefused` for a definitive provider refusal. Anything
        else — a timeout, a lost connection, a 5xx — leaves the outcome UNKNOWN and is raised as is.
        The request is never retried here: repeating ``watch`` is not an idempotent retry.
        """
        expiration = parse_instant(record.requested_expiry)
        if expiration is None:
            raise WatchNotDispatched("watch intent has no requested expiry")
        try:
            svc = self._service(deadline)
            kwargs: dict[str, Any] = {
                "pageToken": page_token,
                "body": {
                    "id": record.attempt_id,
                    "type": "web_hook",
                    "address": self._webhook_url,
                    "expiration": int(expiration.timestamp() * 1000),
                    "token": verification_token,
                },
            }
            if record.drive_id != "my-drive":
                kwargs.update(driveId=record.drive_id, supportsAllDrives=True)
            request = svc.changes().watch(**kwargs)
            # The live authority check, as close to the dispatch as it can be.
            if self._provider_gate:
                self._provider_gate()
            if deadline is not None and _remaining(deadline) <= 0:
                raise WatchNotDispatched("run deadline reached before the watch request was sent")
        except WatchNotDispatched:
            raise
        except Exception as exc:
            raise WatchNotDispatched(f"watch request not sent: {type(exc).__name__}") from exc
        try:
            return dict(request.execute(num_retries=0))
        except Exception as exc:
            status = _status_of(exc)
            if status is not None and 400 <= status < 500 and status != 408:
                raise WatchRefused(status) from exc
            raise

    def stop(self, channel_id: str, resource_id: str, *, deadline: float | None = None) -> None:
        """Stop one known channel. A channel the provider no longer knows (404) is already gone."""
        svc = self._service(deadline)
        request = svc.channels().stop(body={"id": channel_id, "resourceId": resource_id})
        if self._provider_gate:
            self._provider_gate()
        try:
            request.execute(num_retries=0)
        except Exception as exc:
            if _status_of(exc) == 404:
                return
            raise



class ConfiguredGoogleDriveWatchManager:
    """Production router that keeps credentials local and accepts brokered OAuth access tokens."""

    def __init__(self, connections):
        self._connections = {conn.name: conn for conn in connections if conn.source == "gdrive"}

    def _manager(self, connection: str, *, access_token=None, provider_gate=None,
                 drive_id: str | None = None) -> GoogleDriveWatchManager:
        conn = self._connections[connection]
        options = conn.options
        webhook_url = str(options.get("webhook_url") or "")
        if not webhook_url:
            raise ValueError(f"Google Drive connection {conn.name} has no webhook_url")
        return GoogleDriveWatchManager(
            service_account_key_path=options.get("service_account_key_path"),
            credential_json=options.get("credential_json"),
            access_token=access_token,
            provider_gate=provider_gate,
            drive_id=drive_id,
            webhook_url=webhook_url,
        )

    def ttl_seconds(self, connection: str) -> int:
        conn = self._connections.get(connection)
        return int((conn.options if conn else {}).get("watch_ttl_seconds") or 604_800)

    def dispatch(self, record: WatchRecord, *, page_token: str, verification_token: str,
                 access_token: str | None = None, provider_gate=None,
                 deadline: float | None = None) -> dict[str, Any]:
        try:
            manager = self._manager(
                record.connection, access_token=access_token, provider_gate=provider_gate,
                drive_id=record.drive_id,
            )
        except Exception as exc:
            raise WatchNotDispatched(f"watch manager unavailable: {type(exc).__name__}") from exc
        return manager.dispatch(
            record, page_token=page_token, verification_token=verification_token, deadline=deadline,
        )

    def stop(self, record: WatchRecord, resource_id: str, *, access_token: str | None = None,
             provider_gate=None, deadline: float | None = None) -> None:
        self._manager(
            record.connection, access_token=access_token, provider_gate=provider_gate,
            drive_id=record.drive_id,
        ).stop(record.attempt_id, resource_id, deadline=deadline)
