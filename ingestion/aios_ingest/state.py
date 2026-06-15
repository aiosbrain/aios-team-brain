"""Local sync state (sqlite): per-connection cursors and webhook-channel records.

The brain is the system of record for content; this store only remembers *where the
connector left off* so polls are incremental and Drive watch-channels can be renewed.
Kept local (not in the brain) so the sidecar stays loosely coupled — HTTP only.
"""

from __future__ import annotations

import sqlite3
from contextlib import closing
from dataclasses import dataclass

_SCHEMA = """
CREATE TABLE IF NOT EXISTS cursors (
  connection TEXT PRIMARY KEY,
  cursor     TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS webhook_channels (
  connection TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  resource_id TEXT,
  expires_at TEXT
);
"""


@dataclass(frozen=True)
class Channel:
    connection: str
    channel_id: str
    resource_id: str | None
    expires_at: str | None


class StateStore:
    def __init__(self, db_path: str = "aios_ingest_state.sqlite"):
        self._db = sqlite3.connect(db_path)
        self._db.executescript(_SCHEMA)
        self._db.commit()

    def close(self) -> None:
        self._db.close()

    # -- cursors ------------------------------------------------------------
    def get_cursor(self, connection: str) -> str | None:
        with closing(self._db.execute("SELECT cursor FROM cursors WHERE connection=?", (connection,))) as c:
            row = c.fetchone()
        return row[0] if row else None

    def set_cursor(self, connection: str, cursor: str) -> None:
        self._db.execute(
            "INSERT INTO cursors(connection, cursor) VALUES(?,?) "
            "ON CONFLICT(connection) DO UPDATE SET cursor=excluded.cursor, updated_at=datetime('now')",
            (connection, cursor),
        )
        self._db.commit()

    # -- webhook channels ---------------------------------------------------
    def save_channel(self, ch: Channel) -> None:
        self._db.execute(
            "INSERT INTO webhook_channels(connection, channel_id, resource_id, expires_at) "
            "VALUES(?,?,?,?) ON CONFLICT(connection) DO UPDATE SET "
            "channel_id=excluded.channel_id, resource_id=excluded.resource_id, expires_at=excluded.expires_at",
            (ch.connection, ch.channel_id, ch.resource_id, ch.expires_at),
        )
        self._db.commit()

    def get_channel(self, connection: str) -> Channel | None:
        with closing(
            self._db.execute(
                "SELECT connection, channel_id, resource_id, expires_at FROM webhook_channels WHERE connection=?",
                (connection,),
            )
        ) as c:
            row = c.fetchone()
        return Channel(*row) if row else None
