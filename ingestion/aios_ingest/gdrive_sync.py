"""Durable baseline + Drive changes coordination.

This is the single Drive coordinator. It captures a provider start token before enumeration,
persists every page obligation before advancing, and treats opaque Drive tokens as opaque strings.
The brain-issued generation/lease fence is the commit authority; local SQLite is resumable work
state only. Notifications, manual runs and periodic polling converge here.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import math
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from pydantic import ValidationError

from .brain_client import BrainClient, BrainDeferred, BrainError, GdriveExecution
from .config import BrainSettings, Connection
from .engine import IngestSummary
from .normalize import normalize
from .sources.gdrive import (
    FOLDER_MIME,
    GOOGLE_DOC_MIME,
    GoogleDriveSource,
    IncompleteExtractionError,
    ProviderCursorInvalid,
    ProviderDeferred,
)
from .state import StateStore, StreamKey, PendingWork, MaterializedPage
from .selections import effective_gdrive_connection

_TERMINAL_AUTHORITY_CODES = {
    "unauthorized", "connector_principal_required", "wrong_connection",
    "stale_execution", "connection_unavailable", "reconnect_required",
}
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
) -> dict[tuple[str, str], str]:
    """Bind every selected file/folder root to the change stream of the drive that contains it.

    A document or folder inside a Shared Drive is reported by that drive's change log, so it is
    consumed through that drive's stream and cursor. A binding only says where a root lives: it
    adds no ``drive`` root, so nothing else in that drive becomes selected. Bindings are durable
    and fixed for the generation — one provider read per root, resumed across runs.
    """
    bindings = state.root_bindings(integration_id, generation)
    for kind, root_id in _selected_roots(options):
        if (kind, root_id) in bindings:
            continue
        meta = source._metadata(root_id)
        drive_id = str(meta.get("driveId") or "my-drive")
        state.bind_root(integration_id, generation, kind, root_id, drive_id)
        bindings[(kind, root_id)] = drive_id
    return bindings


def _stream_ids(
    options: dict[str, Any], bindings: dict[tuple[str, str], str] | None = None,
) -> list[str]:
    """Return every independently consumed Drive change stream for the selected scope."""
    if str(options.get("selection_state") or "selected") == "empty":
        # A synthetic no-provider stream makes the authoritative empty snapshot durable without
        # interpreting empty as all of My Drive.
        return ["my-drive"]
    streams = {str(value) for value in options.get("shared_drive_ids") or [] if value}
    # Without bindings (callers that never resolved them) a file/folder root is a My Drive root.
    streams.update((bindings or {}).get(root, "my-drive") for root in _selected_roots(options))
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
    only when the whole Shared Drive was selected."""
    configured: list[tuple[str, str, str, bool]] = [
        (root_id, kind, drive_id, kind == "folder" and bool(options.get("recursive")))
        for kind, root_id in _selected_roots(options)
        if (bindings or {}).get((kind, root_id), "my-drive") == drive_id
    ]
    if drive_id in {str(value) for value in options.get("shared_drive_ids") or []}:
        configured.append((drive_id, "drive", drive_id, True))
    return configured


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
            return IngestSummary(
                conn.name, skipped=1, failure_categories={exc.code: 1},
                deferred=exc.code == "execution_busy", backlog=None, integration_id=integration_id,
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
                    reconciled = await client.reconcile_gdrive(
                        execution, complete_snapshot_ids=[],
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
                return total
            auth_mode = str(options.get("auth_mode") or "oauth")
            token_provider = None
            if auth_mode == "oauth":
                try:
                    grant = await client.broker_gdrive_access_token(execution)
                except BrainError as exc:
                    return IngestSummary(conn.name, failed=1, failure_categories={exc.code: 1})
                options["granted_scopes"] = list(grant.get("scopes") or [])
                account = grant.get("account") or {}
                options["credential_identity"] = account.get("subject") or account.get("email") or options["credential_identity"]
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
                                         failure_categories={"service_account_credentials_missing": 1})

            provider_gate = client.gdrive_provider_gate(execution)
            control = {"credential_identity", "integration_id", "auth_mode", "service_account_status", "webhook_url", "watch_ttl_seconds"}
            source_options = {key: value for key, value in options.items() if key not in control}
            source = GoogleDriveSource(
                **source_options, provider_gate=provider_gate, token_provider=token_provider,
            )
            if hasattr(source, "set_run_deadline"):
                source.set_run_deadline(run_deadline)
            drive, _ = source._services()
            if auth_mode == "service_account" and options.get("service_account_status") == "pending":
                try:
                    about = source._execute(drive.about().get(fields="user(emailAddress,permissionId)"))
                    user = about.get("user") or {}
                    identity = str(user.get("emailAddress") or "").strip()
                    if not identity:
                        return IngestSummary(
                            conn.name, failed=1,
                            failure_categories={"service_account_identity_unverified": 1},
                        )
                    await client.verify_gdrive_service_account(execution, identity)
                except BrainError as exc:
                    return IngestSummary(conn.name, failed=1, failure_categories={exc.code: 1})
                except ProviderDeferred as exc:
                    return IngestSummary(conn.name, failed=1, failure_categories={exc.category: 1})
            generation = execution.generation
            total = IngestSummary(conn.name, failure_categories={}, integration_id=integration_id)
            # Which streams exist depends on where each selected root lives, so every root is bound
            # before any start token is captured. An unreadable root has no known stream: nothing
            # is enumerated on a guess, and the generation resumes binding on the next run.
            try:
                root_bindings = _bind_selected_roots(
                    source, state, integration_id, generation, options,
                )
            except BrainError as exc:
                total.failed += 1
                total.failure_categories[exc.code] = 1
                return total
            except ProviderDeferred as exc:
                total.failed += 1
                total.failure_categories[exc.category] = 1
                return total
            except Exception:
                total.failed += 1
                total.failure_categories["selection_root_unresolved"] = 1
                return total
            # A stream this generation already consumes stays accounted for, so local state written
            # before roots were bound cannot leave a cursor that no run ever finishes.
            streams = sorted(
                {*_stream_ids(options, root_bindings),
                 *(progress.key.drive_id for progress in state.list_progress(integration_id, generation))},
                key=lambda value: (value != "my-drive", value),
            )
            if not streams:
                total.failed = 1
                total.failure_categories["selection_unresolved"] = 1
                return total

            # Close the backfill race independently for every required stream before enumerating
            # any one of them. A small run budget therefore cannot leave later Shared Drives
            # without their pre-baseline opaque token.
            if str(options.get("selection_state") or "") != "empty":
                for drive_id in streams:
                    key = StreamKey(
                        settings.team, integration_id, credential_identity(options), drive_id,
                    )
                    namespace = key.namespace(generation)
                    if state.get_progress(namespace) or _remote_stream(execution.progress, drive_id):
                        continue
                    kwargs = {"supportsAllDrives": True}
                    if drive_id != "my-drive":
                        kwargs["driveId"] = drive_id
                    try:
                        start = source._execute(
                            drive.changes().getStartPageToken(**kwargs)
                        )["startPageToken"]
                    except BrainError as exc:
                        total.failed += 1
                        total.failure_categories[exc.code] = 1
                        return total
                    except ProviderDeferred as exc:
                        total.failed += 1
                        total.failure_categories[exc.category] = 1
                        return total
                    state.begin_generation(key, generation, start_token=start)
                    await _checkpoint_progress(
                        client, execution, state, namespace, phase="baselining",
                        baseline_start_token=start, page_token=None, listing_complete=False,
                        last_attempt_at=_now(),
                    )

            remaining = max(0, max_work)
            scheduled_streams = state.rotate_streams(integration_id, generation, streams)
            for stream_index, drive_id in enumerate(scheduled_streams):
                key = StreamKey(
                    settings.team, integration_id, credential_identity(options), str(drive_id),
                )
                streams_left = len(scheduled_streams) - stream_index
                stream_work_budget = (
                    0 if remaining <= 0 else max(1, math.ceil(remaining / streams_left))
                )
                part = await _run_gdrive_stream_unlocked(
                    settings, conn, state, client=client, execution=execution, options=options,
                    source=source, drive=drive, generation=generation, drive_id=str(drive_id),
                    namespace=key.namespace(generation), max_work=stream_work_budget,
                    discovery_budget=_MAX_DISCOVERY_PAGES_PER_STREAM,
                    retry_budget=_MAX_RETRY_WORK_PER_STREAM,
                    run_deadline=run_deadline,
                    provider_gate=provider_gate,
                    root_bindings=root_bindings,
                )
                _merge_summary(total, part)
                # Fresh capacity is reserved independently of retries/failures. Debiting the
                # allocation (rather than summary counts) prevents malformed retry work in one
                # stream from stealing another stream's fresh-work turn.
                remaining = max(0, remaining - stream_work_budget)
                if any(code in _TERMINAL_AUTHORITY_CODES for code in part.failure_categories):
                    return total
                # A depleted document budget must not prevent later streams from validating and
                # durably restoring their independent cursor/snapshot state. They run with zero
                # work capacity, which permits checkpoint recovery but no provider-page drain.

            progresses = state.list_progress(integration_id, generation)
            if len(progresses) == len(streams) and all(
                p.listing_complete
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
                    reconciled = await client.reconcile_gdrive(
                        execution, complete_snapshot_ids=snapshot,
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
                )
                if not total.authoritative_complete and total.backlog == 0:
                    # Enumeration/drain evidence is itself outstanding work.
                    total.backlog = sum(
                        0 if progress.listing_complete and _terminal_drain_complete(progress) else 1
                        for progress in progresses
                    )
                attempts = [progress.last_attempt_at for progress in progresses if progress.last_attempt_at]
                if attempts:
                    try:
                        newest = max(datetime.fromisoformat(value.replace("Z", "+00:00")) for value in attempts)
                        total.cursor_age_seconds = max(0.0, (datetime.now(timezone.utc) - newest).total_seconds())
                    except (TypeError, ValueError):
                        total.cursor_age_seconds = None
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
) -> IngestSummary:
    discovery_budget = max(0, discovery_budget if discovery_budget is not None else max_work)
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
        # Server ack won the race but the process died before the SQLite mirror swap.
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
            and int(remote.get("drain_observation") or 0) == checkpoint_page.drain_observation
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
    if progress is None:
        kwargs = {"supportsAllDrives": True}
        if drive_id != "my-drive":
            kwargs["driveId"] = drive_id
        start = source._execute(drive.changes().getStartPageToken(**kwargs))["startPageToken"]
        progress = state.begin_generation(key, generation, start_token=start)
        await _checkpoint_progress(
            client, execution, state, namespace, phase="baselining",
            baseline_start_token=start, page_token=None, listing_complete=False,
            last_attempt_at=_now(),
        )
        progress = state.get_progress(namespace)

    if remote_v2 and progress is not None:
        needs_recovery = not durable_remote_match
        if needs_recovery:
            kwargs = {"supportsAllDrives": True}
            if drive_id != "my-drive":
                kwargs["driveId"] = drive_id
            fresh = source._execute(drive.changes().getStartPageToken(**kwargs))["startPageToken"]
            state.begin_selection_snapshot(
                namespace, generation, _configured_roots(options, drive_id, root_bindings),
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
                drain_observation=progress.drain_observation + 1,
                terminal_drain_observation=None,
            )
            progress = state.get_progress(namespace)

    summary = IngestSummary(conn.name, failure_categories={})
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
            except BrainError:
                raise
            except ProviderDeferred as exc:
                await _checkpoint_progress(
                    client, execution, state, namespace, phase="partial",
                    last_error=exc.category, retry_not_before=exc.not_before,
                )
                summary.failed += 1
                summary.failure_categories[exc.category] = summary.failure_categories.get(exc.category, 0) + 1
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
                if existing.terminal_token and not existing.next_token:
                    break
                continue
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
                kwargs = {"supportsAllDrives": True}
                if drive_id != "my-drive":
                    kwargs["driveId"] = drive_id
                fresh = source._execute(drive.changes().getStartPageToken(**kwargs))["startPageToken"]
                state.reset_selection_snapshot(namespace, generation)
                await _checkpoint_progress(
                    client, execution, state, namespace, phase="baselining",
                    baseline_start_token=fresh, page_token=None, listing_complete=False,
                    last_error="invalid cursor; controlled rescan",
                    terminal_drain_token=None, terminal_drain_checkpoint_id=None,
                    terminal_drain_acknowledged=False,
                    drain_observation=(state.get_progress(namespace).drain_observation + 1),
                    terminal_drain_observation=None,
                )
                summary.failed += 1
                summary.failure_categories["invalid_cursor"] = 1
                return summary
            except ProviderDeferred as exc:
                await _checkpoint_progress(
                    client, execution, state, namespace, phase="partial",
                    last_error=exc.category, retry_not_before=exc.not_before,
                )
                summary.failed += 1
                summary.failure_categories[exc.category] = 1
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
                        membership_root_removals.extend(ancestor_pairs)
                        final_items = set(ancestor_final)
                        tombstoned_roots = {
                            str(row["root_id"])
                            for row in active_roots
                            if row["root_kind"] == "folder" and str(row["root_id"]) == file_id
                        }
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
                removed = bool(change.get("removed") or file.get("trashed"))
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
                if removed or (selected and not in_scope):
                    if selected:
                        obligations.append((file_id, "remove", {"file_id": file_id}))
                        membership_removals.append(file_id)
                    continue
                if file.get("mimeType") not in (None, GOOGLE_DOC_MIME) or not (in_scope or selected):
                    continue
                if root_parents:
                    for root, parent in root_parents:
                        membership_additions.append((file_id, root, drive_id, parent))
                else:
                    for root in ([file_id] if direct else ([drive_root] if drive_root else [])):
                        membership_additions.append((file_id, root, drive_id, None))
                obligations.append((file_id, "upsert", {"file_id": file_id, "metadata": file}))
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
            if terminal:
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
    except BrainError as exc:
        summary.failed += 1
        summary.failure_categories[exc.code] = summary.failure_categories.get(exc.code, 0) + 1
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
    roots = state.list_roots(namespace, generation)
    if not roots:
        configured = _configured_roots(options, drive_id, root_bindings)
        state.replace_roots(namespace, generation, configured)
        roots = state.list_roots(namespace, generation)
    snapshot_id = state.snapshot_id(namespace)
    if snapshot_id is None:
        raise RuntimeError("selection snapshot initialization failed")

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
            meta = source._metadata(root["root_id"])
            pages_read += 1
            obligations: list[tuple[str, str, dict[str, Any]]] = []
            membership_additions: list[tuple[str, str, str]] = []
            bound_drive = (root_bindings or {}).get(("file", str(root["root_id"])))
            if bound_drive is not None and bound_drive != drive_id:
                # Retained from local state written before roots were bound: the stream of the
                # drive that contains this root owns it now. Its page here records nothing.
                pass
            elif bound_drive is not None and str(meta.get("driveId") or "my-drive") != drive_id:
                # This stream's cursor can no longer observe the document. Reading it once here
                # and then reporting the stream current would hide every later edit, so the
                # baseline stays partial until the selection is saved again and rebound.
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

    while pages_read < page_budget:
        row = state.next_traversal(namespace, generation, snapshot_id=snapshot_id)
        if row is None:
            break
        token = str(row["page_token"] or "") or None
        page_id = _page_id("baseline", snapshot_id, row["root_id"], row["folder_id"], token)
        page = state.get_page(namespace, generation, page_id)
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
            response = source._execute(drive.files().list(**kwargs))
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
            terminal = bool(page.terminal_token and not page.next_token)
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
) -> bool:
    """Push one document. Returns False only when the run's deadline deferred the sink call."""
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
            state.fail_work(work, detail, not_before=_defer_until())
        return True
    if work and not state.work_membership_current(work):
        # A newer remove/move observation won while extraction was in flight. Never let the stale
        # body reach the sink; the newer durable obligation remains independently runnable.
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
            state.fail_work(work, _validation_detail(exc), not_before=_defer_until())
        return True
    try:
        result = await client.push(item, execution=execution)
        setattr(summary, result.status, getattr(summary, result.status) + 1)
        if work:
            progress = state.get_progress(namespace)
            await _checkpoint_progress(client, execution, state, namespace,
                                       phase=progress.phase if progress else "working")
            state.ack_work(work)
    except BrainError as exc:
        if _is_terminal_authority(exc):
            raise
        return _record_sink_failure(state, work, exc, summary)
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
    for work in state.list_pending(
        namespace, generation, limit=max(1, budget), work_class=work_class,
    )[:budget]:
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
                state.fail_work(
                    work, "provider item is no longer in the current selected membership",
                    not_before=_defer_until(),
                )
                summary.failed += 1
                summary.failure_categories["membership_changed"] = (
                    summary.failure_categories.get("membership_changed", 0) + 1
                )
                continue
            doc = source._raw_doc(meta)
            if not state.work_membership_current(work):
                continue
        except BrainError:
            raise
        except ProviderDeferred as exc:
            state.fail_work(work, str(exc), not_before=exc.not_before)
            summary.failed += 1
            summary.failure_categories[exc.category] = summary.failure_categories.get(exc.category, 0) + 1
            continue
        except ProviderCursorInvalid:
            # Cursor validity is only meaningful for change enumeration, never an item fetch.
            state.fail_work(
                work, "unexpected invalid cursor while reading document",
                not_before=_defer_until(),
            )
            summary.failed += 1
            summary.failure_categories["provider_read"] = summary.failure_categories.get("provider_read", 0) + 1
            continue
        except IncompleteExtractionError as exc:
            state.fail_work(work, str(exc), not_before=_defer_until())
            summary.failed += 1
            summary.failure_categories["incomplete_extraction"] = summary.failure_categories.get("incomplete_extraction", 0) + 1
            continue
        except Exception as exc:
            state.fail_work(
                work, f"{type(exc).__name__}: {exc}", not_before=_defer_until(),
            )
            summary.failed += 1
            summary.failure_categories["provider_read"] = summary.failure_categories.get("provider_read", 0) + 1
            continue
        if not await _push_doc(
            client, execution, doc, conn, state, namespace, generation, summary, work,
        ):
            break
    return consumed


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
        state.fail_work(work, str(exc), not_before=not_before or _defer_until())
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
    for local in state.list_progress(execution.integration_id, execution.generation):
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
    payload: dict[str, Any] = {"version": 2, "streams": streams, **stream_payload}
    ack = await client.checkpoint_gdrive_execution(execution, payload) or {}
    acknowledged = dict(ack.get("progress") or payload)
    execution.progress.clear()
    execution.progress.update(acknowledged)
    revision = int(ack.get("progress_revision") or progress.server_revision)
    state.update_progress(
        namespace,
        **changes,
        server_revision=revision,
    )
    if publish_snapshot is not None:
        state.publish_selection_snapshot(namespace, execution.generation, publish_snapshot)
    for local in state.list_progress(execution.integration_id, execution.generation):
        if local.namespace != namespace and local.server_revision < revision:
            state.update_progress(local.namespace, server_revision=revision)


def _merge_summary(target: IngestSummary, source: IngestSummary) -> None:
    for field in ("created", "updated", "unchanged", "failed", "skipped", "removed"):
        setattr(target, field, getattr(target, field) + getattr(source, field))
    target.failure_categories = target.failure_categories or {}
    for key, value in (source.failure_categories or {}).items():
        target.failure_categories[key] = target.failure_categories.get(key, 0) + value


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
