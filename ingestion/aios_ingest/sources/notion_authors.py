"""Notion author enrichment.

`NotionPageReader` returns page text but not who wrote it, so a Notion item would land on the connector
account. This fetches each page's ``created_by`` / ``last_edited_by`` (Notion API) and resolves those
user ids to name + email, producing the structured ``authors[]`` the brain resolves to a roster member
at ingest (lib/attribution/resolve-authors). Best-effort: any API hiccup yields no authors (the item is
then simply unattributed, surfaced by the attribution-health read) — it never breaks the sync.
"""

from __future__ import annotations

import time
from typing import Any, Callable

import httpx

NOTION_API = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"


def resolve_page_authors(
    page_id: str,
    *,
    get_page: Callable[[str], dict[str, Any]],
    get_user: Callable[[str], dict[str, Any]],
) -> list[dict[str, str]]:
    """Pure: page metadata → author refs. ``get_page``/``get_user`` are injected (Notion API in prod,
    fakes in tests). ``created_by`` → role "author", ``last_edited_by`` → "editor"; the same user in
    both roles is emitted once (as author). A ``type:"bot"`` user (the integration itself on API-created
    pages) is skipped — it's never a mappable human. Each ref carries the Notion user id
    (provider="notion") plus email/name when the user is a resolvable person. Never raises."""
    try:
        page = get_page(page_id)
    except Exception:
        return []
    if not isinstance(page, dict):
        return []

    refs: list[dict[str, str]] = []
    seen: set[str] = set()
    for role, key in (("author", "created_by"), ("editor", "last_edited_by")):
        who = page.get(key)
        uid = who.get("id") if isinstance(who, dict) else None
        if not uid or uid in seen:
            continue
        seen.add(uid)
        try:
            info = get_user(uid)
        except Exception:
            info = {}  # user lookup failed → type unknown → keep the id-only ref (may be mappable)
        if isinstance(info, dict) and info.get("type") == "bot":
            continue  # integration/bot account — not a person to attribute; skip entirely
        ref: dict[str, str] = {"role": role, "provider": "notion", "external_id": uid}
        if isinstance(info, dict):
            person = info.get("person")
            email = person.get("email") if isinstance(person, dict) else None
            if email:
                ref["email"] = str(email)
            if info.get("name"):
                ref["display_name"] = str(info["name"])
        refs.append(ref)
    return refs


class NotionAuthorClient:
    """Notion-API-backed `get_page`/`get_user`, with one reused HTTP client, a per-run user cache (a
    page's editors repeat), and a single Retry-After-honoring retry on 429 (Notion's ~3 rps limit)."""

    def __init__(self, token: str, *, version: str = NOTION_VERSION, timeout: float = 15.0):
        self._client = httpx.Client(
            timeout=timeout, headers={"Authorization": f"Bearer {token}", "Notion-Version": version}
        )
        self._user_cache: dict[str, dict[str, Any]] = {}

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "NotionAuthorClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _get(self, path: str) -> dict[str, Any]:
        r = self._client.get(f"{NOTION_API}{path}")
        if r.status_code == 429:  # one Retry-After-honoring retry, then surface (caller swallows per-page)
            try:
                delay = float(r.headers.get("Retry-After", "1") or 1)
            except ValueError:
                delay = 1.0
            time.sleep(min(max(delay, 0.0), 10.0))
            r = self._client.get(f"{NOTION_API}{path}")
        r.raise_for_status()
        return r.json()

    def get_page(self, page_id: str) -> dict[str, Any]:
        return self._get(f"/pages/{page_id}")

    def get_user(self, user_id: str) -> dict[str, Any]:
        if user_id in self._user_cache:
            return self._user_cache[user_id]
        data = self._get(f"/users/{user_id}")
        self._user_cache[user_id] = data
        return data

    def page_authors(self, page_id: str) -> list[dict[str, str]]:
        return resolve_page_authors(page_id, get_page=self.get_page, get_user=self.get_user)
