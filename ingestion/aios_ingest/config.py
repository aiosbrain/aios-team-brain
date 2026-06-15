"""Configuration: brain connection settings + named source connections.

Brain credentials come from the environment (never commit secrets). Source connections
come from a YAML file (``connections.yaml``) or are constructed ad hoc by the CLI.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

from .normalize import AccessTier, NormalizeConfig


@dataclass(frozen=True)
class BrainSettings:
    base_url: str
    api_key: str
    team: str

    @classmethod
    def from_env(cls) -> "BrainSettings":
        try:
            return cls(
                base_url=os.environ["BRAIN_URL"],
                api_key=os.environ["AIOS_API_KEY"],
                team=os.environ["AIOS_TEAM"],
            )
        except KeyError as e:
            raise RuntimeError(
                f"missing env var {e}. Set BRAIN_URL, AIOS_API_KEY, AIOS_TEAM "
                "(see ingestion/.env.example)."
            ) from None


@dataclass
class Connection:
    """A configured source instance."""

    name: str  # unique connection id, e.g. "eng-slack"
    source: str  # source type, e.g. "slack"
    options: dict[str, Any] = field(default_factory=dict)
    project: str | None = None
    access: AccessTier = "team"
    actor: str | None = None

    def normalize_config(self) -> NormalizeConfig:
        return NormalizeConfig(
            default_project=self.project,
            default_access=self.access,
            actor=self.actor,
        )


def load_connections(path: str) -> list[Connection]:
    """Load connections from a YAML file. Secrets in options should be ``${ENV_VAR}``
    references, expanded here from the environment."""
    import yaml

    with open(path) as f:
        raw = yaml.safe_load(f) or {}
    conns: list[Connection] = []
    for entry in raw.get("connections", []):
        conns.append(
            Connection(
                name=entry["name"],
                source=entry["source"],
                options=_expand_env(entry.get("options", {})),
                project=entry.get("project"),
                access=entry.get("access", "team"),
                actor=entry.get("actor"),
            )
        )
    return conns


def _expand_env(obj: Any) -> Any:
    if isinstance(obj, str):
        return os.path.expandvars(obj)
    if isinstance(obj, dict):
        return {k: _expand_env(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_expand_env(v) for v in obj]
    return obj
