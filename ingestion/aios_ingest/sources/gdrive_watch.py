"""Google Drive watch-channel manager (real renewal via the Drive API).

Drive push notifications use channels that expire (max ~1 week); the scheduler's renewal
sweep calls :meth:`renew` to open a fresh channel before the old one lapses. Lazy-imports
google-api-python-client (the 'gdrive' extra). Requires a service account and a publicly
reachable webhook address (the FastAPI receiver's /webhooks/gdrive URL).
"""

from __future__ import annotations

import uuid
import json
from datetime import datetime, timezone
import secrets

from ..state import Channel, verification_hash
from .base import MissingExtraError


class GoogleDriveWatchManager:
    def __init__(
        self,
        *,
        service_account_key_path: str | None = None,
        credential_json: str | dict | None = None,
        webhook_url: str,
        page_token: str,
        ttl_seconds: int = 604_800,
        verification_token: str | None = None,
        access_token: str | None = None,
        provider_gate=None,
        drive_id: str | None = None,
    ):
        self._key_path = service_account_key_path
        self._credential_json = credential_json
        self._webhook_url = webhook_url
        self._ttl = ttl_seconds
        self._page_token = page_token
        self._verification_token = verification_token or secrets.token_urlsafe(32)
        self._access_token = access_token
        self._provider_gate = provider_gate
        self._drive_id = drive_id or "my-drive"

    def _service(self):
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
        if self._provider_gate:
            self._provider_gate()
        return build("drive", "v3", credentials=creds, cache_discovery=False)

    def renew(
        self, channel: Channel, page_token: str | None = None,
        drive_id: str | None = None,
    ) -> Channel:  # pragma: no cover - requires creds
        """Open a fresh changes-watch channel and return its bookkeeping record."""
        svc = self._service()
        new_id = str(uuid.uuid4())
        expiration_ms = int(
            (datetime.now(timezone.utc).timestamp() + self._ttl) * 1000
        )
        if self._provider_gate:
            self._provider_gate()
        kwargs = {
            "pageToken": page_token or self._page_token,
            "body": {
                "id": new_id,
                "type": "web_hook",
                "address": self._webhook_url,
                "expiration": expiration_ms,
                "token": self._verification_token,
            },
        }
        authoritative_drive = drive_id or self._drive_id
        if authoritative_drive != "my-drive":
            kwargs.update(driveId=authoritative_drive, supportsAllDrives=True)
        response = svc.changes().watch(**kwargs).execute()
        actual_expiration = int(response.get("expiration") or expiration_ms)
        expires_iso = datetime.fromtimestamp(actual_expiration / 1000, tz=timezone.utc).isoformat()
        return Channel(
            connection=channel.connection,
            channel_id=str(response.get("id") or new_id),
            resource_id=response.get("resourceId"),
            expires_at=expires_iso,
            namespace=channel.namespace,
            verification_hash=verification_hash(self._verification_token),
        )


class ConfiguredGoogleDriveWatchManager:
    """Production router that keeps credentials local and accepts brokered OAuth access tokens."""

    def __init__(self, connections):
        self._connections = {conn.name: conn for conn in connections if conn.source == "gdrive"}

    def renew(self, channel: Channel, page_token: str | None = None,
              access_token: str | None = None, provider_gate=None,
              drive_id: str | None = None) -> Channel:
        conn = self._connections[channel.connection]
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
            page_token=page_token or "",
            ttl_seconds=int(options.get("watch_ttl_seconds") or 604_800),
        ).renew(channel, page_token, drive_id)
