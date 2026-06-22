"""Granola source — meetings in, decisions out (NO verbatim transcript team-tier).

Privacy is the whole point of this adapter. Granola records meeting transcripts; we
must never sync that verbatim audio/text to the team tier. So this source does two
distinct, deliberately-separated things:

1. ``fetch()`` (the team-push path used by ``aios-ingest sync``) yields **metadata-only
   meeting markers** — title, date, participants, the Granola permalink — for meetings
   that pass the privacy gate. It NEVER puts transcript text in the body. The actual
   decisions are extracted by a HUMAN-reviewed skill (transcript-decisions) into
   ``3-log/decision-log.md`` and reach the brain as decision rows via ``aios push`` →
   ``materializeDecisions`` (see docs/GRANOLA.md). This adapter does not auto-extract
   decisions; doing so unreviewed would defeat the consent model.
2. ``pull_transcripts(dest_dir)`` writes the **full transcript** to a LOCAL workspace
   folder at **admin tier** only. These files never enter the team-push path; they exist
   so the human extractor has source material on their own machine.

The privacy gate (``_allowed``):
- ALLOWLIST: a meeting must either mention an allowlist topic (default ``"AIOS"``) in its
  title, or include an allowlist participant (default John / Chetan) by name or email.
- CONSENT: a meeting must additionally carry a per-note consent marker (a tag/label, a
  ``consent`` flag, or an opt-in title token like ``[aios]``). Absent consent, the meeting
  is dropped entirely — not even a metadata marker leaves the machine.

Both gates must pass. The gate is applied identically to the team-push path and the local
transcript pull, so an un-consented meeting's transcript is never even written locally
under the connector's automation.

Official public API (https://docs.granola.ai/introduction), mocked in tests:
    GET https://public-api.granola.ai/v1/notes?limit=&cursor=&created_after=
    GET https://public-api.granola.ai/v1/notes/{id}?include=transcript
    Authorization: Bearer grn_…   ·   rate limit ~300 req/min (429 → Retry-After)

Pull-only (no webhook). The API key arrives via ``options`` (a ``${GRANOLA_API_KEY}`` env
reference in connections.yaml) and is never logged.
"""

from __future__ import annotations

import os
import time
from typing import Any, Iterator

import httpx

from ..normalize import RawDoc
from .base import PullOnlySource, Source

_API = "https://public-api.granola.ai/v1"
_MAX_RETRIES = 5

# Default privacy gate. AIOS-topic meetings or meetings with John/Chetan, AND consent.
_DEFAULT_TOPICS = ("aios",)
_DEFAULT_PARTICIPANTS = ("john", "chetan", "john@john-ellison.com")
# A note is treated as consented if any of these markers is present.
_CONSENT_TAGS = ("aios-consent", "consent", "share-decisions")
_CONSENT_TITLE_TOKENS = ("[aios]", "[consent]")


def _pick(obj: Any, *keys: str) -> Any:
    for k in keys:
        if isinstance(obj, dict) and obj.get(k) is not None:
            return obj[k]
    return None


def _participant_strings(note: dict[str, Any]) -> list[str]:
    """Flatten Granola's people/attendees/participants into lowercased name+email tokens."""
    raw = note.get("participants") or note.get("attendees") or note.get("people") or []
    out: list[str] = []
    for p in raw:
        if isinstance(p, str):
            out.append(p.lower())
        elif isinstance(p, dict):
            for v in (p.get("name"), p.get("email"), p.get("displayName")):
                if v:
                    out.append(str(v).lower())
    return out


def _tags(note: dict[str, Any]) -> list[str]:
    raw = note.get("tags") or note.get("labels") or []
    out: list[str] = []
    for t in raw:
        if isinstance(t, str):
            out.append(t.lower())
        elif isinstance(t, dict):
            v = t.get("name") or t.get("label") or t.get("value")
            if v:
                out.append(str(v).lower())
    return out


class GranolaSource(PullOnlySource, Source):
    name = "granola"

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = _API,
        topics: list[str] | str | None = None,
        participants: list[str] | str | None = None,
        require_consent: bool = True,
        timeout: float = 30.0,
        page_size: int = 100,
    ):
        if not api_key:
            raise ValueError("granola source needs an `api_key` (set GRANOLA_API_KEY)")
        self._key = api_key
        self._base = base_url.rstrip("/")
        self._topics = _as_lower_list(topics, _DEFAULT_TOPICS)
        self._participants = _as_lower_list(participants, _DEFAULT_PARTICIPANTS)
        # CLI `--opt require_consent=false` arrives as a string.
        self._require_consent = _as_bool(require_consent)
        self._timeout = float(timeout)
        self._page_size = min(int(page_size), 100)

    # ── HTTP with rate-limit (429) backoff ───────────────────────────────────
    @property
    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._key}", "Accept": "application/json"}

    def _get(
        self, http: httpx.Client, url: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        resp: httpx.Response | None = None
        for attempt in range(_MAX_RETRIES):
            resp = http.get(url, params=params, headers=self._headers)
            if resp.status_code == 429:
                # ~300/min limit. Honor Retry-After; otherwise exponential backoff.
                retry_after = resp.headers.get("Retry-After")
                if retry_after and retry_after.replace(".", "", 1).isdigit():
                    delay = float(retry_after)
                else:
                    delay = 2.0 ** attempt
                time.sleep(delay)
                continue
            resp.raise_for_status()
            return resp.json()
        raise httpx.HTTPStatusError(
            "granola: exhausted retries on persistent 429 (rate limited)",
            request=httpx.Request("GET", url),
            response=resp,  # type: ignore[arg-type]
        )

    def _list_notes(self, http: httpx.Client, since: str | None) -> Iterator[dict[str, Any]]:
        cursor: str | None = None
        while True:
            params: dict[str, Any] = {"limit": self._page_size}
            if since:
                params["created_after"] = since
            if cursor:
                params["cursor"] = cursor
            page = self._get(http, f"{self._base}/notes", params=params)
            items = _pick(page, "data", "notes", "items") or (page if isinstance(page, list) else [])
            for n in items:
                yield n
            cursor = _pick(page, "next_cursor", "cursor") or _pick(
                _pick(page, "pagination") or {}, "next_cursor"
            )
            if not cursor:
                return

    # ── privacy gate ─────────────────────────────────────────────────────────
    def _allowed(self, note: dict[str, Any]) -> bool:
        title = (_pick(note, "title", "name") or "").lower()
        people = _participant_strings(note)
        topic_hit = any(t in title for t in self._topics)
        people_hit = any(any(p in person for p in self._participants) for person in people)
        if not (topic_hit or people_hit):
            return False
        return self._consented(note)

    def _consented(self, note: dict[str, Any]) -> bool:
        if not self._require_consent:
            return True
        if _as_bool(note.get("consent")):
            return True
        tags = _tags(note)
        if any(c in tags for c in _CONSENT_TAGS):
            return True
        title = (_pick(note, "title", "name") or "").lower()
        return any(tok in title for tok in _CONSENT_TITLE_TOKENS)

    # ── team-push path: METADATA-ONLY markers, never transcript text ──────────
    def fetch(self, *, since: str | None = None) -> Iterator[RawDoc]:
        with httpx.Client(timeout=self._timeout) as http:
            for note in self._list_notes(http, since):
                if not self._allowed(note):
                    continue
                yield self._marker(note)

    def _marker(self, note: dict[str, Any]) -> RawDoc:
        """A privacy-safe meeting marker. Body intentionally carries NO transcript text —
        only metadata + a pointer back to Granola for the human reviewer."""
        nid = str(_pick(note, "id", "note_id", "uuid") or "")
        title = _pick(note, "title", "name") or "Untitled meeting"
        created = _pick(note, "created_at", "created", "createdAt") or None
        url = _pick(note, "url", "permalink", "html_url")
        people = list(_participant_strings(note))
        body = (
            f"Granola meeting **{title}**"
            + (f" ({str(created)[:10]})" if created else "")
            + ".\n\nThis is a privacy-safe marker — the verbatim transcript is NOT synced. "
            "Decisions are extracted by a human-reviewed workflow into the decision log. "
            "See docs/GRANOLA.md."
        )
        return RawDoc(
            source=self.name,
            external_id=nid or (title if isinstance(title, str) else "untitled"),
            body=body,
            title=str(title),
            url=str(url) if url else None,
            source_ts=str(created) if created else None,
            kind="artifact",  # NOT "transcript" — there is no transcript in the body
            access="team",
            extra_frontmatter={
                "granola": True,
                "meeting": True,
                "participants": ", ".join(people),
                "transcript_synced": False,
            },
        )

    # ── local-only path: full transcript to an ADMIN-tier workspace folder ────
    def pull_transcripts(self, dest_dir: str, *, since: str | None = None) -> list[str]:
        """Write full transcripts for allowlisted+consented meetings to ``dest_dir``
        (a LOCAL admin-tier workspace folder). Returns the written paths. These files are
        never pushed team-tier; they feed the human transcript-decisions workflow only."""
        os.makedirs(dest_dir, exist_ok=True)
        written: list[str] = []
        with httpx.Client(timeout=self._timeout) as http:
            for note in self._list_notes(http, since):
                if not self._allowed(note):
                    continue
                nid = str(_pick(note, "id", "note_id", "uuid") or "")
                if not nid:
                    continue
                full = self._get(
                    http, f"{self._base}/notes/{nid}", params={"include": "transcript"}
                )
                text = _transcript_text(full)
                title = _pick(full, "title", "name") or _pick(note, "title", "name") or "untitled"
                created = (
                    _pick(full, "created_at", "created", "createdAt")
                    or _pick(note, "created_at")
                    or ""
                )
                fname = f"{str(created)[:10] or 'undated'}-{_slug(title)}.md"
                path = os.path.join(dest_dir, fname)
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(_admin_transcript_md(nid, str(title), str(created), text))
                written.append(path)
        return written


# ── helpers ──────────────────────────────────────────────────────────────────
def _as_lower_list(value: list[str] | str | None, default: tuple[str, ...]) -> list[str]:
    if value is None:
        return list(default)
    if isinstance(value, str):
        value = [v.strip() for v in value.split(",") if v.strip()]
    return [v.lower() for v in value]


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def _slug(s: Any) -> str:
    out = "".join(c if c.isalnum() else "-" for c in str(s or "untitled").lower())
    return "-".join(part for part in out.split("-") if part)[:60] or "untitled"


def _transcript_text(note: dict[str, Any]) -> str:
    t = note.get("transcript")
    if not t:
        # some payloads inline segments at the top level
        t = note.get("segments")
    if not t:
        return ""
    if isinstance(t, str):
        return t
    if isinstance(t, dict):
        if isinstance(t.get("text"), str):
            return t["text"]
        if isinstance(t.get("segments"), list):
            t = t["segments"]
    if isinstance(t, list):
        lines = []
        for seg in t:
            if isinstance(seg, dict):
                speaker = seg.get("speaker") or seg.get("source") or ""
                txt = seg.get("text") or ""
                lines.append(f"{speaker + ': ' if speaker else ''}{txt}")
            elif isinstance(seg, str):
                lines.append(seg)
        return "\n".join(lines)
    return ""


def _admin_transcript_md(nid: str, title: str, created: str, text: str) -> str:
    return (
        "---\n"
        "type: transcript\n"
        "source: granola\n"
        f"granola_id: {nid}\n"
        f"created: {created}\n"
        "access: admin            # LOCAL ONLY — never pushed team-tier (privacy)\n"
        "status: ingested\n"
        "---\n\n"
        f"# {title}\n\n"
        f"{text or '(no transcript available)'}\n"
    )
