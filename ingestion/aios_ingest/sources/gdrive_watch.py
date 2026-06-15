"""Google Drive watch-channel manager (real renewal via the Drive API).

Drive push notifications use channels that expire (max ~1 week); the scheduler's renewal
sweep calls :meth:`renew` to open a fresh channel before the old one lapses. Lazy-imports
google-api-python-client (the 'gdrive' extra). Requires a service account and a publicly
reachable webhook address (the FastAPI receiver's /webhooks/gdrive URL).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from ..state import Channel
from .base import MissingExtraError


class GoogleDriveWatchManager:
    def __init__(self, *, service_account_key_path: str, webhook_url: str, ttl_seconds: int = 604_800):
        self._key_path = service_account_key_path
        self._webhook_url = webhook_url
        self._ttl = ttl_seconds

    def _service(self):
        try:
            from google.oauth2 import service_account  # type: ignore
            from googleapiclient.discovery import build  # type: ignore
        except ImportError as e:  # pragma: no cover - requires the extra
            raise MissingExtraError("gdrive", "google-api-python-client") from e
        creds = service_account.Credentials.from_service_account_file(
            self._key_path, scopes=["https://www.googleapis.com/auth/drive.readonly"]
        )
        return build("drive", "v3", credentials=creds, cache_discovery=False)

    def renew(self, channel: Channel) -> Channel:  # pragma: no cover - requires creds
        """Open a fresh changes-watch channel and return its bookkeeping record."""
        svc = self._service()
        new_id = str(uuid.uuid4())
        start_token = svc.changes().getStartPageToken().execute()["startPageToken"]
        expiration_ms = int(
            (datetime.now(timezone.utc).timestamp() + self._ttl) * 1000
        )
        svc.changes().watch(
            pageToken=start_token,
            body={
                "id": new_id,
                "type": "web_hook",
                "address": self._webhook_url,
                "expiration": expiration_ms,
            },
        ).execute()
        expires_iso = datetime.fromtimestamp(expiration_ms / 1000, tz=timezone.utc).isoformat()
        return Channel(
            connection=channel.connection,
            channel_id=new_id,
            resource_id=start_token,
            expires_at=expires_iso,
        )
