"""Linear source — queries the Linear GraphQL API directly (httpx).

Linear has no heavy reader dependency worth pulling, and its GraphQL API is simple, so
this adapter talks to it directly (like the GitHub adapter). Issues become deliverable
items keyed by their human identifier (e.g. ENG-123). Pull-based with cursor paging.
"""

from __future__ import annotations

from typing import Iterator

import httpx

from ..normalize import RawDoc
from .base import PullOnlySource, Source

_API = "https://api.linear.app/graphql"
_QUERY = """
query Issues($after: String) {
  issues(first: 100, after: $after, orderBy: updatedAt) {
    pageInfo { hasNextPage endCursor }
    nodes { id identifier title description url updatedAt
            assignee { displayName } state { name } }
  }
}
"""


class LinearSource(PullOnlySource, Source):
    name = "linear"

    def __init__(self, *, api_key: str, timeout: float = 30.0):
        self._headers = {"Authorization": api_key, "Content-Type": "application/json"}
        self._timeout = timeout

    def fetch(self, *, since: str | None = None) -> Iterator[RawDoc]:
        with httpx.Client(timeout=self._timeout) as http:
            after: str | None = None
            while True:
                resp = http.post(
                    _API, headers=self._headers, json={"query": _QUERY, "variables": {"after": after}}
                )
                resp.raise_for_status()
                issues = resp.json()["data"]["issues"]
                for node in issues["nodes"]:
                    yield RawDoc(
                        source=self.name,
                        external_id=node["identifier"],
                        body=node.get("description") or "",
                        title=f"{node['identifier']}: {node['title']}",
                        url=node.get("url"),
                        author=(node.get("assignee") or {}).get("displayName"),
                        source_ts=node.get("updatedAt"),
                        extra_frontmatter={"state": (node.get("state") or {}).get("name", "")},
                    )
                if not issues["pageInfo"]["hasNextPage"]:
                    return
                after = issues["pageInfo"]["endCursor"]
