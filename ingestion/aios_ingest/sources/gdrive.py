"""Google Drive / Docs source with complete tab-aware readable extraction.

The provider id is the durable identity. Folder traversal and Drive change-stream
coordination live above this adapter; this module owns authenticated provider reads,
selection enumeration and conversion of one Google document to :class:`RawDoc`.
"""

from __future__ import annotations

import json
import random
import time
import types
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Iterable, Iterator

from ..brain_client import BrainError
from ..normalize import RawDoc
from .base import MissingExtraError, PullOnlySource, Source
from ._llamahub import docs_to_raw, lazy_reader
from .gdrive_docs import extract_google_doc

GOOGLE_DOC_MIME = "application/vnd.google-apps.document"
FOLDER_MIME = "application/vnd.google-apps.folder"
DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
DOCS_READONLY_SCOPE = "https://www.googleapis.com/auth/documents.readonly"


def _broker_authorized_http(
    credentials: Any, http: Any | None = None, *, timeout_seconds: float = 30.0,
) -> Any:
    """Google transport that authenticates but never owns OAuth token replacement."""
    try:
        import httplib2  # type: ignore
        from google_auth_httplib2 import AuthorizedHttp  # type: ignore
    except ImportError as exc:  # pragma: no cover - optional live dependency
        raise MissingExtraError("gdrive", "google-api-python-client google-auth-httplib2") from exc
    return AuthorizedHttp(
        credentials,
        http=http or httplib2.Http(timeout=max(0.1, float(timeout_seconds))),
        # Let googleapiclient surface HttpError(401) to _provider_call. The brain broker is the
        # only refresh authority and the sidecar intentionally has no refresh secret.
        refresh_status_codes=(),
    )


def _credential_authorized_http(
    credentials: Any, http: Any | None = None, *, timeout_seconds: float = 30.0,
) -> Any:
    """Deadline-aware normal google-auth transport for local service-account credentials."""
    try:
        import httplib2  # type: ignore
        from google_auth_httplib2 import AuthorizedHttp  # type: ignore
    except ImportError as exc:  # pragma: no cover - optional live dependency
        raise MissingExtraError("gdrive", "google-api-python-client google-auth-httplib2") from exc
    raw_http = http or httplib2.Http(timeout=max(0.1, float(timeout_seconds)))
    return AuthorizedHttp(credentials, http=_AbsoluteDeadlineHttp(raw_http))


class IncompleteExtractionError(RuntimeError):
    """Required readable content was missing, so an older complete body must be kept."""


class ProviderDeferred(RuntimeError):
    """A retryable provider call cannot complete inside the current bounded run."""

    def __init__(self, message: str, *, not_before: str | None = None, category: str = "provider_retry"):
        super().__init__(message)
        self.not_before = not_before
        self.category = category


class ProviderCursorInvalid(RuntimeError):
    """Drive rejected an opaque change token; the coordinator must perform a controlled rescan."""


class _AbsoluteDeadlineHttp:
    """Raw google-auth transport enforcing one monotonic deadline at every dispatch.

    ``AuthorizedHttp`` uses the same raw transport for credential ``before_request`` refreshes,
    provider requests, and its credential-refresh replay. Keeping the absolute deadline here means
    every one of those HTTP calls recomputes the remaining budget and reused sockets cannot retain a
    longer timeout. The deadline is never extended by a refresh, redirect, or retry.
    """

    def __init__(self, http: Any, *, monotonic: Callable[[], float] | None = None):
        self._http = http
        self._monotonic = monotonic or time.monotonic
        self._deadline: float | None = None
        original_conn_request = getattr(http, "_conn_request", None)
        if callable(original_conn_request):
            def guarded_conn_request(
                _raw: Any, connection: Any, *args: Any, **kwargs: Any,
            ) -> Any:
                return original_conn_request(
                    _DeadlineConnection(connection, self), *args, **kwargs,
                )
            http._conn_request = types.MethodType(guarded_conn_request, http)

    def set_deadline(self, deadline_monotonic: float) -> None:
        self._deadline = float(deadline_monotonic)

    @property
    def timeout(self) -> Any:
        return getattr(self._http, "timeout", None)

    @timeout.setter
    def timeout(self, value: float) -> None:
        if hasattr(self._http, "timeout"):
            self._http.timeout = value

    @property
    def connections(self) -> Any:
        return getattr(self._http, "connections", None)

    def request(self, *args: Any, **kwargs: Any) -> Any:
        remaining = self._remaining()
        if remaining is not None:
            GoogleDriveSource._bound_transport_timeout(self._http, remaining)
        return self._http.request(*args, **kwargs)

    def _remaining(self) -> float | None:
        if self._deadline is None:
            return None
        remaining = self._deadline - self._monotonic()
        if remaining <= 0:
            raise ProviderDeferred(
                "Google service-account transport deadline expired before HTTP dispatch",
                not_before=datetime.now(timezone.utc).isoformat(),
                category="provider_timeout",
            )
        return remaining

    def __getattr__(self, name: str) -> Any:
        return getattr(self._http, name)


class _DeadlineConnection:
    """Connection proxy that rechecks the parent deadline on httplib2 internal retries."""

    def __init__(self, connection: Any, owner: _AbsoluteDeadlineHttp):
        object.__setattr__(self, "_connection", connection)
        object.__setattr__(self, "_owner", owner)

    def _apply_remaining_timeout(self) -> None:
        remaining = self._owner._remaining()
        if remaining is not None:
            # This proxy is the last boundary before httplib2 touches the network. Use the
            # actual remaining time rather than the transport's normal 100ms floor: a floor
            # here could let a connect, redirect, or retry outlive the absolute run deadline.
            self.timeout = remaining
            socket = getattr(self._connection, "sock", None)
            if socket is not None:
                socket.settimeout(remaining)

    def connect(self, *args: Any, **kwargs: Any) -> Any:
        self._apply_remaining_timeout()
        return self._connection.connect(*args, **kwargs)

    def request(self, *args: Any, **kwargs: Any) -> Any:
        self._apply_remaining_timeout()
        return self._connection.request(*args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)

    def __setattr__(self, name: str, value: Any) -> None:
        if name in {"_connection", "_owner"}:
            object.__setattr__(self, name, value)
        else:
            setattr(self._connection, name, value)


@dataclass(frozen=True)
class ExtractedDocument:
    text: str
    tabs: list[dict[str, Any]]
    unsupported: list[str]
    complete: bool = True


def _iso_utc(value: str | None) -> str | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _identity(person: dict[str, Any], role: str) -> dict[str, str] | None:
    permission_id = str(person.get("permissionId") or "").strip()
    email = str(person.get("emailAddress") or "").strip().lower()
    display = str(person.get("displayName") or "").strip()
    if not (permission_id or email or display):
        return None
    out = {"provider": "gdrive", "role": role}
    if permission_id:
        # The provider namespace makes the identifier kind explicit. OAuth subjects and Drive
        # permission ids are never placed in the same identity namespace.
        out["external_id"] = f"permission:{permission_id}"
    elif email:
        # Retain the identifier KIND even when Drive withholds a permission id. This remains an
        # unresolved author reference until the server verifies the exact address against its roster;
        # it can never collide with an OAuth subject or permission id.
        out["external_id"] = f"author-email:{email}"
    if email:
        out["email"] = email
    if display:
        out["display_name"] = display
    return out


def _is_service_identity(person: dict[str, Any]) -> bool:
    email = str(person.get("emailAddress") or "").strip().lower()
    return email.endswith(".gserviceaccount.com")


class GoogleDocsExtractor:
    """Render the supported Google Docs model without dropping child tabs or tables."""

    def __init__(self, *, max_chars: int = 1_000_000):
        self._max_chars = max_chars

    def extract(self, document: dict[str, Any]) -> ExtractedDocument:
        tabs = document.get("tabs")
        if not isinstance(tabs, list) or not tabs:
            body = document.get("body")
            if not isinstance(body, dict) or not isinstance(body.get("content"), list):
                raise IncompleteExtractionError("document has neither tabs nor a readable root body")
            unsupported: list[str] = []
            text = self._content(body["content"], unsupported).strip()
            return self._bounded(text, [{"id": "root", "title": "Document", "order": 0}], unsupported)

        flattened: list[dict[str, Any]] = []

        def walk(nodes: list[dict[str, Any]]) -> None:
            ordered = sorted(
                (n for n in nodes if isinstance(n, dict)),
                key=lambda n: int((n.get("tabProperties") or {}).get("index") or 0),
            )
            for node in ordered:
                props = node.get("tabProperties") or {}
                tab_id = str(props.get("tabId") or "").strip()
                title = str(props.get("title") or "Untitled tab").strip()
                doc_tab = node.get("documentTab")
                body = doc_tab.get("body") if isinstance(doc_tab, dict) else None
                if not tab_id or not isinstance(body, dict) or not isinstance(body.get("content"), list):
                    raise IncompleteExtractionError(f"tab {tab_id or '(unknown)'} has no documentTab body")
                flattened.append({"id": tab_id, "title": title, "body": body["content"]})
                children = node.get("childTabs")
                if isinstance(children, list):
                    walk(children)

        walk(tabs)
        unsupported: list[str] = []
        rendered: list[str] = []
        tab_meta: list[dict[str, Any]] = []
        for order, tab in enumerate(flattened):
            tab_meta.append({"id": tab["id"], "title": tab["title"], "order": order})
            rendered.append(f"## Tab: {tab['title']}\n\n<!-- gdrive-tab:{tab['id']} -->")
            rendered.append(self._content(tab["body"], unsupported).strip())
        text = "\n\n".join(part for part in rendered if part).strip()
        footnotes = document.get("footnotes") or {}
        for footnote_id in sorted(footnotes):
            content = (footnotes[footnote_id] or {}).get("content")
            if isinstance(content, list):
                note = self._content(content, unsupported).strip()
                if note:
                    text += f"\n\n[^{footnote_id}]: {note}"
        return self._bounded(text, tab_meta, unsupported)

    def _bounded(
        self, text: str, tabs: list[dict[str, Any]], unsupported: list[str]
    ) -> ExtractedDocument:
        if len(text) > self._max_chars:
            raise IncompleteExtractionError(
                f"readable content exceeds configured {self._max_chars} character limit"
            )
        return ExtractedDocument(text=text, tabs=tabs, unsupported=unsupported)

    def _content(self, structural: Iterable[dict[str, Any]], unsupported: list[str]) -> str:
        parts: list[str] = []
        for block in structural:
            if not isinstance(block, dict):
                unsupported.append("malformed_block")
                continue
            if "paragraph" in block:
                parts.append(self._paragraph(block["paragraph"], unsupported))
            elif "table" in block:
                parts.append(self._table(block["table"], unsupported))
            elif "tableOfContents" in block:
                content = (block.get("tableOfContents") or {}).get("content")
                if isinstance(content, list):
                    parts.append(self._content(content, unsupported))
            elif "sectionBreak" in block:
                parts.append("\n")
            elif "inlineObjectElement" in block:
                object_id = str((block.get("inlineObjectElement") or {}).get("inlineObjectId") or "unknown")
                unsupported.append(f"inline_object:{object_id}")
            elif any(k in block for k in ("startIndex", "endIndex")):
                continue
            else:
                unsupported.append("unsupported_block:" + ",".join(sorted(block)))
        return "".join(parts)

    def _paragraph(self, paragraph: dict[str, Any], unsupported: list[str]) -> str:
        rendered: list[str] = []
        for element in paragraph.get("elements") or []:
            if not isinstance(element, dict):
                unsupported.append("malformed_paragraph_element")
                continue
            run = element.get("textRun")
            if isinstance(run, dict):
                content = str(run.get("content") or "")
                link = ((run.get("textStyle") or {}).get("link") or {}).get("url")
                stripped = content.rstrip("\n")
                suffix = content[len(stripped):]
                rendered.append(f"[{stripped}]({link}){suffix}" if link and stripped else content)
                continue
            ref = element.get("footnoteReference")
            if isinstance(ref, dict) and ref.get("footnoteId"):
                rendered.append(f"[^{ref['footnoteId']}]")
                continue
            inline = element.get("inlineObjectElement")
            if isinstance(inline, dict):
                object_id = str(inline.get("inlineObjectId") or "unknown")
                unsupported.append(f"inline_object:{object_id}")
                rendered.append(f"[unsupported inline object {object_id}]")
                continue
            if "pageBreak" in element:
                rendered.append("\n")
            else:
                unsupported.append("unsupported_paragraph_element:" + ",".join(sorted(element)))
        text = "".join(rendered)
        style = str((paragraph.get("paragraphStyle") or {}).get("namedStyleType") or "")
        if style.startswith("HEADING_"):
            try:
                level = min(6, max(1, int(style.rsplit("_", 1)[1])))
            except ValueError:
                level = 2
            text = f"{'#' * level} {text.lstrip()}"
        bullet = paragraph.get("bullet")
        if isinstance(bullet, dict):
            nesting = int(bullet.get("nestingLevel") or 0)
            text = f"{'  ' * nesting}- {text.lstrip()}"
        return text

    def _table(self, table: dict[str, Any], unsupported: list[str]) -> str:
        rows: list[list[str]] = []
        for row in table.get("tableRows") or []:
            cells: list[str] = []
            for cell in (row or {}).get("tableCells") or []:
                content = (cell or {}).get("content")
                if not isinstance(content, list):
                    unsupported.append("malformed_table_cell")
                    cells.append("")
                else:
                    cells.append(" ".join(self._content(content, unsupported).split()))
            rows.append(cells)
        if not rows:
            return ""
        width = max(len(row) for row in rows)
        padded = [row + [""] * (width - len(row)) for row in rows]
        lines = ["| " + " | ".join(cell.replace("|", "\\|") for cell in row) + " |" for row in padded]
        return "\n" + "\n".join(lines) + "\n"


class GoogleDriveSource(PullOnlySource, Source):
    name = "gdrive"

    def __init__(
        self,
        *,
        folder_id: str | None = None,
        folder_ids: list[str] | None = None,
        file_ids: list[str] | None = None,
        shared_drive_ids: list[str] | None = None,
        recursive: bool = False,
        selection_state: str | None = None,
        service_account_key_path: str | None = None,
        credential_json: str | dict[str, Any] | None = None,
        access_token: str | None = None,
        granted_scopes: list[str] | None = None,
        drive_service: Any | None = None,
        docs_service: Any | None = None,
        metadata_loader: Callable[[str], dict[str, Any]] | None = None,
        revisions_loader: Callable[[str], list[dict[str, Any]]] | None = None,
        provider_gate: Callable[[], None] | None = None,
        token_provider: Any | None = None,
        max_chars: int = 1_000_000,
        request_deadline_seconds: float = 30.0,
        provider_retry_attempts: int = 4,
        api_mode: str = "legacy",
        _drive_service: Any | None = None,
        _docs_service: Any | None = None,
    ):
        self._folder_ids = list(folder_ids or ([] if not folder_id else [folder_id]))
        self._file_ids = list(file_ids or [])
        self._shared_drive_ids = list(shared_drive_ids or [])
        self._recursive = bool(recursive)
        self._selection_state = selection_state or (
            "selected" if self._folder_ids or self._file_ids or self._shared_drive_ids else "absent"
        )
        if self._selection_state == "absent":
            raise ValueError("Google Drive selection is absent; choose files/folders or explicitly save an empty selection")
        if self._selection_state not in {"selected", "empty", "denied", "partial"}:
            raise ValueError(f"invalid Google Drive selection state {self._selection_state!r}")
        self._key_path = service_account_key_path
        self._credential_json = credential_json
        # Broker grants are memory-only. They are never serialized into selection/state payloads.
        self._access_token = access_token
        self._granted_scopes = list(granted_scopes or [])
        if api_mode not in {"docs", "legacy"}:
            raise ValueError("api_mode must be 'docs' or 'legacy'")
        self._api_mode = api_mode
        self._drive = drive_service or _drive_service
        self._docs = docs_service or _docs_service
        self._metadata_loader = metadata_loader
        self._revisions_loader = revisions_loader
        self._provider_gate = provider_gate
        self._token_provider = token_provider
        self._max_chars = max_chars
        self._request_deadline_seconds = max(1.0, float(request_deadline_seconds))
        self._provider_retry_attempts = max(1, int(provider_retry_attempts))
        self._run_deadline_monotonic: float | None = None

    def set_run_deadline(self, deadline_monotonic: float | None) -> None:
        self._run_deadline_monotonic = deadline_monotonic

    def _authorize_provider_call(self) -> None:
        if self._token_provider:
            self._token_provider.ensure_valid()
        if self._provider_gate:
            self._provider_gate()

    @staticmethod
    def _unauthorized(exc: Exception) -> bool:
        response = getattr(exc, "resp", None)
        return getattr(response, "status", None) == 401 or getattr(exc, "status_code", None) == 401

    @staticmethod
    def _status(exc: Exception) -> int | None:
        response = getattr(exc, "resp", None)
        value = getattr(response, "status", None) or getattr(exc, "status_code", None)
        try:
            return int(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _retry_after(exc: Exception) -> float | None:
        response = getattr(exc, "resp", None) or getattr(exc, "response", None)
        headers = getattr(response, "headers", None)
        if not isinstance(headers, Mapping) and isinstance(response, Mapping):
            # httplib2.Response is itself a case-insensitive mapping, not a requests-style object.
            headers = response
        if not isinstance(headers, Mapping):
            return None
        value = next(
            (candidate for key, candidate in headers.items() if str(key).lower() == "retry-after"),
            None,
        )
        if value is None:
            return None
        try:
            return max(0.0, float(value))
        except (TypeError, ValueError):
            try:
                parsed = parsedate_to_datetime(str(value))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return max(0.0, (parsed - datetime.now(timezone.utc)).total_seconds())
            except (TypeError, ValueError, OverflowError):
                return None

    @classmethod
    def _retryable(cls, exc: Exception) -> bool:
        status = cls._status(exc)
        if status == 429 or (status is not None and status >= 500):
            return True
        return isinstance(exc, (TimeoutError, ConnectionError)) or "timeout" in type(exc).__name__.lower()

    @staticmethod
    def _bound_transport_timeout(transport: Any | None, remaining: float) -> None:
        """Constrain the real httplib2 socket to the remaining per-request deadline."""
        raw_http = getattr(transport, "http", transport)
        if raw_http is None or not hasattr(raw_http, "timeout"):
            return
        timeout = max(0.1, float(remaining))
        raw_http.timeout = timeout
        # httplib2 may reuse an already-open connection whose timeout was copied at creation.
        # Tighten it too; failure to expose a socket is harmless and the next connection uses the
        # raw Http timeout above.
        connections = getattr(raw_http, "connections", None)
        if isinstance(connections, Mapping):
            for connection in connections.values():
                try:
                    connection.timeout = timeout
                    socket = getattr(connection, "sock", None)
                    if socket is not None:
                        socket.settimeout(timeout)
                except (AttributeError, OSError, ValueError):
                    continue

    @staticmethod
    def _bind_transport_deadline(transport: Any | None, deadline: float) -> None:
        raw_http = getattr(transport, "http", transport)
        setter = getattr(raw_http, "set_deadline", None)
        if callable(setter):
            setter(deadline)

    def _provider_call(
        self, call: Callable[[], Any] | None = None, *, transport: Any | None = None,
        request_factory: Callable[[], Any] | None = None,
    ) -> Any:
        if (call is None) == (request_factory is None):
            raise ValueError("provide exactly one provider callable or request factory")
        deadline = time.monotonic() + self._request_deadline_seconds
        if self._run_deadline_monotonic is not None:
            deadline = min(deadline, self._run_deadline_monotonic)
        replaced_token = False

        def remaining_or_defer(stage: str) -> float:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProviderDeferred(
                    f"Google provider request deadline expired {stage}",
                    not_before=datetime.now(timezone.utc).isoformat(),
                    category="provider_timeout",
                )
            return remaining

        for attempt in range(self._provider_retry_attempts):
            # Authority is checked outside the provider catch on every request and retry. A pause,
            # revoked key, or replaced fence is therefore run-terminal and cannot be downgraded to
            # an ordinary provider failure.
            remaining_or_defer("before token validation")
            if self._token_provider:
                self._token_provider.ensure_valid()
                remaining_or_defer("during token validation")
            if self._provider_gate:
                self._provider_gate()
                remaining_or_defer("during authority validation")
            attempt_call = call
            attempt_transport = transport
            remaining: float | None = None
            if request_factory is not None:
                request = request_factory()
                remaining = remaining_or_defer("during request construction")
                attempt_call = request.execute
                attempt_transport = getattr(request, "http", None)
            # Preparation may consume most of the request/run budget. Compute the effective
            # remainder immediately before the actual transport call, and tighten both new and
            # reused sockets to that value. Never execute after preparation exhausted the budget.
            if remaining is None:
                remaining = remaining_or_defer("before transport execution")
            self._bind_transport_deadline(attempt_transport, deadline)
            self._bound_transport_timeout(attempt_transport, remaining)
            try:
                result = attempt_call()
                if time.monotonic() > deadline:
                    raise ProviderDeferred(
                        "Google provider request exceeded its deadline",
                        not_before=datetime.now(timezone.utc).isoformat(),
                        category="provider_timeout",
                    )
                return result
            except ProviderDeferred:
                raise
            except BrainError:
                raise
            except Exception as exc:
                status = self._status(exc)
                if status == 410:
                    raise ProviderCursorInvalid("Google Drive change cursor is no longer valid") from exc
                if self._unauthorized(exc):
                    if not self._token_provider or replaced_token:
                        raise BrainError(
                            401, "provider_unauthorized", "Google rejected the replacement token"
                        ) from exc
                    self._token_provider.force_refresh()
                    replaced_token = True
                    continue
                if not self._retryable(exc):
                    raise
                remaining = deadline - time.monotonic()
                delay = self._retry_after(exc)
                if delay is None:
                    delay = min(0.25 * (2**attempt), 4.0) + random.uniform(0, 0.1)
                if attempt + 1 >= self._provider_retry_attempts or delay >= remaining:
                    not_before = datetime.fromtimestamp(
                        datetime.now(timezone.utc).timestamp() + max(0.0, delay), timezone.utc
                    ).isoformat()
                    category = "rate_limited" if status == 429 else (
                        "provider_timeout" if status is None else "provider_unavailable"
                    )
                    raise ProviderDeferred(
                        f"Google provider retry deferred after {type(exc).__name__}",
                        not_before=not_before, category=category,
                    ) from exc
                time.sleep(delay)
        raise ProviderDeferred("Google provider retry budget exhausted")  # pragma: no cover

    def _execute(self, request: Any) -> Any:
        # Request context is explicit: timeout enforcement never guesses through a bound callable.
        return self._provider_call(request.execute, transport=getattr(request, "http", None))

    def _request(self, factory: Callable[[], Any]) -> Any:
        """Build and execute a provider request after authority, rebuilding it on retry."""
        return self._provider_call(request_factory=factory)

    def _services(self) -> tuple[Any, Any]:
        if self._drive is not None and self._docs is not None:
            return self._drive, self._docs
        try:
            from google.oauth2 import service_account  # type: ignore
            from google.oauth2.credentials import Credentials  # type: ignore
            from googleapiclient.discovery import build  # type: ignore
        except ImportError as exc:  # pragma: no cover - optional live dependency
            raise MissingExtraError("gdrive", "google-api-python-client google-auth") from exc
        default_scopes = [DRIVE_READONLY_SCOPE, DOCS_READONLY_SCOPE]
        if self._token_provider:
            credentials = Credentials(
                token=self._token_provider.access_token,
                scopes=self._token_provider.scopes or None,
            )
            self._token_provider.bind(credentials)
        elif self._access_token:
            credentials = Credentials(token=self._access_token, scopes=self._granted_scopes or None)
        elif self._key_path:
            credentials = service_account.Credentials.from_service_account_file(
                self._key_path, scopes=default_scopes
            )
        else:
            raw = self._credential_json
            info = json.loads(raw) if isinstance(raw, str) else (raw or {})
            if info.get("type") == "service_account":
                credentials = service_account.Credentials.from_service_account_info(
                    info, scopes=default_scopes
                )
            else:
                raise ValueError(
                    "Google Drive credentials must be a local service account or a brokered access token"
                )
        if self._token_provider:
            # google-auth-httplib2 normally catches a provider 401 and calls Credentials.refresh().
            # These OAuth credentials deliberately contain no refresh token: replacement belongs
            # exclusively to the brain broker under the current execution fence. Disable the
            # transport-owned retry so HttpError(401) reaches _provider_call, which performs one
            # authority-aware broker replacement and one replay for both Drive and Docs.
            drive_http = _broker_authorized_http(
                credentials, timeout_seconds=self._request_deadline_seconds,
            )
            self._drive = self._provider_call(
                lambda: build("drive", "v3", http=drive_http, cache_discovery=False),
                transport=drive_http,
            )
            docs_http = _broker_authorized_http(
                credentials, timeout_seconds=self._request_deadline_seconds,
            )
            self._docs = self._provider_call(
                lambda: build("docs", "v1", http=docs_http, cache_discovery=False),
                transport=docs_http,
            )
        else:
            drive_http = _credential_authorized_http(
                credentials, timeout_seconds=self._request_deadline_seconds,
            )
            self._drive = self._provider_call(
                lambda: build("drive", "v3", http=drive_http, cache_discovery=False),
                transport=drive_http,
            )
            docs_http = _credential_authorized_http(
                credentials, timeout_seconds=self._request_deadline_seconds,
            )
            self._docs = self._provider_call(
                lambda: build("docs", "v1", http=docs_http, cache_discovery=False),
                transport=docs_http,
            )
        return self._drive, self._docs

    def _metadata(self, file_id: str) -> dict[str, Any]:
        if self._metadata_loader:
            return self._provider_call(lambda: self._metadata_loader(file_id))
        drive, _ = self._services()
        return self._request(lambda: drive.files().get(
            fileId=file_id,
            supportsAllDrives=True,
            fields="id,name,mimeType,webViewLink,createdTime,modifiedTime,trashed,driveId,parents,owners(permissionId,emailAddress,displayName),lastModifyingUser(permissionId,emailAddress,displayName)",
        ))

    def _revisions(self, file_id: str) -> list[dict[str, Any]]:
        if self._revisions_loader:
            return self._provider_call(lambda: self._revisions_loader(file_id))
        drive, _ = self._services()
        out: list[dict[str, Any]] = []
        if not hasattr(drive, "revisions"):
            return out
        token: str | None = None
        while True:
            response = self._request(lambda: drive.revisions().list(
                fileId=file_id,
                pageToken=token,
                pageSize=1000,
                fields="nextPageToken,revisions(id,modifiedTime,lastModifyingUser(permissionId,emailAddress,displayName))",
            ))
            out.extend(response.get("revisions") or [])
            token = response.get("nextPageToken")
            if not token:
                return out

    def _selected_files(self) -> Iterator[dict[str, Any]]:
        if self._selection_state == "empty":
            return
        seen: set[str] = set()
        for file_id in self._file_ids:
            meta = self._metadata(file_id)
            if meta.get("id") not in seen:
                seen.add(meta["id"])
                yield meta
        if not (self._folder_ids or self._shared_drive_ids):
            return
        drive, _ = self._services()
        queue = [(folder, None) for folder in self._folder_ids]
        queue.extend(("root", drive_id) for drive_id in self._shared_drive_ids)
        visited_folders: set[tuple[str, str | None]] = set()
        while queue:
            folder_id, drive_id = queue.pop(0)
            marker = (folder_id, drive_id)
            if marker in visited_folders:
                continue
            visited_folders.add(marker)
            token: str | None = None
            while True:
                kwargs: dict[str, Any] = {
                    "q": f"'{folder_id}' in parents and trashed = false",
                    "pageToken": token,
                    "pageSize": 1000,
                    "supportsAllDrives": True,
                    "includeItemsFromAllDrives": True,
                    "fields": "nextPageToken,files(id,name,mimeType,webViewLink,createdTime,modifiedTime,trashed,driveId,parents,owners(permissionId,emailAddress,displayName),lastModifyingUser(permissionId,emailAddress,displayName))",
                }
                if drive_id:
                    kwargs.update(corpora="drive", driveId=drive_id)
                response = self._request(lambda: drive.files().list(**kwargs))
                for meta in response.get("files") or []:
                    file_id = meta.get("id")
                    if meta.get("mimeType") == FOLDER_MIME:
                        if self._recursive:
                            queue.append((file_id, drive_id or meta.get("driveId")))
                    elif meta.get("mimeType") == GOOGLE_DOC_MIME and file_id not in seen:
                        seen.add(file_id)
                        yield meta
                token = response.get("nextPageToken")
                if not token:
                    break

    def _raw_doc(self, meta: dict[str, Any]) -> RawDoc:
        file_id = str(meta.get("id") or "").strip()
        if not file_id:
            raise IncompleteExtractionError("Drive returned a document without a stable id")
        if meta.get("trashed"):
            raise IncompleteExtractionError(f"document {file_id} is trashed")
        if not meta.get("name") or not meta.get("modifiedTime"):
            meta = {**meta, **self._metadata(file_id)}
        docs = self._docs
        if docs is None:
            _, docs = self._services()
        document = self._request(
            lambda: docs.documents().get(documentId=file_id, includeTabsContent=True)
        )
        extracted = extract_google_doc(document, max_chars=self._max_chars)
        if not extracted.complete:
            details = "; ".join(
                f"{issue.code} at {issue.location}: {issue.detail}"
                for issue in extracted.issues
                if issue.blocking
            )
            raise IncompleteExtractionError(
                f"document {file_id} extraction is incomplete"
                + (f" ({details})" if details else "")
            )

        # Drive ownership is access metadata, not proof that the owner wrote the document. Retain it
        # as source provenance for diagnostics/manual repair, but never feed it into authorship.
        source_identities: list[dict[str, str]] = []
        attribution_diagnostics: list[dict[str, str]] = []
        for owner in meta.get("owners") or []:
            ident = _identity(owner, "owner")
            if ident:
                source_identities.append(ident)
                attribution_diagnostics.append({
                    "code": "owner_not_authorship",
                    "role": "owner",
                    "identity": ident.get("external_id") or ident.get("email") or "unresolved",
                })
        modifier = meta.get("lastModifyingUser") or {}
        modifier_is_service = _is_service_identity(modifier)
        editor = None if modifier_is_service else _identity(modifier, "editor")
        authors: list[dict[str, str]] = []
        if editor:
            authors.append(editor)
        elif modifier_is_service:
            attribution_diagnostics.append({
                "code": "service_account_not_authorship", "role": "editor",
                "identity": str(modifier.get("emailAddress") or "service-account").lower(),
            })
        elif meta.get("modifiedTime"):
            attribution_diagnostics.append({
                "code": "missing_editor_identity", "role": "editor",
                "identity": "unresolved",
            })

        contributions: list[dict[str, str]] = []
        seen_contributions: set[tuple[str, str, str]] = set()
        revisions = self._revisions(file_id)
        if not revisions and editor and meta.get("modifiedTime"):
            revisions = [{"modifiedTime": meta.get("modifiedTime"), "lastModifyingUser": meta.get("lastModifyingUser")}]
            attribution_diagnostics.append({
                "code": "latest_editor_only", "role": "editor",
                "identity": editor.get("external_id") or editor.get("email") or "unresolved",
            })
        for revision in revisions:
            at = _iso_utc(revision.get("modifiedTime"))
            revision_person = revision.get("lastModifyingUser") or {}
            revision_service = _is_service_identity(revision_person)
            identity = None if revision_service else _identity(revision_person, "editor")
            if not at:
                attribution_diagnostics.append({
                    "code": "missing_contribution_time", "role": "editor",
                    "identity": (identity or {}).get("external_id", "unresolved"),
                })
                continue
            if not identity:
                attribution_diagnostics.append({
                    "code": "service_account_not_authorship" if revision_service else "missing_contributor_identity",
                    "role": "editor",
                    "identity": str(revision_person.get("emailAddress") or "unresolved").lower(),
                })
                continue
            identity_key = identity.get("external_id") or identity.get("email") or ""
            dedupe = (identity_key, "editor", at)
            if dedupe in seen_contributions:
                continue
            seen_contributions.add(dedupe)
            contributions.append({**identity, "at": at})

        return RawDoc(
            source=self.name,
            external_id=file_id,
            title=str(meta.get("name") or document.get("title") or file_id),
            body=extracted.text,
            url=str(meta.get("webViewLink") or f"https://docs.google.com/document/d/{file_id}/edit"),
            authors=authors or None,
            source_ts=str(meta.get("modifiedTime") or "") or None,
            extra_frontmatter={
                "created_time": meta.get("createdTime"),
                "modified_time": meta.get("modifiedTime"),
                "drive_id": meta.get("driveId"),
                "parent_ids": meta.get("parents") or [],
                "gdrive_tabs": extracted.tabs,
                "extraction_complete": extracted.complete,
                "extraction_issues": [
                    {
                        "code": issue.code,
                        "location": issue.location,
                        "detail": issue.detail,
                        "blocking": issue.blocking,
                    }
                    for issue in extracted.issues
                ],
                "gdrive_source_identities": source_identities,
                "attribution_diagnostics": attribution_diagnostics,
                "contributions": contributions,
            },
        )

    def fetch(self, *, since: str | None = None) -> Iterator[RawDoc]:
        # `since` is intentionally ignored. A timestamp is not a Drive change token; durable
        # incremental consumption is coordinated by the namespaced stream runner/state store.
        if self._api_mode == "legacy":
            GoogleDriveReader = lazy_reader(
                "llama_index.readers.google", "GoogleDriveReader", "gdrive",
                "llama-index-readers-google",
            )
            kwargs: dict[str, Any] = {}
            if self._key_path:
                kwargs["service_account_key_path"] = self._key_path
            reader = GoogleDriveReader(**kwargs)
            if self._folder_ids:
                docs = reader.load_data(folder_id=self._folder_ids[0])
            else:
                docs = reader.load_data(file_ids=self._file_ids)
            yield from docs_to_raw(
                docs,
                source=self.name,
                id_keys=("file id", "file_id", "id"),
                fallback_prefix="gdrive",
            )
            return
        for meta in self._selected_files():
            yield self._raw_doc(meta)
