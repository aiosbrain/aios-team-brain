"""Durable connector progress for the ingestion sidecar.

The brain is the system of record for content and execution authority; this store only remembers
*where the connector left off* so polls are incremental and Drive watch-channels can be renewed.
Kept local so the sidecar stays HTTP only. Every authoritative mutation is checked against the
brain-issued generation/fence before this state may advance. Drive
page tokens are opaque and are therefore stored verbatim, namespaced by team,
connection id, credential identity, selected drive and scope generation.  The older
``cursors``/single-channel tables remain readable for non-Drive connectors and for a
safe upgrade from pre-AIO-1167 installations.
"""

from __future__ import annotations

import sqlite3
import json
import hashlib
import hmac
import secrets
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS cursors (
  connection TEXT PRIMARY KEY,
  cursor     TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS webhook_channels (
  connection TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  resource_id TEXT,
  expires_at TEXT,
  namespace TEXT NOT NULL DEFAULT '',
  verification_hash TEXT,
  retired_at TEXT,
  PRIMARY KEY (connection, channel_id)
);
CREATE TABLE IF NOT EXISTS stream_progress (
  namespace TEXT PRIMARY KEY,
  team TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  drive_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  phase TEXT NOT NULL,
  page_token TEXT,
  baseline_start_token TEXT,
  traversal_token TEXT,
  listing_complete INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  server_revision INTEGER NOT NULL DEFAULT 0,
  retry_not_before TEXT,
  active_snapshot INTEGER,
  building_snapshot INTEGER,
  recovery_required INTEGER NOT NULL DEFAULT 0,
  checkpoint_id TEXT,
  terminal_drain_token TEXT,
  terminal_drain_checkpoint_id TEXT,
  terminal_drain_acknowledged INTEGER NOT NULL DEFAULT 0,
  drain_observation INTEGER NOT NULL DEFAULT 0,
  terminal_drain_observation INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS selection_snapshots (
  namespace TEXT NOT NULL,
  generation INTEGER NOT NULL,
  snapshot_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  PRIMARY KEY (namespace, generation, snapshot_id)
);
CREATE TABLE IF NOT EXISTS selection_roots (
  namespace TEXT NOT NULL,
  generation INTEGER NOT NULL,
  snapshot_id INTEGER NOT NULL DEFAULT 1,
  root_id TEXT NOT NULL,
  root_kind TEXT NOT NULL,
  drive_id TEXT NOT NULL,
  recursive INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace, generation, snapshot_id, root_kind, root_id)
);
CREATE TABLE IF NOT EXISTS traversal_queue (
  namespace TEXT NOT NULL,
  generation INTEGER NOT NULL,
  snapshot_id INTEGER NOT NULL DEFAULT 1,
  root_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  drive_id TEXT NOT NULL,
  page_token TEXT NOT NULL DEFAULT '',
  completed_at TEXT,
  PRIMARY KEY (namespace, generation, snapshot_id, root_id, folder_id, page_token)
);
CREATE TABLE IF NOT EXISTS selected_membership (
  namespace TEXT NOT NULL,
  generation INTEGER NOT NULL,
  snapshot_id INTEGER NOT NULL DEFAULT 1,
  provider_id TEXT NOT NULL,
  root_ids TEXT NOT NULL DEFAULT '[]',
  drive_id TEXT NOT NULL,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (namespace, generation, snapshot_id, provider_id)
);
CREATE TABLE IF NOT EXISTS traversal_ancestry (
  namespace TEXT NOT NULL,
  generation INTEGER NOT NULL,
  snapshot_id INTEGER NOT NULL,
  root_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  ancestor_id TEXT NOT NULL,
  PRIMARY KEY (namespace,generation,snapshot_id,root_id,folder_id,ancestor_id)
);
CREATE TABLE IF NOT EXISTS membership_ancestry (
  namespace TEXT NOT NULL,
  generation INTEGER NOT NULL,
  snapshot_id INTEGER NOT NULL,
  provider_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  ancestor_id TEXT NOT NULL,
  PRIMARY KEY (namespace,generation,snapshot_id,provider_id,root_id,ancestor_id)
);
CREATE TABLE IF NOT EXISTS materialized_pages (
  namespace TEXT NOT NULL,
  generation INTEGER NOT NULL,
  page_id TEXT NOT NULL,
  page_kind TEXT NOT NULL,
  drain_observation INTEGER NOT NULL DEFAULT 0,
  snapshot_id INTEGER,
  input_token TEXT NOT NULL DEFAULT '',
  next_token TEXT,
  terminal_token TEXT,
  materialized_at TEXT NOT NULL DEFAULT (datetime('now')),
  committed_at TEXT,
  rescan_snapshot_id INTEGER,
  PRIMARY KEY (namespace, generation, page_id)
);
CREATE TABLE IF NOT EXISTS pending_work (
  namespace TEXT NOT NULL,
  generation INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  action TEXT NOT NULL,
  observation_revision INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}',
  page_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT,
  last_error TEXT,
  acknowledged_at TEXT,
  superseded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (namespace, generation, item_key, action)
);
CREATE TABLE IF NOT EXISTS stream_observation_revisions (
  namespace TEXT NOT NULL,
  generation INTEGER NOT NULL,
  last_revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace, generation)
);
CREATE TABLE IF NOT EXISTS item_observations (
  namespace TEXT NOT NULL,
  generation INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  observation_revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  page_id TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (namespace, generation, item_key)
);
CREATE TABLE IF NOT EXISTS page_obligation_outcomes (
  namespace TEXT NOT NULL,
  generation INTEGER NOT NULL,
  page_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  observation_revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (namespace, generation, page_id, item_key, observation_revision)
);
CREATE TABLE IF NOT EXISTS stream_leases (
  namespace TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  fence INTEGER NOT NULL,
  lease_until TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connection_stream_schedule (
  connection_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  next_drive_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (connection_id, generation)
);
"""


@dataclass(frozen=True)
class Channel:
    connection: str
    channel_id: str
    resource_id: str | None
    expires_at: str | None
    namespace: str = ""
    verification_hash: str | None = None
    retired_at: str | None = None


@dataclass(frozen=True)
class StreamKey:
    team: str
    connection_id: str
    credential_id: str
    drive_id: str = "my-drive"

    def namespace(self, generation: int) -> str:
        material = "\0".join(
            (self.team, self.connection_id, self.credential_id, self.drive_id, str(generation))
        )
        return hashlib.sha256(material.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class StreamProgress:
    namespace: str
    key: StreamKey
    generation: int
    phase: str
    page_token: str | None = None
    baseline_start_token: str | None = None
    traversal_token: str | None = None
    listing_complete: bool = False
    last_attempt_at: str | None = None
    last_success_at: str | None = None
    last_error: str | None = None
    server_revision: int = 0
    retry_not_before: str | None = None
    active_snapshot: int | None = None
    building_snapshot: int | None = None
    recovery_required: bool = False
    checkpoint_id: str | None = None
    terminal_drain_token: str | None = None
    terminal_drain_checkpoint_id: str | None = None
    terminal_drain_acknowledged: bool = False
    drain_observation: int = 0
    terminal_drain_observation: int | None = None


@dataclass(frozen=True)
class PendingWork:
    namespace: str
    generation: int
    item_key: str
    action: str
    observation_revision: int
    payload: dict[str, Any]
    attempts: int
    not_before: str | None
    last_error: str | None
    page_id: str | None = None
    acknowledged_at: str | None = None


@dataclass(frozen=True)
class MaterializedPage:
    namespace: str
    generation: int
    page_id: str
    page_kind: str
    drain_observation: int
    input_token: str
    next_token: str | None
    terminal_token: str | None
    committed_at: str | None
    snapshot_id: int | None = None
    rescan_snapshot_id: int | None = None


class StateStore:
    def __init__(self, db_path: str = "aios_ingest_state.sqlite"):
        self._db = sqlite3.connect(db_path)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(_SCHEMA)
        columns = {r[1] for r in self._db.execute("PRAGMA table_info(stream_progress)")}
        if "server_revision" not in columns:
            self._db.execute("ALTER TABLE stream_progress ADD COLUMN server_revision INTEGER NOT NULL DEFAULT 0")
        if "retry_not_before" not in columns:
            self._db.execute("ALTER TABLE stream_progress ADD COLUMN retry_not_before TEXT")
        if "active_snapshot" not in columns:
            self._db.execute("ALTER TABLE stream_progress ADD COLUMN active_snapshot INTEGER")
        if "building_snapshot" not in columns:
            self._db.execute("ALTER TABLE stream_progress ADD COLUMN building_snapshot INTEGER")
        if "recovery_required" not in columns:
            self._db.execute("ALTER TABLE stream_progress ADD COLUMN recovery_required INTEGER NOT NULL DEFAULT 0")
        if "checkpoint_id" not in columns:
            self._db.execute("ALTER TABLE stream_progress ADD COLUMN checkpoint_id TEXT")
        if "terminal_drain_token" not in columns:
            self._db.execute("ALTER TABLE stream_progress ADD COLUMN terminal_drain_token TEXT")
        if "terminal_drain_checkpoint_id" not in columns:
            self._db.execute("ALTER TABLE stream_progress ADD COLUMN terminal_drain_checkpoint_id TEXT")
        if "terminal_drain_acknowledged" not in columns:
            self._db.execute(
                "ALTER TABLE stream_progress ADD COLUMN terminal_drain_acknowledged INTEGER NOT NULL DEFAULT 0"
            )
        if "drain_observation" not in columns:
            self._db.execute(
                "ALTER TABLE stream_progress ADD COLUMN drain_observation INTEGER NOT NULL DEFAULT 0"
            )
        if "terminal_drain_observation" not in columns:
            self._db.execute("ALTER TABLE stream_progress ADD COLUMN terminal_drain_observation INTEGER")
        self._upgrade_selection_schema()
        self._upgrade_legacy_shared_drive_roots()
        page_columns = {r[1] for r in self._db.execute("PRAGMA table_info(materialized_pages)")}
        if "snapshot_id" not in page_columns:
            self._db.execute("ALTER TABLE materialized_pages ADD COLUMN snapshot_id INTEGER")
        if "rescan_snapshot_id" not in page_columns:
            self._db.execute("ALTER TABLE materialized_pages ADD COLUMN rescan_snapshot_id INTEGER")
        if "drain_observation" not in page_columns:
            self._db.execute(
                "ALTER TABLE materialized_pages ADD COLUMN drain_observation INTEGER NOT NULL DEFAULT 0"
            )
        work_columns = {r[1] for r in self._db.execute("PRAGMA table_info(pending_work)")}
        if "page_id" not in work_columns:
            self._db.execute("ALTER TABLE pending_work ADD COLUMN page_id TEXT")
        if "acknowledged_at" not in work_columns:
            self._db.execute("ALTER TABLE pending_work ADD COLUMN acknowledged_at TEXT")
        if "observation_revision" not in work_columns:
            self._db.execute(
                "ALTER TABLE pending_work ADD COLUMN observation_revision INTEGER NOT NULL DEFAULT 0"
            )
        if "superseded_at" not in work_columns:
            self._db.execute("ALTER TABLE pending_work ADD COLUMN superseded_at TEXT")
        self._upgrade_observation_revisions()
        self._upgrade_legacy_channels()
        self._db.commit()

    def _upgrade_observation_revisions(self) -> None:
        """Conservatively adopt pre-revision obligations and resolve old action conflicts."""
        rows = self._db.execute(
            "SELECT rowid,* FROM pending_work WHERE observation_revision=0 "
            "ORDER BY namespace,generation,item_key,updated_at,rowid"
        ).fetchall()
        latest: dict[tuple[str, int, str], sqlite3.Row] = {}
        for row in rows:
            latest[(row["namespace"], row["generation"], row["item_key"])] = row
        now = _now_iso()
        for (namespace, generation, item_key), row in latest.items():
            self._db.execute(
                "UPDATE pending_work SET superseded_at=coalesce(superseded_at,?),"
                "acknowledged_at=coalesce(acknowledged_at,?) "
                "WHERE namespace=? AND generation=? AND item_key=? AND rowid<>?",
                (now, now, namespace, generation, item_key, row["rowid"]),
            )
            revision = max(1, int(row["observation_revision"] or 0))
            self._db.execute(
                "UPDATE pending_work SET observation_revision=? WHERE rowid=?",
                (revision, row["rowid"]),
            )
            self._db.execute(
                "INSERT INTO item_observations(namespace,generation,item_key,observation_revision,action,payload,page_id,observed_at) "
                "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(namespace,generation,item_key) DO UPDATE SET "
                "observation_revision=excluded.observation_revision,action=excluded.action,payload=excluded.payload,"
                "page_id=excluded.page_id,observed_at=excluded.observed_at",
                (namespace, generation, item_key, revision, row["action"], row["payload"],
                 row["page_id"], now),
            )
            self._db.execute(
                "INSERT INTO stream_observation_revisions(namespace,generation,last_revision) VALUES(?,?,?) "
                "ON CONFLICT(namespace,generation) DO UPDATE SET "
                "last_revision=max(last_revision,excluded.last_revision)",
                (namespace, generation, revision),
            )

    def _upgrade_selection_schema(self) -> None:
        """Add snapshot incarnation to pre-Batch-3 local state without discarding progress."""
        for table, definition, columns in (
            (
                "selection_roots",
                """CREATE TABLE selection_roots (
                  namespace TEXT NOT NULL, generation INTEGER NOT NULL, snapshot_id INTEGER NOT NULL DEFAULT 1,
                  root_id TEXT NOT NULL, root_kind TEXT NOT NULL, drive_id TEXT NOT NULL,
                  recursive INTEGER NOT NULL DEFAULT 0,
                  PRIMARY KEY(namespace,generation,snapshot_id,root_kind,root_id))""",
                "namespace,generation,snapshot_id,root_id,root_kind,drive_id,recursive",
            ),
            (
                "traversal_queue",
                """CREATE TABLE traversal_queue (
                  namespace TEXT NOT NULL, generation INTEGER NOT NULL, snapshot_id INTEGER NOT NULL DEFAULT 1,
                  root_id TEXT NOT NULL, folder_id TEXT NOT NULL, drive_id TEXT NOT NULL,
                  page_token TEXT NOT NULL DEFAULT '', completed_at TEXT,
                  PRIMARY KEY(namespace,generation,snapshot_id,root_id,folder_id,page_token))""",
                "namespace,generation,snapshot_id,root_id,folder_id,drive_id,page_token,completed_at",
            ),
            (
                "selected_membership",
                """CREATE TABLE selected_membership (
                  namespace TEXT NOT NULL, generation INTEGER NOT NULL, snapshot_id INTEGER NOT NULL DEFAULT 1,
                  provider_id TEXT NOT NULL, root_ids TEXT NOT NULL DEFAULT '[]', drive_id TEXT NOT NULL,
                  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
                  PRIMARY KEY(namespace,generation,snapshot_id,provider_id))""",
                "namespace,generation,snapshot_id,provider_id,root_ids,drive_id,seen_at",
            ),
        ):
            present = {r[1] for r in self._db.execute(f"PRAGMA table_info({table})")}
            if "snapshot_id" in present:
                continue
            legacy = f"{table}_pre_snapshot"
            self._db.execute(f"ALTER TABLE {table} RENAME TO {legacy}")
            self._db.execute(definition)
            select_columns = columns.replace("snapshot_id", "1")
            self._db.execute(
                f"INSERT INTO {table}({columns}) SELECT {select_columns} FROM {legacy}"
            )
            self._db.execute(f"DROP TABLE {legacy}")
        self._db.execute(
            "INSERT OR IGNORE INTO selection_snapshots(namespace,generation,snapshot_id,status,completed_at) "
            "SELECT namespace,generation,1,'active',? FROM ("
            "SELECT namespace,generation FROM selection_roots "
            "UNION SELECT namespace,generation FROM traversal_queue "
            "UNION SELECT namespace,generation FROM selected_membership"
            ")",
            (_now_iso(),),
        )
        self._db.execute(
            "UPDATE stream_progress SET active_snapshot=1 WHERE active_snapshot IS NULL AND namespace IN "
            "(SELECT namespace FROM selection_snapshots WHERE status='active')"
        )

    def _upgrade_legacy_shared_drive_roots(self) -> None:
        """Repair the old synthetic ``root`` traversal key only when its Drive is provable.

        Shared Drive file parents contain the actual drive ID, never the literal string ``root``.
        Exact root/drive matches can therefore be migrated losslessly. Ambiguous legacy rows force
        controlled recovery and cannot become evidence that an existing member moved out of scope.
        """
        validated = self._db.execute(
            "SELECT tq.* FROM traversal_queue tq JOIN selection_roots sr ON "
            "sr.namespace=tq.namespace AND sr.generation=tq.generation "
            "AND sr.snapshot_id=tq.snapshot_id AND sr.root_id=tq.root_id "
            "WHERE tq.folder_id='root' AND sr.root_kind='drive' "
            "AND sr.root_id=sr.drive_id AND tq.drive_id=sr.drive_id"
        ).fetchall()
        for row in validated:
            self._db.execute(
                "INSERT OR IGNORE INTO traversal_queue(namespace,generation,snapshot_id,root_id,folder_id,drive_id,page_token,completed_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (row["namespace"], row["generation"], row["snapshot_id"], row["root_id"],
                 row["drive_id"], row["drive_id"], row["page_token"], row["completed_at"]),
            )
            self._db.execute(
                "DELETE FROM traversal_queue WHERE namespace=? AND generation=? AND snapshot_id=? "
                "AND root_id=? AND folder_id='root' AND drive_id=? AND page_token=?",
                (row["namespace"], row["generation"], row["snapshot_id"], row["root_id"],
                 row["drive_id"], row["page_token"]),
            )
        self._db.execute(
            "UPDATE stream_progress SET recovery_required=1,listing_complete=0,phase='baselining',"
            "last_error='ambiguous legacy Shared Drive root; controlled rescan required' "
            "WHERE namespace IN (SELECT DISTINCT tq.namespace FROM traversal_queue tq "
            "LEFT JOIN selection_roots sr ON sr.namespace=tq.namespace "
            "AND sr.generation=tq.generation AND sr.snapshot_id=tq.snapshot_id "
            "AND sr.root_id=tq.root_id AND sr.root_kind='drive' "
            "WHERE tq.folder_id='root' AND (sr.root_id IS NULL OR sr.root_id<>sr.drive_id "
            "OR tq.drive_id<>sr.drive_id))"
        )

    def _upgrade_legacy_channels(self) -> None:
        """SQLite cannot add a composite PK in-place; rebuild only the legacy shape.

        The check is deliberately structural so replaying this startup migration is a no-op.
        """
        columns = {r[1] for r in self._db.execute("PRAGMA table_info(webhook_channels)")}
        if {"namespace", "verification_hash", "retired_at"}.issubset(columns):
            return
        self._db.executescript(
            """
            ALTER TABLE webhook_channels RENAME TO webhook_channels_legacy;
            CREATE TABLE webhook_channels (
              connection TEXT NOT NULL,
              channel_id TEXT NOT NULL,
              resource_id TEXT,
              expires_at TEXT,
              namespace TEXT NOT NULL DEFAULT '',
              verification_hash TEXT,
              retired_at TEXT,
              PRIMARY KEY (connection, channel_id)
            );
            INSERT INTO webhook_channels(connection, channel_id, resource_id, expires_at)
              SELECT connection, channel_id, resource_id, expires_at FROM webhook_channels_legacy;
            DROP TABLE webhook_channels_legacy;
            """
        )

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
            "INSERT INTO webhook_channels(connection, channel_id, resource_id, expires_at, namespace, verification_hash, retired_at) "
            "VALUES(?,?,?,?,?,?,?) ON CONFLICT(connection,channel_id) DO UPDATE SET "
            "resource_id=excluded.resource_id, expires_at=excluded.expires_at, namespace=excluded.namespace, "
            "verification_hash=excluded.verification_hash, retired_at=excluded.retired_at",
            (ch.connection, ch.channel_id, ch.resource_id, ch.expires_at, ch.namespace,
             ch.verification_hash, ch.retired_at),
        )
        self._db.commit()

    def get_channel(self, connection: str) -> Channel | None:
        with closing(
            self._db.execute(
                "SELECT connection, channel_id, resource_id, expires_at, namespace, verification_hash, retired_at "
                "FROM webhook_channels WHERE connection=? AND retired_at IS NULL "
                "ORDER BY expires_at DESC LIMIT 1",
                (connection,),
            )
        ) as c:
            row = c.fetchone()
        return Channel(*row) if row else None

    def list_channels(self, connection: str | None = None, *, active_only: bool = True) -> list[Channel]:
        where: list[str] = []
        args: list[str] = []
        if connection is not None:
            where.append("connection=?")
            args.append(connection)
        if active_only:
            where.append("retired_at IS NULL")
        sql = (
            "SELECT connection, channel_id, resource_id, expires_at, namespace, verification_hash, retired_at "
            "FROM webhook_channels"
        )
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY expires_at DESC"
        return [Channel(*r) for r in self._db.execute(sql, args).fetchall()]

    def retire_channel(self, connection: str, channel_id: str, *, at: str | None = None) -> None:
        self._db.execute(
            "UPDATE webhook_channels SET retired_at=? WHERE connection=? AND channel_id=?",
            (at or _now_iso(), connection, channel_id),
        )
        self._db.commit()

    def validate_notification(
        self, *, channel_id: str, resource_id: str | None, verification_token: str | None
    ) -> Channel | None:
        row = self._db.execute(
            "SELECT connection, channel_id, resource_id, expires_at, namespace, verification_hash, retired_at "
            "FROM webhook_channels WHERE channel_id=? AND retired_at IS NULL",
            (channel_id,),
        ).fetchone()
        if not row:
            return None
        channel = Channel(*row)
        if channel.resource_id and channel.resource_id != resource_id:
            return None
        if channel.verification_hash:
            supplied = _token_hash(verification_token or "")
            if not hmac.compare_digest(supplied, channel.verification_hash):
                return None
        return channel

    # -- namespaced Drive progress -----------------------------------------
    def begin_generation(
        self, key: StreamKey, generation: int, *, start_token: str, phase: str = "baselining"
    ) -> StreamProgress:
        namespace = key.namespace(generation)
        self._db.execute(
            "INSERT INTO stream_progress(namespace, team, connection_id, credential_id, drive_id, generation, phase, baseline_start_token, last_attempt_at) "
            "VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(namespace) DO NOTHING",
            (namespace, key.team, key.connection_id, key.credential_id, key.drive_id, generation,
             phase, start_token, _now_iso()),
        )
        self._db.commit()
        progress = self.get_progress(namespace)
        if progress is None:  # pragma: no cover - defensive SQLite failure guard
            raise RuntimeError("failed to create stream progress")
        return progress

    def get_progress(self, namespace: str) -> StreamProgress | None:
        row = self._db.execute("SELECT * FROM stream_progress WHERE namespace=?", (namespace,)).fetchone()
        if not row:
            return None
        return StreamProgress(
            namespace=row["namespace"],
            key=StreamKey(row["team"], row["connection_id"], row["credential_id"], row["drive_id"]),
            generation=row["generation"], phase=row["phase"], page_token=row["page_token"],
            baseline_start_token=row["baseline_start_token"], traversal_token=row["traversal_token"],
            listing_complete=bool(row["listing_complete"]), last_attempt_at=row["last_attempt_at"],
            last_success_at=row["last_success_at"], last_error=row["last_error"],
            server_revision=int(row["server_revision"] or 0),
            retry_not_before=row["retry_not_before"],
            active_snapshot=row["active_snapshot"],
            building_snapshot=row["building_snapshot"],
            recovery_required=bool(row["recovery_required"]),
            checkpoint_id=row["checkpoint_id"],
            terminal_drain_token=row["terminal_drain_token"],
            terminal_drain_checkpoint_id=row["terminal_drain_checkpoint_id"],
            terminal_drain_acknowledged=bool(row["terminal_drain_acknowledged"]),
            drain_observation=int(row["drain_observation"] or 0),
            terminal_drain_observation=(
                int(row["terminal_drain_observation"])
                if row["terminal_drain_observation"] is not None else None
            ),
        )

    def list_progress(self, connection_id: str, generation: int) -> list[StreamProgress]:
        rows = self._db.execute(
            "SELECT namespace FROM stream_progress WHERE connection_id=? AND generation=? ORDER BY drive_id",
            (connection_id, generation),
        ).fetchall()
        return [p for row in rows if (p := self.get_progress(row["namespace"])) is not None]

    def latest_progress_for_connection(self, connection_id: str) -> StreamProgress | None:
        row = self._db.execute(
            "SELECT namespace FROM stream_progress WHERE connection_id=? ORDER BY updated_at DESC LIMIT 1",
            (connection_id,),
        ).fetchone()
        return self.get_progress(row["namespace"]) if row else None

    def rotate_streams(
        self, connection_id: str, generation: int, drive_ids: list[str],
    ) -> list[str]:
        """Return this run's fair stream order and durably rotate the next run's head."""
        ordered = list(dict.fromkeys(drive_ids))
        if not ordered:
            return []
        row = self._db.execute(
            "SELECT next_drive_id FROM connection_stream_schedule "
            "WHERE connection_id=? AND generation=?",
            (connection_id, generation),
        ).fetchone()
        start = ordered.index(row["next_drive_id"]) if row and row["next_drive_id"] in ordered else 0
        rotated = ordered[start:] + ordered[:start]
        next_drive = ordered[(start + 1) % len(ordered)]
        self._db.execute(
            "INSERT INTO connection_stream_schedule(connection_id,generation,next_drive_id,updated_at) "
            "VALUES(?,?,?,?) ON CONFLICT(connection_id,generation) DO UPDATE SET "
            "next_drive_id=excluded.next_drive_id,updated_at=excluded.updated_at",
            (connection_id, generation, next_drive, _now_iso()),
        )
        self._db.commit()
        return rotated

    def update_progress(self, namespace: str, **changes: Any) -> None:
        allowed = {
            "phase", "page_token", "baseline_start_token", "traversal_token", "listing_complete",
            "last_attempt_at", "last_success_at", "last_error",
            "server_revision",
            "retry_not_before",
            "active_snapshot", "building_snapshot", "recovery_required", "checkpoint_id",
            "terminal_drain_token", "terminal_drain_checkpoint_id",
            "terminal_drain_acknowledged",
            "drain_observation", "terminal_drain_observation",
        }
        bad = set(changes) - allowed
        if bad:
            raise ValueError(f"unsupported progress fields: {sorted(bad)}")
        if not changes:
            return
        changes["updated_at"] = _now_iso()
        assignments = ", ".join(f"{k}=?" for k in changes)
        values = [int(v) if isinstance(v, bool) else v for v in changes.values()]
        cur = self._db.execute(
            f"UPDATE stream_progress SET {assignments} WHERE namespace=?", (*values, namespace)
        )
        if cur.rowcount != 1:
            raise KeyError(f"unknown stream namespace {namespace}")
        self._db.commit()

    # Progress may advance only after the page's obligations are durable. Callers materialize every
    # item first, retain acknowledgments through the server cursor checkpoint, then purge the page.
    def _next_observation_revision(self, namespace: str, generation: int) -> int:
        self._db.execute(
            "INSERT OR IGNORE INTO stream_observation_revisions(namespace,generation,last_revision) "
            "VALUES(?,?,0)",
            (namespace, generation),
        )
        self._db.execute(
            "UPDATE stream_observation_revisions SET last_revision=last_revision+1 "
            "WHERE namespace=? AND generation=?",
            (namespace, generation),
        )
        return int(self._db.execute(
            "SELECT last_revision FROM stream_observation_revisions WHERE namespace=? AND generation=?",
            (namespace, generation),
        ).fetchone()[0])

    def _observe_work(
        self, namespace: str, generation: int, item_key: str, action: str,
        payload: dict[str, Any], *, page_id: str | None,
    ) -> int:
        """Record one ordered provider observation inside the caller's transaction."""
        revision = self._next_observation_revision(namespace, generation)
        now = _now_iso()
        serialized = json.dumps(payload, separators=(",", ":"))
        self._db.execute(
            "UPDATE pending_work SET superseded_at=coalesce(superseded_at,?),"
            "acknowledged_at=coalesce(acknowledged_at,?) "
            "WHERE namespace=? AND generation=? AND item_key=? AND superseded_at IS NULL",
            (now, now, namespace, generation, item_key),
        )
        self._db.execute(
            "UPDATE page_obligation_outcomes SET status='superseded',updated_at=? "
            "WHERE namespace=? AND generation=? AND item_key=? AND status='pending'",
            (now, namespace, generation, item_key),
        )
        self._db.execute(
            "INSERT INTO pending_work(namespace,generation,item_key,action,observation_revision,payload,page_id,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(namespace,generation,item_key,action) DO UPDATE SET "
            "observation_revision=excluded.observation_revision,payload=excluded.payload,page_id=excluded.page_id,"
            "attempts=0,not_before=NULL,last_error=NULL,acknowledged_at=NULL,superseded_at=NULL,"
            "updated_at=datetime('now')",
            (namespace, generation, item_key, action, revision, serialized, page_id, now, now),
        )
        self._db.execute(
            "INSERT INTO item_observations(namespace,generation,item_key,observation_revision,action,payload,page_id,observed_at) "
            "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(namespace,generation,item_key) DO UPDATE SET "
            "observation_revision=excluded.observation_revision,action=excluded.action,payload=excluded.payload,"
            "page_id=excluded.page_id,observed_at=excluded.observed_at",
            (namespace, generation, item_key, revision, action, serialized, page_id, now),
        )
        if page_id is not None:
            self._db.execute(
                "INSERT OR IGNORE INTO page_obligation_outcomes(namespace,generation,page_id,item_key,observation_revision,action) "
                "VALUES(?,?,?,?,?,?)",
                (namespace, generation, page_id, item_key, revision, action),
            )
        return revision

    def enqueue_work(
        self, namespace: str, generation: int, item_key: str, action: str,
        payload: dict[str, Any] | None = None, *, page_id: str | None = None,
    ) -> None:
        self._db.execute("BEGIN IMMEDIATE")
        try:
            self._observe_work(
                namespace, generation, item_key, action, payload or {}, page_id=page_id,
            )
            self._db.commit()
        except Exception:
            self._db.rollback()
            raise

    def list_pending(
        self, namespace: str, generation: int, *, limit: int = 100,
        work_class: str | None = None,
    ) -> list[PendingWork]:
        if work_class not in {None, "fresh", "retry"}:
            raise ValueError("work_class must be fresh, retry, or None")
        class_clause = (
            " AND attempts=0" if work_class == "fresh"
            else " AND attempts>0" if work_class == "retry"
            else ""
        )
        rows = self._db.execute(
            "SELECT * FROM pending_work WHERE namespace=? AND generation=? "
            "AND acknowledged_at IS NULL AND superseded_at IS NULL "
            "AND (not_before IS NULL OR not_before<=?) " + class_clause + " "
            "ORDER BY attempts ASC,created_at,item_key LIMIT ?",
            (namespace, generation, _now_iso(), max(1, limit)),
        ).fetchall()
        return [PendingWork(r["namespace"], r["generation"], r["item_key"], r["action"],
                            r["observation_revision"], json.loads(r["payload"]),
                            r["attempts"], r["not_before"], r["last_error"],
                            r["page_id"], r["acknowledged_at"])
                for r in rows]

    def work_is_current(self, work: PendingWork) -> bool:
        row = self._db.execute(
            "SELECT observation_revision,action FROM item_observations "
            "WHERE namespace=? AND generation=? AND item_key=?",
            (work.namespace, work.generation, work.item_key),
        ).fetchone()
        return bool(
            row
            and int(row["observation_revision"]) == work.observation_revision
            and row["action"] == work.action
        )

    def work_membership_current(self, work: PendingWork) -> bool:
        if work.action != "upsert":
            return self.work_is_current(work)
        snapshot_id: int | None = None
        if work.page_id:
            page = self.get_page(work.namespace, work.generation, work.page_id)
            snapshot_id = page.snapshot_id if page else None
        if snapshot_id is None:
            progress = self.get_progress(work.namespace)
            snapshot_id = progress.active_snapshot if progress else None
            if snapshot_id is None:
                # Compatibility for pre-page local obligations. Upgraded Drive enumeration always
                # binds an upsert to a materialized page/snapshot before it can reach this path.
                return self.work_is_current(work)
        return self.work_is_current(work) and self.has_membership(
            work.namespace, work.generation, work.item_key,
            snapshot_id=snapshot_id, building=False,
        )

    def work_snapshot_id(self, work: PendingWork) -> int | None:
        if work.page_id:
            page = self.get_page(work.namespace, work.generation, work.page_id)
            if page and page.snapshot_id is not None:
                return int(page.snapshot_id)
        progress = self.get_progress(work.namespace)
        return progress.active_snapshot if progress else None

    def ack_work(self, work: PendingWork) -> None:
        parent_committed = bool(
            work.page_id
            and self._db.execute(
                "SELECT committed_at FROM materialized_pages "
                "WHERE namespace=? AND generation=? AND page_id=?",
                (work.namespace, work.generation, work.page_id),
            ).fetchone()
            and self.page_committed(work.namespace, work.generation, work.page_id)
        )
        if work.page_id is None or parent_committed:
            self._db.execute(
                "DELETE FROM pending_work WHERE namespace=? AND generation=? AND item_key=? AND action=? "
                "AND observation_revision=?",
                (work.namespace, work.generation, work.item_key, work.action,
                 work.observation_revision),
            )
        else:
            self._db.execute(
                "UPDATE pending_work SET acknowledged_at=coalesce(acknowledged_at,?),updated_at=datetime('now') "
                "WHERE namespace=? AND generation=? AND item_key=? AND action=? AND observation_revision=?",
                (_now_iso(), work.namespace, work.generation, work.item_key, work.action,
                 work.observation_revision),
            )
        if work.page_id:
            self._db.execute(
                "UPDATE page_obligation_outcomes SET status='acknowledged',updated_at=? "
                "WHERE namespace=? AND generation=? AND page_id=? AND item_key=? AND observation_revision=? "
                "AND status='pending'",
                (_now_iso(), work.namespace, work.generation, work.page_id, work.item_key,
                 work.observation_revision),
            )
        self._db.commit()

    def purge_committed_page_work(self, namespace: str, generation: int, page_id: str) -> None:
        self._db.execute(
            "DELETE FROM pending_work WHERE namespace=? AND generation=? AND page_id=? AND acknowledged_at IS NOT NULL",
            (namespace, generation, page_id),
        )
        self._db.commit()

    def forget_acknowledged_unpaged(self, work: PendingWork) -> None:
        self._db.execute(
            "DELETE FROM pending_work WHERE namespace=? AND generation=? AND item_key=? AND action=? "
            "AND page_id IS NULL AND acknowledged_at IS NOT NULL",
            (work.namespace, work.generation, work.item_key, work.action),
        )
        self._db.commit()

    def fail_work(self, work: PendingWork, error: str, *, not_before: str | None = None) -> None:
        self._db.execute(
            "UPDATE pending_work SET attempts=attempts+1,last_error=?,not_before=?,updated_at=datetime('now') "
            "WHERE namespace=? AND generation=? AND item_key=? AND action=? AND observation_revision=? "
            "AND superseded_at IS NULL",
            (error[:1000], not_before, work.namespace, work.generation, work.item_key, work.action,
             work.observation_revision),
        )
        self._db.commit()

    def pending_count(self, namespace: str, generation: int) -> int:
        return int(self._db.execute(
            "SELECT count(*) FROM pending_work WHERE namespace=? AND generation=? "
            "AND acknowledged_at IS NULL AND superseded_at IS NULL",
            (namespace, generation),
        ).fetchone()[0])

    def projected_pending_count(
        self, namespace: str, generation: int, item_keys: list[str],
    ) -> int:
        """Return backlog size after observations atomically supersede the same items."""
        distinct = sorted(set(item_keys))
        current = self.pending_count(namespace, generation)
        if not distinct:
            return current
        placeholders = ",".join("?" for _ in distinct)
        replaced = int(self._db.execute(
            "SELECT count(DISTINCT item_key) FROM pending_work WHERE namespace=? AND generation=? "
            "AND acknowledged_at IS NULL AND superseded_at IS NULL "
            f"AND item_key IN ({placeholders})",
            (namespace, generation, *distinct),
        ).fetchone()[0])
        return current - replaced + len(distinct)

    def page_pending_count(self, namespace: str, generation: int, page_id: str) -> int:
        return int(self._db.execute(
            "SELECT count(*) FROM pending_work WHERE namespace=? AND generation=? AND page_id=? "
            "AND acknowledged_at IS NULL AND superseded_at IS NULL",
            (namespace, generation, page_id),
        ).fetchone()[0])

    # -- durable selection traversal / provider pages ----------------------
    def begin_selection_snapshot(
        self, namespace: str, generation: int, roots: list[tuple[str, str, str, bool]],
    ) -> int:
        """Atomically create a replacement incarnation with roots and traversal seeds.

        The prior active incarnation remains readable until :meth:`publish_selection_snapshot`.
        Repeated calls while a build exists return that build and repair any missing seeds.
        """
        self._db.execute("BEGIN IMMEDIATE")
        try:
            progress = self._db.execute(
                "SELECT building_snapshot FROM stream_progress WHERE namespace=?",
                (namespace,),
            ).fetchone()
            snapshot_id = int(progress[0]) if progress and progress[0] is not None else int(
                self._db.execute(
                    "SELECT coalesce(max(snapshot_id),0)+1 FROM ("
                    "SELECT snapshot_id FROM selection_snapshots WHERE namespace=? AND generation=? "
                    "UNION ALL SELECT snapshot_id FROM selected_membership WHERE namespace=? AND generation=? "
                    "UNION ALL SELECT snapshot_id FROM selection_roots WHERE namespace=? AND generation=? "
                    "UNION ALL SELECT snapshot_id FROM traversal_queue WHERE namespace=? AND generation=?"
                    ")",
                    (namespace, generation, namespace, generation, namespace, generation,
                     namespace, generation),
                ).fetchone()[0]
            )
            self._db.execute(
                "INSERT OR IGNORE INTO selection_snapshots(namespace,generation,snapshot_id,status) "
                "VALUES(?,?,?,'building')",
                (namespace, generation, snapshot_id),
            )
            for root_id, kind, drive_id, recursive in roots:
                self._db.execute(
                    "INSERT OR IGNORE INTO selection_roots(namespace,generation,snapshot_id,root_id,root_kind,drive_id,recursive) "
                    "VALUES(?,?,?,?,?,?,?)",
                    (namespace, generation, snapshot_id, root_id, kind, drive_id, int(recursive)),
                )
                if kind in {"folder", "drive"}:
                    self._db.execute(
                        "INSERT OR IGNORE INTO traversal_queue(namespace,generation,snapshot_id,root_id,folder_id,drive_id,page_token) "
                        "VALUES(?,?,?,?,?,?,?)",
                        (namespace, generation, snapshot_id, root_id,
                         drive_id if kind == "drive" else root_id, drive_id, ""),
                    )
                    seed_folder = drive_id if kind == "drive" else root_id
                    self._db.execute(
                        "INSERT OR IGNORE INTO traversal_ancestry(namespace,generation,snapshot_id,root_id,folder_id,ancestor_id) "
                        "VALUES(?,?,?,?,?,?)",
                        (namespace, generation, snapshot_id, root_id, seed_folder, seed_folder),
                    )
            self._db.execute(
                "UPDATE stream_progress SET building_snapshot=?,listing_complete=0,phase='baselining',"
                "terminal_drain_token=NULL,terminal_drain_checkpoint_id=NULL,"
                "terminal_drain_acknowledged=0,terminal_drain_observation=NULL,updated_at=? "
                "WHERE namespace=?",
                (snapshot_id, _now_iso(), namespace),
            )
            self._db.commit()
            return snapshot_id
        except Exception:
            self._db.rollback()
            raise

    def replace_roots(self, namespace: str, generation: int,
                      roots: list[tuple[str, str, str, bool]]) -> None:
        self.begin_selection_snapshot(namespace, generation, roots)

    def snapshot_id(self, namespace: str, *, building: bool = True) -> int | None:
        row = self._db.execute(
            "SELECT active_snapshot,building_snapshot FROM stream_progress WHERE namespace=?",
            (namespace,),
        ).fetchone()
        if not row:
            return None
        selected = row["building_snapshot"] if building and row["building_snapshot"] is not None else row["active_snapshot"]
        # Compatibility for callers/tests that predate explicit snapshot initialization. The
        # coordinator always calls begin_selection_snapshot before provider enumeration.
        return int(selected) if selected is not None else 1

    def list_roots(self, namespace: str, generation: int,
                   *, snapshot_id: int | None = None) -> list[sqlite3.Row]:
        selected = snapshot_id if snapshot_id is not None else self.snapshot_id(namespace)
        if selected is None:
            return []
        return self._db.execute(
            "SELECT * FROM selection_roots WHERE namespace=? AND generation=? AND snapshot_id=? "
            "ORDER BY root_kind,root_id",
            (namespace, generation, selected),
        ).fetchall()

    def enqueue_traversal(
        self, namespace: str, generation: int, root_id: str, folder_id: str,
        drive_id: str, page_token: str | None = None, *, snapshot_id: int | None = None,
    ) -> None:
        selected = snapshot_id if snapshot_id is not None else self.snapshot_id(namespace)
        if selected is None:
            raise RuntimeError("selection snapshot is not initialized")
        self._db.execute(
            "INSERT OR IGNORE INTO traversal_queue(namespace,generation,snapshot_id,root_id,folder_id,drive_id,page_token) "
            "VALUES(?,?,?,?,?,?,?)",
            (namespace, generation, selected, root_id, folder_id, drive_id, page_token or ""),
        )
        self._db.commit()

    def next_traversal(self, namespace: str, generation: int,
                       *, snapshot_id: int | None = None) -> sqlite3.Row | None:
        selected = snapshot_id if snapshot_id is not None else self.snapshot_id(namespace)
        if selected is None:
            return None
        return self._db.execute(
            "SELECT * FROM traversal_queue WHERE namespace=? AND generation=? AND snapshot_id=? "
            "AND completed_at IS NULL "
            "ORDER BY rowid LIMIT 1",
            (namespace, generation, selected),
        ).fetchone()

    def complete_traversal(self, namespace: str, generation: int, root_id: str,
                           folder_id: str, page_token: str | None,
                           *, snapshot_id: int | None = None) -> None:
        selected = snapshot_id if snapshot_id is not None else self.snapshot_id(namespace)
        self._db.execute(
            "UPDATE traversal_queue SET completed_at=? WHERE namespace=? AND generation=? AND root_id=? "
            "AND snapshot_id=? AND folder_id=? AND page_token=?",
            (_now_iso(), namespace, generation, root_id, selected, folder_id, page_token or ""),
        )
        self._db.commit()

    def record_membership(self, namespace: str, generation: int, provider_id: str,
                          root_id: str, drive_id: str, *, snapshot_id: int | None = None) -> None:
        selected = snapshot_id if snapshot_id is not None else self.snapshot_id(namespace)
        if selected is None:
            raise RuntimeError("selection snapshot is not initialized")
        self._db.execute(
            "INSERT OR IGNORE INTO selection_snapshots(namespace,generation,snapshot_id,status,completed_at) "
            "VALUES(?,?,?,'active',?)",
            (namespace, generation, selected, _now_iso()),
        )
        self._db.execute(
            "UPDATE stream_progress SET active_snapshot=coalesce(active_snapshot,?) WHERE namespace=?",
            (selected, namespace),
        )
        row = self._db.execute(
            "SELECT root_ids FROM selected_membership WHERE namespace=? AND generation=? AND snapshot_id=? AND provider_id=?",
            (namespace, generation, selected, provider_id),
        ).fetchone()
        roots = set(json.loads(row["root_ids"])) if row else set()
        roots.add(root_id)
        self._db.execute(
            "INSERT INTO selected_membership(namespace,generation,snapshot_id,provider_id,root_ids,drive_id,seen_at) "
            "VALUES(?,?,?,?,?,?,?) ON CONFLICT(namespace,generation,snapshot_id,provider_id) DO UPDATE SET "
            "root_ids=excluded.root_ids,drive_id=excluded.drive_id,seen_at=excluded.seen_at",
            (namespace, generation, selected, provider_id, json.dumps(sorted(roots)), drive_id, _now_iso()),
        )
        self._db.commit()

    def membership_ids(self, namespace: str, generation: int,
                       *, snapshot_id: int | None = None, building: bool = False) -> list[str]:
        selected = snapshot_id
        if selected is None:
            selected = self.snapshot_id(namespace, building=building)
        if selected is None:
            return []
        return [r[0] for r in self._db.execute(
            "SELECT provider_id FROM selected_membership WHERE namespace=? AND generation=? AND snapshot_id=? "
            "ORDER BY provider_id",
            (namespace, generation, selected),
        ).fetchall()]

    def membership_impacts_for_root(
        self, namespace: str, generation: int, root_id: str,
        *, snapshot_id: int | None = None,
    ) -> tuple[list[str], list[str]]:
        """Return (all descendants, descendants losing their final selected-root claim).

        ``root_ids`` is retained subtree provenance, not display metadata. Using it means a
        confirmed selected-folder/Shared-Drive tombstone can suppress only that connection's
        affected claims while preserving a doc selected directly or through an overlapping root.
        """
        selected = snapshot_id if snapshot_id is not None else self.snapshot_id(namespace, building=False)
        if selected is None:
            return [], []
        affected: list[str] = []
        final: list[str] = []
        for row in self._db.execute(
            "SELECT provider_id,root_ids FROM selected_membership "
            "WHERE namespace=? AND generation=? AND snapshot_id=? ORDER BY provider_id",
            (namespace, generation, selected),
        ).fetchall():
            roots = set(json.loads(row["root_ids"]))
            if root_id not in roots:
                continue
            affected.append(str(row["provider_id"]))
            if roots == {root_id}:
                final.append(str(row["provider_id"]))
        return affected, final

    def membership_impacts_for_ancestor(
        self, namespace: str, generation: int, ancestor_id: str,
        *, snapshot_id: int | None = None,
    ) -> tuple[list[tuple[str, str]], list[str]]:
        """Resolve a nested-folder tombstone through persisted transitive traversal provenance."""
        selected = snapshot_id if snapshot_id is not None else self.snapshot_id(namespace, building=False)
        if selected is None:
            return [], []
        rows = self._db.execute(
            "SELECT provider_id,root_id FROM membership_ancestry WHERE namespace=? AND generation=? "
            "AND snapshot_id=? AND ancestor_id=? ORDER BY provider_id,root_id",
            (namespace, generation, selected, ancestor_id),
        ).fetchall()
        pairs = [(str(row["provider_id"]), str(row["root_id"])) for row in rows]
        affected_by_item: dict[str, set[str]] = {}
        for provider_id, root_id in pairs:
            affected_by_item.setdefault(provider_id, set()).add(root_id)
        final: list[str] = []
        for provider_id, affected_roots in affected_by_item.items():
            row = self._db.execute(
                "SELECT root_ids FROM selected_membership WHERE namespace=? AND generation=? "
                "AND snapshot_id=? AND provider_id=?",
                (namespace, generation, selected, provider_id),
            ).fetchone()
            roots = set(json.loads(row["root_ids"])) if row else set()
            if roots and not (roots - affected_roots):
                final.append(provider_id)
        return pairs, sorted(final)

    def has_membership(self, namespace: str, generation: int, provider_id: str,
                       *, snapshot_id: int | None = None, building: bool = True) -> bool:
        selected = snapshot_id if snapshot_id is not None else self.snapshot_id(namespace, building=building)
        if selected is None:
            return False
        return self._db.execute(
            "SELECT 1 FROM selected_membership WHERE namespace=? AND generation=? AND snapshot_id=? AND provider_id=?",
            (namespace, generation, selected, provider_id),
        ).fetchone() is not None

    def remove_membership(self, namespace: str, generation: int, provider_id: str,
                          *, snapshot_id: int | None = None) -> bool:
        selected = snapshot_id if snapshot_id is not None else self.snapshot_id(namespace)
        cur = self._db.execute(
            "DELETE FROM selected_membership WHERE namespace=? AND generation=? AND snapshot_id=? AND provider_id=?",
            (namespace, generation, selected, provider_id),
        )
        self._db.commit()
        return cur.rowcount == 1

    def roots_for_parent(self, namespace: str, generation: int, parent_id: str,
                         *, snapshot_id: int | None = None) -> list[str]:
        selected = snapshot_id if snapshot_id is not None else self.snapshot_id(namespace, building=False)
        if selected is None:
            return []
        return [r[0] for r in self._db.execute(
            "SELECT DISTINCT root_id FROM traversal_queue WHERE namespace=? AND generation=? "
            "AND snapshot_id=? AND folder_id=?",
            (namespace, generation, selected, parent_id),
        ).fetchall()]

    def reset_selection_snapshot(self, namespace: str, generation: int) -> int:
        """Start a replacement snapshot while retaining the prior authoritative membership."""
        active = self.snapshot_id(namespace, building=False)
        roots = self.list_roots(namespace, generation, snapshot_id=active)
        return self.begin_selection_snapshot(namespace, generation, [
            (row["root_id"], row["root_kind"], row["drive_id"], bool(row["recursive"]))
            for row in roots
        ])

    def snapshot_complete(self, namespace: str, generation: int, snapshot_id: int | None) -> bool:
        if snapshot_id is None:
            return False
        row = self._db.execute(
            "SELECT status FROM selection_snapshots WHERE namespace=? AND generation=? AND snapshot_id=?",
            (namespace, generation, snapshot_id),
        ).fetchone()
        if not row or row["status"] != "active":
            return False
        traversal = self._db.execute(
            "SELECT 1 FROM traversal_queue WHERE namespace=? AND generation=? AND snapshot_id=? "
            "AND completed_at IS NULL LIMIT 1",
            (namespace, generation, snapshot_id),
        ).fetchone()
        return traversal is None

    def snapshot_build_complete(self, namespace: str, generation: int, snapshot_id: int | None) -> bool:
        if snapshot_id is None:
            return False
        row = self._db.execute(
            "SELECT status FROM selection_snapshots WHERE namespace=? AND generation=? AND snapshot_id=?",
            (namespace, generation, snapshot_id),
        ).fetchone()
        if not row or row["status"] != "building":
            return False
        return self.next_traversal(namespace, generation, snapshot_id=snapshot_id) is None

    def page_committed(self, namespace: str, generation: int, page_id: str | None) -> bool:
        if not page_id:
            return True
        page = self.get_page(namespace, generation, page_id)
        return bool(page and page.committed_at)

    def publish_selection_snapshot(self, namespace: str, generation: int, snapshot_id: int) -> None:
        """Atomically swap completed membership into authority after the server checkpoint."""
        self._db.execute("BEGIN IMMEDIATE")
        try:
            pending_traversal = self._db.execute(
                "SELECT 1 FROM traversal_queue WHERE namespace=? AND generation=? AND snapshot_id=? "
                "AND completed_at IS NULL LIMIT 1",
                (namespace, generation, snapshot_id),
            ).fetchone()
            if pending_traversal:
                raise RuntimeError("cannot publish incomplete selection traversal")
            self._db.execute(
                "UPDATE selection_snapshots SET status='retired' WHERE namespace=? AND generation=? AND status='active'",
                (namespace, generation),
            )
            cur = self._db.execute(
                "UPDATE selection_snapshots SET status='active',completed_at=? "
                "WHERE namespace=? AND generation=? AND snapshot_id=? AND status='building'",
                (_now_iso(), namespace, generation, snapshot_id),
            )
            if cur.rowcount != 1:
                already = self._db.execute(
                    "SELECT status FROM selection_snapshots WHERE namespace=? AND generation=? AND snapshot_id=?",
                    (namespace, generation, snapshot_id),
                ).fetchone()
                if not already or already["status"] != "active":
                    raise RuntimeError("selection snapshot is not publishable")
            self._db.execute(
                "UPDATE stream_progress SET active_snapshot=?,building_snapshot=NULL,recovery_required=0,"
                "listing_complete=1,updated_at=? WHERE namespace=?",
                (snapshot_id, _now_iso(), namespace),
            )
            self._db.commit()
        except Exception:
            self._db.rollback()
            raise

    def materialize_page(
        self, namespace: str, generation: int, page_id: str, page_kind: str,
        input_token: str | None, next_token: str | None, terminal_token: str | None,
        obligations: list[tuple[str, str, dict[str, Any]]],
        *,
        snapshot_id: int | None = None,
        membership_additions: list[tuple[str, str, str] | tuple[str, str, str, str | None]] | None = None,
        membership_removals: list[str] | None = None,
        membership_root_removals: list[tuple[str, str]] | None = None,
        traversal_additions: list[tuple[str, str, str, str | None]] | None = None,
        traversal_completion: tuple[str, str, str | None] | None = None,
        rescan_roots: list[tuple[str, str, str, bool]] | None = None,
        drain_observation: int = 0,
    ) -> MaterializedPage:
        """Atomically retain a provider page and every required outcome before processing."""
        self._db.execute("BEGIN IMMEDIATE")
        try:
            existing_page = self._db.execute(
                "SELECT snapshot_id,rescan_snapshot_id FROM materialized_pages "
                "WHERE namespace=? AND generation=? AND page_id=?",
                (namespace, generation, page_id),
            ).fetchone()
            selected = (
                existing_page["snapshot_id"]
                if existing_page is not None and existing_page["snapshot_id"] is not None
                else snapshot_id if snapshot_id is not None else self.snapshot_id(namespace)
            )
            # Replaying a page after its rescan published (for example, a crash immediately before
            # page retirement) must repair the original incarnation, never create another one.
            rescan_snapshot_id: int | None = (
                int(existing_page["rescan_snapshot_id"])
                if existing_page is not None and existing_page["rescan_snapshot_id"] is not None
                else None
            )
            if rescan_roots is not None:
                if rescan_snapshot_id is None:
                    progress = self._db.execute(
                        "SELECT building_snapshot FROM stream_progress WHERE namespace=?",
                        (namespace,),
                    ).fetchone()
                    rescan_snapshot_id = int(progress[0]) if progress and progress[0] is not None else int(
                        self._db.execute(
                            "SELECT coalesce(max(snapshot_id),0)+1 FROM selection_snapshots "
                            "WHERE namespace=? AND generation=?",
                            (namespace, generation),
                        ).fetchone()[0]
                    )
                self._db.execute(
                    "INSERT OR IGNORE INTO selection_snapshots(namespace,generation,snapshot_id,status) "
                    "VALUES(?,?,?,'building')",
                    (namespace, generation, rescan_snapshot_id),
                )
                for root_id, kind, drive_id, recursive in rescan_roots:
                    self._db.execute(
                        "INSERT OR IGNORE INTO selection_roots(namespace,generation,snapshot_id,root_id,root_kind,drive_id,recursive) "
                        "VALUES(?,?,?,?,?,?,?)",
                        (namespace, generation, rescan_snapshot_id, root_id, kind, drive_id, int(recursive)),
                    )
                    if kind in {"folder", "drive"}:
                        self._db.execute(
                            "INSERT OR IGNORE INTO traversal_queue(namespace,generation,snapshot_id,root_id,folder_id,drive_id,page_token) "
                            "VALUES(?,?,?,?,?,?,?)",
                            (namespace, generation, rescan_snapshot_id, root_id,
                             drive_id if kind == "drive" else root_id, drive_id, ""),
                        )
                        seed_folder = drive_id if kind == "drive" else root_id
                        self._db.execute(
                            "INSERT OR IGNORE INTO traversal_ancestry(namespace,generation,snapshot_id,root_id,folder_id,ancestor_id) "
                            "VALUES(?,?,?,?,?,?)",
                            (namespace, generation, rescan_snapshot_id, root_id, seed_folder, seed_folder),
                        )
                rescan_status = self._db.execute(
                    "SELECT status FROM selection_snapshots WHERE namespace=? AND generation=? AND snapshot_id=?",
                    (namespace, generation, rescan_snapshot_id),
                ).fetchone()
                if rescan_status is not None and rescan_status["status"] == "building":
                    self._db.execute(
                        "UPDATE stream_progress SET building_snapshot=?,listing_complete=0,phase='baselining',"
                        "terminal_drain_token=NULL,terminal_drain_checkpoint_id=NULL,"
                        "terminal_drain_acknowledged=0,terminal_drain_observation=NULL,updated_at=? "
                        "WHERE namespace=?",
                        (rescan_snapshot_id, _now_iso(), namespace),
                    )
            self._db.execute(
                "INSERT OR IGNORE INTO materialized_pages(namespace,generation,page_id,page_kind,drain_observation,snapshot_id,input_token,next_token,terminal_token,rescan_snapshot_id) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (namespace, generation, page_id, page_kind, drain_observation, selected,
                 input_token or "", next_token, terminal_token, rescan_snapshot_id),
            )
            for item_key, action, payload in obligations:
                replay = self._db.execute(
                    "SELECT observation_revision,status FROM page_obligation_outcomes "
                    "WHERE namespace=? AND generation=? AND page_id=? AND item_key=? AND action=? "
                    "ORDER BY observation_revision DESC LIMIT 1",
                    (namespace, generation, page_id, item_key, action),
                ).fetchone()
                if replay is None:
                    self._observe_work(
                        namespace, generation, item_key, action, payload, page_id=page_id,
                    )
                elif replay["status"] == "pending":
                    current = self._db.execute(
                        "SELECT observation_revision,action FROM item_observations "
                        "WHERE namespace=? AND generation=? AND item_key=?",
                        (namespace, generation, item_key),
                    ).fetchone()
                    if (
                        current
                        and int(current["observation_revision"]) == int(replay["observation_revision"])
                        and current["action"] == action
                    ):
                        self._db.execute(
                            "INSERT OR IGNORE INTO pending_work(namespace,generation,item_key,action,"
                            "observation_revision,payload,page_id,created_at,updated_at) "
                            "VALUES(?,?,?,?,?,?,?,?,?)",
                            (namespace, generation, item_key, action,
                             int(replay["observation_revision"]),
                             json.dumps(payload, separators=(",", ":")), page_id,
                             _now_iso(), _now_iso()),
                        )
            # The page row, membership and traversal outcomes share this transaction. Replaying an
            # already-materialized older page may repair its still-current work row, but must never
            # reapply membership over a newer conflicting observation.
            if existing_page is None:
                for membership in membership_additions or []:
                    provider_id, root_id, drive_id = membership[:3]
                    parent_id = membership[3] if len(membership) > 3 else None
                    existing = self._db.execute(
                        "SELECT root_ids FROM selected_membership WHERE namespace=? AND generation=? AND snapshot_id=? AND provider_id=?",
                        (namespace, generation, selected, provider_id),
                    ).fetchone()
                    roots = set(json.loads(existing["root_ids"])) if existing else set()
                    roots.add(root_id)
                    self._db.execute(
                        "INSERT INTO selected_membership(namespace,generation,snapshot_id,provider_id,root_ids,drive_id,seen_at) "
                        "VALUES(?,?,?,?,?,?,?) ON CONFLICT(namespace,generation,snapshot_id,provider_id) DO UPDATE SET "
                        "root_ids=excluded.root_ids,drive_id=excluded.drive_id,seen_at=excluded.seen_at",
                        (namespace, generation, selected, provider_id, json.dumps(sorted(roots)), drive_id, _now_iso()),
                    )
                    if parent_id:
                        ancestors = self._db.execute(
                            "SELECT ancestor_id FROM traversal_ancestry WHERE namespace=? AND generation=? "
                            "AND snapshot_id=? AND root_id=? AND folder_id=?",
                            (namespace, generation, selected, root_id, parent_id),
                        ).fetchall()
                        for ancestor in ancestors:
                            self._db.execute(
                                "INSERT OR IGNORE INTO membership_ancestry(namespace,generation,snapshot_id,provider_id,root_id,ancestor_id) "
                                "VALUES(?,?,?,?,?,?)",
                                (namespace, generation, selected, provider_id, root_id, ancestor["ancestor_id"]),
                            )
                for provider_id in membership_removals or []:
                    self._db.execute(
                        "DELETE FROM selected_membership WHERE namespace=? AND generation=? AND snapshot_id=? AND provider_id=?",
                        (namespace, generation, selected, provider_id),
                    )
                    self._db.execute(
                        "DELETE FROM membership_ancestry WHERE namespace=? AND generation=? AND snapshot_id=? AND provider_id=?",
                        (namespace, generation, selected, provider_id),
                    )
                for provider_id, root_id in membership_root_removals or []:
                    row = self._db.execute(
                        "SELECT root_ids FROM selected_membership WHERE namespace=? AND generation=? "
                        "AND snapshot_id=? AND provider_id=?",
                        (namespace, generation, selected, provider_id),
                    ).fetchone()
                    if row is None:
                        continue
                    roots = set(json.loads(row["root_ids"]))
                    roots.discard(root_id)
                    self._db.execute(
                        "DELETE FROM membership_ancestry WHERE namespace=? AND generation=? AND snapshot_id=? "
                        "AND provider_id=? AND root_id=?",
                        (namespace, generation, selected, provider_id, root_id),
                    )
                    if roots:
                        self._db.execute(
                            "UPDATE selected_membership SET root_ids=?,seen_at=? WHERE namespace=? "
                            "AND generation=? AND snapshot_id=? AND provider_id=?",
                            (json.dumps(sorted(roots)), _now_iso(), namespace, generation, selected, provider_id),
                        )
                    else:
                        self._db.execute(
                            "DELETE FROM selected_membership WHERE namespace=? AND generation=? "
                            "AND snapshot_id=? AND provider_id=?",
                            (namespace, generation, selected, provider_id),
                        )
                for root_id, folder_id, drive_id, traversal_token in traversal_additions or []:
                    self._db.execute(
                        "INSERT OR IGNORE INTO traversal_queue(namespace,generation,snapshot_id,root_id,folder_id,drive_id,page_token) "
                        "VALUES(?,?,?,?,?,?,?)",
                        (namespace, generation, selected, root_id, folder_id, drive_id, traversal_token or ""),
                    )
                    parent_folder = traversal_completion[1] if traversal_completion is not None else root_id
                    ancestors = self._db.execute(
                        "SELECT ancestor_id FROM traversal_ancestry WHERE namespace=? AND generation=? "
                        "AND snapshot_id=? AND root_id=? AND folder_id=?",
                        (namespace, generation, selected, root_id, parent_folder),
                    ).fetchall()
                    for ancestor_id in [folder_id, *(row["ancestor_id"] for row in ancestors)]:
                        self._db.execute(
                            "INSERT OR IGNORE INTO traversal_ancestry(namespace,generation,snapshot_id,root_id,folder_id,ancestor_id) "
                            "VALUES(?,?,?,?,?,?)",
                            (namespace, generation, selected, root_id, folder_id, ancestor_id),
                        )
                if traversal_completion is not None:
                    root_id, folder_id, traversal_token = traversal_completion
                    self._db.execute(
                        "UPDATE traversal_queue SET completed_at=? WHERE namespace=? AND generation=? "
                        "AND snapshot_id=? AND root_id=? AND folder_id=? AND page_token=?",
                        (_now_iso(), namespace, generation, selected, root_id, folder_id,
                         traversal_token or ""),
                    )
            self._db.commit()
        except Exception:
            self._db.rollback()
            raise
        page = self.get_page(namespace, generation, page_id)
        if page is None:  # pragma: no cover
            raise RuntimeError("failed to materialize provider page")
        return page

    def get_page(self, namespace: str, generation: int, page_id: str) -> MaterializedPage | None:
        row = self._db.execute(
            "SELECT * FROM materialized_pages WHERE namespace=? AND generation=? AND page_id=?",
            (namespace, generation, page_id),
        ).fetchone()
        return MaterializedPage(
            row["namespace"], row["generation"], row["page_id"], row["page_kind"],
            int(row["drain_observation"] or 0), row["input_token"], row["next_token"],
            row["terminal_token"], row["committed_at"],
            row["snapshot_id"], row["rescan_snapshot_id"],
        ) if row else None

    def next_uncommitted_page(self, namespace: str, generation: int,
                              *, snapshot_id: int | None = None) -> MaterializedPage | None:
        sql = (
            "SELECT page_id FROM materialized_pages WHERE namespace=? AND generation=? "
            "AND committed_at IS NULL"
        )
        args: list[Any] = [namespace, generation]
        if snapshot_id is not None:
            sql += " AND snapshot_id=?"
            args.append(snapshot_id)
        sql += " ORDER BY materialized_at,rowid LIMIT 1"
        row = self._db.execute(sql, args).fetchone()
        return self.get_page(namespace, generation, row["page_id"]) if row else None

    def commit_page(self, namespace: str, generation: int, page_id: str,
                    *, require_acks: bool = True) -> None:
        if require_acks and self.page_pending_count(namespace, generation, page_id):
            raise RuntimeError("cannot commit provider page with unacknowledged obligations")
        page = self.get_page(namespace, generation, page_id)
        if page and page.rescan_snapshot_id is not None and not self.snapshot_complete(
            namespace, generation, page.rescan_snapshot_id,
        ):
            raise RuntimeError("cannot commit provider page before its subtree rescan publishes")
        self._db.execute(
            "UPDATE materialized_pages SET committed_at=coalesce(committed_at,?) "
            "WHERE namespace=? AND generation=? AND page_id=?",
            (_now_iso(), namespace, generation, page_id),
        )
        self._db.commit()

    # -- stream serialization ------------------------------------------------
    def acquire_lease(self, namespace: str, *, ttl_seconds: int = 300) -> tuple[str, int] | None:
        """Acquire one fenced local-worker lease, or return None while another owner is live."""
        from datetime import timedelta

        owner = secrets.token_hex(16)
        now = datetime.now(timezone.utc)
        until = (now + timedelta(seconds=max(30, ttl_seconds))).isoformat()
        self._db.execute("BEGIN IMMEDIATE")
        try:
            row = self._db.execute(
                "SELECT owner,fence,lease_until FROM stream_leases WHERE namespace=?", (namespace,)
            ).fetchone()
            if row and datetime.fromisoformat(row["lease_until"]) > now:
                self._db.rollback()
                return None
            fence = (int(row["fence"]) + 1) if row else 1
            self._db.execute(
                "INSERT INTO stream_leases(namespace,owner,fence,lease_until) VALUES(?,?,?,?) "
                "ON CONFLICT(namespace) DO UPDATE SET owner=excluded.owner,fence=excluded.fence,lease_until=excluded.lease_until",
                (namespace, owner, fence, until),
            )
            self._db.commit()
            return owner, fence
        except Exception:
            self._db.rollback()
            raise

    def renew_lease(self, namespace: str, owner: str, fence: int, *, ttl_seconds: int = 300) -> bool:
        from datetime import timedelta

        until = (datetime.now(timezone.utc) + timedelta(seconds=max(30, ttl_seconds))).isoformat()
        cur = self._db.execute(
            "UPDATE stream_leases SET lease_until=? WHERE namespace=? AND owner=? AND fence=?",
            (until, namespace, owner, fence),
        )
        self._db.commit()
        return cur.rowcount == 1

    def release_lease(self, namespace: str, owner: str, fence: int) -> None:
        self._db.execute(
            "UPDATE stream_leases SET lease_until=? WHERE namespace=? AND owner=? AND fence=?",
            ("1970-01-01T00:00:00+00:00", namespace, owner, fence),
        )
        self._db.commit()


def verification_hash(token: str) -> str:
    return _token_hash(token)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
