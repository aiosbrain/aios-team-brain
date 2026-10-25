"""The brain-fenced Drive connector-state document, and who owns which part of it (AIO-1167 R41).

One document per connection is the execution authority's progress record
(``gdrive_connection_authority.progress``): every write is fenced by generation, owner, fence and
progress revision, and the brain stores it opaquely. Several producers write it, so each part has
exactly ONE owner, and every other producer carries that part through unchanged:

=================================  ==============================  ===================================
Section                            Owner (sole writer)             Every other writer
=================================  ==============================  ===================================
``streams`` + top-level mirror     coordinator — cursor            renewal carries it unchanged; it may
                                   transitions (poll, manual,      not advance or reset a cursor
                                   notification runs)
``roots``                          coordinator — selected-root     renewal carries it unchanged
                                   obligations
``watches``                        renewal — channel lifecycle     the coordinator carries it unchanged;
                                   (intents, active, uncertain,    a poll may never erase an intent or
                                   cleanup, retired)               a terminal record
=================================  ==============================  ===================================

A legacy checkpoint kept renewal's fields inside each stream record (``watch_*``); the coordinator
carries those per stream too, so an upgrade cannot erase them either.

Merging arbitrary dictionaries would let any producer overwrite any field. These functions are the
whole contract: the coordinator builds its document with :func:`coordinator_document`, renewal with
:func:`renewal_document`, and neither can produce a document that drops the other's part.
"""

from __future__ import annotations

import copy
from typing import Any

from .state import ROOT_STATES, RootBinding

ROOTS_KEY = "roots"
WATCHES_KEY = "watches"
# Renewal's legacy per-stream fields. A stream record is otherwise the coordinator's alone.
RENEWAL_STREAM_PREFIX = "watch_"
# A diagnostic is for people; it is bounded so a pathological provider message cannot bloat the
# one authority document every run rewrites.
_DETAIL_LIMIT = 200


def _streams(document: dict[str, Any]) -> dict[str, dict[str, Any]]:
    streams = document.get("streams")
    if not isinstance(streams, dict):
        return {}
    return {str(key): value for key, value in streams.items() if isinstance(value, dict)}


def coordinator_document(previous: dict[str, Any], cursor_document: dict[str, Any]) -> dict[str, Any]:
    """The coordinator's checkpoint: its own cursor and root sections, plus renewal's, unchanged.

    ``cursor_document`` is what the coordinator owns (``version``, ``streams``, the top-level
    mirror, ``roots``). Renewal's ``watches`` section and its legacy per-stream ``watch_*`` fields
    are copied from ``previous`` — the last document the brain acknowledged — whatever
    ``cursor_document`` says about them: the coordinator cannot write them, so it cannot erase them.
    """
    document = copy.deepcopy(cursor_document)
    document.pop(WATCHES_KEY, None)
    if WATCHES_KEY in previous:
        document[WATCHES_KEY] = copy.deepcopy(previous[WATCHES_KEY])
    previous_streams = _streams(previous)
    for drive_id, stream in _streams(document).items():
        for key in [key for key in stream if key.startswith(RENEWAL_STREAM_PREFIX)]:
            del stream[key]
        for key, value in previous_streams.get(drive_id, {}).items():
            if key.startswith(RENEWAL_STREAM_PREFIX):
                stream[key] = copy.deepcopy(value)
    # The top-level mirror repeats the active stream for old readers, renewal fields included.
    for key in [key for key in document if key.startswith(RENEWAL_STREAM_PREFIX)]:
        del document[key]
    active = _streams(document).get(str(document.get("drive_id") or ""))
    if active is not None:
        for key, value in active.items():
            if key.startswith(RENEWAL_STREAM_PREFIX):
                document[key] = copy.deepcopy(value)
    return document


def renewal_document(previous: dict[str, Any], watches: dict[str, Any]) -> dict[str, Any]:
    """Renewal's checkpoint: the acknowledged document with ONLY the ``watches`` section replaced.

    Streams, cursors, the top-level mirror and root obligations are carried exactly as the brain
    holds them, so renewal can neither advance nor reset consumption progress.
    """
    document = copy.deepcopy(previous)
    document[WATCHES_KEY] = copy.deepcopy(watches)
    return document


def roots_section(
    generation: int, obligations: dict[tuple[str, str], RootBinding],
) -> dict[str, Any]:
    """Root-resolution evidence for the checkpoint: every obligation of ``generation``."""
    return {
        "generation": int(generation),
        "items": [
            {
                "kind": kind, "id": root_id, "status": binding.status,
                "drive_id": binding.drive_id or None,
                "pending_drive_id": binding.pending_drive_id,
                "detail": (binding.detail or "")[:_DETAIL_LIMIT] or None,
            }
            for (kind, root_id), binding in sorted(obligations.items())
        ],
    }


def parse_roots_section(document: dict[str, Any], generation: int) -> dict[tuple[str, str], RootBinding]:
    """The root obligations an acknowledged document holds for exactly ``generation``.

    Anything malformed, of another generation or in an unknown state is ignored — never guessed
    into a binding.
    """
    section = document.get(ROOTS_KEY)
    if not isinstance(section, dict):
        return {}
    try:
        if int(section.get("generation")) != int(generation):
            return {}
    except (TypeError, ValueError):
        return {}
    items = section.get("items")
    if not isinstance(items, list):
        return {}
    parsed: dict[tuple[str, str], RootBinding] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        kind, root_id, status = item.get("kind"), item.get("id"), item.get("status")
        if kind not in ("file", "folder") or not isinstance(root_id, str) or not root_id:
            continue
        if status not in ROOT_STATES:
            continue
        drive_id = item.get("drive_id")
        pending = item.get("pending_drive_id")
        detail = item.get("detail")
        parsed[(kind, root_id)] = RootBinding(
            str(drive_id) if isinstance(drive_id, str) else "",
            str(status),
            str(pending) if isinstance(pending, str) and pending else None,
            str(detail)[:_DETAIL_LIMIT] if isinstance(detail, str) else None,
        )
    return parsed
