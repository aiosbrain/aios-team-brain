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
``account_hold``,                  the shared restriction owner    renewal's lifecycle checkpoints carry
``document_restrictions``,         (``gdrive_sync._publish_        them unchanged; the brain's
``retained_restrictions``          restriction_evidence``) —       scope/credential transition keeps
                                   provider minimums observed by   exactly these three
                                   the coordinator (R47 F5, R49
                                   F1, R50) or by renewal's watch
                                   calls (R51 final 3)
=================================  ==============================  ===================================

Renewal contributes a provider minimum only as an OBSERVATION through that same owner — journaled
locally, then published onto the latest acknowledged document under its own fence and revision,
monotonically (add or extend, never shorten or drop) — never as a separate watch hold, and never by
writing coordinator sections itself (AIO-1167 R51 final 3).

Provider minimums are bound to the verified account and the stable provider resource, never to a
selection generation (AIO-1167 R50): ``account_hold`` and ``document_restrictions`` hold the
publishing worker's OWN verified account, ``retained_restrictions`` carries every OTHER account's
standing evidence forward unchanged, so another account neither inherits nor erases it. The
generation recorded in a section is observation context only.

A legacy checkpoint kept renewal's fields inside each stream record (``watch_*``); the coordinator
carries those per stream too, so an upgrade cannot erase them either.

Merging arbitrary dictionaries would let any producer overwrite any field. These functions are the
whole contract: the coordinator builds its document with :func:`coordinator_document`, renewal with
:func:`renewal_document`, and neither can produce a document that drops the other's part.
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone
from typing import Any, Callable

from .state import ROOT_STATES, RootBinding, handoff_source_set

ROOTS_KEY = "roots"
# The coordinator's account-level provider hold (AIO-1167 R47 F5): ``{generation, credential,
# not_before, category}``. Published with the coordinator's checkpoints, so a sidecar that restores
# from the brain makes no provider call for that account before ``not_before``.
ACCOUNT_HOLD_KEY = "account_hold"
# Provider-named minimums for single documents (AIO-1167 R49 F1): ``{generation, credential,
# items: [{id, not_before, category, unrepresentable}]}``. The coordinator's, published with its
# checkpoints and restored before any provider read of a listed document.
DOCUMENT_RESTRICTIONS_KEY = "document_restrictions"
# Standing provider minimums of the connection's OTHER verified accounts (AIO-1167 R50):
# ``{credential: {account_hold?: {not_before, category}, items: [{id, not_before, category,
# unrepresentable}]}}``. Carried forward unchanged by a worker of another account.
RETAINED_RESTRICTIONS_KEY = "retained_restrictions"
RESTRICTION_KEYS = (ACCOUNT_HOLD_KEY, DOCUMENT_RESTRICTIONS_KEY, RETAINED_RESTRICTIONS_KEY)
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
                "handoff_sources": list(binding.handoff_sources),
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
            # The predecessor streams; an older checkpoint's scalar ``handoff_from`` is a one-drive set.
            handoff_source_set(item.get("handoff_sources"), item.get("handoff_from")),
        )
    return parsed


# -- provider-minimum evidence (AIO-1167 R50) ------------------------------------------------------
#
# Evidence is keyed by verified account (the sidecar's credential namespace) and, for a resource,
# by stable provider id: ``{credential: {"hold": (not_before, category) | None,
# "resources": {provider_id: (not_before, category, unrepresentable)}}}``. Every merge is
# monotonic — a later, shorter minimum never shortens a standing one — and an unrepresentable
# resource minimum stays unrepresentable: it is fail-closed, never an ordinary instant that lapses.

Hold = tuple[str, str]
Resource = tuple[str, str, bool]


def _moment(value: object) -> datetime | None:
    """An ISO instant for ordering, or ``None`` when it is not one (never guessed)."""
    if not isinstance(value, str) or not value:
        return None
    try:
        at = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return at if at.tzinfo is not None else at.replace(tzinfo=timezone.utc)


def merge_hold(held: Hold | None, other: Hold | None) -> Hold | None:
    """The later of two account holds."""
    if held is None:
        return other
    if other is None:
        return held
    current, candidate = _moment(held[0]), _moment(other[0])
    if candidate is not None and (current is None or candidate > current):
        return other
    return held


def merge_resource(held: Resource | None, other: Resource | None) -> Resource | None:
    """The stronger of two resource minimums: unrepresentable wins, then the later instant."""
    if held is None:
        return other
    if other is None:
        return held
    if held[2]:
        return held
    if other[2]:
        return other
    current, candidate = _moment(held[0]), _moment(other[0])
    if candidate is not None and (current is None or candidate > current):
        return other
    return held


def add_hold(evidence: dict[str, dict[str, Any]], credential: str, hold: Hold | None) -> None:
    """Merge one account hold into ``evidence`` (monotonic)."""
    if not credential or hold is None:
        return
    account = evidence.setdefault(credential, {"hold": None, "resources": {}})
    account["hold"] = merge_hold(account["hold"], hold)


def add_resource(
    evidence: dict[str, dict[str, Any]], credential: str, provider_id: str, resource: Resource | None,
) -> None:
    """Merge one resource minimum into ``evidence`` (monotonic, unrepresentable sticky)."""
    if not credential or not provider_id or resource is None:
        return
    account = evidence.setdefault(credential, {"hold": None, "resources": {}})
    account["resources"][provider_id] = merge_resource(account["resources"].get(provider_id), resource)


def _parse_items(items: object) -> list[tuple[str, Resource]]:
    parsed: list[tuple[str, Resource]] = []
    if not isinstance(items, list):
        return parsed
    for item in items:
        if not isinstance(item, dict):
            continue
        provider_id, not_before = item.get("id"), item.get("not_before")
        if not isinstance(provider_id, str) or not provider_id or _moment(not_before) is None:
            continue
        parsed.append((provider_id, (
            str(not_before), str(item.get("category") or "provider_unavailable"),
            item.get("unrepresentable") is True,
        )))
    return parsed


def _parse_hold(hold: object, default_credential: str | None = None) -> tuple[str, Hold] | None:
    if not isinstance(hold, dict):
        return None
    credential = hold.get("credential", default_credential)
    not_before = hold.get("not_before")
    if not isinstance(credential, str) or not credential or _moment(not_before) is None:
        return None
    return credential, (str(not_before), str(hold.get("category") or "rate_limited"))


def parse_restriction_evidence(document: object) -> dict[str, dict[str, Any]]:
    """Every provider minimum an acknowledged document holds, for every verified account.

    The generation a section names is observation context, not a lifetime: it is read but never
    used to discard evidence. Anything malformed is ignored, never guessed into a minimum.
    """
    evidence: dict[str, dict[str, Any]] = {}
    if not isinstance(document, dict):
        return evidence
    own_hold = _parse_hold(document.get(ACCOUNT_HOLD_KEY))
    if own_hold is not None:
        add_hold(evidence, *own_hold)
    section = document.get(DOCUMENT_RESTRICTIONS_KEY)
    if isinstance(section, dict) and isinstance(section.get("credential"), str) and section["credential"]:
        for provider_id, resource in _parse_items(section.get("items")):
            add_resource(evidence, section["credential"], provider_id, resource)
    retained = document.get(RETAINED_RESTRICTIONS_KEY)
    if isinstance(retained, dict):
        for credential, entry in retained.items():
            if not isinstance(credential, str) or not credential or not isinstance(entry, dict):
                continue
            hold = _parse_hold(entry.get(ACCOUNT_HOLD_KEY), credential)
            if hold is not None:
                add_hold(evidence, credential, hold[1])
            for provider_id, resource in _parse_items(entry.get("items")):
                add_resource(evidence, credential, provider_id, resource)
    return evidence


def restriction_sections(
    evidence: dict[str, dict[str, Any]],
    *,
    credential: str,
    generation: int,
    standing: Callable[[str, bool], bool],
) -> dict[str, Any]:
    """The three restriction sections a worker of ``credential`` publishes from ``evidence``.

    ``standing(not_before, unrepresentable)`` drops what has lapsed; an unrepresentable minimum
    never lapses. The worker's own account goes in ``account_hold`` / ``document_restrictions``
    (with this generation as context); every other account's standing evidence goes, unchanged, in
    ``retained_restrictions``. A key whose value is ``None`` is not published.
    """
    sections: dict[str, Any] = {key: None for key in RESTRICTION_KEYS}
    retained: dict[str, Any] = {}
    for account_id in sorted(evidence):
        account = evidence[account_id]
        hold = account.get("hold")
        if hold is not None and not standing(hold[0], False):
            hold = None
        items = [
            {"id": provider_id, "not_before": resource[0], "category": resource[1],
             "unrepresentable": resource[2]}
            for provider_id, resource in sorted((account.get("resources") or {}).items())
            if resource is not None and standing(resource[0], resource[2])
        ]
        if account_id == credential:
            if hold is not None:
                sections[ACCOUNT_HOLD_KEY] = {
                    "generation": int(generation), "credential": account_id,
                    "not_before": hold[0], "category": hold[1],
                }
            if items:
                sections[DOCUMENT_RESTRICTIONS_KEY] = {
                    "generation": int(generation), "credential": account_id, "items": items,
                }
        elif hold is not None or items:
            entry: dict[str, Any] = {"items": items}
            if hold is not None:
                entry[ACCOUNT_HOLD_KEY] = {"not_before": hold[0], "category": hold[1]}
            retained[account_id] = entry
    if retained:
        sections[RETAINED_RESTRICTIONS_KEY] = retained
    return sections


def apply_restriction_sections(document: dict[str, Any], sections: dict[str, Any]) -> None:
    """Write the three restriction sections into ``document``; a ``None`` section is removed."""
    for key in RESTRICTION_KEYS:
        value = sections.get(key)
        if value is None:
            document.pop(key, None)
        else:
            document[key] = copy.deepcopy(value)
