"""Merge brain-side integration *selections* onto local source connections.

The brain stores per-team integration selections — which sources are enabled and
their NON-SECRET config (channel ids, repos, keywords). The sidecar holds the
secrets (tokens, signing secrets, api keys) locally in each connection's options.

F4 overlays the brain's selection onto the matching local connection by
``(type, name)`` so that an operator can change *what* a source ingests from the
brain's Admin → Integrations UI, while the *secret* needed to run it always stays
local. The brain rejects secret-like keys at write time, so a brain ``config`` can
never contain a secret — merging it can therefore never overwrite a local secret.

This module is pure (no I/O) so it is trivially testable.
"""

from __future__ import annotations

import dataclasses
import logging
from typing import Any, Callable

from .config import Connection

log = logging.getLogger(__name__)


def _translate_slack(config: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if "channelIds" in config:
        out["channel_ids"] = list(config["channelIds"])
    return out


def _no_op(config: dict[str, Any]) -> dict[str, Any]:
    # No consuming adapter field yet (linear teamId/projectId, plane, notion).
    # Translate to nothing so we never inject a key the adapter would reject.
    # Adapter wiring for these selection fields is future work.
    return {}


def _translate_gdrive(config: dict[str, Any]) -> dict[str, Any]:
    """Admin config → direct Docs adapter kwargs; credential options remain local."""
    return {
        "file_ids": list(config.get("fileIds") or []),
        "folder_ids": list(config.get("folderIds") or []),
        "shared_drive_ids": list(config.get("sharedDriveIds") or []),
        "recursive": bool(config.get("recursive", False)),
        "selection_state": config.get("selectionState", "absent"),
        "api_mode": "docs",
        "auth_mode": config.get("authMode", "oauth"),
        "service_account_status": config.get("serviceAccountStatus"),
        "credential_identity": config.get("authenticatedAccountId") or config.get("authenticatedAccount") or "",
    }


_GDRIVE_AUTHORITATIVE_KEYS = {
    "file_ids", "folder_id", "folder_ids", "shared_drive_ids", "recursive",
    "selection_state", "api_mode", "auth_mode", "credential_identity",
    "access_token", "granted_scopes", "project", "project_slug", "access",
    "service_account_status",
}


def effective_gdrive_connection(
    local: Connection,
    config: dict[str, Any],
    integration_id: str,
) -> Connection:
    """Build, rather than overlay, the one effective Drive connection for an execution.

    Selection/project/access/auth mode are brain-authoritative. Local configuration contributes only
    operational values and, in explicit service-account mode, compatible local credential material.
    """
    auth_mode = str(config.get("authMode") or "oauth")
    if auth_mode not in {"oauth", "service_account"}:
        raise ValueError(f"unsupported Google Drive authMode {auth_mode!r}")
    options = {key: value for key, value in local.options.items() if key not in _GDRIVE_AUTHORITATIVE_KEYS}
    options.update(_translate_gdrive(config))
    options["integration_id"] = integration_id
    options["auth_mode"] = auth_mode
    if auth_mode == "oauth":
        # Leftover local credentials must never override the server-side OAuth broker decision.
        options.pop("service_account_key_path", None)
        options.pop("credential_json", None)
    access = config.get("access") if config.get("access") in {"team", "external"} else "team"
    project = config.get("projectSlug") or None
    return dataclasses.replace(local, options=options, project=project, access=access)


# Dispatch by brain integration `type`. Defaults to a no-op so an unknown/unwired
# type never injects keys that would make build_source() raise TypeError.
_SELECTION_TRANSLATORS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "slack": _translate_slack,
    "linear": _no_op,
    "plane": _no_op,
    "notion": _no_op,
    "gdrive": _translate_gdrive,
}


def _translate(integration_type: str, config: dict[str, Any]) -> dict[str, Any]:
    translator = _SELECTION_TRANSLATORS.get(integration_type, _no_op)
    return translator(config or {})


def merge_selections(local: list[Connection], remote: list[dict]) -> list[Connection]:
    """Overlay brain selections onto local connections by ``(type, name)``.

    - For each local Connection, if a remote selection matches
      (``remote['type'] == conn.source`` and ``remote['name'] == conn.name``),
      produce a NEW Connection (``dataclasses.replace``) whose options are
      ``{**conn.options, **translated_selection}``. The translated selection maps
      the brain's camelCase config to the adapter's option keys; LOCAL SECRETS ARE
      PRESERVED because the brain config has no secret keys.
    - A matching remote ``status=disabled`` row suppresses the local connection (pause/disconnect)
      without deleting its local credential or durable cursor state.
    - Local connections with no matching remote selection are returned unchanged
      (backward compat).
    - Remote selections with no matching local connection are SKIPPED (no local
      secret → cannot run); they never become runnable connections.

    Order of returned connections follows ``local``. Input objects are not mutated.
    """
    # Index remote selections by (type, name) for O(1) lookup.
    by_key: dict[tuple[str, str], dict] = {}
    for sel in remote:
        key = (sel.get("type"), sel.get("name"))
        by_key[key] = sel

    merged: list[Connection] = []
    matched_keys: set[tuple[str, str]] = set()
    for conn in local:
        key = (conn.source, conn.name)
        sel = by_key.get(key)
        if sel is None:
            # No brain selection for this connection — leave it exactly as-is.
            merged.append(conn)
            continue
        matched_keys.add(key)
        if sel.get("status") == "disabled":
            log.info("brain selection %s/%s is paused or disconnected — skipped", *key)
            continue
        translated = _translate(conn.source, sel.get("config") or {})
        if conn.source == "gdrive":
            merged.append(effective_gdrive_connection(conn, sel.get("config") or {}, str(sel.get("id") or "")))
        else:
            merged.append(dataclasses.replace(conn, options={**conn.options, **translated}))

    # OAuth Drive credentials are delivered by the short-lived broker, so an Admin-created OAuth
    # integration is runnable without a duplicate local refresh secret. Other sources, and local
    # service-account Drive installations, continue to require a matching local connection.
    for sel in remote:
        key = (sel.get("type"), sel.get("name"))
        if key not in matched_keys:
            config = sel.get("config") or {}
            if (sel.get("type") == "gdrive" and sel.get("status") != "disabled"
                    and config.get("authMode", "oauth") == "oauth"):
                merged.append(effective_gdrive_connection(Connection(
                    name=sel.get("name"), source="gdrive", options={},
                    project=config.get("projectSlug"), access=config.get("access", "team"),
                ), config, str(sel.get("id") or "")))
                continue
            log.info(
                "brain selection %s/%s has no matching local connection — skipped "
                "(no local secret to run it)",
                sel.get("type"),
                sel.get("name"),
            )

    return merged
