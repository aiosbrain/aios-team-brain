"""Durable baseline + Drive changes coordination.

This is the single Drive coordinator. It captures a provider start token before enumeration,
persists every page obligation before advancing, and treats opaque Drive tokens as opaque strings.
The brain-issued generation/lease fence is the commit authority; local SQLite is resumable work
state only. Notifications, manual runs and periodic polling converge here.
"""

from __future__ import annotations

import copy
import dataclasses
import hashlib
import json
import math
import random
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from collections.abc import Callable, Iterable
from typing import Any

from pydantic import ValidationError

from .brain_client import BrainClient, BrainDeferred, BrainError, GdriveExecution
from .config import BrainSettings, Connection
from .connector_state import (
    ROOTS_KEY, add_hold, add_resource, apply_restriction_sections, coordinator_document,
    parse_restriction_evidence, parse_roots_section, restriction_sections, roots_section,
)
from .engine import IngestSummary
from .normalize import normalize
from .sources.gdrive import (
    FOLDER_MIME,
    GOOGLE_DOC_MIME,
    GoogleDriveSource,
    IncompleteExtractionError,
    ProviderCursorInvalid,
    ProviderDeferred,
    is_drive_rate_limit,
)
from .state import ROOT_AUTHORITY_CONFLICT_DETAIL, ROOT_MEMBERSHIP_EVENT_DETAIL, StateStore, StreamKey, PendingWork, MaterializedPage
from .selections import effective_gdrive_connection

_TERMINAL_AUTHORITY_CODES = {
    "unauthorized", "connector_principal_required", "wrong_connection",
    "stale_execution", "connection_unavailable", "reconnect_required",
}
# What stops the coordinator from starting the NEXT stream: every brain authority refusal, plus Google
# rejecting the account's credential. That rejection is the account's, not one stream's — every other
# stream would present the same credential — so it ends the run (AIO-1167 R45 M8). Kept apart from
# `_is_terminal_authority`, which classifies BRAIN responses on the sink/checkpoint paths.
_RUN_TERMINAL_CODES = _TERMINAL_AUTHORITY_CODES | {"provider_unauthorized"}
_MAX_PENDING_PER_STREAM = 5_000
_MAX_DISCOVERY_PAGES_PER_STREAM = 25
_MAX_RETRY_WORK_PER_STREAM = 25
_RUN_DEADLINE_SECONDS = 55.0


def _is_terminal_authority(exc: BrainError) -> bool:
    return exc.code in _TERMINAL_AUTHORITY_CODES


def scope_generation(options: dict[str, Any]) -> int:
    selection = {
        key: options.get(key)
        for key in ("file_ids", "folder_ids", "shared_drive_ids", "recursive", "selection_state")
    }
    digest = hashlib.sha256(json.dumps(selection, sort_keys=True, separators=(",", ":")).encode()).digest()
    return int.from_bytes(digest[:4], "big")


def credential_identity(options: dict[str, Any]) -> str:
    explicit = str(options.get("credential_identity") or "").strip()
    if explicit:
        return explicit
    raw = options.get("credential_json")
    subject = ""
    if raw:
        try:
            info = json.loads(raw) if isinstance(raw, str) else raw
            subject = str(info.get("client_email") or info.get("client_id") or "")
        except (TypeError, ValueError):
            subject = "credential-json"
    if not subject:
        subject = str(options.get("service_account_key_path") or "application-default")
    return hashlib.sha256(subject.encode()).hexdigest()


_CONTROL_OPTIONS = frozenset({
    "credential_identity", "integration_id", "auth_mode", "service_account_status", "webhook_url",
    "watch_ttl_seconds", "rearm_exhausted",
})

# Durable document retries (AIO-1167 R44 C7): capped exponential backoff with jitter, from the
# PERSISTED failure count, and a bounded number of automatic failures. An exhausted obligation stays
# owed — the run stays partial and absence stays withheld — until an explicit Admin run (Run now /
# Retry) or a new observation of the document re-arms it.
_RETRY_BASE_SECONDS = 60
_RETRY_CAP_SECONDS = 6 * 3600
_MAX_AUTOMATIC_ATTEMPTS = 8


def _backoff_seconds(attempts_so_far: int, rng: Any = None) -> float:
    """Delay before the next attempt after ``attempts_so_far + 1`` failures: base·2^n, capped, with
    jitter in [50%, 100%] so a burst of failures does not retry in lockstep."""
    delay = min(_RETRY_CAP_SECONDS, _RETRY_BASE_SECONDS * (2 ** min(max(0, attempts_so_far), 20)))
    return delay * (0.5 + 0.5 * float((rng or random.random)()))


def _fail_work(
    state: StateStore, work: PendingWork, detail: str, *, retry_after: str | None = None,
    external: bool = True, minimum: str | None = None,
) -> bool:
    """Record one failed attempt of ``work``; returns whether its automatic retries are exhausted.

    The next attempt is no earlier than the attempt-aware backoff and no earlier than a wait the
    provider or brain named (``retry_after``) — the later of the two, so Retry-After is always
    honoured. ``external`` says whether that wait is an EXTERNAL minimum (provider-named or
    brain-named) recorded apart from the backoff; a local fallback (``external=False``, R51 F5)
    delays the attempt the same way but is backoff a rearm may drop. When ``retry_after`` combines
    a named minimum with local fallback (a ``BrainDeferred``), ``minimum`` carries the named part
    alone and is the only part recorded as external (R51 L2); a valid zero is still a minimum.

    Backoff and exhaustion count FAILURES as persisted (``StateStore.work_failures``), not the
    obligation's ``attempts``: a document withheld behind another stream's drain is re-attempted each
    run without failing, and that waiting must not spend its retry budget."""
    from datetime import timedelta

    def instant(value: str | None) -> datetime | None:
        if not value:
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)

    failures = state.work_failures(work)
    not_before = datetime.now(timezone.utc) + timedelta(seconds=_backoff_seconds(failures))
    recorded: datetime | None = None
    for value, is_external in ((retry_after, external), (minimum, True)):
        named = instant(value)
        if named is None:
            continue
        not_before = max(not_before, named)
        if is_external:
            recorded = named if recorded is None else max(recorded, named)
    minimum = recorded.isoformat() if recorded is not None else None
    exhausted = failures + 1 >= _MAX_AUTOMATIC_ATTEMPTS
    # The named wait is recorded apart from the local backoff (R50 F2): an explicit Admin rearm
    # drops the backoff, never the external minimum.
    state.fail_work(work, detail, not_before=not_before.isoformat(), exhaust=exhausted, minimum=minimum)
    return exhausted


class _ProviderAdmissionClosed(Exception):
    """Google refused this account's calls until ``not_before`` (AIO-1167 R44 C6). The whole drain
    for the account stops; no further provider call is made for it before that instant.

    A CONTROL signal, not a read failure: it must reach the coordinator's account-hold owner from
    every phase (drain, baseline enumeration, change pages) and is never converted into a
    per-stream ``provider_read`` (R45 H1). ``partial`` carries the counts the interrupted stream had
    already completed, so the work done before the limit is still reported."""

    def __init__(self, not_before: str, category: str, diagnostic: str | None = None):
        super().__init__(category)
        self.not_before = not_before
        self.category = category
        self.diagnostic = diagnostic
        self.partial: IngestSummary | None = None


class _AcknowledgmentUncertain(Exception):
    """A checkpoint may have committed on the brain without its acknowledgment arriving, or the
    brain's revision is not the one this run holds (AIO-1167 R47 F3). A CONTROL signal: the run's
    progress revision is unknown, so no further changed checkpoint is sent and the run ends partial;
    the next acquisition restores the brain's authoritative progress, and the owed work — never
    acknowledged here — replays idempotently. Never a document failure. ``partial`` carries the
    counts completed before it, as ``_ProviderAdmissionClosed`` does."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code
        self.partial: IngestSummary | None = None


def _progress_uncertain(client: BrainClient, execution: GdriveExecution) -> bool:
    """Whether the client latched this execution's revision as unknown (R47 F3). A brain double
    without the latch has none to report."""
    probe = getattr(client, "gdrive_progress_uncertain", None)
    return bool(probe(execution)) if callable(probe) else False


# Provider deferrals caused by this run's own budget, never by Google (U5 pre-dispatch; R45 M6 late
# but in-time response). They stop the drain without charging the document.
_LOCAL_DEADLINE_CATEGORIES = frozenset({"dispatch_deadline", "run_deadline"})


def _account_hold(exc: ProviderDeferred) -> _ProviderAdmissionClosed:
    """The account-wide hold a provider rate limit opens (C6), from wherever it was read."""
    return _ProviderAdmissionClosed(
        exc.not_before or _defer_until(), exc.category, getattr(exc, "diagnostic", None),
    )


def _count_retry_after_diagnostic(summary: IngestSummary, exc: object) -> None:
    """Report a defective provider Retry-After beside the deferral it caused (AIO-1167 R48 D2):
    ``retry_after_malformed`` (ignored for the bounded fallback) or ``retry_after_unrepresentable``
    (held at the last representable instant)."""
    diagnostic = getattr(exc, "diagnostic", None)
    if diagnostic:
        summary.failure_categories[diagnostic] = summary.failure_categories.get(diagnostic, 0) + 1


def _standing_account_hold(
    state: StateStore, integration_id: str, generation: int, credential: str,
) -> dict[str, Any] | None:
    """The account hold in force now, as the document it is published as; ``None`` once it passed."""
    hold = state.connection_hold(integration_id, generation, credential)
    if hold is None or not _retry_deferred(hold[0]):
        return None
    return {"generation": generation, "credential": credential, "not_before": hold[0], "category": hold[1]}


def _restriction_standing(not_before: str, unrepresentable: bool) -> bool:
    """A provider minimum in force now. An unrepresentable one never lapses (fail closed)."""
    return unrepresentable or _retry_deferred(not_before)


def _standing_document_restrictions(
    state: StateStore, integration_id: str, generation: int, credential: str,
) -> dict[str, tuple[str, str, bool]]:
    """The provider-named resource minimums in force for this verified account (R49 F1), from every
    generation of it (R50): a new selection generation never waives one."""
    return {
        provider_id: held
        for provider_id, held in state.document_restrictions(integration_id, generation, credential).items()
        if _restriction_standing(held[0], held[2])
    }


# Operation-scoped resource keys in the same restriction owner (AIO-1167 R50 F3). A provider answer
# for a stream's start token or for the service-account identity prerequisite governs THAT operation,
# not the account: it is recorded as a resource restriction under a key no Drive file id can take.
_START_TOKEN_RESOURCE = "start-token:"
_IDENTITY_PREREQUISITE_RESOURCE = "prerequisite:service-account-identity"
# AIO-1167 final review A3/A4: the remaining provider operations whose named minimum must survive a
# generation transition. Each binds to the STABLE operation — never a page token, cursor, generation or
# attempt id — under the verified account the restriction owner already keys by:
#   * listing one folder's children (`files.list` of that folder);
#   * reading one drive's change pages;
#   * creating a watch channel on one drive; stopping one known channel resource.
_FOLDER_LISTING_RESOURCE = "list-folder:"
_CHANGES_RESOURCE = "changes:"
WATCH_CREATE_RESOURCE = "watch-create:"
WATCH_STOP_RESOURCE = "watch-stop:"


def _operation_restricted(
    state: StateStore, execution: GdriveExecution, credential: str, resource: str,
) -> bool:
    """Whether a provider-named minimum still stands for one operation of this verified account."""
    return resource in _standing_document_restrictions(
        state, execution.integration_id, execution.generation, credential,
    )


def _restrict_operation(
    state: StateStore, execution: GdriveExecution, credential: str, resource: str, exc: ProviderDeferred,
) -> bool:
    """Journal a valid provider minimum for one operation through the ONE restriction owner (A3/A4).
    An account quota answer stays the account's hold and the run's own budget stays local; a missing
    or malformed Retry-After's fallback is attempt-local (`_restrict_resource` records only a
    provider-named deadline)."""
    if exc.category == "rate_limited" or exc.category in _LOCAL_DEADLINE_CATEGORIES:
        return False
    return _restrict_resource(state, execution, credential, resource, exc)


def _restriction_evidence(
    state: StateStore, execution: GdriveExecution, *, local: bool = True, local_holds: bool = True,
) -> dict[str, dict[str, Any]]:
    """Every provider minimum known for this connection: the brain's acknowledged evidence for
    every verified account, merged with this sidecar's local journal (``local``), monotonically.
    ``local_holds=False`` merges only the local RESOURCE/operation minima: the acknowledged account
    holds are carried unchanged and a merely local account hold is left for its own publication
    owner (AIO-1167 final review A4 — a late watch quota publishes on the next fresh acquisition)."""
    evidence = parse_restriction_evidence(execution.progress)
    if local:
        for account in state.restriction_credentials(execution.integration_id):
            if local_holds:
                add_hold(evidence, account, state.connection_hold(
                    execution.integration_id, execution.generation, account,
                ))
            for provider_id, held in state.document_restrictions(
                execution.integration_id, execution.generation, account,
            ).items():
                add_resource(evidence, account, provider_id, held)
    return evidence


def _restriction_sections(
    state: StateStore, execution: GdriveExecution, credential: str, *, local_holds: bool = True,
) -> dict[str, Any]:
    """The three restriction sections a checkpoint of ``credential``'s worker publishes (R50).

    Built from the acknowledged evidence AND the local journal, so publication can only add or extend
    a standing minimum: another account's evidence is carried forward in ``retained_restrictions``,
    and nothing standing is dropped merely because this worker did not adopt it. Lapsed minimums are
    not republished; an unrepresentable one never lapses."""
    return restriction_sections(
        _restriction_evidence(state, execution, local_holds=local_holds), credential=credential,
        generation=int(execution.generation), standing=_restriction_standing,
    )


# The two restriction owners and the truthful diagnostic each reports while its standing local
# evidence is not acknowledged by the brain (R50 F7, R51 F3).
_HOLD_UNPUBLISHED = "account_hold_unpublished"
_RESOURCE_UNPUBLISHED = "document_restriction_unpublished"


def _standing_resources(evidence: dict[str, dict[str, Any]]) -> dict[tuple[str, str], Any]:
    return {
        (account, provider_id): held
        for account, entry in evidence.items()
        for provider_id, held in (entry.get("resources") or {}).items()
        if held is not None and _restriction_standing(held[0], held[2])
    }


def _standing_holds(evidence: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return {
        account: entry["hold"]
        for account, entry in evidence.items()
        if entry.get("hold") is not None and _retry_deferred(entry["hold"][0])
    }


def _restriction_outstanding(state: StateStore, execution: GdriveExecution) -> set[str]:
    """Which owners hold a standing local minimum — newly learned or extended — that the brain has
    not acknowledged: account holds (``account_hold_unpublished``) and resource restrictions
    (``document_restriction_unpublished``), compared separately (R50 F7, R51 F3)."""
    local = _restriction_evidence(state, execution)
    acknowledged = _restriction_evidence(state, execution, local=False)
    outstanding: set[str] = set()
    if _standing_holds(local) != _standing_holds(acknowledged):
        outstanding.add(_HOLD_UNPUBLISHED)
    if _standing_resources(local) != _standing_resources(acknowledged):
        outstanding.add(_RESOURCE_UNPUBLISHED)
    return outstanding


def _note_unpublished(summary: IngestSummary, categories: set[str]) -> None:
    """Report each unpublished restriction owner ONCE per run (R51 F3), however many publications
    were attempted or streams observed it; ``_merge_summary`` keeps the same dedupe."""
    seen: set[str] = summary.__dict__.setdefault("_unpublished_restrictions", set())
    seen.update(categories)
    summary.failure_categories = summary.failure_categories or {}
    for category in seen:
        summary.failure_categories[category] = 1


def _adopt_remote_restriction_evidence(
    state: StateStore, execution: GdriveExecution, integration_id: str, generation: int, credential: str,
) -> None:
    """Restore the provider minimums the brain acknowledged for THIS verified account (R47 F5,
    R49 F1) — from whatever generation they were observed in (R50) — before any provider read, so a
    restart, a fresh state file, a scope edit or a same-account reconnect cannot read early. Another
    account's evidence is not adopted (it is carried, untouched, by ``_restriction_sections``).
    Monotonic; anything malformed is ignored, never guessed."""
    account = parse_restriction_evidence(execution.progress).get(credential)
    if not account:
        return
    hold = account.get("hold")
    if hold is not None:
        state.hold_connection(integration_id, generation, credential, hold[0], hold[1])
    for provider_id, (not_before, category, unrepresentable) in (account.get("resources") or {}).items():
        state.restrict_document(
            integration_id, generation, credential, provider_id, not_before, category,
            unrepresentable=unrepresentable,
        )


def _restrict_resource(
    state: StateStore, execution: GdriveExecution, credential: str, resource: str, exc: ProviderDeferred,
) -> bool:
    """Record a provider-named minimum for ONE resource or operation (R49 F1, R50 F3), never the
    account. Only a provider-named deadline (a valid or unrepresentable Retry-After) is recorded; a
    malformed header's bounded fallback and a timeout stay attempt-local. Returns whether recorded."""
    if not (getattr(exc, "provider_deadline", False) and exc.not_before and credential and resource):
        return False
    state.restrict_document(
        execution.integration_id, execution.generation, credential, resource, exc.not_before, exc.category,
        unrepresentable=getattr(exc, "diagnostic", None) == "retry_after_unrepresentable",
    )
    return True


def _count(summary: IngestSummary, category: str, amount: int = 1) -> None:
    summary.failure_categories = summary.failure_categories or {}
    summary.failure_categories[category] = summary.failure_categories.get(category, 0) + amount


def _note_root_unavailable(summary: IngestSummary, kind: str, root_id: str) -> None:
    """Count a root whose OWN not-found was verified in this run — once per root per run (R50 F7),
    however many phases or streams observed it; a retained historical detail is never counted."""
    seen: set[tuple[str, str]] = summary.__dict__.setdefault("_verified_unavailable_roots", set())
    seen.add((kind, root_id))
    summary.failure_categories = summary.failure_categories or {}
    summary.failure_categories["selection_root_unavailable"] = len(seen)


async def _publish_restriction_evidence(
    client: BrainClient, execution: GdriveExecution, state: StateStore, credential: str,
    total: IngestSummary, *, local_holds: bool = True,
) -> bool:
    """Publish the restriction sections onto the LATEST acknowledged document, changing nothing
    else, so no stream, root or watch the brain holds can regress. One attempt, never a loop.

    A refused or lost publication keeps the local journal and says so — each outstanding owner once
    (``_note_unpublished``) — and is never reported as remote-durable. Under the BrainClient
    uncertainty latch nothing is sent at all: only a fresh acquisition restores the revision
    (R47 F3). A terminal authority refusal is re-raised. Returns whether nothing is outstanding."""
    outstanding = _restriction_outstanding(state, execution)
    if not local_holds:
        outstanding = outstanding & {_RESOURCE_UNPUBLISHED}
    payload = copy.deepcopy(execution.progress)
    apply_restriction_sections(
        payload, _restriction_sections(state, execution, credential, local_holds=local_holds),
    )
    if payload == execution.progress:
        return True  # the acknowledged document already carries every section
    if _progress_uncertain(client, execution):
        _note_unpublished(total, outstanding or {_RESOURCE_UNPUBLISHED})
        return False
    try:
        ack = await client.checkpoint_gdrive_execution(execution, payload) or {}
    except BrainError as error:
        if _is_terminal_authority(error):
            raise
        _note_unpublished(total, outstanding or {_RESOURCE_UNPUBLISHED})
        return False
    acknowledged = dict(ack.get("progress") or payload)
    execution.progress.clear()
    execution.progress.update(acknowledged)
    # The roots it carried are the ACQUIRED canonical ones, not a root snapshot this coordinator
    # submitted: this acknowledgement advances no local root baseline (R59).
    return True


async def _flush_restriction_evidence(
    client: BrainClient, execution: GdriveExecution, state: StateStore, credential: str,
    total: IngestSummary, *, cause: BaseException | None = None,
    run_failure_counted: bool = False,
) -> None:
    """On an orderly early return, publish the minimums already observed this run (R51 F2) when
    the execution's authority still permits it — never under a terminal authority refusal, never
    through the uncertainty latch.

    The run's accumulated outcome is NEVER replaced (R51 L1). A terminal authority refusal met
    while publishing (``stale_execution``, ``connection_unavailable``, …) is reported as that
    authority code — beside, never instead of, any ``cause`` that already ended the run — with
    the applicable unpublished categories; the local journal keeps the evidence. Every caller
    returns right after this, so nothing further is read or sent under the lost authority, and the
    coordinator's ``finally`` still releases the lease. The exception's text is never reported.

    Two separate inputs (R51 Note A, adjacent run-count correction): ``cause`` only decides whether
    publication is attempted at all (a terminal cause suppresses it); ``run_failure_counted`` says
    the coordinator ALREADY charged this run its one run-level failure (an early BrainError, an
    unresolved selection, a failed reconciliation), so a refusal here adds its category but no
    second charge. It is set only by those identified charges — never inferred from ``failed``,
    from categories, or from document failures."""
    outstanding = _restriction_outstanding(state, execution)
    if not outstanding:
        return
    if isinstance(cause, BrainError) and _is_terminal_authority(cause):
        _note_unpublished(total, outstanding)
        return
    try:
        await _publish_restriction_evidence(client, execution, state, credential, total)
    except BrainError as error:
        # `_publish_restriction_evidence` lets only a terminal authority refusal escape. When the
        # coordinator already charged this run, the authority code is reported beside that charge,
        # never charged a second time (R51 Note A).
        _note_unpublished(total, outstanding)
        _note_flush_authority(total, error, charge=not run_failure_counted)


def _note_flush_authority(total: IngestSummary, error: BrainError, *, charge: bool = True) -> None:
    """Report a terminal authority refusal met at an orderly-return checkpoint as its code — once —
    keeping every category, count and partial result the summary already holds (R51 L1).

    ``charge`` says whether it is this run's one failed outcome, as an early authority refusal is.
    It is ``False`` only when the coordinator already charged this run its run-level failure, so
    one terminating run is never counted twice (R51 Note A); a document failure elsewhere in the run
    is never taken to stand in for it. Status then follows the ordinary classification: a run that also
    made progress or holds backlog is not reported as a bare failure, and a paused/disconnected
    connection is still suppressed by the scheduler's re-read."""
    total.failure_categories = total.failure_categories or {}
    if error.code not in total.failure_categories:
        total.failure_categories[error.code] = 1
        if charge:
            total.failed += 1


async def _open_account_hold(
    client: BrainClient,
    execution: GdriveExecution,
    state: StateStore,
    integration_id: str,
    credential: str,
    exc: ProviderDeferred,
    total: IngestSummary,
    *,
    run_failure_counted: bool = False,
) -> None:
    """A QUOTA answer read before any stream could carry it (AIO-1167 R47 F5; scoped by R50 F3):
    root metadata, relocation re-reads, start-token capture, the service-account identity read.

    Only a rate limit (429, or a 403 naming a quota reason) is the ACCOUNT's: it is held durably —
    locally first, then published onto the acknowledged document unchanged but for the restriction
    sections. A failed publication keeps the local hold and says so. A local budget stop is not a
    provider wait and opens no hold, and neither does any other provider answer: its scope is the
    resource or operation it was read for (``_restrict_resource``), never the account. Reported as a
    held (partial) run, never a document failure or deletion evidence.

    Either way the run returns here, so every minimum already observed this run — a root's 503
    recorded before this answer (R51 F2) — is published with the hold, or flushed on its own for a
    local stop; a quota answer adds the account hold and never replaces a resource minimum.
    ``run_failure_counted`` is passed through to the flush unchanged (R51 Note A)."""
    total.skipped += 1
    _count(total, exc.category)
    _count_retry_after_diagnostic(total, exc)
    if exc.category == "rate_limited":
        state.hold_connection(
            integration_id, execution.generation, credential, exc.not_before or _defer_until(), exc.category,
        )
    await _flush_restriction_evidence(
        client, execution, state, credential, total, run_failure_counted=run_failure_counted,
    )


def provider_source_options(options: dict[str, Any]) -> dict[str, Any]:
    """The options a provider source is built from: everything but coordinator control fields."""
    return {key: value for key, value in options.items() if key not in _CONTROL_OPTIONS}


class ServiceAccountBindingRefused(Exception):
    """The loaded service-account credential cannot run this connection (AIO-1167 R44 F3)."""

    def __init__(self, category: str):
        super().__init__(category)
        self.category = category


def _account_hash(account: str) -> str:
    return hashlib.sha256(account.strip().lower().encode()).hexdigest()


def oauth_account_namespace(config: dict[str, Any], grant: dict[str, Any] | None, options: dict[str, Any]) -> str:
    """The OAuth credential namespace, the same for the coordinator and watch renewal (R44 S2):
    the broker's verified account (subject, else email) first, then the connection's recorded
    account, then the configured fallback."""
    account = (grant or {}).get("account") or {}
    return str(
        account.get("subject") or account.get("email")
        or config.get("authenticatedAccountId") or config.get("authenticatedAccount")
        or credential_identity(options)
    )


def service_account_namespace(source: Any, config: dict[str, Any], status: str | None) -> str:
    """Bind a service-account run to the account its LOADED credential authenticates as.

    A pathname is not an account: replacing the key file with another account's key keeps the path
    and changes the account. So the namespace is derived from the credential object provider calls
    will use, and — once the brain has verified an identity for this connection — that account must
    be the verified one. A mismatch (or a verified status with no recorded identity) is refused
    before any local or remote progress is restored or consumed; nothing is inferred deleted. The
    same account with rotated key material keeps its namespace. Malformed material is refused as
    invalid credentials; an unreadable file raises as before (a sanitized coordinator failure) —
    both fail closed.
    """
    try:
        loaded = source.service_account_identity()
    except (ValueError, TypeError, KeyError):
        raise ServiceAccountBindingRefused("service_account_credentials_invalid") from None
    if not isinstance(loaded, str) or not loaded.strip():
        raise ServiceAccountBindingRefused("service_account_credentials_invalid")
    if status == "verified":
        verified = str(config.get("serviceAccountIdentity") or "").strip().lower()
        if not verified:
            raise ServiceAccountBindingRefused("service_account_identity_unverified")
        if verified != loaded.strip().lower():
            raise ServiceAccountBindingRefused("service_account_identity_changed")
    return _account_hash(loaded)


@dataclass(frozen=True)
class ChangePage:
    changes: list[dict[str, Any]]
    next_page_token: str | None
    new_start_page_token: str | None


def _page_id(kind: str, *parts: object) -> str:
    material = "\0".join(str(part or "") for part in (kind, *parts))
    return f"{kind}:{hashlib.sha256(material.encode()).hexdigest()}"


class SelectedRootRelocated(RuntimeError):
    """A selected root no longer lives in the drive whose change stream it is bound to."""


class SelectedRootUnverified(RuntimeError):
    """Where a selected root lives now could not be read, so nothing is concluded about it."""


# What a stream is told when its drive's change log could not be opened. The text is a diagnostic
# for people; whether a stream has started is read from its tokens (``_unstarted``), never from it.
_START_UNAVAILABLE = "start token unavailable"
# What a STARTED stream is told when the provider refuses its change log (a 403/404 that is not a
# quota answer). Its cursor and claims stand; for explicit file roots it is probe eligibility (R57).
_STREAM_ACCESS_DENIED = "stream_access_denied"


def _provider_status(exc: Exception) -> int | None:
    """The HTTP status a provider error carries, if any."""
    response = getattr(exc, "resp", None)
    value = getattr(response, "status", None) or getattr(exc, "status_code", None)
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _unstarted(stream: Any) -> bool:
    """True for a stream record, local or on the brain, that holds no change token.

    This is structure, not wording. A stream with no token has nothing to drain from, so it never
    started — whether its start-token diagnostic was recorded, was replaced by another message, or
    was never written because the run that created the record was interrupted first. Such a stream
    is asked for a token before anything of its drive is enumerated, on every run.
    """
    if isinstance(stream, dict):
        tokens = (stream.get("baseline_start_token"), stream.get("page_token"))
    else:
        tokens = (stream.baseline_start_token, stream.page_token)
    return not any(tokens)


def _holds_enumeration(stream: Any) -> bool:
    """Whether a stream record names a snapshot: something was enumerated through it."""
    if isinstance(stream, dict):
        snapshots = (stream.get("active_snapshot"), stream.get("building_snapshot"))
    else:
        snapshots = (stream.active_snapshot, stream.building_snapshot)
    return any(snapshot is not None for snapshot in snapshots)


def _start_recovery_blocked(progress: Any) -> bool:
    """True for a stream that had started and whose recovery is waiting on a start token."""
    return bool(
        not _unstarted(progress) and progress.recovery_required
        and str(progress.last_error or "").startswith(_START_UNAVAILABLE)
    )


class StreamStartUnavailable(RuntimeError):
    """A containing drive's change log could not be opened: that stream's failure, not the run's."""

    def __init__(self, drive_id: str, status: int):
        super().__init__(
            f"{_START_UNAVAILABLE}: drive {drive_id} not found or not accessible ({status})"
        )
        self.drive_id = drive_id
        self.status = status


def _capture_start_token(source: GoogleDriveSource, drive: Any, drive_id: str) -> str:
    """Capture one drive's start token — the only way any path here asks for one.

    A Shared Drive that answers 403 or 404 is a drive whose change log the account cannot open: a
    root shared without its drive, or a drive since lost. That is ``StreamStartUnavailable`` at
    every site alike — a new stream, the recovery of local state, the recovery of an invalid
    cursor — so none of them can turn one stream's failure into the run's. My Drive, authority
    and provider deferrals, and every other status are raised exactly as they came. A 403 that
    names a rate-limit reason is a quota answer, not an inaccessible drive: the provider call
    retries and defers it as ``rate_limited``, and should one ever reach here it is raised as is.
    """
    kwargs = {"supportsAllDrives": True}
    if drive_id != "my-drive":
        kwargs["driveId"] = drive_id
    try:
        return source._execute(drive.changes().getStartPageToken(**kwargs))["startPageToken"]
    except (BrainError, ProviderDeferred):
        raise
    except Exception as exc:
        status = _provider_status(exc)
        # The module function, not ``GoogleDriveSource``: the source class in hand may be any
        # provider-shaped object, and classification must not depend on it.
        if drive_id == "my-drive" or status not in (403, 404) or is_drive_rate_limit(exc):
            raise
        raise StreamStartUnavailable(drive_id, status) from exc


_DRIVE_MEMBERSHIP_CACHE = "_aios_shared_drive_membership"


def _shared_drive_membership(source: GoogleDriveSource, drive_id: str) -> str:
    """Whether this credential is a MEMBER of one Shared Drive: ``member``, ``nonmember`` or ``unknown``.

    Provider evidence only (AIO-1167 R56): the drive's own ``drives.get`` answering is membership,
    and a definitive 404 for it is non-membership. Nothing else is: a 403, a 5xx, a source without a
    drives API, or any other failure is ``unknown`` — never read as non-membership, so a drive stream
    the account cannot open keeps its existing unavailable-stream handling. A quota or authority
    answer is raised as is. One answer per drive per source (one run, one credential).
    """
    cache = getattr(source, _DRIVE_MEMBERSHIP_CACHE, None)
    if not isinstance(cache, dict):
        cache = {}
        try:
            setattr(source, _DRIVE_MEMBERSHIP_CACHE, cache)
        except Exception:  # pragma: no cover - a provider-shaped object that refuses attributes
            pass
    if drive_id in cache:
        return cache[drive_id]
    verdict = "unknown"
    try:
        drive, _docs = source._services()
        drives = getattr(drive, "drives", None)
        if callable(drives):
            source._execute(drives().get(driveId=drive_id, fields="id"))
            verdict = "member"
    except (BrainError, ProviderDeferred):
        raise
    except Exception as exc:
        verdict = "nonmember" if _provider_status(exc) == 404 and not is_drive_rate_limit(exc) else "unknown"
    cache[drive_id] = verdict
    return verdict


def _consumed_drive(
    source: GoogleDriveSource, root_kind: str, meta: dict[str, Any], current: str | None = None,
) -> str:
    """The change log that observes a selected root — its STREAM identity, not where it physically is.

    Google reports a file individually shared with a NON-member of its Shared Drive in the user's
    change log, not that drive's (AIO-1167 R56). So an explicitly selected FILE root whose readable
    metadata names a Shared Drive this credential is provably not a member of is consumed through
    the user log (``my-drive``). A member's file, a folder root, a My Drive root and every root
    whose membership is not proven keep the drive they are in, exactly as before. The physical drive
    is always read fresh from the metadata, so a membership change or a move is a route transition
    (a relocation between streams), never a guess: with ``current`` (the stream that consumes the
    root now), an UNPROVEN membership keeps a root the user log already consumes there — only
    provider evidence (membership) moves it to the drive's own stream.
    """
    physical = str(meta.get("driveId") or "my-drive")
    if physical == "my-drive" or root_kind != "file":
        return physical
    membership = _shared_drive_membership(source, physical)
    if membership == "nonmember" or (membership == "unknown" and current == "my-drive"):
        return "my-drive"
    return physical


def _user_log_route_proven(
    source: GoogleDriveSource, root_kind: str, physical_drive: str | None, consumed_by: str,
) -> bool:
    """Positive proof that a root consumed by ``consumed_by`` belongs there (AIO-1167 R63).

    ``_consumed_drive`` keeps an explicit FILE root on the user log when membership is UNKNOWN — a
    continuity fallback, not evidence. Where a root's obligation is DISCHARGED onto the user log (a
    relocation cancelled back to it, a deferred root settled by enumeration, a membership-event debt
    settled), that fallback must not count: only a file physically in My Drive, or a Shared Drive that
    definitively answers non-membership, proves the user log consumes it. Any other stream, and any
    folder root, is unaffected (its consumed drive IS its physical drive). A provider deferral of the
    membership read is raised for the caller's owners."""
    if consumed_by != "my-drive" or root_kind != "file":
        return True
    if physical_drive in (None, "", "my-drive"):
        return True
    return _shared_drive_membership(source, str(physical_drive)) == "nonmember"


def _start_token_restricted(
    state: StateStore, execution: GdriveExecution, options: dict[str, Any], drive_id: str,
) -> bool:
    """Whether this stream's start token is under a standing provider minimum (R50 F3 admission)."""
    return f"{_START_TOKEN_RESOURCE}{drive_id}" in _standing_document_restrictions(
        state, execution.integration_id, execution.generation, credential_identity(options),
    )


def _deferred_root_admissible(
    state: StateStore, execution: GdriveExecution, options: dict[str, Any], generation: int,
    drive_id: str,
    *,
    source: GoogleDriveSource | None = None,
    probed: set[tuple[str, str]] | None = None,
    diagnostics: IngestSummary | None = None,
) -> bool:
    """Whether a controlled rescan should start because a root this drive's enumeration deferred
    (R50 F4) may be read again.

    A root under a standing provider minimum is never read early: it cannot authorize a rescan. Any
    other deferred root first gets a bounded ROOT-LOCAL probe (R51 F4) — one metadata read through
    the existing provider gate, deadline and retry contract, at most once per root per run
    (``probed``, owned by the coordinator) — so a root that keeps timing out does not relist its
    healthy siblings on every poll:

      * a quota answer is the account's hold (raised);
      * the run's own budget ends probing for this run, the rescan not started;
      * any other deferral keeps the root deferred, records a newly named provider minimum, and
        the stream's independent changes drain without a rescan;
      * an answer that locates the root (present here, elsewhere, or verified not-found) only
        AUTHORIZES the normal controlled rescan, whose own evidence paths decide; the probe never
        settles the root nor establishes membership.

    With no ``source`` (no probe possible) the pre-R51 rule applies: any unrestricted deferred root."""
    deferred = state.deferred_roots(execution.integration_id, generation, drive_id)
    if not deferred:
        return False
    credential = credential_identity(options)
    restricted = set(_standing_document_restrictions(
        state, execution.integration_id, generation, credential,
    ))
    eligible = [(kind, root_id) for kind, root_id in deferred if root_id not in restricted]
    if not eligible:
        return False
    if source is None:
        return True
    probed = probed if probed is not None else set()
    report = diagnostics if diagnostics is not None else IngestSummary("probe", failure_categories={})
    for kind, root_id in eligible:
        if (kind, root_id) in probed:
            continue
        probed.add((kind, root_id))
        try:
            observed = _observe_root(source, root_id, drive_id, {}, kind)
        except ProviderDeferred as exc:
            if exc.category == "rate_limited":
                raise _account_hold(exc) from exc
            _count(report, exc.category)
            _count_retry_after_diagnostic(report, exc)
            if exc.category in _LOCAL_DEADLINE_CATEGORIES:
                return False
            _restrict_resource(state, execution, credential, root_id, exc)
            continue
        if observed.state == "unverified":
            _count(report, "selection_root_deferred")
            continue
        return True
    return False


def _stream_start_deferred(
    state: StateStore, execution: GdriveExecution, options: dict[str, Any], drive_id: str,
    exc: ProviderDeferred | None, summary: IngestSummary,
) -> IngestSummary:
    """One stream's start token could not be captured now (R50 F3). ``exc`` is ``None`` when its
    standing minimum withheld the request. A quota answer is the account's hold; the run's own
    budget is a local stop; any other answer (a 503, a timeout) is THIS stream's: nothing is
    enumerated without its token, its named minimum is kept, and the other streams still run."""
    if exc is None:
        summary.skipped += 1
        _count(summary, "provider_restricted_resource")
        return summary
    if exc.category == "rate_limited":
        raise _account_hold(exc) from exc
    summary.skipped += 1
    if exc.category in _LOCAL_DEADLINE_CATEGORIES:
        # A local stop keeps its own category — `dispatch_deadline` or `run_deadline` (R51 F7) —
        # and is neither a provider hold nor a restriction.
        summary.failure_categories = summary.failure_categories or {}
        summary.failure_categories.setdefault(exc.category, 1)
        return summary
    _count(summary, exc.category)
    _count_retry_after_diagnostic(summary, exc)
    _restrict_resource(
        state, execution, credential_identity(options), f"{_START_TOKEN_RESOURCE}{drive_id}", exc,
    )
    return summary


@dataclass(frozen=True)
class RootObservation:
    """Where one selected root is now: ``here`` (the stream's own drive), ``elsewhere`` (another
    drive, named), ``absent`` (the provider says there is no such file) or ``unverified``."""
    state: str
    drive_id: str | None = None
    detail: str | None = None
    # The drive the root physically is in, when read (R61): differs from ``drive_id`` for a
    # non-member's file consumed through the user log.
    physical_drive_id: str | None = dataclasses.field(default=None, compare=False)


# The diagnostic a verified-unavailable selected root carries in the fenced root evidence (R48 D1).
_ROOT_UNAVAILABLE_DETAIL = "selected root unavailable: the provider reports it not found; remove or reselect it"


def _restorable_file_root(
    state: StateStore, execution: GdriveExecution, namespace: str, generation: int,
    work: PendingWork, meta: dict[str, Any], source: GoogleDriveSource | None = None,
) -> str | None:
    """The selected file root this document's ingestion would prove restored (R49 F3), or ``None``.

    Only the SAME stable id as a selected file root of this generation recorded unavailable, still
    bound (no relocation pending) to this stream's drive, whose FRESH metadata — just read under the
    live execution gate — shows a readable, nontrashed Google Doc in that drive. The detail is
    cleared later, and only once the content is accepted (``_push_doc``)."""
    binding = state.root_obligations(execution.integration_id, generation).get(("file", work.item_key))
    if binding is None or binding.status != "bound" or not (binding.detail or "").startswith(
        "selected root unavailable"
    ):
        return None
    stream = state.get_progress(namespace)
    actual_drive = (
        _consumed_drive(source, "file", meta, binding.drive_id)
        if source is not None else str(meta.get("driveId") or "my-drive")
    )
    if stream is None or actual_drive != binding.drive_id or actual_drive != stream.key.drive_id:
        return None
    if meta.get("trashed") or meta.get("mimeType") != GOOGLE_DOC_MIME or str(meta.get("id")) != work.item_key:
        return None
    return work.item_key


def _observe_root(
    source: GoogleDriveSource, root_id: str, drive_id: str, seen: dict[str, RootObservation],
    root_kind: str = "folder",
) -> RootObservation:
    """Read a selected root's current metadata, under the run's own fence, once per ``seen``.

    A change page or a folder listing only says what one drive's stream can still see. When a root
    was moved to another drive, that is a removal and an empty folder — the same as a deletion. The
    root's own metadata tells them apart. Only an explicit not-found is ``absent``; any other
    failure to read it is ``unverified`` and is never treated as either.
    """
    if root_id in seen:
        return seen[root_id]
    try:
        meta = source._metadata(root_id)
    except (BrainError, ProviderDeferred):
        raise
    except Exception as exc:
        status = _provider_status(exc)
        observed = RootObservation("absent") if status == 404 else RootObservation(
            "unverified", detail=f"root metadata unreadable ({status or type(exc).__name__})",
        )
    else:
        # Compared by consumed change log (R56), so a non-member's file in the user log is "here".
        actual = _consumed_drive(source, root_kind, meta, drive_id)
        observed = RootObservation(
            "here" if actual == drive_id else "elsewhere", actual,
            physical_drive_id=str(meta.get("driveId") or "my-drive"),
        )
    seen[root_id] = observed
    return observed


def _leaving_roots(state: StateStore, integration_id: str, generation: int) -> set[tuple[str, str]]:
    """Selected roots read in another drive whose stream has not taken them over yet."""
    return {
        root for root, binding in state.unsettled_roots(integration_id, generation).items()
        if binding.status == "relocating"
    }


def _reobserve_stalled_relocations(
    source: GoogleDriveSource, state: StateStore, integration_id: str, generation: int,
    destination_blocked: Any,
    *,
    restricted: set[str] | frozenset[str] = frozenset(),
    deferred: list[tuple[str, ProviderDeferred | None]] | None = None,
    observe: Callable[[str, ProviderDeferred], None] | None = None,
) -> None:
    """Read again, on every run, each relocating root whose destination has no start token.

    A root is handed over only once its destination stream holds a token. While that drive's
    change log cannot be opened the hand-over waits — and would wait for good if the root were
    moved on to a third drive, or back, since nothing else reads where it is. So where it is NOW
    is read again: found in another drive, that drive becomes its destination; found in the drive
    it is still bound to, it never left that stream. Still there, unreadable or gone, nothing is
    concluded. In every case the root stays bound where it was until a hand-over, the claims made
    through it stand, and the connection stays incomplete.

    Admission and scope (AIO-1167 R50): a root under a standing provider minimum is not read early,
    and a non-quota deferral of its read is that root's (reported through ``deferred``, and handed
    to the coordinator's ``observe`` the moment it is read, R51 F2); a quota answer or the run's own
    budget still stops the run as before.
    """
    seen: dict[str, RootObservation] = {}
    for (root_kind, root_id), binding in state.unsettled_roots(integration_id, generation).items():
        if binding.status != "relocating" or not binding.pending_drive_id:
            continue
        if not destination_blocked(str(binding.pending_drive_id)):
            continue
        if root_id in restricted:
            if deferred is not None:
                deferred.append((root_id, None))
            continue
        try:
            observed = _observe_root(source, root_id, binding.drive_id, seen, root_kind)
        except ProviderDeferred as exc:
            if exc.category == "rate_limited" or exc.category in _LOCAL_DEADLINE_CATEGORIES:
                raise
            if observe is not None:
                observe(root_id, exc)
            if deferred is not None:
                deferred.append((root_id, exc))
            continue
        if observed.state == "here":
            # Back on the user log only on proof (R63): an unknown membership keeps the relocation,
            # its pending destination and its claims exactly as they are.
            try:
                proven = _user_log_route_proven(source, root_kind, observed.physical_drive_id, binding.drive_id)
            except ProviderDeferred as exc:
                if exc.category == "rate_limited" or exc.category in _LOCAL_DEADLINE_CATEGORIES:
                    raise
                if observe is not None:
                    observe(root_id, exc)
                if deferred is not None:
                    deferred.append((root_id, exc))
                continue
            if proven:
                state.cancel_relocation(integration_id, generation, root_kind, root_id)
        elif observed.state == "elsewhere" and observed.drive_id != binding.pending_drive_id:
            state.mark_root_relocating(
                integration_id, generation, root_kind, root_id, binding.drive_id,
                destination=str(observed.drive_id),
            )


def _reobserve_conflicted_roots(
    source: GoogleDriveSource, state: StateStore, integration_id: str, generation: int,
    *,
    restricted: set[str] | frozenset[str] = frozenset(),
    deferred: list[tuple[str, ProviderDeferred | None]] | None = None,
    observe: Callable[[str, ProviderDeferred], None] | None = None,
) -> None:
    """Freshly observe each root whose binding was adopted from CONFLICTING authority (R58).

    Such a root is ``uncertain`` with ``ROOT_AUTHORITY_CONFLICT_DETAIL``: nothing was settled on its
    behalf. Its metadata is read where it is now bound — read there, it is settled (the ordinary
    rule for a non-deferred uncertain root); read elsewhere, it relocates; unreadable or absent,
    nothing is concluded and it stays uncertain. A deferred listing debt is never touched here.
    Admission and deferral follow ``_reobserve_stalled_relocations``.
    """
    seen: dict[str, RootObservation] = {}
    for (root_kind, root_id), binding in state.unsettled_roots(integration_id, generation).items():
        if binding.status != "uncertain" or binding.detail != ROOT_AUTHORITY_CONFLICT_DETAIL or not binding.drive_id:
            continue
        if root_id in restricted:
            if deferred is not None:
                deferred.append((root_id, None))
            continue
        try:
            observed = _observe_root(source, root_id, binding.drive_id, seen, root_kind)
        except ProviderDeferred as exc:
            if exc.category == "rate_limited" or exc.category in _LOCAL_DEADLINE_CATEGORIES:
                raise
            if observe is not None:
                observe(root_id, exc)
            if deferred is not None:
                deferred.append((root_id, exc))
            continue
        if observed.state == "here":
            # Cleared on the user log only on proof (R64): `_consumed_drive`'s unknown-membership
            # continuity answer is not one, and keeps the conflict debt (partial).
            try:
                proven = _user_log_route_proven(source, root_kind, observed.physical_drive_id, binding.drive_id)
            except ProviderDeferred as exc:
                if exc.category == "rate_limited" or exc.category in _LOCAL_DEADLINE_CATEGORIES:
                    raise
                if observe is not None:
                    observe(root_id, exc)
                if deferred is not None:
                    deferred.append((root_id, exc))
                continue
            if proven:
                state.settle_root(integration_id, generation, root_kind, root_id)
        elif observed.state == "elsewhere" and observed.drive_id:
            state.mark_root_relocating(
                integration_id, generation, root_kind, root_id, binding.drive_id,
                destination=str(observed.drive_id),
            )


def _revalidate_membership_event_roots(
    source: GoogleDriveSource, state: StateStore, integration_id: str, generation: int,
    *,
    restricted: set[str] | frozenset[str] = frozenset(),
    deferred: list[tuple[str, ProviderDeferred | None]] | None = None,
    observe: Callable[[str, ProviderDeferred], None] | None = None,
) -> None:
    """Revalidate each user-log file root a Shared Drive membership event invalidated (AIO-1167 R61).

    Such a root is ``uncertain`` with ``ROOT_MEMBERSHIP_EVENT_DETAIL``
    (``StateStore.invalidate_user_log_file_roots``). Its own metadata and its drive's membership are
    read again through the same probes binding uses (``_observe_root``/``_shared_drive_membership``):

      * now consumed by its Shared Drive's own stream (membership gained) — it RELOCATES there, the
        ordinary hand-over: start token before enumeration, verified snapshot, then retirement;
      * provably still the user log's — it is in My Drive, or the drive answers non-membership —
        it is settled where it is bound;
      * an unknown membership, an unreadable or absent root, a provider deferral — nothing is
        concluded: it stays uncertain and the connection partial.

    Nothing else in the drive becomes selected. Admission and deferral follow
    ``_reobserve_stalled_relocations``.
    """
    seen: dict[str, RootObservation] = {}
    for (root_kind, root_id), binding in state.unsettled_roots(integration_id, generation).items():
        if binding.status != "uncertain" or binding.detail != ROOT_MEMBERSHIP_EVENT_DETAIL or not binding.drive_id:
            continue
        if root_id in restricted:
            if deferred is not None:
                deferred.append((root_id, None))
            continue
        try:
            observed = _observe_root(source, root_id, binding.drive_id, seen, root_kind)
            proven_here = observed.state == "here" and _user_log_route_proven(
                source, root_kind, observed.physical_drive_id, binding.drive_id,
            )
        except ProviderDeferred as exc:
            if exc.category == "rate_limited" or exc.category in _LOCAL_DEADLINE_CATEGORIES:
                raise
            if observe is not None:
                observe(root_id, exc)
            if deferred is not None:
                deferred.append((root_id, exc))
            continue
        if proven_here:
            state.settle_root(integration_id, generation, root_kind, root_id, revalidated=True)
        elif observed.state == "elsewhere" and observed.drive_id:
            state.mark_root_relocating(
                integration_id, generation, root_kind, root_id, binding.drive_id,
                destination=str(observed.drive_id),
            )


def _reclassify_nonmember_file_roots(
    source: GoogleDriveSource, state: StateStore, integration_id: str, generation: int,
    drive_blocked: Any,
    *,
    restricted: set[str] | frozenset[str] = frozenset(),
    deferred: list[tuple[str, ProviderDeferred | None]] | None = None,
    observe: Callable[[str, ProviderDeferred], None] | None = None,
) -> None:
    """Route an already-bound explicit FILE root to the user log once non-membership is proven (R56).

    Binding reads a root once per generation, so a root bound to its Shared Drive before routing
    existed — or by a member who has since lost membership — would keep asking that drive for a
    start token it can never open. Each run, a ``bound`` FILE root whose Shared Drive stream is
    unstarted or waiting on a start token it cannot get (``drive_blocked``) is reclassified, and only
    on provider evidence: the drive's own ``drives.get`` answering 404 (``_shared_drive_membership``)
    and the root's own readable metadata (``_observe_root``). It is then recorded as RELOCATING
    toward the user log, the ordinary hand-over: it stays bound — its claims and the drive stream's
    published snapshot standing — until the user log holds a start token captured before anything is
    enumerated there, and the old claims stand until the replacement snapshot is verified and every
    stream reconciles. A member, an unknown membership (a 403, a 5xx), an unreadable or absent root,
    a folder and a root not blocked are left exactly as they are. Admission and deferral follow
    ``_reobserve_stalled_relocations``.
    """
    seen: dict[str, RootObservation] = {}
    for (root_kind, root_id), binding in state.root_obligations(integration_id, generation).items():
        if root_kind != "file" or binding.status != "bound":
            continue
        bound_drive = str(binding.drive_id or "")
        if not bound_drive or bound_drive == "my-drive" or not drive_blocked(bound_drive):
            continue
        if root_id in restricted:
            if deferred is not None:
                deferred.append((root_id, None))
            continue
        try:
            if _shared_drive_membership(source, bound_drive) != "nonmember":
                continue
            observed = _observe_root(source, root_id, bound_drive, seen, root_kind)
        except ProviderDeferred as exc:
            if exc.category == "rate_limited" or exc.category in _LOCAL_DEADLINE_CATEGORIES:
                raise
            if observe is not None:
                observe(root_id, exc)
            if deferred is not None:
                deferred.append((root_id, exc))
            continue
        if observed.state == "elsewhere" and observed.drive_id:
            state.mark_root_relocating(
                integration_id, generation, root_kind, root_id, bound_drive,
                destination=str(observed.drive_id),
            )


def _handoff_verified(
    state: StateStore, execution: GdriveExecution, team: str, integration_id: str, credential: str,
    generation: int, root: tuple[str, str], destination: str,
) -> bool:
    """Whether ``destination``'s stream holds a COMPLETE verified snapshot that contains ``root`` — and
    the brain's ACQUIRED record of that stream names exactly that snapshot (R56 checkpoint order).

    Local state alone is not evidence here: retirement runs before any stream recovers, so an older
    complete local snapshot could stand in for a newer acquired one that lacks the root or is still
    being rebuilt. The acquired record must name the same published snapshot, under the same
    committed checkpoint page and drain observation, with its listing complete and no build or
    recovery outstanding. A missing or different acquired record certifies nothing.
    """
    progress = state.get_progress(StreamKey(team, integration_id, credential, destination).namespace(generation))
    if progress is None or _unstarted(progress) or progress.active_snapshot is None:
        return False
    if (not progress.listing_complete or progress.recovery_required or progress.building_snapshot is not None
            or not state.snapshot_complete(progress.namespace, generation, progress.active_snapshot)):
        return False
    remote = _remote_stream(execution.progress, destination)
    try:
        remote_active = int(remote.get("active_snapshot")) if remote.get("active_snapshot") is not None else None
        remote_observation = int(remote.get("drain_observation") or 0)
    except (TypeError, ValueError):
        return False
    remote_checkpoint = str(remote.get("checkpoint_id") or "")
    if (not remote or remote.get("recovery_required") or remote.get("building_snapshot") is not None
            or not remote.get("listing_complete") or remote_active != progress.active_snapshot
            or not remote_checkpoint or remote_checkpoint != str(progress.checkpoint_id or "")
            or remote_observation != progress.drain_observation
            or not state.page_committed(progress.namespace, generation, remote_checkpoint)):
        return False
    return root in {
        (str(row["root_kind"]), str(row["root_id"]))
        for row in state.list_roots(progress.namespace, generation, snapshot_id=progress.active_snapshot)
    }


def _retire_handed_over_streams(
    state: StateStore, execution: GdriveExecution, team: str, integration_id: str, generation: int,
    options: dict[str, Any], required: set[str],
) -> set[str]:
    """Retire a STARTED stream every root of which was handed over and verified (AIO-1167 R56).

    A root reclassified away from a drive (a member who lost membership, a move) is rebound once its
    destination holds a token; the old stream keeps its cursor, published snapshot and claims. Left
    in place it would block authoritative completion forever. It is retired — from local state and
    from the outgoing remote checkpoint, before the roster is read — only when ALL of these hold:
      · some root records it among its ``handoff_sources`` (durable, so this survives restarts);
      · no configured Shared Drive selection names it, and no bound, uncertain or relocating root is
        on it or on its way to it (``required`` and the obligations), and no root is unresolved —
        an unread root could live there;
      · every root it handed over is ``bound`` to a destination whose COMPLETE verified snapshot
        contains it (``_handoff_verified``);
      · the stream owes no work, page or removal barrier (``StateStore.retire_handoff_source_stream``).
    Nothing is concluded about its documents here: absence is only the ordinary complete-snapshot
    reconciliation, which the remaining streams submit, and its claims stand until that succeeds.
    Returns the drives retired.
    """
    obligations = state.root_obligations(integration_id, generation)
    sources = sorted({source for b in obligations.values() for source in b.handoff_sources})
    if not sources or any(b.status == "unresolved" for b in obligations.values()):
        return set()
    configured = {str(value) for value in options.get("shared_drive_ids") or [] if value}
    credential = credential_identity(options)
    remote = execution.progress.get("streams")
    retired: set[str] = set()
    for source_drive in sources:
        if source_drive in configured or source_drive in required:
            continue
        if any(b.drive_id == source_drive or b.pending_drive_id == source_drive for b in obligations.values()):
            continue
        # Every root this drive EVER handed over this generation (A→B→C: A and B), judged by where
        # each root is now — its current destination must hold it verified.
        handed = [(root, b) for root, b in obligations.items() if source_drive in b.handoff_sources]
        if not all(
            b.status == "bound" and b.drive_id != source_drive
            and _handoff_verified(state, execution, team, integration_id, credential, generation, root, b.drive_id)
            for root, b in handed
        ):
            continue
        namespace = StreamKey(team, integration_id, credential, source_drive).namespace(generation)
        local = state.get_progress(namespace) is not None
        if local and not state.retire_handoff_source_stream(namespace, generation):
            continue
        # Removed from the outgoing map; the caller publishes it (acknowledged) before any
        # connection-wide reconciliation. Until then the brain still holds the old stream, and this
        # retirement is repeated by the next run from the durable ``handoff_sources``.
        on_remote = isinstance(remote, dict) and remote.pop(source_drive, None) is not None
        if local or on_remote:
            retired.add(source_drive)
    return retired


def _retire_orphan_start_diagnostics(
    state: StateStore, execution: GdriveExecution, integration_id: str, generation: int,
    required: set[str],
) -> None:
    """Forget a stream that never started once no root needs its drive.

    Such a stream holds no token, snapshot or work. Left in place after the root that was on its
    way there moved on, it would be retried — and would keep the connection incomplete, and every
    removal that waits on it withheld — forever. It leaves the brain's record with the next
    checkpoint of this run, which is built from ``execution.progress``; a stream that holds a
    token or names a snapshot is never forgotten here, on either side.
    """
    remote = execution.progress.get("streams")
    for progress in state.list_progress(integration_id, generation):
        if progress.key.drive_id in required or not _unstarted(progress):
            continue
        if state.forget_unstarted_stream(progress.namespace) and isinstance(remote, dict):
            remote.pop(progress.key.drive_id, None)
    if isinstance(remote, dict):
        local = {progress.key.drive_id for progress in state.list_progress(integration_id, generation)}
        for drive_id in [
            str(drive_id) for drive_id, stream in remote.items()
            if str(drive_id) not in required and str(drive_id) not in local
            and isinstance(stream, dict) and _unstarted(stream) and not _holds_enumeration(stream)
        ]:
            remote.pop(drive_id, None)


def _remote_stream_ids(progress: dict[str, Any]) -> set[str]:
    """The drives the brain's checkpoint holds a stream record for."""
    streams = progress.get("streams")
    if isinstance(streams, dict):
        return {
            str(drive_id) for drive_id, stream in streams.items()
            if isinstance(stream, dict) and stream
        }
    legacy_drive = str(progress.get("drive_id") or "")
    return {legacy_drive} if legacy_drive else set()


def _stream_roster(
    state: StateStore, integration_id: str, generation: int, remote_progress: dict[str, Any],
    configured: Any = (),
) -> list[str]:
    """Every drive whose change stream this connection consumes: the one roster, from every source.

    A stream exists because a root is configured for or bound to its drive, because a root is on
    its way there, because local state holds it, or because the brain's checkpoint does. None of
    those alone is the roster: local state can be missing a stream the brain acknowledged, and a
    relocation destination has no state anywhere until its first run. A drive in the roster with
    no local progress is a stream nothing is known about yet — unknown, and never absent.
    """
    roster = {str(drive_id) for drive_id in configured if drive_id}
    roster.update(state.root_bindings(integration_id, generation).values())
    roster.update(
        str(binding.pending_drive_id)
        for binding in state.unsettled_roots(integration_id, generation).values()
        if binding.status == "relocating" and binding.pending_drive_id
    )
    roster.update(
        progress.key.drive_id for progress in state.list_progress(integration_id, generation)
    )
    roster.update(_remote_stream_ids(remote_progress))
    return sorted(roster, key=lambda value: (value != "my-drive", value))


def _stream_roots(
    state: StateStore, integration_id: str, generation: int, options: dict[str, Any],
    drive_id: str, bindings: dict[tuple[str, str], str] | None,
) -> list[tuple[str, str, str, bool]]:
    """The roots one stream enumerates now: those configured for it, less any that left its drive."""
    configured = _configured_roots(options, drive_id, bindings)
    if bindings is None:
        return configured
    leaving = _leaving_roots(state, integration_id, generation)
    return [root for root in configured if (root[1], root[0]) not in leaving]


def _bound_root_drift(
    state: StateStore, namespace: str, generation: int, snapshot_id: int | None, drive_id: str,
    bindings: dict[tuple[str, str], str], leaving: set[tuple[str, str]],
) -> tuple[set[tuple[str, str]], set[tuple[str, str]]]:
    """Compare one snapshot's bound file/folder roots with what its stream enumerates now.

    Returns ``(missing, stale)``: roots bound to this drive that the snapshot never enumerated, and
    roots it holds that are no longer this stream's. Either means the snapshot is not a verified
    statement of the stream's current selection.
    """
    held = {
        (str(row["root_kind"]), str(row["root_id"]))
        for row in (state.list_roots(namespace, generation, snapshot_id=snapshot_id)
                    if snapshot_id is not None else [])
    } & set(bindings)
    wanted = {root for root, bound in bindings.items() if bound == drive_id and root not in leaving}
    return wanted - held, held - wanted


def _selected_roots(options: dict[str, Any]) -> list[tuple[str, str]]:
    """Every explicitly selected file/folder root as ``(kind, id)``, in configuration order."""
    return (
        [("file", str(value)) for value in options.get("file_ids") or [] if value]
        + [("folder", str(value)) for value in options.get("folder_ids") or [] if value]
    )


def _bind_selected_roots(
    source: GoogleDriveSource,
    state: StateStore,
    integration_id: str,
    generation: int,
    options: dict[str, Any],
    *,
    restricted: set[str] | frozenset[str] = frozenset(),
    deferred: list[tuple[str, ProviderDeferred | None]] | None = None,
    observe: Callable[[str, ProviderDeferred], None] | None = None,
) -> dict[tuple[str, str], str]:
    """Bind every selected file/folder root to the change stream of the drive that contains it.

    A document or folder inside a Shared Drive is reported by that drive's change log, so it is
    consumed through that drive's stream and cursor. A binding only says where a root lives: it
    adds no ``drive`` root, so nothing else in that drive becomes selected. Bindings are durable
    and fixed for the generation — one provider read per root, resumed across runs.

    A root whose metadata cannot be read is an UNRESOLVED obligation, recorded durably with no
    drive at all: no stream is guessed for it — least of all My Drive — and nothing is enumerated
    through it. Binding then continues with the next root, so one unreadable selection never
    blocks the roots that can be read or the Shared Drives selected outright; the connection just
    cannot be complete, and no absence is inferred from stream membership, while any obligation is
    unresolved. Connection-wide authority loss (``BrainError``), a QUOTA answer (the account's
    hold) and the run's own budget stop the binding as before.

    Admission (AIO-1167 R50): a root under a standing provider minimum (``restricted``) is not read
    early — it stays an unresolved obligation. Any other provider deferral of a root's metadata (a
    503, a timeout) is THAT root's: it stays unresolved, its named minimum is handed to the
    coordinator's ``observe`` (its restriction journal) BEFORE the next root is read (R51 F2), it is
    reported through ``deferred``, and binding goes on with the next root.

    Returns the drive of every root whose drive is KNOWN.
    """
    bindings = state.root_bindings(integration_id, generation)
    for kind, root_id in _selected_roots(options):
        if (kind, root_id) in bindings:
            continue
        if root_id in restricted:
            state.mark_root_unresolved(
                integration_id, generation, kind, root_id,
                detail="selected root held by a provider minimum; not read before it passes",
            )
            if deferred is not None:
                deferred.append((root_id, None))
            continue
        try:
            meta = source._metadata(root_id)
        except BrainError:
            raise
        except ProviderDeferred as exc:
            if exc.category == "rate_limited" or exc.category in _LOCAL_DEADLINE_CATEGORIES:
                raise
            state.mark_root_unresolved(
                integration_id, generation, kind, root_id,
                detail=f"selected root metadata deferred ({exc.category})",
            )
            if observe is not None:
                observe(root_id, exc)
            if deferred is not None:
                deferred.append((root_id, exc))
            continue
        except Exception as exc:
            status = _provider_status(exc)
            state.mark_root_unresolved(
                integration_id, generation, kind, root_id,
                detail=(
                    "selected root not found" if status == 404
                    else f"selected root metadata unreadable ({status or type(exc).__name__})"
                ),
            )
            continue
        # The stream that observes it (R56): a non-member's individually shared file is the user log's.
        try:
            drive_id = _consumed_drive(source, kind, meta)
        except ProviderDeferred as exc:
            if exc.category == "rate_limited" or exc.category in _LOCAL_DEADLINE_CATEGORIES:
                raise
            state.mark_root_unresolved(
                integration_id, generation, kind, root_id,
                detail=f"selected root drive membership deferred ({exc.category})",
            )
            if observe is not None:
                observe(root_id, exc)
            if deferred is not None:
                deferred.append((root_id, exc))
            continue
        state.bind_root(integration_id, generation, kind, root_id, drive_id)
        bindings[(kind, root_id)] = drive_id
    return bindings


def _adopt_remote_root_evidence(
    state: StateStore, execution: GdriveExecution, integration_id: str, generation: int,
) -> None:
    """Reconcile every local root obligation with the brain's ACQUIRED root document (AIO-1167 R58).

    The fenced root document is canonical and SQLite is resumable work storage, so a worker whose
    local row is older than what another worker published must not keep — or republish — it: a stale
    ``bound(A)`` adopts the newer ``relocating``, ``uncertain`` or deferred evidence. An unpublished
    local transition made from the same acknowledged baseline stands; a conflict adopts the
    authority conservatively (``StateStore.reconcile_root_authority``). Runs before binding, the
    roster, retirement and any publication of this run.
    """
    for (kind, root_id), binding in parse_roots_section(execution.progress, generation).items():
        state.restore_root_obligation(integration_id, generation, kind, root_id, binding)


def _root_coverage_complete(
    state: StateStore, integration_id: str, generation: int, options: dict[str, Any],
) -> bool:
    """Whether EVERY selected file/folder root is bound to a known drive and settled.

    Coverage is positive evidence: a selected root with no obligation at all is unknown, not
    resolved, and an unresolved, uncertain or relocating one leaves the roster incomplete. This is
    the gate in front of every connection-wide absence conclusion.
    """
    if str(options.get("selection_state") or "") == "empty":
        # An intentionally empty selection names no root to bind.
        return not state.unsettled_roots(integration_id, generation)
    obligations = state.root_obligations(integration_id, generation)
    return all(
        (binding := obligations.get(root)) is not None and binding.status == "bound"
        and bool(binding.drive_id)
        for root in _selected_roots(options)
    ) and not state.unsettled_roots(integration_id, generation)


class IncompleteRootCoverage(BrainError):
    """A complete snapshot was about to be submitted while the selected-root roster is not covered."""

    def __init__(self) -> None:
        super().__init__(
            409, "root_coverage_incomplete",
            "selected roots are not all resolved; a complete snapshot would infer absence",
        )


async def _submit_complete_snapshot(
    client: BrainClient, execution: GdriveExecution, state: StateStore, options: dict[str, Any],
    snapshot: list[str], *, reason: str,
) -> dict[str, Any]:
    """THE coordinator's only way to submit a complete snapshot (connection-wide absence).

    It re-derives root coverage itself rather than trusting its caller, so a future call site
    cannot skip the gate; ``test_only_the_typed_boundary_submits_complete_snapshots`` fails the
    build if ``complete_snapshot_ids=`` appears anywhere else. The brain enforces the same rule
    against the fenced ``roots`` evidence (`lib/integrations/gdrive-root-coverage.ts`) — this side
    refuses before a request is made, that side refuses whatever the caller.
    """
    generation = int(execution.generation)
    if not _root_coverage_complete(state, execution.integration_id, generation, options):
        raise IncompleteRootCoverage()
    # The brain judges coverage from the root evidence it last ACKNOWLEDGED. A root can settle in a
    # run that writes no other checkpoint (a relocation cancelled during binding, every stream
    # already complete-pending), so the current evidence is published first whenever it differs —
    # otherwise the boundary would refuse a covered snapshot forever.
    current = roots_section(generation, state.root_obligations(execution.integration_id, generation))
    if execution.progress.get(ROOTS_KEY) != current:
        streams = state.list_progress(execution.integration_id, generation)
        if streams:
            await _checkpoint_progress(client, execution, state, streams[0].namespace)
    return await client.reconcile_gdrive(execution, complete_snapshot_ids=snapshot, reason=reason)


def _stream_ids(
    options: dict[str, Any], bindings: dict[tuple[str, str], str] | None = None,
) -> list[str]:
    """Return every independently consumed Drive change stream for the selected scope.

    With ``bindings`` (the coordinator always resolves them), a root without a known drive opens
    no stream: it is an unresolved obligation, never a guessed My Drive root. Only a caller that
    never resolved bindings at all (``None`` — the single-stream contract of direct unit callers)
    reads a file/folder root as a My Drive root.
    """
    if str(options.get("selection_state") or "selected") == "empty":
        # A synthetic no-provider stream makes the authoritative empty snapshot durable without
        # interpreting empty as all of My Drive.
        return ["my-drive"]
    streams = {str(value) for value in options.get("shared_drive_ids") or [] if value}
    if bindings is None:
        streams.update("my-drive" for _root in _selected_roots(options))
    else:
        streams.update(bindings[root] for root in _selected_roots(options) if root in bindings)
    return sorted(streams, key=lambda value: (value != "my-drive", value))


def _remote_stream(progress: dict[str, Any], drive_id: str) -> dict[str, Any]:
    streams = progress.get("streams")
    if isinstance(streams, dict):
        candidate = streams.get(drive_id)
        return dict(candidate) if isinstance(candidate, dict) else {}
    remote_drive = str(progress.get("drive_id") or drive_id)
    return dict(progress) if remote_drive == drive_id else {}


def _configured_roots(
    options: dict[str, Any], drive_id: str,
    bindings: dict[tuple[str, str], str] | None = None,
) -> list[tuple[str, str, str, bool]]:
    """The selected roots one stream enumerates: those bound to its drive, plus the drive itself
    only when the whole Shared Drive was selected.

    A root with no known drive is enumerated by NO stream (see ``_stream_ids``); only a caller that
    never resolved bindings (``None``) reads file/folder roots as My Drive roots."""
    def bound_here(root: tuple[str, str]) -> bool:
        if bindings is None:
            return drive_id == "my-drive"
        return bindings.get(root) == drive_id

    configured: list[tuple[str, str, str, bool]] = [
        (root_id, kind, drive_id, kind == "folder" and bool(options.get("recursive")))
        for kind, root_id in _selected_roots(options)
        if bound_here((kind, root_id))
    ]
    if drive_id in {str(value) for value in options.get("shared_drive_ids") or []}:
        configured.append((drive_id, "drive", drive_id, True))
    return configured


def _terminal_before_rescan(page: Any) -> bool:
    """True for a terminal change page that seeded a rescan.

    Such a page was read before the enumeration it caused. A document moved between two folders of
    the rescanned subtree while that enumeration ran can be listed in neither, and the only record
    of it is a change after this page's token. So this page's terminal token is not evidence that
    the stream is drained: only a change page read after the enumeration is.
    """
    return bool(
        page.page_kind == "changes" and page.rescan_snapshot_id is not None
        and page.terminal_token and not page.next_token
    )


# A start token just captured for a stream that had none is where its drain begins: whatever the
# record said about a finished drain was said without a token, and is not evidence of one.
_NO_TERMINAL_DRAIN: dict[str, Any] = {
    "terminal_drain_token": None, "terminal_drain_checkpoint_id": None,
    "terminal_drain_acknowledged": False, "terminal_drain_observation": None,
}


def _terminal_drain_complete(progress: Any) -> bool:
    if not progress.terminal_drain_acknowledged:
        return False
    if progress.terminal_drain_checkpoint_id != progress.checkpoint_id:
        return False
    if progress.terminal_drain_observation != progress.drain_observation:
        return False
    if progress.terminal_drain_token == "empty-selection":
        return progress.checkpoint_id == "empty-selection"
    return bool(progress.terminal_drain_token and progress.terminal_drain_token == progress.page_token)


def read_change_page(
    drive: Any,
    page_token: str,
    drive_id: str | None = None,
    provider_gate=None,
    request_executor=None,
) -> ChangePage:
    kwargs: dict[str, Any] = {
        "pageToken": page_token,
        "pageSize": 1000,
        "supportsAllDrives": True,
        "includeItemsFromAllDrives": True,
        "includeRemoved": True,
        # Drive emits two different shapes here. File changes carry ``fileId`` and may omit the
        # file resource after removal; Shared Drive access/membership changes carry
        # ``changeType=drive`` plus a top-level ``driveId`` and no file at all. Request both
        # discriminators explicitly -- treating a no-file change as an ignorable row would advance
        # the cursor past the only evidence that an entire selected subtree needs reconciliation.
        "fields": "nextPageToken,newStartPageToken,changes(changeType,removed,fileId,driveId,file(id,name,mimeType,trashed,driveId,parents,modifiedTime))",
    }
    if drive_id:
        kwargs["driveId"] = drive_id
    request = drive.changes().list(**kwargs)
    if request_executor:
        response = request_executor(request)
    else:
        if provider_gate:
            provider_gate()
        response = request.execute()
    return ChangePage(
        changes=list(response.get("changes") or []),
        next_page_token=response.get("nextPageToken"),
        new_start_page_token=response.get("newStartPageToken"),
    )


async def run_gdrive_stream(
    settings: BrainSettings,
    conn: Connection,
    state: StateStore,
    *,
    max_work: int = 500,
) -> IngestSummary:
    # Set only by the scheduler for an explicit Admin run (Run now / Retry) — R44 C7.
    rearm_exhausted = bool(conn.options.get("rearm_exhausted"))
    options = dict(conn.options)
    async with BrainClient(settings.base_url, settings.api_key, settings.team) as client:
        integration_id = str(options.get("integration_id") or "")
        if not integration_id:
            # Preserve documented local service-account configs: resolve their immutable Admin row
            # by name at run time, while credentials themselves stay local.
            selections = await client.fetch_integration_selections(include_disabled=True)
            match = next((row for row in selections
                          if row.get("type") == "gdrive" and row.get("name") == conn.name), None)
            if match:
                integration_id = str(match.get("id") or "")
        if not integration_id:
            return IngestSummary(conn.name, failed=1,
                                 failure_categories={"connection_authority_missing": 1})
        owner = str(uuid.uuid4())
        try:
            execution = await client.acquire_gdrive_execution(integration_id, owner)
        except BrainError as exc:
            busy = exc.code == "execution_busy"
            # Busy is a neutral deferral: another coordinator owns the work. Any other refusal of the
            # execution authority (paused, reconnect required, rotated principal, …) is a failure of
            # this run — counted as one, so it can never pass for healthy partial progress.
            return IngestSummary(
                conn.name, skipped=1, failed=0 if busy else 1, failure_categories={exc.code: 1},
                deferred=busy, backlog=None, integration_id=integration_id,
            )
        # One absolute deadline for the whole run. It travels with the execution so every sink and
        # reconcile call — limiter wait, request and retry — is bounded by the same instant.
        run_deadline = time.monotonic() + _RUN_DEADLINE_SECONDS
        execution = dataclasses.replace(execution, run_deadline=run_deadline)
        try:
            config = execution.config
            conn = effective_gdrive_connection(conn, config, integration_id)
            options = dict(conn.options)
            if str(options.get("selection_state") or "") == "empty":
                key = StreamKey(
                    settings.team, integration_id, credential_identity(options), "my-drive",
                )
                namespace = key.namespace(execution.generation)
                if state.get_progress(namespace) is None:
                    state.begin_generation(key, execution.generation, start_token="", phase="current")
                snapshot_id = state.begin_selection_snapshot(namespace, execution.generation, [])
                await _checkpoint_progress(
                    client, execution, state, namespace, phase="partial", page_token=None,
                    baseline_start_token=None, listing_complete=True,
                    last_error="stream complete; awaiting all-stream reconciliation",
                    retry_not_before=None,
                    checkpoint_id="empty-selection", terminal_drain_token="empty-selection",
                    terminal_drain_checkpoint_id="empty-selection",
                    terminal_drain_acknowledged=True,
                    drain_observation=1, terminal_drain_observation=1,
                    publish_snapshot=snapshot_id,
                )
                total = IngestSummary(conn.name, failure_categories={}, integration_id=integration_id)
                try:
                    reconciled = await _submit_complete_snapshot(
                        client, execution, state, options, [],
                        reason=f"complete empty gdrive scope generation {execution.generation}",
                    )
                    total.removed += int(reconciled.get("items") or 0)
                    await _checkpoint_complete_if_clean(
                        client, execution, state, namespace, execution.generation,
                        finalize=True,
                    )
                    total.authoritative_complete = True
                    total.backlog = 0
                except BrainError as exc:
                    if not isinstance(exc, BrainDeferred):
                        total.failed += 1
                    total.failure_categories[exc.code] = 1
                    # The empty selection is published, but absence is not established until its
                    # reconciliation is acknowledged — deferred or failed, that reconciliation is
                    # the outstanding work. Unmeasured would report the run failed; zero, done.
                    total.backlog = 1
                # An empty selection's one stream: fresh only once its empty drain was finalized
                # after the acknowledged reconciliation; otherwise its previous success, or unknown.
                total.cursor_age_seconds = _roster_cursor_age_seconds(
                    state, settings.team, integration_id, credential_identity(options),
                    execution.generation, ["my-drive"],
                )
                return total
            auth_mode = str(options.get("auth_mode") or "oauth")
            token_provider = None
            # From here on the immutable integration id is known: every early return carries it,
            # so `_poll_job` can report the failure for a local configuration too (AIO-1167 r37).
            if auth_mode == "oauth":
                try:
                    grant = await client.broker_gdrive_access_token(execution)
                except BrainError as exc:
                    return IngestSummary(conn.name, failed=1, failure_categories={exc.code: 1},
                                         integration_id=integration_id)
                options["granted_scopes"] = list(grant.get("scopes") or [])
                options["credential_identity"] = oauth_account_namespace(config, grant, options)
                token_provider = client.gdrive_token_provider(execution, grant)
            else:
                valid_service_account = bool(options.get("service_account_key_path"))
                if options.get("credential_json"):
                    try:
                        raw_credential = options["credential_json"]
                        parsed_credential = json.loads(raw_credential) if isinstance(raw_credential, str) else raw_credential
                        valid_service_account = valid_service_account or parsed_credential.get("type") == "service_account"
                    except (TypeError, ValueError, AttributeError):
                        pass
                if not valid_service_account:
                    return IngestSummary(conn.name, failed=1,
                                         failure_categories={"service_account_credentials_missing": 1},
                                         integration_id=integration_id)

            provider_gate = client.gdrive_provider_gate(execution)
            source_options = provider_source_options(options)
            source = GoogleDriveSource(
                **source_options, provider_gate=provider_gate, token_provider=token_provider,
            )
            if hasattr(source, "set_run_deadline"):
                source.set_run_deadline(run_deadline)
            if auth_mode == "service_account":
                # Bound to the account the loaded key authenticates as, BEFORE any stream (local
                # or remote) is restored or consumed under it (AIO-1167 R44 F3).
                try:
                    options["credential_identity"] = service_account_namespace(
                        source, config, options.get("service_account_status"),
                    )
                except ServiceAccountBindingRefused as exc:
                    return IngestSummary(conn.name, failed=1, failure_categories={exc.category: 1},
                                         integration_id=integration_id)
            # The account's provider hold — this run's state, or the brain's — is honoured before
            # the first Drive call of the run, streams or not (AIO-1167 R47 F5).
            account = credential_identity(options)
            # This verified account's acknowledged minimums — from whatever generation they were
            # observed in (R50) — are adopted before any provider read; another account's are not.
            _adopt_remote_restriction_evidence(
                state, execution, integration_id, execution.generation, account,
            )
            standing = _standing_account_hold(state, integration_id, execution.generation, account)
            if standing is not None:
                held = IngestSummary(
                    conn.name, skipped=1, failure_categories={str(standing["category"]): 1},
                    integration_id=integration_id,
                )
                # A hold (or a resource minimum) a previous run kept only locally — its publication
                # refused or lost — is repaired HERE, from this fresh acquisition's acknowledged
                # document, before returning and with no provider call while the hold stands
                # (R51 F3). One attempt; a failure stays truthfully unpublished.
                await _flush_restriction_evidence(client, execution, state, account, held)
                return held

            def restricted_now() -> set[str]:
                """The resources and operations under a standing provider minimum (R50 admission)."""
                return set(_standing_document_restrictions(state, integration_id, execution.generation, account))

            drive, _ = source._services()
            if auth_mode == "service_account" and options.get("service_account_status") == "pending":
                if _IDENTITY_PREREQUISITE_RESOURCE in restricted_now():
                    # The identity prerequisite is under a provider minimum: not read again early.
                    held = IngestSummary(
                        conn.name, skipped=1, failure_categories={"provider_restricted_resource": 1},
                        integration_id=integration_id,
                    )
                    # A restriction an earlier run kept only locally — its publication refused or
                    # lost — is published from this fresh acquisition, once, before returning
                    # (R51 blind-final 4), with the flush's authority-loss, uncertainty-latch and
                    # unpublished-diagnostic semantics. No identity read is made while it stands.
                    await _flush_restriction_evidence(client, execution, state, account, held)
                    return held
                try:
                    about = source._execute(drive.about().get(fields="user(emailAddress,permissionId)"))
                    user = about.get("user") or {}
                    identity = str(user.get("emailAddress") or "").strip()
                    if not identity:
                        return IngestSummary(
                            conn.name, failed=1,
                            failure_categories={"service_account_identity_unverified": 1},
                            integration_id=integration_id,
                        )
                    # What Drive says this credential is must be the loaded credential's account.
                    if options["credential_identity"] != _account_hash(identity):
                        return IngestSummary(
                            conn.name, failed=1,
                            failure_categories={"service_account_identity_mismatch": 1},
                            integration_id=integration_id,
                        )
                    await client.verify_gdrive_service_account(execution, identity)
                except BrainError as exc:
                    return IngestSummary(conn.name, failed=1, failure_categories={exc.code: 1},
                                         integration_id=integration_id)
                except ProviderDeferred as exc:
                    held = IngestSummary(conn.name, failure_categories={}, integration_id=integration_id)
                    if exc.category == "rate_limited" or exc.category in _LOCAL_DEADLINE_CATEGORIES:
                        await _open_account_hold(client, execution, state, integration_id, account, exc, held)
                    else:
                        # A non-quota answer defers this connection's identity PREREQUISITE (R50 F3):
                        # the run cannot go on without it, but it is no evidence of an account-wide
                        # outage, so it opens no account hold. A named minimum is kept for the
                        # prerequisite itself and published.
                        held.skipped += 1
                        _count(held, exc.category)
                        _count_retry_after_diagnostic(held, exc)
                        _restrict_resource(state, execution, account, _IDENTITY_PREREQUISITE_RESOURCE, exc)
                        await _flush_restriction_evidence(client, execution, state, account, held)
                    return held
            generation = execution.generation
            total = IngestSummary(conn.name, failure_categories={}, integration_id=integration_id)

            def start_blocked(drive_id: str) -> bool:
                """Whether a drive's stream exists, locally or on the brain, without a token."""
                local = state.get_progress(StreamKey(
                    settings.team, integration_id, credential_identity(options), drive_id,
                ).namespace(generation))
                started = local if local is not None else (
                    _remote_stream(execution.progress, drive_id) or None
                )
                return started is not None and _unstarted(started)

            def access_blocked(drive_id: str) -> bool:
                """Unstarted, started and waiting on a start token it cannot get (R56), or started
                with its change log REFUSED (``stream_access_denied``, R57): a member who lost
                membership keeps a valid cursor the provider no longer serves. Any of these only
                makes the drive's explicit file roots ELIGIBLE for the conservative non-member probe
                (readable metadata and a definitive ``drives.get`` 404); it is never read as a failed
                start-token request, and nothing else about the stream changes."""
                if start_blocked(drive_id):
                    return True
                local = state.get_progress(StreamKey(
                    settings.team, integration_id, credential_identity(options), drive_id,
                ).namespace(generation))
                if local is not None:
                    return _start_recovery_blocked(local) or bool(
                        not _unstarted(local) and local.last_error == _STREAM_ACCESS_DENIED
                    )
                remote = _remote_stream(execution.progress, drive_id)
                return bool(
                    remote and not _unstarted(remote) and (
                        (remote.get("recovery_required")
                         and str(remote.get("last_error") or "").startswith(_START_UNAVAILABLE))
                        or remote.get("last_error") == _STREAM_ACCESS_DENIED
                    )
                )

            # Which streams exist depends on where each selected root lives, so every root is bound
            # before any start token is captured. An unreadable root is a durable UNRESOLVED
            # obligation with no stream: nothing is enumerated on a guess, its binding is retried on
            # every run, and the roots and Shared Drives that ARE known still run (AC-04) — the
            # connection just cannot be complete, nor infer absence, until it resolves. Root
            # evidence the brain acknowledged is adopted first, so a sidecar that lost its local
            # state neither re-guesses a root's drive nor forgets one that is unresolved.
            # A root on its way to a drive whose change log an earlier run could not open is read
            # again here, so the streams below are those of where it is now.
            _adopt_remote_root_evidence(state, execution, integration_id, generation)
            # A root metadata or relocation answer that is not a quota answer is that ROOT's (R50 F3):
            # it is deferred with its named minimum, and the readable roots and streams go on.
            deferred_roots: list[tuple[str, ProviderDeferred | None]] = []
            # Whether THIS run's one run-level failure has been charged (R51 Note A). Set only where
            # the coordinator itself charges the run — never inferred from `total.failed`,
            # categories or document failures — and handed to every later flush/drain refusal so
            # a terminal authority refusal adds its category without a second charge.
            run_failure_counted = False

            def observe_root_minimum(root_id: str, deferral: ProviderDeferred) -> None:
                # Recorded in the local journal the moment it is read (R51 F2) — before the next
                # root's read can end the binding with a quota answer, a BrainError or the run's own
                # budget — so a later short circuit can never drop it.
                _restrict_resource(state, execution, account, root_id, deferral)

            def report_deferred_roots() -> None:
                for _root_id, deferral in deferred_roots:
                    if deferral is None:
                        _count(total, "provider_restricted_resource")
                        continue
                    _count(total, deferral.category)
                    _count_retry_after_diagnostic(total, deferral)

            try:
                root_bindings = _bind_selected_roots(
                    source, state, integration_id, generation, options,
                    restricted=restricted_now(), deferred=deferred_roots, observe=observe_root_minimum,
                )
                _reobserve_stalled_relocations(
                    source, state, integration_id, generation, start_blocked,
                    restricted=restricted_now(), deferred=deferred_roots, observe=observe_root_minimum,
                )
                _reobserve_conflicted_roots(
                    source, state, integration_id, generation,
                    restricted=restricted_now(), deferred=deferred_roots, observe=observe_root_minimum,
                )
                _revalidate_membership_event_roots(
                    source, state, integration_id, generation,
                    restricted=restricted_now(), deferred=deferred_roots, observe=observe_root_minimum,
                )
                _reclassify_nonmember_file_roots(
                    source, state, integration_id, generation, access_blocked,
                    restricted=restricted_now(), deferred=deferred_roots, observe=observe_root_minimum,
                )
            except BrainError as exc:
                total.failed += 1
                run_failure_counted = True
                total.failure_categories[exc.code] = 1
                report_deferred_roots()
                # Already-observed minimums are flushed where authority allows; the original
                # error stays the run's outcome either way (R51 F2).
                await _flush_restriction_evidence(
                    client, execution, state, account, total, cause=exc,
                    run_failure_counted=run_failure_counted,
                )
                return total
            except ProviderDeferred as exc:
                # Only a quota answer (the account's hold) or the run's own budget reaches here. The
                # roots deferred before it keep their recorded minimums, published with the hold.
                report_deferred_roots()
                await _open_account_hold(client, execution, state, integration_id, account, exc, total)
                return total
            report_deferred_roots()
            unresolved_roots = [
                root for root, binding in state.unsettled_roots(integration_id, generation).items()
                if binding.status == "unresolved"
            ]
            if unresolved_roots:
                # Diagnosed and counted as backlog below — one outstanding obligation per root —
                # without pretending to know what lies under a root nothing has read.
                total.failed += 1
                run_failure_counted = True
                total.failure_categories["selection_root_unresolved"] = len(unresolved_roots)
            # A stream this generation already consumes stays accounted for, so local state written
            # before roots were bound cannot leave a cursor that no run ever finishes.
            # A root read in another drive stays bound where it was until that drive's stream has a
            # start token, so the destination is a stream from here on and the old one stays one.
            relocating = {
                root: str(binding.pending_drive_id)
                for root, binding in state.unsettled_roots(integration_id, generation).items()
                if binding.status == "relocating" and binding.pending_drive_id
            }
            required = {*_stream_ids(options, root_bindings), *relocating.values()}
            # A drive no root lives in or is on its way to any more — the root moved on, or back —
            # is not a stream if it never started.
            _retire_orphan_start_diagnostics(state, execution, integration_id, generation, required)
            # A started stream whose roots were all handed over to verified destinations (R56). Its
            # removal is published by an ACKNOWLEDGED fenced checkpoint before anything else this run
            # may reconcile connection-wide; refused, nothing reconciles, and the next run retries.
            retirement_published = True
            if _retire_handed_over_streams(
                state, execution, settings.team, integration_id, generation, options, required,
            ):
                retirement_published = False
                publishing = state.list_progress(integration_id, generation)
                if publishing:
                    try:
                        await _checkpoint_progress(client, execution, state, publishing[0].namespace)
                        retirement_published = True
                    except BrainError as exc:
                        total.failure_categories[exc.code] = total.failure_categories.get(exc.code, 0) + 1
                        if _progress_uncertain(client, execution):
                            # It may have committed: no further changed checkpoint under a guessed
                            # revision. The next acquisition restores the brain's progress.
                            total.failure_categories.setdefault("checkpoint_unacknowledged", 1)
                            return total
            # The roster is read after that, from every source: a stream the brain's checkpoint
            # holds is consumed, and has to finish, even when this sidecar's local state lacks it.
            streams = _stream_roster(
                state, integration_id, generation, execution.progress, configured=required,
            )
            if not streams:
                if not unresolved_roots:
                    total.failed = 1
                    run_failure_counted = True
                    total.failure_categories["selection_unresolved"] = 1
                # Every selected root is unresolved: there is no stream to run, and no backlog is
                # measured — nothing is known about what lies under them. A minimum learned while
                # binding is still published, since no stream checkpoint will carry it. Either arm
                # above has charged the run, so a refused publication is not charged again.
                await _flush_restriction_evidence(
                    client, execution, state, account, total, run_failure_counted=run_failure_counted,
                )
                return total

            # Close the backfill race independently for every required stream before enumerating
            # any one of them. A small run budget therefore cannot leave later Shared Drives
            # without their pre-baseline opaque token.
            blocked: set[str] = set()
            if str(options.get("selection_state") or "") != "empty":
                for drive_id in streams:
                    key = StreamKey(
                        settings.team, integration_id, credential_identity(options), drive_id,
                    )
                    namespace = key.namespace(generation)
                    local = state.get_progress(namespace)
                    started = local if local is not None else (
                        _remote_stream(execution.progress, drive_id) or None
                    )
                    if started is not None and not _unstarted(started):
                        continue
                    if local is not None and _holds_enumeration(local):
                        # No token, yet something was enumerated through it: its own run asks for
                        # the token as the first step of a controlled rescan, never as a resume.
                        continue
                    if f"{_START_TOKEN_RESOURCE}{drive_id}" in restricted_now():
                        # This stream's start token is under a provider minimum: it is not asked for
                        # early, and nothing is enumerated without it; the other streams run.
                        _count(total, "provider_restricted_resource")
                        blocked.add(drive_id)
                        continue
                    try:
                        start = _capture_start_token(source, drive, drive_id)
                    except BrainError as exc:
                        total.failed += 1
                        run_failure_counted = True
                        total.failure_categories[exc.code] = 1
                        await _flush_restriction_evidence(
                            client, execution, state, account, total, cause=exc,
                            run_failure_counted=run_failure_counted,
                        )
                        return total
                    except ProviderDeferred as exc:
                        if exc.category == "rate_limited" or exc.category in _LOCAL_DEADLINE_CATEGORIES:
                            # A quota answer is the account's hold; a local budget stop keeps its own
                            # category (`dispatch_deadline` or `run_deadline`, R51 F7) and opens none.
                            await _open_account_hold(
                                client, execution, state, integration_id, account, exc, total,
                                run_failure_counted=run_failure_counted,
                            )
                            return total
                        # A 503 or timeout for one stream's start token is that STREAM's (R50 F3): it
                        # cannot enumerate without its token, and its named minimum is kept, while
                        # the independent streams still run.
                        total.skipped += 1
                        _count(total, exc.category)
                        _count_retry_after_diagnostic(total, exc)
                        _restrict_resource(state, execution, account, f"{_START_TOKEN_RESOURCE}{drive_id}", exc)
                        blocked.add(drive_id)
                        continue
                    except StreamStartUnavailable as exc:
                        # This drive's change log cannot be opened — a root that lives in a Shared
                        # Drive the account cannot list changes for. That is this stream's failure,
                        # not the connection's authority: it is recorded durably, as a stream that
                        # is not complete, and the streams that can be read still run. Nothing is
                        # enumerated without a token, and the connection cannot reconcile without
                        # this stream.
                        if local is None:
                            state.begin_generation(key, generation, start_token="", phase="partial")
                        await _checkpoint_start_unavailable(
                            client, execution, state, namespace, exc, total,
                        )
                        blocked.add(drive_id)
                        continue
                    if local is None:
                        state.begin_generation(key, generation, start_token=start)
                    await _checkpoint_progress(
                        client, execution, state, namespace, phase="baselining",
                        baseline_start_token=start, page_token=None, listing_complete=False,
                        last_error=None, last_attempt_at=_now(), **_NO_TERMINAL_DRAIN,
                    )

            # Only now — its destination stream holding a token captured before anything is
            # enumerated there — is a relocated root handed over. From this point the destination
            # enumerates that root (and nothing else of its drive) and the old stream stops
            # claiming it; the claims the old stream made stand until the destination's snapshot
            # is verified and every stream reconciles together.
            for (root_kind, root_id), destination in relocating.items():
                destination_progress = state.get_progress(StreamKey(
                    settings.team, integration_id, credential_identity(options), destination,
                ).namespace(generation))
                if destination_progress is None or _unstarted(destination_progress):
                    continue
                state.rebind_root(integration_id, generation, root_kind, root_id, destination)
            if relocating:
                root_bindings = state.root_bindings(integration_id, generation)

            remaining = max(0, max_work)
            # A stream whose provider read was refused this run (R44 C5): the others still run, but
            # no complete snapshot is submitted — its membership is not known now.
            stream_access_failed = False
            # A checkpoint whose acknowledgment was lost this run (R47 F3): nothing more is sent.
            acknowledgment_uncertain = False
            # One probe per deferred root per run, across every stream visit (R51 F4).
            deferred_root_probes: set[tuple[str, str]] = set()
            scheduled_streams = state.rotate_streams(
                integration_id, generation, [value for value in streams if value not in blocked],
            )
            for stream_index, drive_id in enumerate(scheduled_streams):
                key = StreamKey(
                    settings.team, integration_id, credential_identity(options), str(drive_id),
                )
                streams_left = len(scheduled_streams) - stream_index
                stream_work_budget = (
                    0 if remaining <= 0 else max(1, math.ceil(remaining / streams_left))
                )
                if rearm_exhausted:
                    # An explicit Admin run (Run now / Retry): exhausted obligations retry again.
                    state.rearm_exhausted(key.namespace(generation), generation)
                try:
                    part = await _run_gdrive_stream_unlocked(
                        settings, conn, state, client=client, execution=execution, options=options,
                        source=source, drive=drive, generation=generation, drive_id=str(drive_id),
                        namespace=key.namespace(generation), max_work=stream_work_budget,
                        discovery_budget=_MAX_DISCOVERY_PAGES_PER_STREAM,
                        retry_budget=_MAX_RETRY_WORK_PER_STREAM,
                        run_deadline=run_deadline,
                        provider_gate=provider_gate,
                        root_bindings=root_bindings,
                        deferred_root_probes=deferred_root_probes,
                    )
                except _ProviderAdmissionClosed as closed:
                    # The provider's wait governs the ACCOUNT (AIO-1167 R44 C6): every stream of it
                    # is held until then — persisted, so a restart makes no early call — and no
                    # further provider call is made this run. Remaining work is untouched.
                    # Held for the account too, so the next run's root and start-token reads wait
                    # as well, not just its drains (AIO-1167 R47 F5).
                    state.hold_connection(
                        integration_id, generation, account, closed.not_before, closed.category,
                    )
                    for held in scheduled_streams:
                        held_ns = StreamKey(
                            settings.team, integration_id, credential_identity(options), str(held),
                        ).namespace(generation)
                        if state.get_progress(held_ns) is not None:
                            state.update_progress(
                                held_ns, retry_not_before=closed.not_before, last_error=closed.category,
                            )
                    # The hold is also published, so a restart that restores from the brain's
                    # checkpoint cannot drop it. A failed publication keeps the local hold.
                    held_progress = state.get_progress(key.namespace(generation))
                    authority_lost = False
                    if held_progress is not None:
                        try:
                            await _checkpoint_progress(client, execution, state, key.namespace(generation))
                        except BrainError as exc:
                            if _is_terminal_authority(exc):
                                # The execution's authority ended (R51 L1): the hold, the progress
                                # made before it and the refusal are reported — not a generic
                                # coordinator error — and nothing further is sent or read.
                                authority_lost = True
                                # Not charged again when the run's failure was already charged
                                # (an unresolved selected root, R51 Note A).
                                _note_flush_authority(total, exc, charge=not run_failure_counted)
                            else:
                                # The checkpoint's own error stays reported (R51 F3); the unpublished
                                # hold is reported and repaired by the end-of-run publisher below.
                                total.failure_categories.setdefault(exc.code, 1)
                    if closed.partial is not None:
                        _merge_summary(total, closed.partial)  # work completed before the limit
                    total.failure_categories[closed.category] = total.failure_categories.get(closed.category, 0) + 1
                    _count_retry_after_diagnostic(total, closed)
                    if authority_lost:
                        outstanding = _restriction_outstanding(state, execution)
                        if outstanding:
                            _note_unpublished(total, outstanding)
                        return total
                    break
                except _AcknowledgmentUncertain as uncertain:
                    # The brain may hold a checkpoint this run never saw acknowledged (AIO-1167 R47
                    # F3). No further changed checkpoint is sent under a guessed revision — that
                    # could replace newer sibling streams, roots or watch state — and no document is
                    # charged. The run ends partial; the next acquisition restores the authority.
                    if uncertain.partial is not None:
                        _merge_summary(total, uncertain.partial)
                    total.failure_categories.setdefault("checkpoint_unacknowledged", 1)
                    acknowledgment_uncertain = True
                    break
                except Exception as exc:
                    if not _stream_access_refusal(exc):
                        raise
                    # A started stream the provider refuses (a non-quota 403/404 on its drive) is
                    # THIS stream's failure, not the connection's (AIO-1167 R44 C5): its cursor,
                    # membership and owed work are kept, the refusal is recorded durably, and the
                    # independent streams still run. A 403/404 proves nothing deleted.
                    stream_access_failed = True
                    namespace_now = key.namespace(generation)
                    if state.get_progress(namespace_now) is not None:
                        state.update_progress(
                            namespace_now, last_error=_STREAM_ACCESS_DENIED, last_attempt_at=_now(),
                        )
                    part = IngestSummary(
                        conn.name, failed=1, failure_categories={"stream_access_denied": 1},
                        integration_id=integration_id,
                    )
                exhausted = state.exhausted_count(key.namespace(generation), generation)
                if exhausted:
                    # Owed work whose automatic retries ran out: actionable, and still owed.
                    part.failed += exhausted
                    part.failure_categories["retry_exhausted"] = (
                        part.failure_categories.get("retry_exhausted", 0) + exhausted
                    )
                _merge_summary(total, part)
                # Fresh capacity is reserved independently of retries/failures. Debiting the
                # allocation (rather than summary counts) prevents malformed retry work in one
                # stream from stealing another stream's fresh-work turn.
                remaining = max(0, remaining - stream_work_budget)
                if any(code in _RUN_TERMINAL_CODES for code in part.failure_categories):
                    return total
                # A depleted document budget must not prevent later streams from validating and
                # durably restoring their independent cursor/snapshot state. They run with zero
                # work capacity, which permits checkpoint recovery but no provider-page drain.

            progresses = state.list_progress(integration_id, generation)
            # A selected root that is unresolved, uncertain or on its way to another drive — or has
            # no obligation recorded at all — and a stream whose published snapshot is not of the
            # roots it enumerates now, are an incomplete connection: reconciling would turn what
            # has not been verified into absence.
            verified = retirement_published and not stream_access_failed and not acknowledgment_uncertain and _root_coverage_complete(
                state, integration_id, generation, options,
            ) and not any(
                any(_bound_root_drift(
                    state, p.namespace, generation, p.active_snapshot, p.key.drive_id,
                    root_bindings, set(),
                ))
                for p in progresses
            )
            # Every stream of the roster has to be here and finished. One the roster names that has
            # no local progress yet, or holds no token, is unknown: nothing reconciles around it.
            if verified and len(progresses) == len(streams) and all(
                p.listing_complete
                and not _unstarted(p)
                and not p.recovery_required
                and p.building_snapshot is None
                and state.snapshot_complete(p.namespace, generation, p.active_snapshot)
                and state.pending_count(p.namespace, generation) == 0
                and state.next_uncommitted_page(p.namespace, generation) is None
                and _terminal_drain_complete(p)
                for p in progresses
            ):
                snapshot = sorted({
                    provider_id
                    for progress in progresses
                    for provider_id in state.membership_ids(
                        progress.namespace, generation, snapshot_id=progress.active_snapshot,
                    )
                })
                try:
                    reconciled = await _submit_complete_snapshot(
                        client, execution, state, options, snapshot,
                        reason=f"complete multi-stream gdrive scope generation {generation}",
                    )
                    total.removed += int(reconciled.get("items") or 0)
                    for completed in state.list_progress(integration_id, generation):
                        await _checkpoint_complete_if_clean(
                            client, execution, state, completed.namespace, generation,
                            finalize=True,
                        )
                    total.authoritative_complete = True
                except BrainError as exc:
                    # A reconciliation the rate limit or the run deadline deferred is not a failed
                    # one: every stream stays complete-pending, a staged snapshot keeps the pages
                    # the brain already holds, and the next run continues from them.
                    if not isinstance(exc, BrainDeferred):
                        total.failed += 1
                        run_failure_counted = True
                    total.failure_categories[exc.code] = total.failure_categories.get(exc.code, 0) + 1
            # Report only coordinator evidence, never infer zero from counters. A partial listing,
            # deferred retry, uncommitted page, or unacknowledged notification is backlog even when
            # this run processed no docs.
            progresses = state.list_progress(integration_id, generation)
            if len(progresses) == len(streams):
                total.backlog = sum(
                    state.pending_count(progress.namespace, generation)
                    + (1 if state.next_uncommitted_page(progress.namespace, generation) else 0)
                    + (1 if progress.building_snapshot is not None or progress.recovery_required else 0)
                    + (1 if state.pending_stream_hint(progress.key) is not None else 0)
                    for progress in progresses
                ) + len(state.unsettled_roots(integration_id, generation))
                if not total.authoritative_complete and total.backlog == 0:
                    # Enumeration/drain evidence is itself outstanding work.
                    total.backlog = sum(
                        0 if (
                            progress.listing_complete and not _unstarted(progress)
                            and _terminal_drain_complete(progress)
                        ) else 1
                        for progress in progresses
                    )
                if not total.authoritative_complete and total.backlog == 0:
                    # Every stream is complete, yet the all-stream reconciliation has not been
                    # acknowledged — deferred between the pages of a staged snapshot, or failed.
                    # Absence is not established until its final acknowledgment, so that
                    # reconciliation is the outstanding work: zero would report it done.
                    total.backlog = 1
            # A minimum this run learned or extended that no checkpoint carried — a deferred start
            # token, a drain-phase account hold whose checkpoint failed, a lost acknowledgment — is
            # published now, in ONE attempt (R50 F7, R51 F3). If that is refused or lost too
            # (including under the client's uncertainty latch, which sends nothing), the local
            # journal keeps it and the run says so, once per owner: `account_hold_unpublished`,
            # `document_restriction_unpublished`. A run already charged (an unresolved root, a failed
            # reconciliation) is not charged again by a refused publication here (R51 Note A).
            await _flush_restriction_evidence(
                client, execution, state, account, total, run_failure_counted=run_failure_counted,
            )
            # Cursor age is NOT an attempt clock: it is the age of the stalest required stream's
            # last acknowledged durable drain, over exactly this generation's roster, or unknown.
            total.cursor_age_seconds = _roster_cursor_age_seconds(
                state, settings.team, integration_id, credential_identity(options), generation, streams,
            )
            return total
        finally:
            # A pause, replacement, or key revocation may already have invalidated this lease. It
            # expires server-side; cleanup must never mask the run's real result or exception.
            try:
                await client.release_gdrive_execution(execution)
            except Exception:
                pass
            if "provider_gate" in locals():
                try:
                    provider_gate.close()
                except Exception:
                    pass
            if "token_provider" in locals() and token_provider is not None:
                try:
                    token_provider.close()
                except Exception:
                    pass


async def _run_gdrive_stream_unlocked(
    settings: BrainSettings,
    conn: Connection,
    state: StateStore,
    *,
    client: BrainClient,
    execution: GdriveExecution,
    options: dict[str, Any],
    source: GoogleDriveSource,
    drive: Any,
    generation: int,
    drive_id: str,
    namespace: str,
    max_work: int,
    discovery_budget: int | None = None,
    retry_budget: int | None = None,
    run_deadline: float | None = None,
    provider_gate=None,
    root_bindings: dict[tuple[str, str], str] | None = None,
    deferred_root_probes: set[tuple[str, str]] | None = None,
) -> IngestSummary:
    discovery_budget = max(0, discovery_budget if discovery_budget is not None else max_work)
    # The deferred roots already probed this run (R51 F4): the coordinator passes ONE set for the
    # whole run, so each root is probed at most once however many times its stream is visited.
    probe_report = IngestSummary(conn.name, failure_categories={})
    retry_budget = max(0, retry_budget if retry_budget is not None else min(max_work, 10))
    if run_deadline is not None and hasattr(source, "set_run_deadline"):
        source.set_run_deadline(run_deadline)
    if run_deadline is not None and execution.run_deadline is None:
        execution = dataclasses.replace(execution, run_deadline=run_deadline)
    key = StreamKey(settings.team, execution.integration_id, credential_identity(options), drive_id)
    progress = state.get_progress(namespace)
    had_local_progress = progress is not None
    remote = _remote_stream(execution.progress, drive_id)
    remote_start = str(remote.get("baseline_start_token") or "")
    remote_v2 = bool(
        execution.progress.get("version") == 2
        or any(key in remote for key in (
            "active_snapshot", "building_snapshot", "checkpoint_id", "drain_observation",
        ))
    )
    if progress is None and remote_start:
        progress = state.begin_generation(key, generation, start_token=remote_start,
                                          phase=str(remote.get("phase") or "baselining"))

    remote_snapshot = remote.get("active_snapshot")
    if (
        remote_v2
        and had_local_progress
        and remote_snapshot is not None
        and state.snapshot_build_complete(namespace, generation, int(remote_snapshot))
    ):
        # Server ack won the race but the process died before the SQLite mirror swap. The swap
        # carries the decision about what the replaced snapshots still owed, so it is made here
        # exactly as it would have been, before any of that work can be retried below.
        state.publish_selection_snapshot(namespace, generation, int(remote_snapshot))
        progress = state.get_progress(namespace)

    remote_building = remote.get("building_snapshot")
    remote_checkpoint_id = str(remote.get("checkpoint_id") or "")
    if remote_v2 and had_local_progress and remote_checkpoint_id:
        checkpoint_page = state.get_page(namespace, generation, remote_checkpoint_id)
        remote_cursor = str(remote.get("page_token") or "")
        if (
            checkpoint_page is not None
            and checkpoint_page.committed_at is None
            and checkpoint_page.page_kind == "changes"
            and remote_cursor
            and remote_cursor in {checkpoint_page.next_token, checkpoint_page.terminal_token}
            and (
                int(remote.get("drain_observation") or 0) == checkpoint_page.drain_observation
                # Retiring a terminal page that seeded a rescan opens the observation of the
                # drain that has to confirm it, in that same checkpoint.
                or (
                    _terminal_before_rescan(checkpoint_page)
                    and progress is not None
                    and int(remote.get("drain_observation") or 0) == progress.drain_observation + 1
                )
            )
        ):
            # The authoritative cursor checkpoint succeeded and the process died before its local
            # mirror. Retire exactly that durable page; pending document work remains independent.
            state.commit_page(namespace, generation, remote_checkpoint_id, require_acks=False)
            state.purge_committed_page_work(namespace, generation, remote_checkpoint_id)
    remote_listing_complete = bool(remote.get("listing_complete"))
    remote_active_matches = (
        remote_snapshot is not None
        and state.snapshot_complete(namespace, generation, int(remote_snapshot))
    ) if remote_listing_complete else (
        remote_snapshot is None
        or state.snapshot_complete(namespace, generation, int(remote_snapshot))
    )
    durable_remote_match = bool(
        had_local_progress
        and progress is not None
        and remote_active_matches
        and (
            remote_building is None
            or progress.building_snapshot == int(remote_building)
        )
        and state.page_committed(namespace, generation, remote.get("checkpoint_id"))
    )
    if progress is not None and execution.progress_revision > progress.server_revision:
        mirror_fields = (
            ("phase", "page_token", "baseline_start_token", "traversal_token",
             "listing_complete", "last_attempt_at", "last_success_at", "last_error",
             "retry_not_before", "active_snapshot", "building_snapshot",
             "recovery_required", "checkpoint_id", "terminal_drain_token",
             "terminal_drain_checkpoint_id", "terminal_drain_acknowledged",
             "drain_observation", "terminal_drain_observation")
            if not remote_v2 or durable_remote_match
            else ("last_attempt_at", "last_success_at", "last_error", "retry_not_before")
        )
        mirror = {field: remote[field] for field in mirror_fields if field in remote}
        state.update_progress(namespace, **mirror, server_revision=execution.progress_revision)
        progress = state.get_progress(namespace)
    if progress is not None and _retry_deferred(progress.retry_not_before):
        return IngestSummary(
            conn.name, skipped=1,
            failure_categories={"provider_retry_deferred": 1},
        )
    if str(options.get("selection_state") or "") == "empty":
        if progress is None:
            progress = state.begin_generation(key, generation, start_token="", phase="current")
        snapshot_id = state.begin_selection_snapshot(namespace, generation, [])
        await _checkpoint_progress(
            client, execution, state, namespace, phase="current", page_token=None,
            baseline_start_token=None, listing_complete=True, last_success_at=_now(),
            last_error=None, retry_not_before=None,
            checkpoint_id="empty-selection", terminal_drain_token="empty-selection",
            terminal_drain_checkpoint_id="empty-selection",
            terminal_drain_acknowledged=True,
            drain_observation=1, terminal_drain_observation=1,
            publish_snapshot=snapshot_id,
        )
        return IngestSummary(conn.name, failure_categories={})
    if progress is None or (_unstarted(progress) and not _holds_enumeration(progress)):
        if _start_token_restricted(state, execution, options, drive_id):
            return _stream_start_deferred(
                state, execution, options, drive_id, None, IngestSummary(conn.name, failure_categories={}),
            )
        try:
            start = _capture_start_token(source, drive, drive_id)
        except ProviderDeferred as exc:
            return _stream_start_deferred(
                state, execution, options, drive_id, exc, IngestSummary(conn.name, failure_categories={}),
            )
        except StreamStartUnavailable as exc:
            # Nothing is enumerated without a token: the stream is only its diagnostic.
            if progress is None:
                state.begin_generation(key, generation, start_token="", phase="partial")
            unavailable = IngestSummary(conn.name, failure_categories={})
            await _checkpoint_start_unavailable(client, execution, state, namespace, exc, unavailable)
            return unavailable
        if progress is None:
            progress = state.begin_generation(key, generation, start_token=start)
        await _checkpoint_progress(
            client, execution, state, namespace, phase="baselining",
            baseline_start_token=start, page_token=None, listing_complete=False,
            last_error=None, last_attempt_at=_now(), **_NO_TERMINAL_DRAIN,
        )
        progress = state.get_progress(namespace)

    if progress is not None:
        # A recovery that could not capture its start token is owed until it does: the flag is
        # durable, so a later run retries it even when local and remote state then agree.
        # A stream still without a token here names a snapshot: it was enumerated with nothing to
        # drain from. A token alone would not make that enumeration trustworthy, so it is rescanned
        # from a token captured first — and is complete only after a drain from that token.
        needs_recovery = (
            (remote_v2 and not durable_remote_match) or _start_recovery_blocked(progress)
            or _unstarted(progress)
        )
        if needs_recovery:
            if _start_token_restricted(state, execution, options, drive_id):
                return _stream_start_deferred(
                    state, execution, options, drive_id, None, IngestSummary(conn.name, failure_categories={}),
                )
            try:
                fresh = _capture_start_token(source, drive, drive_id)
            except ProviderDeferred as exc:
                # What this stream holds stays exactly as it is; only its recovery waits (R50 F3).
                return _stream_start_deferred(
                    state, execution, options, drive_id, exc, IngestSummary(conn.name, failure_categories={}),
                )
            except StreamStartUnavailable as exc:
                # The recovery cannot begin. What this stream holds stays exactly as it is — its
                # cursor, its published membership, the claims made through it — and the stream
                # is recorded as waiting on its drive, which keeps the connection from
                # reconciling while the other streams run.
                unavailable = IngestSummary(conn.name, failure_categories={})
                await _checkpoint_start_unavailable(
                    client, execution, state, namespace, exc, unavailable,
                )
                return unavailable
            # A build left unfinished was enumerated under another token, or under none. A folder
            # it already listed is not listed again by resuming it, and a document that entered
            # that folder before this token is in no change after it. So the build is superseded,
            # never resumed: every root is listed again under new page identities, and no page
            # read before this token can move the cursor or end the drain that has to follow. The
            # published membership and every document obligation stay until the replacement is
            # published.
            state.restart_selection_snapshot(
                namespace, generation, _stream_roots(
                    state, execution.integration_id, generation, options, drive_id, root_bindings,
                ),
                start_token=fresh,
            )
            await _checkpoint_progress(
                client, execution, state, namespace, phase="baselining",
                baseline_start_token=fresh, page_token=None, listing_complete=False,
                recovery_required=True, last_error="local durable checkpoint unavailable; controlled recovery",
                active_snapshot=(progress.active_snapshot if state.snapshot_complete(
                    namespace, generation, progress.active_snapshot,
                ) else None),
                checkpoint_id=None, terminal_drain_token=None,
                terminal_drain_checkpoint_id=None, terminal_drain_acknowledged=False,
                drain_observation=state.get_progress(namespace).drain_observation,
                terminal_drain_observation=None,
            )
            progress = state.get_progress(namespace)

    if root_bindings is not None and progress is not None:
        # The roots a stream enumerates change only when a selected root is rebound to another
        # drive's stream. A snapshot built before that is not a statement of the current roots:
        # a build in progress gains the root it lacks, and a published snapshot is replaced by a
        # controlled rescan of exactly the current roots. The cursor stays where it is — it was
        # captured before this enumeration — and the published membership stays authoritative
        # until the replacement is complete.
        progress = state.get_progress(namespace)
        leaving = _leaving_roots(state, execution.integration_id, generation)
        current_roots = _stream_roots(
            state, execution.integration_id, generation, options, drive_id, root_bindings,
        )
        if progress.building_snapshot is not None:
            missing, _stale = _bound_root_drift(
                state, namespace, generation, progress.building_snapshot, drive_id,
                root_bindings, leaving,
            )
            if missing:
                state.begin_selection_snapshot(namespace, generation, current_roots)
        elif state.snapshot_complete(namespace, generation, progress.active_snapshot) and (
            any(_bound_root_drift(
                state, namespace, generation, progress.active_snapshot, drive_id,
                root_bindings, leaving,
            ))
            # A root this stream's enumeration deferred (R50 F4) whose read is admissible again: its
            # retained membership is replaced by a verified one through the same controlled rescan —
            # started only once a bounded root-local probe located the root (R51 F4).
            or _deferred_root_admissible(
                state, execution, options, generation, drive_id,
                source=source, probed=deferred_root_probes, diagnostics=probe_report,
            )
        ):
            state.begin_selection_snapshot(namespace, generation, current_roots)
            await _checkpoint_progress(
                client, execution, state, namespace, phase="baselining", listing_complete=False,
                last_error="selected roots rebound; controlled rescan",
                terminal_drain_token=None, terminal_drain_checkpoint_id=None,
                terminal_drain_acknowledged=False,
                drain_observation=progress.drain_observation + 1,
                terminal_drain_observation=None,
            )
        progress = state.get_progress(namespace)

    summary = IngestSummary(conn.name, failure_categories={})
    _merge_summary(summary, probe_report)  # a deferred root's probe diagnostics, never charged
    state.update_progress(namespace, last_attempt_at=_now())
    try:
        if run_deadline is not None and time.monotonic() >= run_deadline:
            await _checkpoint_progress(
                client, execution, state, namespace, phase="partial",
                last_error="overall run deadline exhausted",
            )
            summary.skipped += 1
            summary.failure_categories["run_deadline"] = 1
            return summary
        # Retries and fresh work have independent bounded capacity. A permanently malformed item
        # therefore cannot consume discovery/fresh capacity forever, while retries still receive a
        # deterministic share on every run once their not-before time arrives.
        await _drain_pending(
            client, execution, source, conn, state, namespace, generation, summary, retry_budget,
            work_class="retry",
        )
        fresh_remaining = max_work
        fresh_remaining -= await _drain_pending(
            client, execution, source, conn, state, namespace, generation, summary, max_work,
            work_class="fresh",
        )
        fresh_remaining -= await _finish_materialized_pages(
            client, execution, source, conn, state, namespace, generation, summary,
            max(0, fresh_remaining),
        )

        progress = state.get_progress(namespace)
        if progress and progress.phase in {"baselining", "partial"} and not progress.listing_complete:
            try:
                complete, consumed = await _enumerate_baseline(
                    client, execution, source, drive, options, state, namespace, generation,
                    drive_id, conn, summary,
                    max(0, fresh_remaining), discovery_budget,
                    root_bindings=root_bindings,
                )
                fresh_remaining = max(0, fresh_remaining - consumed)
            except (BrainError, _ProviderAdmissionClosed, _AcknowledgmentUncertain):
                # Authority errors stay run-terminal; an account rate limit raised by the baseline's
                # drain is the coordinator's account hold, never a baseline read failure (R45 H1);
                # an unacknowledged checkpoint is the coordinator's to stop on (R47 F3).
                raise
            except ProviderDeferred as exc:
                if exc.category == "rate_limited":
                    raise _account_hold(exc) from exc
                await _checkpoint_progress(
                    client, execution, state, namespace, phase="partial",
                    last_error=exc.category, retry_not_before=exc.not_before,
                )
                summary.failed += 1
                summary.failure_categories[exc.category] = summary.failure_categories.get(exc.category, 0) + 1
                _count_retry_after_diagnostic(summary, exc)
                return summary
            except Exception as exc:
                await _checkpoint_progress(
                    client, execution, state, namespace, phase="partial",
                    last_error=f"baseline: {type(exc).__name__}",
                )
                summary.failed += 1
                summary.failure_categories["provider_read"] = summary.failure_categories.get("provider_read", 0) + 1
                return summary
            selection_state = str(options.get("selection_state") or "selected")
            if selection_state in {"denied", "partial"}:
                await _checkpoint_progress(client, execution, state, namespace,
                                           phase="partial", last_error=f"selection {selection_state}")
                summary.failed += 1
                summary.failure_categories[f"selection_{selection_state}"] = 1
                return summary
            if not complete:
                await _checkpoint_progress(
                    client, execution, state, namespace, phase="partial",
                    last_error="baseline work remains",
                )
                return summary
            completed_progress = state.get_progress(namespace)
            catchup_token = (
                completed_progress.page_token or completed_progress.baseline_start_token
                if completed_progress else progress.baseline_start_token
            )
            building_snapshot = completed_progress.building_snapshot if completed_progress else None
            if building_snapshot is None:
                raise RuntimeError("completed baseline has no durable snapshot incarnation")
            await _checkpoint_progress(
                client, execution, state, namespace, listing_complete=True,
                phase="catching_up", page_token=catchup_token, last_error=None,
                retry_not_before=None,
                terminal_drain_token=None, terminal_drain_checkpoint_id=None,
                terminal_drain_acknowledged=False, terminal_drain_observation=None,
                publish_snapshot=building_snapshot,
            )

        progress = state.get_progress(namespace)
        token = (progress.page_token or progress.baseline_start_token) if progress else None
        if token and progress and (
            progress.drain_observation == 0 or progress.terminal_drain_acknowledged
        ):
            # A provider token identifies a cursor position, not a poll. Persist a new observation
            # before dispatching the first page of each drain; unfinished pages keep their existing
            # observation across restart even when the opaque input token is unchanged.
            await _checkpoint_progress(
                client, execution, state, namespace, phase="catching_up",
                last_error=None, drain_observation=progress.drain_observation + 1,
                terminal_drain_token=None, terminal_drain_checkpoint_id=None,
                terminal_drain_acknowledged=False, terminal_drain_observation=None,
            )
            progress = state.get_progress(namespace)
        # A notification is acknowledged only by a drain that began after it: read the sequence
        # BEFORE the first change page, and acknowledge exactly that sequence once a page read in
        # this run reaches the terminal token. A notification arriving meanwhile stays pending.
        observed_hint = state.pending_stream_hint(key)
        drained_to_terminal = False
        pages_read = 0
        while token and pages_read < discovery_budget:
            if run_deadline is not None and time.monotonic() >= run_deadline:
                await _checkpoint_progress(
                    client, execution, state, namespace, phase="partial",
                    last_error="overall run deadline exhausted",
                )
                summary.failure_categories["run_deadline"] = 1
                return summary
            existing = state.next_uncommitted_page(namespace, generation)
            if existing is not None:
                consumed = await _finish_materialized_pages(
                    client, execution, source, conn, state, namespace, generation, summary,
                    max(0, fresh_remaining),
                )
                fresh_remaining = max(0, fresh_remaining - consumed)
                if existing.rescan_snapshot_id is not None and not state.snapshot_complete(
                    namespace, generation, existing.rescan_snapshot_id,
                ):
                    await _checkpoint_progress(client, execution, state, namespace,
                                               phase="partial", last_error="change page pending")
                    return summary
                token = existing.next_token or existing.terminal_token or token
                if existing.terminal_token and not existing.next_token and not (
                    _terminal_before_rescan(existing)
                    and state.page_committed(namespace, generation, existing.page_id)
                ):
                    break
                # A terminal page that seeded a rescan was read before that rescan enumerated
                # anything: the drain goes on from its token, and only a page read now can end it.
                continue
            changes_operation = f"{_CHANGES_RESOURCE}{drive_id}"
            if _operation_restricted(state, execution, credential_identity(options), changes_operation):
                # A provider-named minimum for THIS drive's change pages stands (A3) — learned in an
                # earlier generation, run or fresh store, it is not waived by a scope edit, reconnect
                # or restart. No page is read before it; the cursor stays; the stream is partial.
                await _checkpoint_progress(
                    client, execution, state, namespace, phase="partial",
                    last_error="provider_restricted_resource",
                )
                summary.skipped += 1
                _count(summary, "provider_restricted_resource")
                return summary
            try:
                page = read_change_page(
                    drive, token, None if drive_id == "my-drive" else str(drive_id),
                    provider_gate, source._execute,
                )
                pages_read += 1
            except ProviderCursorInvalid:
                # A 410 never becomes an empty snapshot. Retain the old cursor as evidence, clear
                # only the selected-membership traversal, and capture a fresh start token before
                # the controlled baseline rescan.
                if _start_token_restricted(state, execution, options, drive_id):
                    return _stream_start_deferred(state, execution, options, drive_id, None, summary)
                try:
                    fresh = _capture_start_token(source, drive, drive_id)
                except ProviderDeferred as deferral:
                    # The rejected cursor and the published membership stay; only the recovery's
                    # start token waits — this stream's alone, unless it is a quota answer (R50 F3).
                    return _stream_start_deferred(state, execution, options, drive_id, deferral, summary)
                except StreamStartUnavailable as exc:
                    # The cursor is gone and its drive will not issue another. Nothing is reset:
                    # the old cursor and the published membership stay, and the recovery this
                    # stream owes is retried from the top of every run until a token is captured.
                    await _checkpoint_start_unavailable(
                        client, execution, state, namespace, exc, summary,
                    )
                    return summary
                state.reset_selection_snapshot(namespace, generation, start_token=fresh)
                await _checkpoint_progress(
                    client, execution, state, namespace, phase="baselining",
                    baseline_start_token=fresh, page_token=None, listing_complete=False,
                    last_error="invalid cursor; controlled rescan",
                    terminal_drain_token=None, terminal_drain_checkpoint_id=None,
                    terminal_drain_acknowledged=False,
                    drain_observation=state.get_progress(namespace).drain_observation,
                    terminal_drain_observation=None,
                )
                summary.failed += 1
                summary.failure_categories["invalid_cursor"] = 1
                return summary
            except ProviderDeferred as exc:
                if exc.category == "rate_limited":
                    # The account's wait, not this stream's: every stream of it is held (R45 H1).
                    raise _account_hold(exc) from exc
                # A provider-named minimum for this drive's change pages is journaled durably for the
                # operation (A3) BEFORE the checkpoint, so a generation transition cannot waive it.
                _restrict_operation(state, execution, credential_identity(options), changes_operation, exc)
                await _checkpoint_progress(
                    client, execution, state, namespace, phase="partial",
                    last_error=exc.category, retry_not_before=exc.not_before,
                )
                summary.failed += 1
                summary.failure_categories[exc.category] = 1
                _count_retry_after_diagnostic(summary, exc)
                return summary
            obligations: list[tuple[str, str, dict[str, Any]]] = []
            membership_additions: list[tuple[str, str, str] | tuple[str, str, str, str | None]] = []
            membership_removals: list[str] = []
            membership_root_removals: list[tuple[str, str]] = []
            # A folder/drive control-plane change cannot be reduced to one document obligation.
            # Materializing a replacement snapshot on the same durable page keeps the prior
            # membership authoritative until traversal completes, and prevents cursor retirement
            # until the descendant reconciliation evidence has been published.
            subtree_recovery_required = False
            active_roots = state.list_roots(
                namespace, generation,
                snapshot_id=state.snapshot_id(namespace, building=False),
            )
            # A removal in this drive's change log is absence only while the selected root it
            # falls under still lives in this drive. A root moved to another drive is reported
            # here exactly like a deletion — of the root and of everything under it — so before a
            # change may retire a claim, each bound root it is claimed through is read where it is
            # NOW. The page was read first: a move that caused any of its removals has already
            # happened, and the read cannot miss it.
            bound_root_kinds = {
                str(row["root_id"]): str(row["root_kind"])
                for row in active_roots
                if (str(row["root_kind"]), str(row["root_id"])) in (root_bindings or {})
            }
            leaving = (
                _leaving_roots(state, execution.integration_id, generation)
                if bound_root_kinds else set()
            )
            root_observations: dict[str, RootObservation] = {}
            unverified: list[tuple[str, ProviderDeferred | None]] = []
            # Roots under a standing provider minimum are not read here either (R50 admission).
            restricted_roots = set(_standing_document_restrictions(
                state, execution.integration_id, generation, credential_identity(options),
            ))
            # Roots this stream's enumeration DEFERRED (R50 F4): their snapshot membership is
            # retained, not enumerated, so their ancestry is incomplete — conservative admission
            # evidence for the per-document classifier below (R51 F1). Durable, so it survives a
            # reopened state; empty on fresh state, where no membership is retained either.
            deferred_here = {
                root_id for _kind, root_id in state.deferred_roots(
                    execution.integration_id, generation, drive_id,
                )
            }
            held_by_deferred_root = False

            def absence_withheld(root_ids: Any) -> bool:
                """Whether a removal under these roots must NOT become absence. Records why."""
                held = False
                for root_id in sorted({str(value) for value in root_ids}):
                    root_kind = bound_root_kinds.get(root_id)
                    if root_kind is None:
                        continue
                    if (root_kind, root_id) in leaving:
                        held = True
                        continue
                    if root_id in restricted_roots:
                        # Not read before its minimum passes. Its claims stand — nothing under it is
                        # absence — and the page itself is not blocked: the rescan it seeds defers
                        # this root and lets the independent work go on (R50 F3/F4).
                        held = True
                        continue
                    try:
                        observed = _observe_root(source, root_id, drive_id, root_observations, root_kind)
                    except ProviderDeferred as exc:
                        if exc.category == "rate_limited":
                            # The account's wait, not this stream's (R49 F2): the account-hold owner
                            # stops every further call for it. This page is not materialized, so it
                            # stays unresolved and nothing is removed.
                            raise _account_hold(exc) from exc
                        if exc.category not in _LOCAL_DEADLINE_CATEGORIES and _restrict_resource(
                            state, execution, credential_identity(options), root_id, exc,
                        ):
                            # A named minimum for this ROOT (R50 F3): kept, reported, and from here
                            # on handled as a restricted root — claims stand, the page goes on.
                            restricted_roots.add(root_id)
                            _count(summary, exc.category)
                            _count_retry_after_diagnostic(summary, exc)
                            held = True
                            continue
                        unverified.append((root_id, exc))
                        held = True
                        continue
                    if observed.state == "elsewhere":
                        state.mark_root_relocating(
                            execution.integration_id, generation, root_kind, root_id, drive_id,
                            destination=str(observed.drive_id),
                        )
                        leaving.add((root_kind, root_id))
                        held = True
                    elif observed.state == "unverified":
                        state.mark_root_uncertain(
                            execution.integration_id, generation, root_kind, root_id, drive_id,
                            detail=str(observed.detail),
                        )
                        unverified.append((root_id, None))
                        held = True
                    elif observed.state == "absent" and root_id in deferred_here:
                        # A DEFERRED root's snapshot holds only retained placeholder membership
                        # (AIO-1167 R51 F3-A). Its 404 here would discharge the listing debt while
                        # the placeholder's other members stay unverified, so it is not recorded:
                        # the removal is withheld, the caller seeds recovery, and the controlled
                        # replacement snapshot's open traversal records the 404 itself.
                        held = True
                    elif observed.state == "absent":
                        # A verified absence keeps — or records — the root's loss (R49 F2); only a
                        # root read present where it is bound is settled. Claims and absence gates
                        # are decided below exactly as before. Counted once per run (R50 F7).
                        if state.record_root_unavailable(
                            execution.integration_id, generation, root_kind, root_id,
                            detail=_ROOT_UNAVAILABLE_DETAIL,
                        ):
                            _note_root_unavailable(summary, root_kind, root_id)
                    else:
                        state.settle_root(execution.integration_id, generation, root_kind, root_id)
                return held

            def direct_root_left(file_id: str, file: dict[str, Any]) -> bool | None:
                """Whether a direct, bound FILE root is consumed by another stream now (R56) — or
                ``None`` when that cannot be decided now and the change is HELD (AIO-1167 R64).

                The routing decision may be the first call this run makes to the membership oracle
                for the root's Shared Drive, so it is admitted and deferred by the same owners as a
                root read: a root under a standing provider minimum is not probed early; a quota
                answer is the account's hold (raised: this page is not materialized, the cursor
                stays); a provider-named minimum becomes this ROOT's restriction and the page goes
                on, its claim standing; any other deferral — a timeout, the run's own budget — is
                ``unverified``: the page is not retained and is read again, and no provider minimum
                is recorded for it."""
                physical = str(file.get("driveId") or "my-drive")
                answered = getattr(source, _DRIVE_MEMBERSHIP_CACHE, None)
                probes = physical != "my-drive" and not (isinstance(answered, dict) and physical in answered)
                if probes and file_id in restricted_roots:
                    return None
                try:
                    return _consumed_drive(source, "file", file, drive_id) != drive_id
                except ProviderDeferred as exc:
                    if exc.category == "rate_limited":
                        raise _account_hold(exc) from exc
                    if exc.category not in _LOCAL_DEADLINE_CATEGORIES and _restrict_resource(
                        state, execution, credential_identity(options), file_id, exc,
                    ):
                        restricted_roots.add(file_id)
                        _count(summary, exc.category)
                        _count_retry_after_diagnostic(summary, exc)
                        return None
                    unverified.append((file_id, exc))
                    return None

            last_trashed: dict[str, bool] = {}
            # Membership removals that come from explicit trash, kept apart so they follow the same
            # final observation as the trash obligation they belong to (R51 P2, below).
            trash_membership_removals: list[str] = []
            for change in page.changes:
                change_type = str(change.get("changeType") or "file")
                changed_drive_id = str(change.get("driveId") or "")
                file_id = str(change.get("fileId") or (change.get("file") or {}).get("id") or "")
                confirmed_removed = bool(change.get("removed") or (change.get("file") or {}).get("trashed"))
                if change_type == "drive":
                    # A top-level Drive tombstone/access change deliberately has no fileId. It is
                    # relevant only to this selected stream; the replacement baseline determines
                    # whether access was truly lost. Until then no absence is inferred.
                    selected_drive_root = changed_drive_id and any(
                        row["root_kind"] == "drive"
                        and str(row["root_id"]) == changed_drive_id
                        and str(row["drive_id"]) == drive_id
                        for row in active_roots
                    )
                    if changed_drive_id == drive_id or selected_drive_root:
                        subtree_recovery_required = True
                    if drive_id == "my-drive" and changed_drive_id and changed_drive_id != drive_id:
                        # A Shared Drive's membership or access changed (AIO-1167 R61). A file
                        # root the user log consumes because its account was not that drive's
                        # member is reported there only while that holds, and this event names
                        # no file: its routing is revalidated before coverage (durable, before
                        # this page commits). Nothing in the drive becomes selected.
                        state.invalidate_user_log_file_roots(execution.integration_id, generation)
                    if confirmed_removed and selected_drive_root:
                        affected, final = state.membership_impacts_for_root(
                            namespace, generation, changed_drive_id,
                            snapshot_id=state.snapshot_id(namespace, building=False),
                        )
                        membership_root_removals.extend((item_id, changed_drive_id) for item_id in affected)
                        obligations.extend(
                            (item_id, "remove", {"file_id": item_id, "reason": "selected_drive_tombstone"})
                            for item_id in final
                        )
                    continue
                if not file_id:
                    # An unclassifiable row is uncertainty, never removal evidence. Recover the
                    # authorized roots before accepting the provider cursor rather than silently
                    # discarding the row.
                    subtree_recovery_required = True
                    continue
                file = change.get("file") or {}
                known_folder = bool(
                    state.roots_for_parent(namespace, generation, file_id)
                    or any(
                        row["root_kind"] == "folder" and str(row["root_id"]) == file_id
                        for row in active_roots
                    )
                )
                if file.get("mimeType") == FOLDER_MIME or (not file and known_folder):
                    subtree_recovery_required = True
                    # Only an explicit provider tombstone is absence evidence. A missing file body,
                    # permission outage, or ambiguous parent hint starts authorized recovery but
                    # retains claims. For a confirmed root tombstone, retained root provenance lets
                    # us suppress final-root descendants without harming overlapping/direct roots.
                    if confirmed_removed:
                        ancestor_pairs, ancestor_final = state.membership_impacts_for_ancestor(
                            namespace, generation, file_id,
                            snapshot_id=state.snapshot_id(namespace, building=False),
                        )
                        tombstoned_roots = {
                            str(row["root_id"])
                            for row in active_roots
                            if row["root_kind"] == "folder" and str(row["root_id"]) == file_id
                        }
                        if absence_withheld(
                            {root_id for _item_id, root_id in ancestor_pairs} | tombstoned_roots
                        ):
                            # The root this folder is, or is under, left this drive or could not
                            # be read. Its claims stand — in the snapshot and on the brain — and
                            # the rescan this page seeds re-derives this stream's membership.
                            continue
                        membership_root_removals.extend(ancestor_pairs)
                        final_items = set(ancestor_final)
                        for root_id in tombstoned_roots:
                            affected, final = state.membership_impacts_for_root(
                                namespace, generation, root_id,
                                snapshot_id=state.snapshot_id(namespace, building=False),
                            )
                            membership_root_removals.extend((item_id, root_id) for item_id in affected)
                            final_items.update(final)
                        obligations.extend(
                            (item_id, "remove", {"file_id": item_id, "reason": "folder_or_ancestor_tombstone"})
                            for item_id in sorted(final_items)
                        )
                    continue
                # Explicit trash is evidence about the DOCUMENT itself — loss wherever it lives — and
                # is kept apart from an ambiguous `removed` hint (a move, lost access, or a root that
                # left this drive), which stays on the absence gates below (AIO-1167 R51 final 2).
                trashed = bool(file.get("trashed"))
                if file:
                    # The document's own latest state in this page (only a change carrying its body
                    # says whether it is trashed; a bare `removed` says nothing about restoration).
                    last_trashed[file_id] = trashed
                    if not trashed:
                        # Across pages (A1 ordering): a restore read after an EARLIER page's explicit
                        # trash supersedes that trash removal if it is still owed (its sink
                        # acknowledgment failed or was lost) — the stale removal is never sent. One
                        # already acknowledged stays history; root recovery relists the document.
                        state.supersede_pending_trash(namespace, generation, file_id)
                removed = bool(change.get("removed") or trashed)
                selected = file_id in state.membership_ids(namespace, generation)
                root_parents = sorted({
                    (root, str(parent))
                    for parent in file.get("parents") or []
                    for root in state.roots_for_parent(namespace, generation, str(parent))
                })
                roots = sorted({root for root, _parent in root_parents})
                direct = any(
                    row["root_kind"] == "file" and row["root_id"] == file_id
                    for row in active_roots
                )
                actual_drive = str(file.get("driveId") or "")
                drive_root = next((
                    str(row["root_id"])
                    for row in active_roots
                    if row["root_kind"] == "drive"
                    and str(row["root_id"]) == actual_drive
                    and str(row["drive_id"]) == drive_id
                ), None)
                in_scope = bool(roots or direct or drive_root)
                moved_out = False
                if direct and file_id in bound_root_kinds and file and not trashed:
                    # Explicit trash needs no routing decision (R51 final 2), so it never probes.
                    left = direct_root_left(file_id, file)
                    if left is None:
                        # Held: the root's claim stands, and the rescan this seeds defers it (a
                        # restricted root) — or the page is not retained at all (unverified).
                        subtree_recovery_required = True
                        continue
                    moved_out = left
                if selected and not in_scope and not removed and not moved_out and (
                    deferred_here & set(state.membership_roots(namespace, generation, file_id))
                ):
                    # "Out of scope" here only means its parent is unknown — and it is unknown
                    # because a root it is claimed through is DEFERRED (R51 F1): that root's snapshot
                    # carries retained membership without its traversal, so a nested document's
                    # parent is absent from the ancestry. Reading the root's metadata is not
                    # enumerating its subtree. The document is held: no remove, its membership,
                    # claim and the root's recovery obligation stand, and no rescan is started
                    # for it — the deferred root's own recovery re-lists it.
                    held_by_deferred_root = True
                    continue
                if trashed and (selected or file.get("mimeType") in (None, GOOGLE_DOC_MIME)):
                    # Verified trash needs no root to vouch for it: a restricted, deferred, leaving or
                    # unreadable parent root blocks READS, not the reconciliation of evidence already
                    # in hand. The evidence travels in the obligation (`trashed`), so the removal
                    # drain settles it without a parent or document probe — through retries, a
                    # failed sink acknowledgment and a restart alike — via the claim-aware owner.
                    #
                    # Local membership is NOT required (AIO-1167 final review A1): after recovery
                    # with fresh local state behind a restricted root, this stream may hold no
                    # membership while the brain still holds this connection's claim. Whether a claim
                    # exists is the fenced, connection-scoped reconciler's question, never local
                    # state's: for a document this connection never claimed the removal is a no-op,
                    # and another connection's claim is never a candidate. Only POSITIVE document
                    # trash qualifies — an ambiguous `removed`, missing local state or root
                    # uncertainty stays on the absence gates below.
                    obligations.append((file_id, "remove", {
                        "file_id": file_id, "trashed": True, "reason": "explicit_trash",
                        # Which execution OBSERVED it (R66): only that execution may replay it unread.
                        "observed_under": _observation_token(execution),
                    }))
                    if selected:
                        trash_membership_removals.append(file_id)
                    continue
                if removed or moved_out or (selected and not in_scope):
                    if (selected or moved_out) and absence_withheld(
                        {*state.membership_roots(namespace, generation, file_id),
                         *([file_id] if moved_out else [])}
                    ):
                        # Gone from this drive because a root it is claimed through moved, or
                        # cannot be read: not absence. The claim stands until the stream of the
                        # drive that root is in now has verified it.
                        subtree_recovery_required = True
                        continue
                    if removed or (selected and not in_scope):
                        if selected:
                            obligations.append((file_id, "remove", {"file_id": file_id}))
                            membership_removals.append(file_id)
                        continue
                    # Reported with another drive's id, yet read in this one: an ordinary change.
                if file.get("mimeType") not in (None, GOOGLE_DOC_MIME) or not (in_scope or selected):
                    continue
                if root_parents:
                    for root, parent in root_parents:
                        membership_additions.append((file_id, root, drive_id, parent))
                else:
                    for root in ([file_id] if direct else ([drive_root] if drive_root else [])):
                        membership_additions.append((file_id, root, drive_id, None))
                obligations.append((file_id, "upsert", {"file_id": file_id, "metadata": file}))
            # Ordering (A1): explicit trash later RESTORED within the same page is not trash any more. A
            # restored document this stream cannot place (no local membership, its root unreadable)
            # yields no superseding upsert, so its earlier trash removal is dropped here instead of
            # suppressing restored content; an in-scope one keeps only its restore upsert.
            obligations = [
                (item_key, action, payload) for item_key, action, payload in obligations
                if not (action == "remove" and payload.get("reason") == "explicit_trash"
                        and last_trashed.get(item_key) is False)
            ]
            # Membership effects follow the SAME final observation (Astra/Sol R51 P2): the page applies
            # additions before removals, so a trash-origin removal left behind by a canceled trash
            # obligation would erase the membership the restore just re-asserted, and the restored
            # upsert could never be delivered. Only trash-origin removals are dropped; a genuine
            # removal recorded later in the page (out of scope, absence) stands, and a restore
            # followed by trash still removes.
            membership_removals.extend(
                item_key for item_key in trash_membership_removals
                if last_trashed.get(item_key) is not False
            )
            if held_by_deferred_root:
                # Reported, never charged: the document is owed to the deferred root's recovery.
                summary.failure_categories = summary.failure_categories or {}
                summary.failure_categories.setdefault("deferred_root_document_held", 1)
            if unverified:
                # Where a root is could not be read, so this page's removals under it are neither
                # absence nor a move. The page is not retained and the cursor does not pass it:
                # the root is durably uncertain, the stream partial, and the same page is read —
                # and the root read — again on the next run.
                root_id, deferred = unverified[0]
                await _checkpoint_progress(
                    client, execution, state, namespace, phase="partial",
                    last_error=f"selected root {root_id} unverified; absence withheld",
                    retry_not_before=(deferred.not_before if deferred else None),
                )
                category = deferred.category if deferred else "selection_root_unverified"
                summary.failed += 1
                summary.failure_categories[category] = summary.failure_categories.get(category, 0) + 1
                if deferred is not None:
                    _count_retry_after_diagnostic(summary, deferred)  # R49 F2: kept on this path
                return summary
            if state.projected_pending_count(
                namespace, generation, [item_key for item_key, _action, _payload in obligations],
            ) > _MAX_PENDING_PER_STREAM:
                await _checkpoint_progress(
                    client, execution, state, namespace, phase="partial",
                    last_error="durable document backlog saturated",
                )
                summary.failed += 1
                summary.failure_categories["queue_saturated"] = 1
                return summary
            materialized = state.materialize_page(
                namespace, generation, _page_id(
                    "changes", state.get_progress(namespace).drain_observation, token,
                ), "changes", token,
                page.next_page_token, page.new_start_page_token, obligations,
                snapshot_id=state.snapshot_id(namespace, building=False),
                membership_additions=membership_additions,
                membership_removals=membership_removals,
                membership_root_removals=membership_root_removals,
                rescan_roots=[
                    (row["root_id"], row["root_kind"], row["drive_id"], bool(row["recursive"]))
                    for row in active_roots
                    # A root that left this drive is not rescanned here: its stream is another.
                    if (str(row["root_kind"]), str(row["root_id"])) not in leaving
                ] if subtree_recovery_required else None,
                drain_observation=state.get_progress(namespace).drain_observation,
            )
            consumed = await _finish_materialized_pages(
                client, execution, source, conn, state, namespace, generation, summary,
                max(0, fresh_remaining),
            )
            fresh_remaining = max(0, fresh_remaining - consumed)
            if materialized.rescan_snapshot_id is not None and not state.snapshot_complete(
                namespace, generation, materialized.rescan_snapshot_id,
            ):
                await _checkpoint_progress(client, execution, state, namespace,
                                           phase="partial", last_error="change page pending")
                return summary
            token = materialized.next_token or materialized.terminal_token or token
            terminal = materialized.terminal_token and not materialized.next_token
            # A page replayed after its rescan published still predates that enumeration: it ends
            # no drain, and the page after it is read while the budget lasts.
            if terminal and not _terminal_before_rescan(materialized):
                drained_to_terminal = True
                break
        if observed_hint is not None and drained_to_terminal:
            state.ack_stream_hint(key, observed_hint)
        if state.pending_count(namespace, generation):
            await _checkpoint_progress(
                client, execution, state, namespace, phase="partial",
                last_error="durable document backlog remains",
            )
        else:
            await _checkpoint_complete_if_clean(
                client, execution, state, namespace, generation,
            )
        return summary
    except (_ProviderAdmissionClosed, _AcknowledgmentUncertain) as closed:
        # Whatever this stream completed before the stop is still reported by the coordinator.
        closed.partial = summary
        raise
    except BrainError as exc:
        summary.failure_categories[exc.code] = summary.failure_categories.get(exc.code, 0) + 1
        if not _is_terminal_authority(exc) and _progress_uncertain(client, execution):
            # A checkpoint of this stream's own may have committed unacknowledged (R47 F3): the
            # revision is unknown to every stream of the run, so the coordinator stops.
            uncertain = _AcknowledgmentUncertain(exc.code)
            uncertain.partial = summary
            raise uncertain from exc
        summary.failed += 1
        return summary


async def _enumerate_baseline(
    client: BrainClient,
    execution: GdriveExecution,
    source: GoogleDriveSource,
    drive: Any,
    options: dict[str, Any],
    state: StateStore,
    namespace: str,
    generation: int,
    drive_id: str,
    conn: Connection,
    summary: IngestSummary,
    work_budget: int,
    discovery_budget: int,
    *,
    root_bindings: dict[tuple[str, str], str] | None = None,
) -> tuple[bool, int]:
    """Durably enumerate selected roots and process bounded extraction obligations."""
    work_consumed = 0
    pages_read = 0
    page_budget = max(0, discovery_budget)
    integration_id = execution.integration_id
    roots = state.list_roots(namespace, generation)
    if not roots:
        configured = _stream_roots(state, integration_id, generation, options, drive_id, root_bindings)
        state.replace_roots(namespace, generation, configured)
        roots = state.list_roots(namespace, generation)
    snapshot_id = state.snapshot_id(namespace)
    if snapshot_id is None:
        raise RuntimeError("selection snapshot initialization failed")
    leaving = (
        _leaving_roots(state, integration_id, generation) if root_bindings is not None else set()
    )

    def another_streams(root_kind: str, root_id: Any) -> bool:
        """A root this stream no longer enumerates: bound to another drive, or read in one."""
        bound = (root_bindings or {}).get((root_kind, str(root_id)))
        return (bound is not None and bound != drive_id) or (root_kind, str(root_id)) in leaving

    # Bound roots whose OWN metadata the provider answered not-found under this run's authority
    # (AIO-1167 R48 D1). Each is a resolved outcome — it supports nothing now — so its page or
    # traversal is finished empty, without listing a folder that is gone. Only the root's own 404
    # qualifies: a listing 404, a never-bound root, auth, quota, timeouts and transient errors
    # remain conservative. Read again, a restored root is enumerated normally.
    unavailable: set[str] = set()

    def record_unavailable(root_kind: str, root_id: str) -> bool:
        if not state.record_root_unavailable(
            integration_id, generation, root_kind, root_id, detail=_ROOT_UNAVAILABLE_DETAIL,
        ):
            return False
        unavailable.add(root_id)
        _note_root_unavailable(summary, root_kind, root_id)  # once per root per run (R50 F7)
        return True

    # Roots this enumeration cannot read now (AIO-1167 R50 F3/F4): under a standing provider minimum
    # (admission — never read early, whatever a rescan or rebuilt local state asks), or answered by
    # a non-quota deferral (a 503 or timeout — that ROOT's, its named minimum kept). Each is finished
    # WITHOUT a read: its page or traversal commits carrying only the membership this stream's
    # published snapshot already proved through it (retained evidence — none on fresh local state,
    # where nothing is invented), and the root becomes a durable DEFERRED obligation (`uncertain`).
    # So the independent roots and documents keep their discovery and change processing, while
    # the connection stays partial and no complete snapshot can infer absence until a later
    # enumeration lists the root again (`_deferred_root_admissible`). A quota answer is still the
    # account's hold and the run's own budget still stops the run.
    stream_progress = state.get_progress(namespace)
    credential = stream_progress.key.credential_id if stream_progress is not None else ""
    restricted_roots = set(_standing_document_restrictions(
        state, integration_id, generation, credential,
    )) if stream_progress is not None else set()
    deferred: set[str] = set()

    def defer_root(root_kind: str, root_id: str, exc: ProviderDeferred | None) -> None:
        if exc is not None:
            if exc.category == "rate_limited":
                raise _account_hold(exc) from exc
            if exc.category in _LOCAL_DEADLINE_CATEGORIES:
                raise exc
            _count(summary, exc.category)
            _count_retry_after_diagnostic(summary, exc)
            if _restrict_resource(state, execution, credential, root_id, exc):
                restricted_roots.add(root_id)
        else:
            diagnostic = "provider_restricted_document" if root_kind == "file" else "provider_restricted_resource"
            summary.failure_categories[diagnostic] = max(summary.failure_categories.get(diagnostic, 0), 1)
        # Atomically with the deferral, a root this build already listed part of has its remaining
        # traversal closed (R51 F1): a later recovery can never "finish" an old remainder around a
        # withheld part — only a fresh controlled rescan lists it. An untouched root keeps its seed for
        # the placeholder below.
        state.defer_root_in_build(
            integration_id, generation, root_kind, root_id, drive_id,
            detail="its read is withheld; membership retained, not verified",
            namespace=namespace, snapshot_id=snapshot_id,
        )
        deferred.add(root_id)

    # A deferred folder root is settled only by the listing of its subtree, never by its metadata
    # (AIO-1167 R51 final 1). Metadata proves where the folder is, not what is under it.
    #   * If this build's traversal of a previously deferred folder was already closed — by the
    #     placeholder its deferral wrote (retained membership only, none on fresh state) — the
    #     build cannot witness its contents: the root stays deferred, this build cannot support a
    #     complete snapshot, and once it publishes the controlled rescan (`_deferred_root_admissible`)
    #     lists the folder under a fresh snapshot and page identity.
    #   * If its traversal is still open, it is listed now — descendants and further pages included,
    #     across runs if interrupted — and settled only when no entry of it remains (`listed`). That
    #     open traversal is always a genuine listing in progress: a root withheld after this build
    #     touched it has its remaining traversal closed in the same transaction as its deferral
    #     (`defer_root_in_build`, R51 F1), so no old remainder around a withheld part is ever resumed.
    previously_deferred = {
        root_id for kind, root_id in state.deferred_roots(integration_id, generation, drive_id)
        if kind == "folder"
    }
    listed: set[str] = set()

    def settle_listed() -> None:
        for listed_root in sorted(listed):
            if not state.root_traversal_open(namespace, generation, listed_root, snapshot_id=snapshot_id):
                state.settle_root(integration_id, generation, "folder", listed_root, enumerated=True)
                listed.discard(listed_root)

    # A folder listing scoped to this drive is empty for a folder that was moved out of it, which
    # reads exactly like a folder that was emptied. So before a bound folder root is listed, its
    # own metadata is read: found in another drive, it is recorded as relocating and this baseline
    # stops short of publishing; unreadable, it is recorded as uncertain and the baseline stays
    # partial. Neither is ever an empty snapshot.
    for root in (row for row in roots if row["root_kind"] == "folder"):
        root_id = str(root["root_id"])
        if ("folder", root_id) not in (root_bindings or {}) or another_streams("folder", root_id):
            continue
        if root_id in restricted_roots:
            defer_root("folder", root_id, None)
            continue
        if root_id in previously_deferred and not state.root_traversal_open(
            namespace, generation, root_id, snapshot_id=snapshot_id,
        ):
            # Closed by its deferral's placeholder in this build (AIO-1167 R51 F3): it stays deferred
            # and its metadata is not read now. Any answer here — even a verified not-found — would
            # be recorded against a snapshot whose committed page still carries the retained
            # membership. The controlled rescan (`_deferred_root_admissible`) decides it under a
            # fresh snapshot, whose open traversal lists a present folder or finishes a gone one empty.
            continue
        try:
            observed = _observe_root(source, root_id, drive_id, {})
        except ProviderDeferred as exc:
            defer_root("folder", root_id, exc)
            continue
        if observed.state == "elsewhere":
            state.mark_root_relocating(
                integration_id, generation, "folder", root_id, drive_id,
                destination=str(observed.drive_id),
            )
            raise SelectedRootRelocated(
                f"selected folder {root_id} is no longer in the drive it was bound to"
            )
        if observed.state == "unverified":
            state.mark_root_uncertain(
                integration_id, generation, "folder", root_id, drive_id, detail=str(observed.detail),
            )
            raise SelectedRootUnverified(f"selected folder {root_id} could not be verified")
        if observed.state == "absent" and record_unavailable("folder", root_id):
            # What this build already listed through the lost folder — while its pagination or a
            # sibling root kept the build open — supports nothing now (AIO-1167 final review, High):
            # it is withdrawn from the building snapshot before anything can publish it. Support
            # through other roots stays; the rest of the folder's traversal closes empty below.
            state.withdraw_lost_root_support(namespace, generation, root_id, snapshot_id=snapshot_id)
            continue
        binding = state.root_obligations(integration_id, generation).get(("folder", root_id))
        if (
            binding is not None
            and (binding.detail or "").startswith("selected root unavailable")
            and (
                state.root_traversal_touched(namespace, generation, root_id, snapshot_id=snapshot_id)
                or not state.root_traversal_open(namespace, generation, root_id, snapshot_id=snapshot_id)
            )
        ):
            # Restored after its loss was recorded, in a build that already touched it — listed part of
            # it (support then withdrawn) or closed part of it empty — whether or not entries remain
            # open (R51 F1). Neither settling it nor finishing the old remainder can restore what was
            # withdrawn (a materialized page never reapplies membership), so it becomes a DEFERRED
            # obligation and, in the same transaction, its remaining traversal is closed: the
            # connection stays partial and the controlled rescan (`_deferred_root_admissible`) lists it
            # in full under a fresh snapshot and fresh page identities. An untouched root — its seed
            # still open, nothing of it finished in this build — is simply listed in full below.
            state.defer_root_in_build(
                integration_id, generation, "folder", root_id, drive_id,
                detail="restored after its loss was recorded; it must be listed again",
                namespace=namespace, snapshot_id=snapshot_id,
            )
            deferred.add(root_id)
            continue
        # Read where it is bound: a merely uncertain or unavailable root is settled by that read (a
        # DEFERRED one is untouched here — `settle_root` without `enumerated`).
        state.settle_root(integration_id, generation, "folder", root_id)
        if root_id in previously_deferred:
            listed.add(root_id)  # open (checked above): listed below; settled once its subtree is listed

    # Explicit file selections are individual one-item enumeration pages. Their metadata must be
    # proven before membership exists; an inaccessible file leaves this baseline partial.
    for root in (row for row in roots if row["root_kind"] == "file"):
        page_id = _page_id("baseline", snapshot_id, "file", root["root_id"])
        page = state.get_page(namespace, generation, page_id)
        if page and page.committed_at:
            continue
        if page is None:
            if pages_read >= page_budget:
                return False, work_consumed
            obligations: list[tuple[str, str, dict[str, Any]]] = []
            membership_additions: list[tuple[str, str, str]] = []
            bound_drive = (root_bindings or {}).get(("file", str(root["root_id"])))
            consumed, route_proven = drive_id, False  # this root's routing, read with its metadata
            if another_streams("file", root["root_id"]):
                # The stream of the drive that contains this root owns it — it was bound there
                # before this local state was written, or it was read there since. Its page here
                # records nothing, and nothing is read through this stream.
                meta = None
            elif str(root["root_id"]) in restricted_roots:
                # Under a standing provider minimum (R49 F1): not read, by a rescan or a rebuilt
                # local state either. Deferred instead of left unmaterialized (R50 F4): the page
                # commits carrying only the membership the published snapshot already proved
                # through this root, and the other roots and documents go on.
                meta = None
                defer_root("file", str(root["root_id"]), None)
                membership_additions.extend(
                    state.retained_root_membership(namespace, generation, str(root["root_id"])),
                )
            else:
                try:
                    meta = source._metadata(root["root_id"])
                    # The whole observation, routing included (AIO-1167 R64): which stream consumes
                    # the root, and whether a deferred user-log root's route is PROVEN (R63), may be
                    # the run's first call to the membership oracle. Read once, here.
                    if bound_drive is not None:
                        consumed = _consumed_drive(source, "file", meta, drive_id)
                        route_proven = consumed != drive_id or _user_log_route_proven(
                            source, "file", str(meta.get("driveId") or "my-drive"), drive_id,
                        )
                except BrainError:
                    raise
                except ProviderDeferred as exc:
                    # A quota answer is the account's (re-raised as its hold) and the run's own
                    # budget stops the run; any other deferral — of the metadata or of the
                    # membership answer — is THIS root's (R50 F3): deferred exactly as a restricted
                    # one, its named minimum kept, its siblings enumerated.
                    defer_root("file", str(root["root_id"]), exc)
                    meta = None
                    membership_additions.extend(
                        state.retained_root_membership(namespace, generation, str(root["root_id"])),
                    )
                except Exception as exc:
                    # A bound file root's own not-found is its outcome (R48 D1): this page commits
                    # with no membership. Anything else is raised exactly as before.
                    if (bound_drive is None or _provider_status(exc) != 404
                            or not record_unavailable("file", str(root["root_id"]))):
                        raise
                    meta = None
                pages_read += 1
            if meta is None:
                pass
            elif bound_drive is not None and consumed != drive_id:
                # This stream's cursor can no longer observe the document. Reading it once here
                # and then reporting the stream current would hide every later edit: the root is
                # recorded as relocating toward the drive it was read in, and this baseline stops
                # short of publishing. That drive's stream takes it over once it has a token.
                state.mark_root_relocating(
                    integration_id, generation, "file", str(root["root_id"]), drive_id,
                    destination=consumed,
                )
                raise SelectedRootRelocated(
                    f"selected file {root['root_id']} is no longer in the drive it was bound to"
                )
            elif not meta.get("trashed") and meta.get("mimeType") == GOOGLE_DOC_MIME:
                actual_drive = str(meta.get("driveId") or drive_id)
                membership_additions.append((str(meta["id"]), root["root_id"], actual_drive))
                if not state.has_membership(
                    namespace, generation, str(meta["id"]), snapshot_id=snapshot_id,
                ):
                    obligations.append((str(meta["id"]), "upsert", {
                        "file_id": str(meta["id"]), "metadata": meta,
                    }))
            if meta is not None and bound_drive is not None:
                # Read by this enumeration: a deferred file root is settled here, and only here — and
                # on the user log only with positive routing proof (R63): a deferred user-log file
                # root needs BOTH its enumeration and coverage by its consuming stream. Unproven, it
                # stays deferred (partial, its claims standing) and the controlled rescan retries it.
                held = state.root_obligations(integration_id, generation).get(("file", str(root["root_id"])))
                if held is None or held.status != "uncertain" or route_proven:
                    state.settle_root(integration_id, generation, "file", str(root["root_id"]), enumerated=True)
            if state.projected_pending_count(
                namespace, generation, [item_key for item_key, _action, _payload in obligations],
            ) > _MAX_PENDING_PER_STREAM:
                return False, work_consumed
            page = state.materialize_page(
                namespace, generation, page_id, "baseline", root["root_id"], None, None,
                obligations, snapshot_id=snapshot_id,
                membership_additions=membership_additions,
            )
        consumed = await _finish_materialized_pages(
            client, execution, source, conn, state, namespace, generation, summary,
            max(0, work_budget - work_consumed),
            snapshot_id=snapshot_id,
        )
        work_consumed += consumed
        page = state.get_page(namespace, generation, page_id)
        if not page or not page.committed_at:
            return False, work_consumed

    root_kinds = {str(row["root_id"]): str(row["root_kind"]) for row in roots}
    # Folders whose LISTING operation is under a standing provider minimum (A3). Their traversal rows
    # are left open — never read before the minimum, whatever generation, reconnect or fresh store
    # this is — while every other folder's rows go on; the build simply cannot complete meanwhile.
    restricted_listings = {
        key[len(_FOLDER_LISTING_RESOURCE):] for key in restricted_roots
        if key.startswith(_FOLDER_LISTING_RESOURCE)
    }
    if restricted_listings and state.open_traversal_folders(
        namespace, generation, restricted_listings, snapshot_id=snapshot_id,
    ):
        # Name the standing minimum the build is waiting on (Fable R51 L4): once for the held listing —
        # never per row, and nothing here says the baseline completed. Its rows are excluded below,
        # so they are still open whichever way this enumeration returns.
        summary.failure_categories = summary.failure_categories or {}
        summary.failure_categories["provider_restricted_resource"] = max(
            summary.failure_categories.get("provider_restricted_resource", 0), 1,
        )
    while pages_read < page_budget:
        row = state.next_traversal(
            namespace, generation, snapshot_id=snapshot_id, exclude_folders=restricted_listings,
        )
        if row is None:
            break
        token = str(row["page_token"] or "") or None
        page_id = _page_id("baseline", snapshot_id, row["root_id"], row["folder_id"], token)
        page = state.get_page(namespace, generation, page_id)
        if page is None and str(row["root_id"]) in deferred:
            # A deferred folder root (R50 F4) is not listed now. Its traversal is closed without a
            # read; the root's own top row carries the membership the published snapshot already
            # proved through it — retained evidence, never a current observation — so nothing it
            # claimed is dropped and nothing is invented, and the stream's other roots finish.
            retained = (
                state.retained_root_membership(namespace, generation, str(row["root_id"]))
                if str(row["folder_id"]) == str(row["root_id"]) and token is None else []
            )
            page = state.materialize_page(
                namespace, generation, page_id, "baseline", token, None, None, [],
                snapshot_id=snapshot_id,
                membership_additions=retained,
                traversal_completion=(row["root_id"], row["folder_id"], token),
            )
        if page is None and (
            another_streams(root_kinds.get(str(row["root_id"]), ""), row["root_id"])
            or str(row["root_id"]) in unavailable
        ):
            # A folder root that left this drive after this build was seeded. It is not listed
            # here — the listing would be empty and prove nothing — and its traversal is closed
            # with a page that records nothing, so the stream's other roots still finish.
            page = state.materialize_page(
                namespace, generation, page_id, "baseline", token, None, None, [],
                snapshot_id=snapshot_id,
                traversal_completion=(row["root_id"], row["folder_id"], token),
            )
        if page is None:
            if pages_read >= page_budget:
                return False, work_consumed
            kwargs: dict[str, Any] = {
                "q": f"'{row['folder_id']}' in parents and trashed = false",
                "pageToken": token,
                "pageSize": 1000,
                "supportsAllDrives": True,
                "includeItemsFromAllDrives": True,
                "fields": "nextPageToken,files(id,name,mimeType,webViewLink,createdTime,modifiedTime,trashed,driveId,parents,owners(permissionId,emailAddress,displayName),lastModifyingUser(permissionId,emailAddress,displayName))",
            }
            if row["drive_id"] != "my-drive":
                kwargs.update(corpora="drive", driveId=row["drive_id"])
            try:
                response = source._execute(drive.files().list(**kwargs))
            except ProviderDeferred as exc:
                # A provider-named minimum for listing THIS folder is journaled for the folder
                # operation (A3) — not the page token — before the stream's handler checkpoints it.
                _restrict_operation(
                    state, execution, credential, f"{_FOLDER_LISTING_RESOURCE}{row['folder_id']}", exc,
                )
                raise
            pages_read += 1
            obligations = []
            membership_additions = []
            traversal_additions = []
            for meta in response.get("files") or []:
                provider_id = str(meta.get("id") or "")
                if not provider_id:
                    continue
                if meta.get("mimeType") == FOLDER_MIME:
                    root = next(
                        candidate for candidate in roots
                        if candidate["root_id"] == row["root_id"]
                    )
                    if bool(root["recursive"]):
                        traversal_additions.append((
                            row["root_id"], provider_id,
                            str(meta.get("driveId") or row["drive_id"]), None,
                        ))
                elif meta.get("mimeType") == GOOGLE_DOC_MIME:
                    already_selected = state.has_membership(
                        namespace, generation, provider_id, snapshot_id=snapshot_id,
                    )
                    membership_additions.append((
                        provider_id, row["root_id"],
                        str(meta.get("driveId") or row["drive_id"]), row["folder_id"],
                    ))
                    if not already_selected:
                        obligations.append((provider_id, "upsert", {
                            "file_id": provider_id, "metadata": meta,
                        }))
            next_token = response.get("nextPageToken")
            if next_token:
                traversal_additions.append((
                    row["root_id"], row["folder_id"], row["drive_id"], str(next_token),
                ))
            if state.projected_pending_count(
                namespace, generation, [item_key for item_key, _action, _payload in obligations],
            ) > _MAX_PENDING_PER_STREAM:
                return False, work_consumed
            page = state.materialize_page(
                namespace, generation, page_id, "baseline", token, next_token, None,
                obligations, snapshot_id=snapshot_id,
                membership_additions=membership_additions,
                traversal_additions=traversal_additions,
                traversal_completion=(row["root_id"], row["folder_id"], token),
            )
        consumed = await _finish_materialized_pages(
            client, execution, source, conn, state, namespace, generation, summary,
            max(0, work_budget - work_consumed),
            snapshot_id=snapshot_id,
        )
        work_consumed += consumed
        page = state.get_page(namespace, generation, page_id)
        if not page or not page.committed_at:
            return False, work_consumed
        settle_listed()  # a recovered deferred folder whose whole subtree is now listed (R51 final 1)

    settle_listed()
    # A deferred root does not make this enumeration complete as a statement of its membership: its
    # `uncertain` obligation keeps the connection partial and withholds absence (R50 F4). It only lets
    # the snapshot publish so independent change processing can continue.
    return (
        state.next_traversal(namespace, generation, snapshot_id=snapshot_id) is None
        and state.next_uncommitted_page(
            namespace, generation, snapshot_id=snapshot_id,
        ) is None
    ), work_consumed


async def _finish_materialized_pages(
    client: BrainClient,
    execution: GdriveExecution,
    source: GoogleDriveSource,
    conn: Connection,
    state: StateStore,
    namespace: str,
    generation: int,
    summary: IngestSummary,
    budget: int,
    *,
    snapshot_id: int | None = None,
) -> int:
    """Finish durable pages in order; cursor publication precedes local page retirement."""
    consumed = 0
    while True:
        page = state.next_uncommitted_page(
            namespace, generation, snapshot_id=snapshot_id,
        )
        if page is None:
            return consumed
        if page.rescan_snapshot_id is not None and not state.snapshot_complete(
            namespace, generation, page.rescan_snapshot_id,
        ):
            # The page's cursor cannot retire until its durable subtree-rescan obligation has
            # published. Document work may still be attempted fairly below on later invocations.
            if consumed < budget:
                consumed += await _drain_pending(
                    client, execution, source, conn, state, namespace, generation, summary,
                    max(0, budget - consumed),
                    work_class="fresh",
                )
            return consumed
        before_page = page
        if consumed < budget:
            consumed += await _drain_pending(
                client, execution, source, conn, state, namespace, generation, summary,
                max(0, budget - consumed),
                work_class="fresh",
            )
        if page.page_kind == "changes":
            next_token = page.next_token or page.terminal_token
            if not next_token:
                raise RuntimeError("Drive change page omitted both continuation and terminal token")
            # The terminal token of a page that seeded a rescan is where the drain goes on from,
            # not where it ended: the cursor advances past the page, but no terminal drain is
            # acknowledged, and a new observation is opened for the change page that has to be
            # read now that the rescan has enumerated. That is durable — a restart finds a cursor
            # with no acknowledged drain, and reads on from it before anything is reconciled.
            unconfirmed = _terminal_before_rescan(page)
            terminal = bool(page.terminal_token and not page.next_token) and not unconfirmed
            await _checkpoint_progress(
                client, execution, state, namespace, page_token=next_token,
                phase="partial" if terminal else "catching_up",
                last_error=(
                    "cursor advanced; local page retirement or durable obligations remain"
                    if terminal else None
                ),
                retry_not_before=None, checkpoint_id=page.page_id,
                terminal_drain_token=(next_token if terminal else None),
                terminal_drain_checkpoint_id=(page.page_id if terminal else None),
                terminal_drain_acknowledged=terminal,
                terminal_drain_observation=(page.drain_observation if terminal else None),
                **({
                    "drain_observation": state.get_progress(namespace).drain_observation + 1,
                } if unconfirmed else {}),
            )
        state.commit_page(namespace, generation, page.page_id, require_acks=False)
        state.purge_committed_page_work(namespace, generation, page.page_id)
        if page.page_kind == "changes" and page.terminal_token and not page.next_token:
            await _checkpoint_complete_if_clean(
                client, execution, state, namespace, generation,
            )
        # Zero-obligation pages still make progress; a failed obligation consumes budget through
        # the summary and remains durable, so this cannot spin.
        if state.next_uncommitted_page(
            namespace, generation, snapshot_id=snapshot_id,
        ) == before_page:
            return consumed


async def _checkpoint_complete_if_clean(
    client: BrainClient,
    execution: GdriveExecution,
    state: StateStore,
    namespace: str,
    generation: int,
    *,
    finalize: bool = False,
) -> bool:
    """Publish readiness, and only after reconciliation publish complete success."""
    progress = state.get_progress(namespace)
    if not progress or not progress.listing_complete:
        return False
    if progress.recovery_required or progress.building_snapshot is not None:
        return False
    if not state.snapshot_complete(namespace, generation, progress.active_snapshot):
        return False
    if state.pending_count(namespace, generation) or state.next_uncommitted_page(namespace, generation):
        return False
    if not _terminal_drain_complete(progress):
        return False
    if finalize:
        await _checkpoint_progress(
            client, execution, state, namespace, phase="current",
            last_success_at=_now(), last_error=None, retry_not_before=None,
        )
    elif progress.phase != "partial" or progress.last_error != "stream complete; awaiting all-stream reconciliation":
        await _checkpoint_progress(
            client, execution, state, namespace, phase="partial",
            last_error="stream complete; awaiting all-stream reconciliation",
            retry_not_before=None,
        )
    return True


async def _push_doc(
    client: BrainClient,
    execution: GdriveExecution,
    doc: Any,
    conn: Connection,
    state: StateStore,
    namespace: str,
    generation: int,
    summary: IngestSummary,
    work: PendingWork | None = None,
    *,
    restored_root: str | None = None,
) -> bool:
    """Push one document. Returns False only when the run's deadline deferred the sink call.

    ``restored_root`` (R49 F3): the selected file root this ingestion proves restored. Its stale
    unavailable detail is cleared only after the brain ACCEPTED the content, so the checkpoint that
    acknowledges the document publishes the restored root evidence under the same fence."""
    doc.extra_frontmatter["connection_id"] = execution.integration_id
    doc.extra_frontmatter.setdefault("scope_generation", generation)
    work = work or next((w for w in state.list_pending(namespace, generation, limit=1000)
                         if w.item_key == doc.external_id and w.action == "upsert"), None)
    if doc.extra_frontmatter.get("extraction_complete") is False:
        detail = ", ".join(
            str(issue.get("code") or "incomplete")
            for issue in doc.extra_frontmatter.get("extraction_issues", [])
            if isinstance(issue, dict) and issue.get("blocking")
        ) or "incomplete extraction"
        summary.failed += 1
        summary.failure_categories["incomplete_extraction"] = summary.failure_categories.get("incomplete_extraction", 0) + 1
        if work:
            _fail_work(state, work, detail)
        return True
    if work and not state.work_membership_current(work):
        # A newer remove/move observation won while extraction was in flight, or the snapshot
        # this was owed under was replaced by one published without the document. Never let the
        # stale body reach the sink; a newer durable obligation remains independently runnable.
        # Nothing awaits between this check and the sink call, so a publication of this run
        # cannot fall between them; another run is stopped by the brain's execution fence.
        return True
    try:
        item = normalize(doc, conn.normalize_config())
    except ValidationError as exc:
        # The document cannot be expressed as an item at all (an over-long body, title or path).
        # That is this document's failure, not the run's: it stays durable and retryable, and the
        # obligations after it still run.
        summary.failed += 1
        summary.failure_categories["invalid_payload"] = summary.failure_categories.get("invalid_payload", 0) + 1
        if work:
            _fail_work(state, work, _validation_detail(exc))
        return True
    text_map = item.frontmatter.get("gdrive_text_map")
    if isinstance(text_map, dict):
        # Tab/block offsets are into the extracted text; the stored body leads with the title line.
        # Record exactly where that text starts in the body the brain stores, or that it could not
        # be located — never a guessed offset.
        located = item.body.endswith(doc.body)
        item.frontmatter["gdrive_text_map"] = {
            **text_map, "body_offset": len(item.body) - len(doc.body) if located else None,
        }
    try:
        result = await client.push(item, execution=execution)
    except BrainError as exc:
        if _is_terminal_authority(exc):
            raise
        return _record_sink_failure(state, work, exc, summary)
    setattr(summary, result.status, getattr(summary, result.status) + 1)
    if not work:
        return True
    if restored_root is not None and state.work_membership_current(work):
        state.settle_root(execution.integration_id, generation, "file", restored_root)
    try:
        progress = state.get_progress(namespace)
        await _checkpoint_progress(client, execution, state, namespace,
                                   phase=progress.phase if progress else "working")
        state.ack_work(work)
    except BrainError as exc:
        if _is_terminal_authority(exc):
            raise
        # The content was ACCEPTED; only its durable acknowledgment is owed (AIO-1167 R45 M5, R47 F3).
        # Whatever stopped the checkpoint — a deferral, a 5xx, `stale_progress`, a lost response —
        # is the control plane's, judged by STAGE, not by exception type: the obligation stays owed
        # and unacknowledged (its page is not retired), spends none of the retry budget backoff and
        # exhaustion are computed from, and the replayed push is idempotent.
        summary.failure_categories[exc.code] = summary.failure_categories.get(exc.code, 0) + 1
        if isinstance(exc, BrainDeferred) and exc.not_before is not None:
            # The combined wait delays the next attempt; only a minimum the BRAIN named survives rearm
            # (R50 F2) — the client's own exponential fallback and jitter never do (R51 L2).
            state.fail_work(
                work, f"checkpoint deferred: {exc.code}", not_before=exc.not_before, failure=False,
                minimum=getattr(exc, "provider_not_before", None),
            )
        if _progress_uncertain(client, execution):
            # What was sent may have committed: the revision is unknown, so the run stops here.
            raise _AcknowledgmentUncertain(exc.code) from exc
        return False  # nothing committed, but the brain is refusing: start no further work this run
    return True


async def _drain_pending(
    client: BrainClient,
    execution: GdriveExecution,
    source: GoogleDriveSource,
    conn: Connection,
    state: StateStore,
    namespace: str,
    generation: int,
    summary: IngestSummary,
    budget: int,
    *,
    work_class: str | None = None,
) -> int:
    consumed = 0
    stream = state.get_progress(namespace)
    credential = stream.key.credential_id if stream is not None else ""
    # Documents under a standing provider minimum are not read, pushed or acknowledged until it
    # lapses — whatever rearm, a newer observation or a rescan did to their obligation (R49 F1).
    restricted = _standing_document_restrictions(
        state, execution.integration_id, generation, credential,
    )
    # The documents this stream holds back now — one count per document, however many drain passes
    # the stream makes in a run. A verified removal is not held back (R51 blind-final 1) unless it
    # would need an early probe of the restricted document (added below when withheld).
    held_back = {
        provider_id for provider_id in restricted
        if state.has_owed_work(namespace, generation, provider_id, exclude_action="remove")
    }

    def note_held_back(provider_id: str | None = None) -> None:
        if provider_id is not None:
            held_back.add(provider_id)
        if held_back:
            summary.failure_categories["provider_restricted_document"] = max(
                summary.failure_categories.get("provider_restricted_document", 0), len(held_back),
            )

    note_held_back()
    for work in state.list_pending(
        namespace, generation, limit=max(1, budget), work_class=work_class, restricted=restricted,
    )[:budget]:
        restored_root: str | None = None
        if _run_deadline_reached(execution):
            # Out of time is not a failure of the work that was never started: it is left exactly
            # as it was, and no further provider or sink call is made in this drain.
            summary.failure_categories.setdefault("run_deadline", 1)
            break
        if not state.work_is_current(work):
            continue
        consumed += 1
        if work.action == "poll":
            # A validated notification is only a durable wake-up hint. The change stream below is
            # authoritative, so consuming the hint performs no direct file read or deletion.
            state.ack_work(work)
            continue
        if work.action == "remove":
            if not state.work_is_current(work):
                continue
            try:
                verdict = _cross_stream_removal(
                    state, execution, source, work, restricted=work.item_key in restricted,
                )
            except ProviderDeferred as exc:
                # The removal probe was deferred (R51 blind-final 2): neither survival nor loss is
                # known, so the removal stays owed and unacknowledged, routed by the SAME owners as
                # a document read: the run's own deadline stops the drain, a quota answer is the
                # account's hold, a named wait is this document's restriction.
                if exc.category in _LOCAL_DEADLINE_CATEGORIES:
                    summary.failure_categories.setdefault(exc.category, 1)
                    break
                if exc.category == "rate_limited":
                    raise _account_hold(exc) from exc
                _defer_document_read(state, execution, generation, credential, work, exc, summary)
                continue
            if verdict == "restricted":
                # Settling it would need a probe of a document under a standing provider minimum:
                # retained, and nothing is read before the minimum lapses.
                note_held_back(work.item_key)
                continue
            if verdict == "claimed":
                # Moved between two selected roots of this connection: only this stream's own
                # membership ended, and that was recorded with the page. Nothing is removed.
                state.ack_work(work)
                continue
            if verdict == "superseded":
                # Obsolete trash: a later restoration another stream ingested stands (R61).
                continue
            if verdict == "unverified":
                _fail_work(state, work, "explicit trash could not be re-verified against a later claim")
                summary.failed += 1
                summary.failure_categories["provider_read"] = summary.failure_categories.get("provider_read", 0) + 1
                continue
            if verdict == "withheld":
                summary.failure_categories["cross_stream_move_pending"] = (
                    summary.failure_categories.get("cross_stream_move_pending", 0) + 1
                )
                continue
            try:
                result = await client.reconcile_gdrive(
                    execution,
                    removed_provider_ids=[work.item_key],
                    reason="Google Drive removal, trash, or access denial",
                )
                summary.removed += int(result.get("items") or 0)
                state.ack_work(work)
            except BrainError as exc:
                if _is_terminal_authority(exc):
                    raise
                if not _record_sink_failure(state, work, exc, summary):
                    break
            continue
        try:
            if not state.work_membership_current(work):
                continue
            # Provider-page metadata is an observation hint, not restoration authority. Re-read
            # the item under the current provider gate so access, trash state and membership are
            # all current before content extraction.
            meta = source._metadata(work.item_key)
            if not _metadata_in_current_selection(state, work, meta):
                _fail_work(state, work, "provider item is no longer in the current selected membership")
                summary.failed += 1
                summary.failure_categories["membership_changed"] = (
                    summary.failure_categories.get("membership_changed", 0) + 1
                )
                continue
            doc = source._raw_doc(meta)
            if not state.work_membership_current(work):
                continue
            restored_root = _restorable_file_root(state, execution, namespace, generation, work, meta, source)
        except BrainError:
            raise
        except ProviderDeferred as exc:
            if exc.category in _LOCAL_DEADLINE_CATEGORIES:
                # The RUN's budget, not the provider: either nothing was sent before it ran out
                # (AIO-1167 R44 U5), or Google answered in time but after it (R45 M6). Not a provider
                # failure — the work is left exactly as it was, for a fresh budget. Its own category
                # is kept: `dispatch_deadline` or `run_deadline` (R51 F7).
                summary.failure_categories.setdefault(exc.category, 1)
                break
            if exc.category == "rate_limited":
                # The provider's wait governs this account, not this one document (R44 C6): stop
                # every further call for it, and leave this obligation untouched.
                raise _account_hold(exc) from exc
            _defer_document_read(state, execution, generation, credential, work, exc, summary)
            continue
        except ProviderCursorInvalid:
            # Cursor validity is only meaningful for change enumeration, never an item fetch.
            _fail_work(state, work, "unexpected invalid cursor while reading document")
            summary.failed += 1
            summary.failure_categories["provider_read"] = summary.failure_categories.get("provider_read", 0) + 1
            continue
        except IncompleteExtractionError as exc:
            _fail_work(state, work, str(exc))
            summary.failed += 1
            summary.failure_categories["incomplete_extraction"] = summary.failure_categories.get("incomplete_extraction", 0) + 1
            continue
        except Exception as exc:
            _fail_work(state, work, f"{type(exc).__name__}: {exc}")
            summary.failed += 1
            summary.failure_categories["provider_read"] = summary.failure_categories.get("provider_read", 0) + 1
            continue
        if not await _push_doc(
            client, execution, doc, conn, state, namespace, generation, summary, work,
            restored_root=restored_root,
        ):
            break
    return consumed


def _defer_document_read(
    state: StateStore, execution: GdriveExecution, generation: int, credential: str,
    work: PendingWork, exc: ProviderDeferred, summary: IngestSummary,
) -> None:
    """A non-quota provider deferral of one document's read — its content read or its removal
    probe (R51 blind-final 2) — never an account hold.

    The provider's named deadline is the earliest retry, never the shorter backoff (R48 D2), and it
    outlives this observation: recorded as the DOCUMENT's restriction (R49 F1), carried in the
    fenced progress. Only a provider-NAMED deadline is an external minimum that survives an explicit
    rearm (R51 F5); a malformed header's bounded fallback or a timeout is this sidecar's own wait,
    still delaying the next attempt as local backoff. The obligation is never acknowledged here."""
    if getattr(exc, "provider_deadline", False) and exc.not_before and credential:
        state.restrict_document(
            execution.integration_id, generation, credential, work.item_key,
            exc.not_before, exc.category,
            unrepresentable=getattr(exc, "diagnostic", None) == "retry_after_unrepresentable",
        )
    _fail_work(
        state, work, str(exc), retry_after=exc.not_before,
        external=bool(getattr(exc, "provider_deadline", False)),
    )
    summary.failed += 1
    summary.failure_categories[exc.category] = summary.failure_categories.get(exc.category, 0) + 1
    _count_retry_after_diagnostic(summary, exc)


# A removal one stream observed while another stream of the connection had not yet drained past it.
_CROSS_STREAM_PENDING = "cross-stream move unresolved"
# A removal whose settlement needs a probe of a document under a standing provider minimum.
_RESTRICTED_PROBE_PENDING = "removal probe waits on the document's provider restriction"


def _document_loss_verified(source: GoogleDriveSource, file_id: str) -> bool:
    """Whether the provider itself says one document is gone for this connection.

    A removal a drive's change log reports is ambiguous while another stream cannot be read: the
    document may have moved there. The document's own metadata, read under the run's fence, is
    not. An explicit not-found — it was deleted, or the account no longer has access to it — and
    a trashed document are absence whichever drive it was in. Anything else verifies nothing: it
    is readable, so it is somewhere, or the read failed in a way that says nothing about it.

    A DEFERRED probe (``ProviderDeferred``) is raised, never answered (R51 blind-final 2): it is
    neither survival nor loss evidence, and its wait belongs to the removal drain's owners.
    """
    try:
        meta = source._metadata(file_id)
    except (BrainError, ProviderDeferred):
        raise
    except Exception as exc:
        return _provider_status(exc) == 404
    return bool(meta.get("trashed"))


def _observation_token(execution: GdriveExecution) -> str:
    """The identity of ONE execution grant: its fence and the per-acquisition owner the coordinator
    mints (a fresh ``uuid4`` each run). Evidence observed under it is current for exactly that
    execution — never for a later one, however it was reacquired (AIO-1167 R66)."""
    return f"{execution.fence}:{execution.owner}"


def _explicit_trash_verdict(
    state: StateStore, execution: GdriveExecution, source: GoogleDriveSource, work: PendingWork,
    connection_id: str, *, restricted: bool,
) -> str:
    """Whether a retained explicit-trash removal is still the connection's (AIO-1167 R61/R66).

    The connection's brain claim is one per document, whichever stream — or WORKER — made it, while
    trash evidence is retained in one worker's local store — across a refused or lost
    acknowledgment, a restart, a replacement worker. A document restored meanwhile is ingested by
    another stream, or by another worker against another state file, which claims it; replaying the
    older trash would deactivate the restored claim, and no later complete snapshot would reactivate
    it. Neither local absence of a claim, a retry count, the generation nor a fresh execution fence
    says the trash is still current, so:

      · observed under THIS execution (``observed_under``, ``_observation_token``) and claimed by no
        other local stream — ``absent`` at once, with no read: the provider answered within the
        execution that holds authority now, so nothing can have been published since (prompt
        trash, R51 final 2);
      · anything else — retained from an earlier execution, a legacy obligation, or claimed by ANY
        other stream — needs CURRENT provider evidence, and the document's own metadata decides: trashed or not found is
        ``absent`` (a genuinely later trash); readable and not trashed, the trash is OBSOLETE —
        superseded, never sent (``superseded``); unreadable otherwise, nothing is concluded
        (``unverified``). Whether that stream can read its change log NOW says nothing about when
        its claim was made (R62): a stream that ingested the restoration and then lost its start
        token still holds the restored claim, so stream availability is never chronology;
      · needing that evidence under a standing provider minimum — ``restricted``: retained, not
        read early.

    A deferral of the read (a Retry-After, a quota answer) is raised for the removal drain's owners,
    as for any probe, so no later probe is made early."""
    fresh = (work.payload or {}).get("observed_under") == _observation_token(execution)
    if fresh and not state.streams_claiming(connection_id, work.generation, work.namespace, work.item_key):
        return "absent"
    if restricted:
        state.fail_work(work, _RESTRICTED_PROBE_PENDING, not_before=work.not_before, failure=False)
        return "restricted"
    try:
        meta = source._metadata(work.item_key)
    except (BrainError, ProviderDeferred):
        raise
    except Exception as exc:
        return "absent" if _provider_status(exc) == 404 else "unverified"
    if meta.get("trashed"):
        return "absent"
    state.supersede_pending_trash(work.namespace, work.generation, work.item_key)
    return "superseded"


def _cross_stream_removal(
    state: StateStore, execution: GdriveExecution, source: GoogleDriveSource, work: PendingWork,
    *, restricted: bool = False,
) -> str:
    """What one stream's removal means for a connection that consumes other streams too.

    ``removed_provider_ids`` removes a document for the whole connection. But a document — or a
    folder and everything under it — moved between selected roots in two drives is reported as
    removed by the drive it left and as present by the drive it entered, each in its own change
    log, consumed in either order. So before a removal leaves this stream it is weighed against
    every other stream of the roster — including one the brain holds and local state does not,
    and the destination of a root that is still on its way:

      · ``claimed`` — another stream that can read its change log holds the document (in its
        published snapshot, in one it is building, or as an upsert it still owes), and the
        provider does not say it is gone. Only this stream's membership ended.
      · ``withheld`` — no readable stream holds it, but one may not have read that far. Each peer
        is given a durable barrier when it is first known for this removal — at once, or runs
        later when a relocation makes a new one — and the obligation stays until every peer has
        finished a drain that began after its barrier. A peer with no barrier is one nothing is
        known about, across any restart.
      · ``absent`` — every peer has, and none holds it. The removal is the connection's.

    A peer that cannot be read — it has no local state yet, holds no token, or waits on one for
    its recovery — may never pass its barrier, and what it holds is what it held when it could
    last read: it cannot observe the document leaving it. Behind such a peer, claiming the
    document or not, the removal stays withheld while it is ambiguous, but the document itself
    is read: gone at the provider, it is absent now, without waiting for a snapshot that peer may
    never complete.

    A connection with one stream has nothing to wait for: its removals are ``absent`` at once —
    unless a selected root is unresolved or uncertain. Such a root may live in a drive whose stream
    nobody knows of yet, so "no peer holds it" is not evidence there; until the roster is known, a
    removal is ``absent`` only when the document's own metadata says it is gone (AC-05's positive
    verification of a deletion or lost access), and is otherwise withheld.

    ``restricted`` — the document is under a standing provider minimum (R51 blind-final 1). A removal
    that needs no read (one stream, known roster; or every peer passed its barrier) still settles;
    one that would need the document's own metadata is ``restricted``: retained, never probed early,
    and a claim is never honoured without the provider's answer.

    A removal carrying EXPLICIT trash evidence (``payload["trashed"]``, R51 final 2) is ``absent`` at
    once while no other stream of the connection claims the document: the provider already said the
    document itself is trashed — the very answer a probe would seek — so no peer, barrier or probe
    can add to it, and no restriction is consulted (no read is made). An ambiguous ``removed`` hint
    never carries it. Trash evidence is history, though, and a claim is the trace of a LATER
    restoration through another stream (R61, ``_explicit_trash_verdict``): then it is re-verified.
    """
    own = state.get_progress(work.namespace)
    connection_id = own.key.connection_id if own is not None else execution.integration_id
    if (work.payload or {}).get("trashed") is True:
        return _explicit_trash_verdict(state, execution, source, work, connection_id, restricted=restricted)
    roster_unknown = state.unknown_root_count(connection_id, work.generation) > 0
    local = {
        progress.key.drive_id: progress
        for progress in state.list_progress(connection_id, work.generation)
        if progress.namespace != work.namespace
    }
    if own is None:
        # No stream to name the peers from: only those local state itself holds are known.
        peers = {drive_id: progress.key for drive_id, progress in local.items()}
    else:
        peers = {
            drive_id: dataclasses.replace(own.key, drive_id=drive_id)
            for drive_id in _stream_roster(
                state, connection_id, work.generation, execution.progress,
                configured=(execution.config or {}).get("sharedDriveIds") or (),
            )
            if drive_id != own.key.drive_id
        }
    if not peers and not roster_unknown:
        return "absent"
    by_namespace = {progress.namespace: progress for progress in local.values()}
    claimants = state.streams_claiming(
        connection_id, work.generation, work.namespace, work.item_key,
    )
    # A claim is membership a stream recorded, not an observation that the document survived the
    # removal — even where that stream's change log can be read now. So the provider's own answer
    # is read before any claim is honoured, and read once: gone at the provider, no claim keeps it.
    if claimants and restricted:
        state.fail_work(work, _RESTRICTED_PROBE_PENDING, not_before=work.not_before, failure=False)
        return "restricted"
    if claimants and _document_loss_verified(source, work.item_key):
        return "absent"
    if any(not _cannot_read(by_namespace.get(namespace)) for namespace in claimants):
        return "claimed"
    barriers: dict[str, str] = {}
    for drive_id, key in peers.items():
        barrier = state.removal_barrier(work, key)
        if barrier == "missing" or (barrier == "passed" and drive_id not in local):
            # No barrier yet — or one this peer passed before local state lost the stream, whose
            # membership that drain was read into: either way there is no evidence about it now.
            state.raise_removal_barrier(work, key, renew=True)
            barrier = "standing"
        barriers[drive_id] = barrier
    if (
        not claimants and not roster_unknown
        and all(barrier == "passed" for barrier in barriers.values())
    ):
        return "absent"
    unreadable = [
        drive_id for drive_id, barrier in barriers.items()
        if barrier != "passed" and _cannot_read(local.get(drive_id))
    ]
    # Behind an unreadable stream that claims nothing — or a roster an unresolved root may extend —
    # the document is read for itself here; a claim was already weighed against the provider's
    # answer above, and is not read again.
    if not claimants and (unreadable or roster_unknown) and restricted:
        state.fail_work(work, _RESTRICTED_PROBE_PENDING, not_before=work.not_before, failure=False)
        return "restricted"
    if (
        not claimants and (unreadable or roster_unknown)
        and _document_loss_verified(source, work.item_key)
    ):
        return "absent"
    # Attempted again each run, behind retries that have waited less. Waiting is not failing: it
    # spends none of the retry budget C7's backoff and exhaustion are computed from.
    state.fail_work(work, f"{_CROSS_STREAM_PENDING}: awaiting the other streams' next drain", failure=False)
    return "withheld"


def _stream_access_refusal(exc: BaseException) -> bool:
    """A provider refusal of ONE stream's reads: a non-retryable HTTP 403/404 from Google. Brain
    authority errors (including the connection-wide provider-unauthorized), deferrals, cancellation
    and every other exception are not this, and keep their existing run-terminal handling."""
    if isinstance(exc, (BrainError, ProviderDeferred, ProviderCursorInvalid)) or not isinstance(exc, Exception):
        return False
    # The HTTP status as the source reads it (`GoogleDriveSource._status`), read here directly so a
    # substituted source class can never turn this check into a different error.
    response = getattr(exc, "resp", None)
    value = getattr(response, "status", None) or getattr(exc, "status_code", None)
    try:
        return int(value) in (403, 404) if value is not None else False
    except (TypeError, ValueError):
        return False


def _cannot_read(progress: Any) -> bool:
    """A peer stream with no local state, no token, or a recovery waiting on its start token."""
    return progress is None or _unstarted(progress) or _start_recovery_blocked(progress)


def _run_deadline_reached(execution: GdriveExecution) -> bool:
    return execution.run_deadline is not None and time.monotonic() >= execution.run_deadline


def _record_sink_failure(
    state: StateStore, work: PendingWork | None, exc: BrainError, summary: IngestSummary,
) -> bool:
    """Keep one obligation durable and retryable after its sink or reconcile call failed.

    Returns False when the run's deadline deferred the call: the sink will not take more work
    before that deadline, so the caller starts none. A call the deadline stopped before it was
    sent was never an attempt and leaves the obligation untouched; a wait the brain named
    (``Retry-After``) that does not fit is retried no earlier than that.
    """
    summary.failure_categories[exc.code] = summary.failure_categories.get(exc.code, 0) + 1
    deferred = isinstance(exc, BrainDeferred)
    not_before = exc.not_before if isinstance(exc, BrainDeferred) else None
    if deferred and not_before is None:
        return False
    summary.failed += 1
    if work:
        # The combined wait (Retry-After or the client's own fallback, plus jitter) only delays the
        # next attempt; the brain-named part alone is an external minimum (R51 L2).
        _fail_work(
            state, work, str(exc), retry_after=not_before, external=False,
            minimum=getattr(exc, "provider_not_before", None),
        )
    return not deferred


def _validation_detail(exc: ValidationError) -> str:
    """Field and rule only: pydantic's own message would copy the offending text into state."""
    return "invalid item payload: " + ", ".join(
        f"{'.'.join(str(part) for part in error.get('loc', ()))} ({error.get('type', 'invalid')})"
        for error in exc.errors()
    )


def _metadata_in_current_selection(
    state: StateStore, work: PendingWork, meta: dict[str, Any],
) -> bool:
    """Whether the document, as the provider reports it now, is inside the selection.

    The roots and traversal it is weighed against are those of the snapshot that answers for the
    obligation now (``work_snapshot_id``): the build that listed it until that build is published,
    and never a snapshot whose replacement was. A folder a retired snapshot traversed, since moved
    out of the selected root, authorizes nothing.
    """
    if meta.get("trashed") or meta.get("mimeType") not in (None, GOOGLE_DOC_MIME):
        return False
    snapshot_id = state.work_snapshot_id(work)
    if snapshot_id is None:
        return True  # pre-snapshot compatibility; upgraded enumeration always has one
    roots = state.list_roots(work.namespace, work.generation, snapshot_id=snapshot_id)
    if any(row["root_kind"] == "file" and row["root_id"] == work.item_key for row in roots):
        return True
    drive_id = str(meta.get("driveId") or "")
    if any(row["root_kind"] == "drive" and row["root_id"] == drive_id for row in roots):
        return True
    return any(
        state.roots_for_parent(
            work.namespace, work.generation, str(parent), snapshot_id=snapshot_id,
        )
        for parent in meta.get("parents") or []
    )


async def _checkpoint_progress(
    client: BrainClient,
    execution: GdriveExecution,
    state: StateStore,
    namespace: str,
    publish_snapshot: int | None = None,
    **changes: Any,
) -> None:
    """Commit the complete cursor snapshot to the brain first, then mirror it locally."""
    progress = state.get_progress(namespace)
    if progress is None:
        raise RuntimeError(f"missing local Drive progress {namespace}")
    stream_payload: dict[str, Any] = {
        "phase": progress.phase,
        "drive_id": progress.key.drive_id,
        "page_token": progress.page_token,
        "baseline_start_token": progress.baseline_start_token,
        "traversal_token": progress.traversal_token,
        "listing_complete": progress.listing_complete,
        "last_attempt_at": progress.last_attempt_at,
        "last_success_at": progress.last_success_at,
        "last_error": progress.last_error,
        "retry_not_before": progress.retry_not_before,
        "active_snapshot": progress.active_snapshot,
        "building_snapshot": progress.building_snapshot,
        "recovery_required": progress.recovery_required,
        "checkpoint_id": progress.checkpoint_id,
        "terminal_drain_token": progress.terminal_drain_token,
        "terminal_drain_checkpoint_id": progress.terminal_drain_checkpoint_id,
        "terminal_drain_acknowledged": progress.terminal_drain_acknowledged,
        "drain_observation": progress.drain_observation,
        "terminal_drain_observation": progress.terminal_drain_observation,
    }
    stream_payload.update(changes)
    if publish_snapshot is not None:
        stream_payload.update({
            "active_snapshot": publish_snapshot,
            "building_snapshot": None,
            "recovery_required": False,
            "listing_complete": True,
        })
    streams: dict[str, Any] = {}
    remote_streams = execution.progress.get("streams")
    if isinstance(remote_streams, dict):
        streams.update({str(key): dict(value) for key, value in remote_streams.items()
                        if isinstance(value, dict)})
    else:
        legacy_drive = str(execution.progress.get("drive_id") or "")
        if legacy_drive:
            streams[legacy_drive] = dict(execution.progress)
    # A sibling's LOCAL copy replaces the acknowledged remote one only when it is at least as new
    # as what this execution acquired (AIO-1167 R44 S1). A sibling whose local copy has not yet been
    # restored from that remote (`server_revision` behind) is stale: the newer remote stream is kept
    # as acknowledged, and the sibling is restored from it at its own turn. Only streams of THIS
    # account are this coordinator's.
    acquired_revision = int(execution.progress_revision or 0)
    published: set[str] = set()
    for local in state.list_progress(execution.integration_id, execution.generation):
        if local.namespace != namespace and local.key.credential_id != progress.key.credential_id:
            continue
        if (local.namespace != namespace and local.key.drive_id in streams
                and local.server_revision < acquired_revision):
            continue
        published.add(local.namespace)
        streams[local.key.drive_id] = {
            "phase": local.phase, "drive_id": local.key.drive_id,
            "page_token": local.page_token,
            "baseline_start_token": local.baseline_start_token,
            "traversal_token": local.traversal_token,
            "listing_complete": local.listing_complete,
            "last_attempt_at": local.last_attempt_at,
            "last_success_at": local.last_success_at,
            "last_error": local.last_error,
            "retry_not_before": local.retry_not_before,
            "active_snapshot": local.active_snapshot,
            "building_snapshot": local.building_snapshot,
            "recovery_required": local.recovery_required,
            "checkpoint_id": local.checkpoint_id,
            "terminal_drain_token": local.terminal_drain_token,
            "terminal_drain_checkpoint_id": local.terminal_drain_checkpoint_id,
            "terminal_drain_acknowledged": local.terminal_drain_acknowledged,
            "drain_observation": local.drain_observation,
            "terminal_drain_observation": local.terminal_drain_observation,
        }
    streams[progress.key.drive_id] = stream_payload
    # Keep the active stream mirrored at top level for old sidecars/watch readers while v2 readers
    # consume the authoritative per-drive map.
    cursor_document: dict[str, Any] = {"version": 2, "streams": streams, **stream_payload}
    # Root-resolution evidence travels with every cursor checkpoint, under the same fence, so a
    # sidecar that lost its local state recovers it from the brain (`_adopt_remote_root_evidence`).
    cursor_document[ROOTS_KEY] = roots_section(
        execution.generation,
        state.root_obligations(execution.integration_id, execution.generation),
    )
    # Standing provider minimums travel with every cursor checkpoint (AIO-1167 R47 F5, R49 F1): this
    # account's own hold and resource restrictions, and every other account's evidence carried
    # forward unchanged (R50). Built from the acknowledged evidence and the local journal, so a
    # checkpoint can add or extend a minimum but never drop a standing one; a lapsed one is dropped.
    apply_restriction_sections(
        cursor_document, _restriction_sections(state, execution, progress.key.credential_id),
    )
    # The coordinator owns cursors and roots, never renewal's channel lifecycle: that is carried
    # from the acknowledged document unchanged, so a poll cannot erase a watch intent or record.
    payload = coordinator_document(execution.progress, cursor_document)
    ack = await client.checkpoint_gdrive_execution(execution, payload) or {}
    acknowledged = dict(ack.get("progress") or payload)
    execution.progress.clear()
    execution.progress.update(acknowledged)
    # The root snapshot THIS coordinator submitted, as the brain acknowledged it, becomes each root's
    # baseline — state and transition identity (R58/R59). A refused or lost acknowledgement raised
    # above and advanced nothing.
    state.acknowledge_roots(
        execution.integration_id, execution.generation,
        parse_roots_section(acknowledged, execution.generation),
        submitted=parse_roots_section(payload, execution.generation),
    )
    revision = int(ack.get("progress_revision") or progress.server_revision)
    state.update_progress(
        namespace,
        **changes,
        server_revision=revision,
    )
    if publish_snapshot is not None:
        state.publish_selection_snapshot(namespace, execution.generation, publish_snapshot)
    # Only a sibling whose local copy this checkpoint actually published is now current; a stale
    # one keeps its older revision, so it is still restored from the brain before it is used.
    for local in state.list_progress(execution.integration_id, execution.generation):
        if local.namespace != namespace and local.namespace in published and local.server_revision < revision:
            state.update_progress(local.namespace, server_revision=revision)


async def _checkpoint_start_unavailable(
    client: BrainClient,
    execution: GdriveExecution,
    state: StateStore,
    namespace: str,
    unavailable: StreamStartUnavailable,
    summary: IngestSummary,
) -> None:
    """Record one stream, locally and on the brain, as waiting on a start token it cannot get.

    A stream that never started has no token and enumerates nothing. One that had started keeps
    everything it holds — its cursor, its published membership, the claims made through it — and
    is marked for the recovery it could not begin. Either is retried on every run, counts as
    backlog and keeps the connection from reconciling, while the other streams still run.
    """
    progress = state.get_progress(namespace)
    if progress is not None and not _unstarted(progress):
        changes: dict[str, Any] = {"recovery_required": True}
    else:
        changes = {"baseline_start_token": None, "page_token": None, "listing_complete": False}
    await _checkpoint_progress(
        client, execution, state, namespace, phase="partial", last_error=str(unavailable),
        last_attempt_at=_now(), **changes,
    )
    summary.failed += 1
    summary.failure_categories = summary.failure_categories or {}
    summary.failure_categories["stream_start_unavailable"] = (
        summary.failure_categories.get("stream_start_unavailable", 0) + 1
    )


def _merge_summary(target: IngestSummary, source: IngestSummary) -> None:
    for field in ("created", "updated", "unchanged", "failed", "skipped", "removed"):
        setattr(target, field, getattr(target, field) + getattr(source, field))
    target.failure_categories = target.failure_categories or {}
    for key, value in (source.failure_categories or {}).items():
        target.failure_categories[key] = target.failure_categories.get(key, 0) + value
    # A root verified unavailable by several streams or phases counts once per run (R50 F7).
    roots = source.__dict__.get("_verified_unavailable_roots")
    if roots:
        seen: set[tuple[str, str]] = target.__dict__.setdefault("_verified_unavailable_roots", set())
        seen.update(roots)
        target.failure_categories["selection_root_unavailable"] = len(seen)
    # An unpublished restriction owner is reported once per run, however many streams saw it (R51 F3).
    unpublished = source.__dict__.get("_unpublished_restrictions")
    if unpublished:
        _note_unpublished(target, set(unpublished))


def _retry_deferred(not_before: str | None, *, now: str | None = None) -> bool:
    if not not_before:
        return False
    try:
        due = datetime.fromisoformat(not_before.replace("Z", "+00:00"))
        current = datetime.fromisoformat((now or _now()).replace("Z", "+00:00"))
        if due.tzinfo is None:
            due = due.replace(tzinfo=timezone.utc)
        if current.tzinfo is None:
            current = current.replace(tzinfo=timezone.utc)
        return due > current
    except ValueError:
        # Corrupt retry state cannot create a permanent denial; the provider call remains bounded.
        return False


def _defer_until(seconds: int = 60) -> str:
    from datetime import timedelta
    return (datetime.now(timezone.utc) + timedelta(seconds=max(1, seconds))).isoformat()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _utcnow() -> datetime:
    """The same clock as ``_now`` (tests replace ``_now`` to make both deterministic)."""
    return datetime.fromisoformat(_now().replace("Z", "+00:00"))


def _durable_success_instant(value: Any) -> datetime | None:
    """A stream's ``last_success_at`` as an aware instant, or ``None`` when it is not valid evidence.

    Missing, blank, unparseable and offset-less (naive) values are all "no evidence": a naive time
    cannot be placed on the clock it is compared with, and guessing a zone would invent freshness.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        instant = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return instant if instant.tzinfo is not None else None


def _stream_cursor_age_seconds(progresses: Iterable[Any], *, now: datetime) -> float | None:
    """AC-07 cursor age: seconds since the STALEST required stream's last durable success.

    Each element is one required stream's progress (``None`` when the roster names a stream with no
    progress). A stream's ``last_success_at`` is written only by ``_checkpoint_progress`` — the brain
    acknowledges the checkpoint first, then it is mirrored locally — and only when the stream's
    terminal drain is clean and the all-stream reconciliation was acknowledged (``finalize``), or an
    empty selection's drain completed. It is mirrored back from the brain's checkpoint on recovery
    and survives restart in local state. Run entry and every attempt write ``last_attempt_at``,
    which this never reads.

    The oldest success across the roster is the honest answer: one healthy stream must not hide a
    stale one. Unknown (``None``) — never zero — when the roster is empty, any required stream has no
    progress or no valid success time, or a success time lies in the future.
    """
    oldest: datetime | None = None
    counted = 0
    for progress in progresses:
        counted += 1
        instant = _durable_success_instant(getattr(progress, "last_success_at", None)) if progress is not None else None
        # Every required timestamp is validated against `now` on its own, before any is chosen as
        # the oldest: a future success on one stream is invalid evidence even when another stream's
        # older, valid success would otherwise be the one reported.
        if instant is None or instant > now:
            return None
        if oldest is None or instant < oldest:
            oldest = instant
    if counted == 0 or oldest is None:
        return None
    return (now - oldest).total_seconds()


def _roster_cursor_age_seconds(
    state: StateStore,
    team: str,
    integration_id: str,
    credential: str,
    generation: int,
    drive_ids: Iterable[Any],
    *,
    now: datetime | None = None,
) -> float | None:
    """Cursor age over exactly this generation's required roster (see ``_stream_cursor_age_seconds``).

    Each stream is looked up by its own current-generation key, so another generation's or another
    credential's progress can never stand in for a required stream.
    """
    progresses = [
        state.get_progress(StreamKey(team, integration_id, credential, str(drive_id)).namespace(generation))
        for drive_id in drive_ids
    ]
    return _stream_cursor_age_seconds(progresses, now=now if now is not None else _utcnow())
