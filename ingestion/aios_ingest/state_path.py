"""The ONE place the sidecar's local state database path is decided (AIO-1167 R44 C10).

`sync`, `schedule` and the separately launched webhook receiver must open the SAME SQLite file:
the receiver validates a notification against channels the scheduler persisted, and marks the
stream the scheduler then drains. They used to read three different settings (`--state-db`,
`AIOS_INGEST_STATE`, `AIOS_STATE_DB`), so a non-default scheduler path left notifications
validating against another file.

Precedence, for every entry point:
  1. an explicit path (the `schedule --state-db` option);
  2. `AIOS_INGEST_STATE` — the setting to use for separate processes;
  3. `AIOS_STATE_DB` — a backward-compatible alias, used only when `AIOS_INGEST_STATE` is unset;
  4. `aios_ingest_state.sqlite` in the working directory.

Both environment names set to DIFFERENT values is refused rather than silently choosing one.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

DEFAULT_STATE_DB = "aios_ingest_state.sqlite"
STATE_DB_ENV = "AIOS_INGEST_STATE"
LEGACY_STATE_DB_ENV = "AIOS_STATE_DB"


class StatePathConflict(ValueError):
    """Two state-path settings disagree; refusing to guess which file is authoritative."""


def resolve_state_db(explicit: str | None = None, environ: Mapping[str, str] | None = None) -> str:
    env = os.environ if environ is None else environ
    if explicit is not None and explicit.strip():
        return explicit.strip()
    primary = (env.get(STATE_DB_ENV) or "").strip()
    legacy = (env.get(LEGACY_STATE_DB_ENV) or "").strip()
    if primary and legacy and primary != legacy:
        raise StatePathConflict(
            f"{STATE_DB_ENV} and {LEGACY_STATE_DB_ENV} name different state databases; "
            f"set only {STATE_DB_ENV}"
        )
    return primary or legacy or DEFAULT_STATE_DB
