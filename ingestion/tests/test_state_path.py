"""One state database for sync, schedule and the webhook receiver (AIO-1167 R44 C10).

Spec. The receiver validates a notification against channels the SCHEDULER persisted and marks the
stream the scheduler then drains, so both — launched as separate processes — must open the same
SQLite file from ONE documented setting. Precedence: explicit `--state-db` > `AIOS_INGEST_STATE` >
legacy alias `AIOS_STATE_DB` > the default file; the two environment names disagreeing is refused.

The end-to-end case sets only the documented `AIOS_INGEST_STATE`, starts `schedule` through its
public CLI entry point, persists a real channel in the state it opened, validates a callback
through the receiver, and sees the hint in the scheduler's own state.
"""

from __future__ import annotations

import pytest
from click.testing import CliRunner

from aios_ingest.state import Channel, StateStore, StreamKey, verification_hash
from aios_ingest.state_path import (
    DEFAULT_STATE_DB,
    LEGACY_STATE_DB_ENV,
    STATE_DB_ENV,
    StatePathConflict,
    resolve_state_db,
)


@pytest.mark.parametrize(
    "explicit, env, expected",
    [
        ("cli.sqlite", {STATE_DB_ENV: "env.sqlite", LEGACY_STATE_DB_ENV: "env.sqlite"}, "cli.sqlite"),
        (None, {STATE_DB_ENV: "env.sqlite"}, "env.sqlite"),
        (None, {LEGACY_STATE_DB_ENV: "legacy.sqlite"}, "legacy.sqlite"),
        (None, {STATE_DB_ENV: "same.sqlite", LEGACY_STATE_DB_ENV: "same.sqlite"}, "same.sqlite"),
        (None, {STATE_DB_ENV: "  ", LEGACY_STATE_DB_ENV: ""}, DEFAULT_STATE_DB),
        ("  ", {}, DEFAULT_STATE_DB),
        (None, {}, DEFAULT_STATE_DB),
    ],
)
def test_precedence(explicit, env, expected):
    assert resolve_state_db(explicit, env) == expected


def test_disagreeing_environment_names_are_refused():
    with pytest.raises(StatePathConflict):
        resolve_state_db(None, {STATE_DB_ENV: "a.sqlite", LEGACY_STATE_DB_ENV: "b.sqlite"})


def test_schedule_and_the_receiver_share_the_documented_state_file(tmp_path, monkeypatch):
    from aios_ingest import cli, scheduler
    from aios_ingest.webhook_app import _gdrive_notification

    custom = tmp_path / "non-default" / "state.sqlite"
    custom.parent.mkdir()
    monkeypatch.chdir(tmp_path)  # a stray default-path file would appear here, not in custom/
    monkeypatch.setenv(STATE_DB_ENV, str(custom))
    monkeypatch.delenv(LEGACY_STATE_DB_ENV, raising=False)
    for name, value in {"BRAIN_URL": "http://brain.test", "AIOS_API_KEY": "aios_x_y", "AIOS_TEAM": "acme"}.items():
        monkeypatch.setenv(name, value)
    config = tmp_path / "connections.yaml"
    config.write_text("connections: []\n")
    seen: dict[str, object] = {}

    def fake_run(settings, conns, *, state: StateStore, **_kwargs):
        # Inside the running scheduler: persist a real channel in the state it opened…
        key = StreamKey(settings.team, "integration-id", "subject:acct", "my-drive")
        progress = state.begin_generation(key, 3, start_token="start")
        state.save_channel(Channel(
            "docs", "chan-1", "res-1", "2099-01-01T00:00:00Z", progress.namespace, verification_hash("tok"),
        ))
        # …the separately configured receiver validates against it and marks the stream…
        response = _gdrive_notification({
            "x-goog-channel-id": "chan-1", "x-goog-resource-id": "res-1", "x-goog-channel-token": "tok",
        })
        seen["status"] = response.status_code
        # …and the scheduler's own state is what the hint sweep drains.
        seen["pending"] = state.pending_hint_connections(settings.team)

    monkeypatch.setattr(scheduler, "run", fake_run)
    result = CliRunner().invoke(cli.main, ["schedule", "--config", str(config)])

    assert result.exit_code == 0, result.output
    assert seen["status"] == 202
    assert seen["pending"] == {"integration-id": 1}
    assert custom.exists()
    assert not (tmp_path / DEFAULT_STATE_DB).exists()
