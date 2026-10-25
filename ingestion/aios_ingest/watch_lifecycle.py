"""Google Drive watch-channel lifecycle: one typed record per creation attempt (AIO-1167 R41).

Creating a channel is a NON-TRANSACTIONAL external call: Google may create a channel even when its
response is lost, the request times out, the worker is cancelled after dispatch, or the result can
no longer be published. So a channel's life is recorded as durable states, starting BEFORE the call:

    prepared ──► dispatched ──► active ──► (expired | cleanup_pending ──► retired | expired)
        │             │  ╲
        │             │   ╲─► uncertain ──► cleanup_pending ──► retired | expired
        │             │                └─► expired
        ▼             ▼
     retired       retired (definitive provider refusal)  |  cleanup_pending (invalid response)

* ``prepared`` — the intent: attempt/channel identity, connection/account/drive/generation,
  predecessor, verification HASH and requested expiry are durable; nothing has been sent.
* ``dispatched`` — durably marked immediately before the provider call, under the execution fence.
  From here a channel MAY exist at Google.
* ``active`` — the response named this attempt's channel, a resource id and a valid expiration, and
  that was published under the fence. Only active channels are accepted for notifications.
* ``uncertain`` — the outcome is unknown (lost response, timeout, cancellation, failed publication):
  the channel may exist. Polling covers the stream meanwhile; the record is kept until it can be
  stopped (once its resource id is known) or until its requested expiry — the defensible bound of
  its life, since Google never extends a channel past what was requested.
* ``cleanup_pending`` — a channel known to exist (id + resource id) that must be stopped.
* ``retired`` / ``expired`` — terminal. A terminal record is never reopened.

Raw verification tokens and credentials never enter a record: only the token's hash, which is what
notification validation needs. Records live in the renewal-owned ``watches`` section of the
brain-fenced connector state (``connector_state``); the local ``webhook_channels`` rows are a
recoverable projection of them plus webhook observations (early notifications, late responses),
which are cleanup EVIDENCE, never activation.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

PREPARED = "prepared"
DISPATCHED = "dispatched"
ACTIVE = "active"
UNCERTAIN = "uncertain"
CLEANUP_PENDING = "cleanup_pending"
RETIRED = "retired"
EXPIRED = "expired"

WATCH_STATES = frozenset({PREPARED, DISPATCHED, ACTIVE, UNCERTAIN, CLEANUP_PENDING, RETIRED, EXPIRED})
TERMINAL_STATES = frozenset({RETIRED, EXPIRED})
# States in which a channel may exist at Google without being accepted for notifications.
PENDING_STATES = frozenset({PREPARED, DISPATCHED, UNCERTAIN})

_TRANSITIONS: dict[str, frozenset[str]] = {
    # Abandoned before its dispatch marker: nothing was ever sent.
    PREPARED: frozenset({DISPATCHED, RETIRED}),
    # RETIRED only for a definitive provider refusal (nothing created) or a step that provably
    # never started; CLEANUP_PENDING for a channel that exists but cannot be activated.
    DISPATCHED: frozenset({ACTIVE, UNCERTAIN, CLEANUP_PENDING, RETIRED}),
    UNCERTAIN: frozenset({CLEANUP_PENDING, EXPIRED}),
    ACTIVE: frozenset({CLEANUP_PENDING, EXPIRED, RETIRED}),
    CLEANUP_PENDING: frozenset({RETIRED, EXPIRED}),
    RETIRED: frozenset(),
    EXPIRED: frozenset(),
}

# A provider expiration more than this past the requested one is not a channel this attempt asked
# for; Google may shorten a channel's life but never lengthens it.
_EXPIRY_SLACK = timedelta(seconds=60)
_DETAIL_LIMIT = 200
# Terminal records kept per connection after pruning; the rest are no longer evidence of anything.
_TERMINAL_KEPT = 20


class InvalidWatchTransition(ValueError):
    """A lifecycle change the state machine does not allow (e.g. reopening a terminal record)."""


class WatchNotDispatched(RuntimeError):
    """A creation step failed BEFORE the provider call was sent: no channel can exist from it."""


class WatchRefused(RuntimeError):
    """The provider answered the creation request with a definitive refusal: nothing was created."""

    def __init__(self, status: int, message: str = "watch request refused"):
        super().__init__(f"{message} ({status})")
        self.status = status


class InvalidWatchResponse(ValueError):
    """A creation response that does not name exactly the channel this attempt asked for.

    ``resource_id`` is kept when the response carried one: the channel then exists and can be
    stopped, but is never activated.
    """

    def __init__(self, reason: str, resource_id: str | None = None):
        super().__init__(reason)
        self.reason = reason
        self.resource_id = resource_id


@dataclass(frozen=True)
class WatchRecord:
    attempt_id: str  # also the channel id sent to Google: one attempt, one identity
    connection: str
    integration_id: str
    account_id: str
    drive_id: str
    generation: int
    namespace: str
    verification_hash: str
    requested_expiry: str
    state: str = PREPARED
    predecessor: str | None = None
    resource_id: str | None = None
    expires_at: str | None = None  # the PROVIDER's expiration, set only on activation
    detail: str | None = None
    updated_at: str | None = None
    stop_attempts: int = 0

    @property
    def terminal(self) -> bool:
        return self.state in TERMINAL_STATES

    def life_bound(self) -> str:
        """The latest instant this channel can be alive: the provider's expiry once known, else the
        requested one."""
        return self.expires_at or self.requested_expiry


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_instant(value: str | None) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def transition(record: WatchRecord, state: str, **changes: Any) -> WatchRecord:
    """The one way a record changes state. A terminal record is never reopened."""
    if state not in WATCH_STATES:
        raise InvalidWatchTransition(f"unknown watch state {state!r}")
    if state not in _TRANSITIONS[record.state]:
        raise InvalidWatchTransition(f"watch {record.attempt_id}: {record.state} -> {state} not allowed")
    detail = changes.pop("detail", record.detail)
    return dataclasses.replace(
        record, state=state, updated_at=now_iso(),
        detail=(str(detail)[:_DETAIL_LIMIT] if detail else None), **changes,
    )


def validate_watch_response(
    record: WatchRecord, response: Any, *, now: datetime | None = None,
) -> tuple[str, str]:
    """``(resource_id, expires_at_iso)`` for a response naming exactly this attempt's channel.

    No optimistic defaults: a missing id, resource id or expiration is not filled in from the
    request. A response naming another channel, or an expiration already past or beyond what was
    requested, is invalid.
    """
    if not isinstance(response, dict):
        raise InvalidWatchResponse("watch response is not an object")
    resource_id = response.get("resourceId")
    resource_id = str(resource_id) if isinstance(resource_id, str) and resource_id else None
    if str(response.get("id") or "") != record.attempt_id:
        raise InvalidWatchResponse("watch response names another channel", resource_id)
    if resource_id is None:
        raise InvalidWatchResponse("watch response has no resource id")
    raw = response.get("expiration")
    try:
        expiration_ms = int(str(raw))
    except (TypeError, ValueError):
        raise InvalidWatchResponse("watch response has no valid expiration", resource_id) from None
    expires = datetime.fromtimestamp(expiration_ms / 1000, tz=timezone.utc)
    current = now or datetime.now(timezone.utc)
    requested = parse_instant(record.requested_expiry)
    if expires <= current:
        raise InvalidWatchResponse("watch response expiration is already past", resource_id)
    if requested is None or expires > requested + _EXPIRY_SLACK:
        raise InvalidWatchResponse("watch response expiration exceeds the requested one", resource_id)
    return resource_id, expires.isoformat()


def requested_expiry(ttl_seconds: int, *, now: datetime | None = None) -> str:
    return ((now or datetime.now(timezone.utc)) + timedelta(seconds=max(60, int(ttl_seconds)))).isoformat()


def to_section(records: dict[str, WatchRecord]) -> dict[str, Any]:
    """The renewal-owned ``watches`` section: every record, terminal ones pruned to a bounded tail."""
    kept = _prune(records)
    return {
        "version": 1,
        "records": [dataclasses.asdict(record) for _attempt, record in sorted(kept.items())],
    }


def from_section(document: dict[str, Any]) -> dict[str, WatchRecord]:
    """The records an acknowledged connector-state document holds. Malformed ones are ignored."""
    section = document.get("watches")
    if not isinstance(section, dict) or not isinstance(section.get("records"), list):
        return {}
    fields = {field.name for field in dataclasses.fields(WatchRecord)}
    records: dict[str, WatchRecord] = {}
    for raw in section["records"]:
        if not isinstance(raw, dict):
            continue
        values = {key: raw.get(key) for key in fields if key in raw}
        if values.get("state") not in WATCH_STATES:
            continue
        try:
            record = WatchRecord(
                attempt_id=str(values["attempt_id"]), connection=str(values["connection"]),
                integration_id=str(values["integration_id"]), account_id=str(values["account_id"]),
                drive_id=str(values["drive_id"]), generation=int(values["generation"]),
                namespace=str(values["namespace"]), verification_hash=str(values["verification_hash"]),
                requested_expiry=str(values["requested_expiry"]), state=str(values["state"]),
                predecessor=_optional(values.get("predecessor")),
                resource_id=_optional(values.get("resource_id")),
                expires_at=_optional(values.get("expires_at")),
                detail=_optional(values.get("detail")),
                updated_at=_optional(values.get("updated_at")),
                stop_attempts=int(values.get("stop_attempts") or 0),
            )
        except (KeyError, TypeError, ValueError):
            continue
        if record.attempt_id:
            records[record.attempt_id] = record
    return records


def _optional(value: Any) -> str | None:
    return str(value) if isinstance(value, (str, int)) and str(value) else None


def _prune(records: dict[str, WatchRecord]) -> dict[str, WatchRecord]:
    live = {key: record for key, record in records.items() if not record.terminal}
    terminal = sorted(
        (record for record in records.values() if record.terminal),
        key=lambda record: (record.updated_at or "", record.attempt_id), reverse=True,
    )
    kept_terminal: dict[str, WatchRecord] = {}
    per_connection: dict[str, int] = {}
    for record in terminal:
        if per_connection.get(record.connection, 0) >= _TERMINAL_KEPT:
            continue
        per_connection[record.connection] = per_connection.get(record.connection, 0) + 1
        kept_terminal[record.attempt_id] = record
    return {**live, **kept_terminal}
