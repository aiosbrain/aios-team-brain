"""FastAPI webhook receiver.

`POST /webhooks/{source}` verifies the signature against a configured connection of that
source type, then fetches the affected resource and ingests it. Slack's url_verification
handshake is handled inline. Connections are loaded from $CONNECTIONS_YAML at startup.

Run: uvicorn aios_ingest.webhook_app:app --port 8088
"""

from __future__ import annotations

import os

from fastapi import FastAPI, Request, Response

from .config import BrainSettings, Connection, load_connections
from .engine import ingest_docs
from .sources import build_source
from .state import StateStore

app = FastAPI(title="aios-ingest webhooks")


def _connections_by_source() -> dict[str, list[Connection]]:
    path = os.environ.get("CONNECTIONS_YAML")
    if not path:
        return {}
    by_source: dict[str, list[Connection]] = {}
    for conn in load_connections(path):
        by_source.setdefault(conn.source, []).append(conn)
    return by_source


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/webhooks/{source}")
async def webhook(source: str, request: Request) -> Response:
    raw = await request.body()
    headers = {k.lower(): v for k, v in request.headers.items()}

    # Drive notifications are empty-body, header-only HINTS. Validate all persisted channel
    # identity before scheduling an idempotent poll; never fetch provider content in this request.
    if source == "gdrive":
        return _gdrive_notification(headers)

    # Slack Events API URL verification handshake.
    if source == "slack":
        try:
            probe = await _safe_json(raw)
            if probe.get("type") == "url_verification":
                return Response(content=probe.get("challenge", ""), media_type="text/plain")
        except ValueError:
            pass

    conns = _connections_by_source().get(source, [])
    if not conns:
        return Response(status_code=404, content=f"no connection configured for '{source}'")

    payload = await _safe_json(raw)
    settings = BrainSettings.from_env()

    for conn in conns:
        src = build_source(conn.source, conn.options)
        if not src.supports_webhook or not src.verify_webhook(headers, raw):
            continue
        docs = list(src.fetch_for_webhook(headers, payload))
        summary = await ingest_docs(settings, docs, conn.normalize_config(), conn.name)
        return Response(status_code=202, content=str(summary), media_type="text/plain")

    return Response(status_code=401, content="signature verification failed")


async def _safe_json(raw: bytes) -> dict:
    import json

    try:
        data = json.loads(raw or b"{}")
    except json.JSONDecodeError as e:
        raise ValueError("invalid JSON") from e
    return data if isinstance(data, dict) else {}


def _gdrive_notification(headers: dict[str, str]) -> Response:
    channel_id = headers.get("x-goog-channel-id")
    resource_id = headers.get("x-goog-resource-id")
    token = headers.get("x-goog-channel-token")
    if not channel_id or not resource_id:
        return Response(status_code=401, content="invalid Drive notification")
    state = StateStore(os.environ.get("AIOS_INGEST_STATE", "aios_ingest_state.sqlite"))
    try:
        channel = state.validate_notification(
            channel_id=channel_id, resource_id=resource_id, verification_token=token
        )
        if not channel:
            return Response(status_code=401, content="invalid Drive notification")
        if channel.namespace:
            progress = state.get_progress(channel.namespace)
            if progress:
                message_number = headers.get("x-goog-message-number", "unknown")
                state.enqueue_work(
                    channel.namespace,
                    progress.generation,
                    f"notification:{channel_id}:{message_number}",
                    "poll",
                    {"resource_state": headers.get("x-goog-resource-state", "")},
                )
        return Response(status_code=202, content="Drive poll scheduled")
    finally:
        state.close()
