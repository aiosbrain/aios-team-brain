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


def _translate_granola(config: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if "matchKeywords" in config:
        out["topics"] = list(config["matchKeywords"])
    if "participantEmails" in config:
        out["participants"] = list(config["participantEmails"])
    return out


def _no_op(config: dict[str, Any]) -> dict[str, Any]:
    # No consuming adapter field yet (linear teamId/projectId, plane, wise, notion).
    # Translate to nothing so we never inject a key the adapter would reject.
    # Adapter wiring for these selection fields is future work.
    return {}


# Dispatch by brain integration `type`. Defaults to a no-op so an unknown/unwired
# type never injects keys that would make build_source() raise TypeError.
_SELECTION_TRANSLATORS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "slack": _translate_slack,
    "granola": _translate_granola,
    "linear": _no_op,
    "plane": _no_op,
    "wise": _no_op,
    "notion": _no_op,
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
        translated = _translate(conn.source, sel.get("config") or {})
        new_options = {**conn.options, **translated}
        merged.append(dataclasses.replace(conn, options=new_options))

    # Report remote selections that had no local connection (cannot run — no secret).
    for sel in remote:
        key = (sel.get("type"), sel.get("name"))
        if key not in matched_keys:
            log.info(
                "brain selection %s/%s has no matching local connection — skipped "
                "(no local secret to run it)",
                sel.get("type"),
                sel.get("name"),
            )

    return merged
