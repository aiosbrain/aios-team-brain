"""GitHub source.

Uses the GitHub REST API directly (httpx) so it works on public repos with no token
and no heavy dependency — ideal as the end-to-end reference adapter. For private repos
or richer extraction, ``llama-index-readers-github`` is a drop-in alternative behind the
same RawDoc contract. Webhooks: verified with the standard HMAC-SHA256 signature.
"""

from __future__ import annotations

import fnmatch
import hashlib
import hmac
from typing import Any, Iterator

import httpx

from ..normalize import RawDoc
from .base import Source

_API = "https://api.github.com"
# Text-ish files worth indexing by default. Override via path_glob.
_DEFAULT_GLOB = "*.md"


class GithubSource(Source):
    name = "github"
    supports_webhook = True

    def __init__(
        self,
        repo: str,  # "owner/name"
        *,
        ref: str = "HEAD",
        path_glob: str = _DEFAULT_GLOB,
        token: str | None = None,
        webhook_secret: str | None = None,
        timeout: float = 30.0,
    ):
        if "/" not in repo:
            raise ValueError("repo must be 'owner/name'")
        self.repo = repo
        self.ref = ref
        self.path_glob = path_glob
        self._webhook_secret = webhook_secret
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._http = httpx.Client(headers=headers, timeout=timeout)

    # -- pull ---------------------------------------------------------------
    def fetch(self, *, since: str | None = None) -> Iterator[RawDoc]:
        owner, name = self.repo.split("/", 1)
        tree = self._http.get(
            f"{_API}/repos/{self.repo}/git/trees/{self.ref}", params={"recursive": "1"}
        )
        tree.raise_for_status()
        for node in tree.json().get("tree", []):
            if node.get("type") != "blob":
                continue
            path = node["path"]
            if not fnmatch.fnmatch(path, self.path_glob):
                continue
            doc = self._fetch_blob(owner, name, path)
            if doc is not None:
                yield doc

    def _fetch_blob(self, owner: str, name: str, path: str) -> RawDoc | None:
        resp = self._http.get(
            f"{_API}/repos/{self.repo}/contents/{path}", params={"ref": self.ref}
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        if data.get("encoding") != "base64":
            return None
        import base64

        try:
            body = base64.b64decode(data["content"]).decode("utf-8")
        except (UnicodeDecodeError, ValueError):
            return None  # binary blob — skip (Unstructured handles binaries elsewhere)
        return RawDoc(
            source=self.name,
            external_id=f"{self.repo}/{path}",
            body=body,
            title=path.rsplit("/", 1)[-1],
            url=data.get("html_url"),
            extra_frontmatter={"repo": self.repo, "ref": self.ref, "repo_path": path},
        )

    # -- webhook ------------------------------------------------------------
    def verify_webhook(self, headers: dict[str, str], raw_body: bytes) -> bool:
        if not self._webhook_secret:
            return False
        sig = headers.get("x-hub-signature-256", "")
        expected = "sha256=" + hmac.new(
            self._webhook_secret.encode(), raw_body, hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(sig, expected)

    def fetch_for_webhook(
        self, headers: dict[str, str], payload: dict[str, Any]
    ) -> Iterator[RawDoc]:
        owner, name = self.repo.split("/", 1)
        changed: set[str] = set()
        for commit in payload.get("commits", []):
            changed.update(commit.get("added", []))
            changed.update(commit.get("modified", []))
        for path in changed:
            if not fnmatch.fnmatch(path, self.path_glob):
                continue
            doc = self._fetch_blob(owner, name, path)
            if doc is not None:
                yield doc
