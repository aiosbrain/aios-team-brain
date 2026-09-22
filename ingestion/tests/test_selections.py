"""Spec tests for F4 — sidecar consumes brain selections.

Derived from the F4 product contract, NOT from the current implementation:
  1. Merge by (type, name): brain selection updates the matching local connection's
     selection fields; the local connection supplies the secret/token.
  2. Selection from brain, tokens local: brain config has no secret keys, so merging
     can never overwrite a local secret.
  3. Backward compatible: unconfigured → output equals local input, no brain call.
"""

import copy

from aios_ingest.cli import _selections_enabled
from aios_ingest.config import Connection
from aios_ingest.selections import effective_gdrive_connection, merge_selections
from aios_ingest.sources.registry import build_source


def _slack_conn() -> Connection:
    return Connection(
        name="eng-slack",
        source="slack",
        options={"token": "xoxb-LOCAL", "signing_secret": "s", "channel_ids": ["C_OLD"]},
    )


def _github_conn() -> Connection:
    return Connection(
        name="eng-handbook",
        source="github",
        options={"repo": "org/old", "token": "ghp-LOCAL", "webhook_secret": "wh"},
    )


# --- 1 + 2: merge precedence + secrets preserved (slack) --------------------


def test_slack_brain_channels_win_local_secrets_preserved():
    remote = [
        {
            "id": "i1",
            "type": "slack",
            "name": "eng-slack",
            "config": {"channelIds": ["C_NEW1", "C_NEW2"]},
            "status": "enabled",
        }
    ]
    merged = merge_selections([_slack_conn()], remote)
    assert len(merged) == 1
    opts = merged[0].options
    # brain selection wins
    assert opts["channel_ids"] == ["C_NEW1", "C_NEW2"]
    # local secrets preserved verbatim
    assert opts["token"] == "xoxb-LOCAL"
    assert opts["signing_secret"] == "s"


# --- build_source compatibility: merged options are adapter-valid -----------


def test_merged_slack_options_construct_without_typeerror():
    remote = [
        {"type": "slack", "name": "eng-slack", "config": {"channelIds": ["C1"]}, "status": "enabled"}
    ]
    conn = merge_selections([_slack_conn()], remote)[0]
    src = build_source(conn.source, conn.options)  # must not raise TypeError
    assert src is not None


# --- unmatched remote skipped ----------------------------------------------


def test_unmatched_remote_selection_is_skipped():
    remote = [
        {"type": "slack", "name": "no-such-local", "config": {"channelIds": ["C9"]}, "status": "enabled"}
    ]
    local = [_slack_conn()]
    merged = merge_selections(local, remote)
    # only the one local connection comes back; the orphan remote never becomes runnable
    assert len(merged) == 1
    assert merged[0].name == "eng-slack"
    # and it was not affected by the unmatched remote
    assert merged[0].options["channel_ids"] == ["C_OLD"]


def test_unmatched_oauth_gdrive_selection_bootstraps_broker_connection():
    remote = [{
        "id": "11111111-1111-1111-1111-111111111111",
        "type": "gdrive", "name": "company-docs", "status": "enabled",
        "config": {
            "authMode": "oauth", "fileIds": ["DocA"], "folderIds": [],
            "sharedDriveIds": [], "recursive": False, "selectionState": "selected",
            "authenticatedAccount": "docs@example.com",
            "authenticatedAccountId": "subject:google-123", "scopeSet": ["drive.file"],
            "projectSlug": "company-docs", "access": "team",
        },
    }]
    merged = merge_selections([], remote)
    assert len(merged) == 1
    assert merged[0].name == "company-docs"
    assert merged[0].options["integration_id"] == remote[0]["id"]
    assert merged[0].options["credential_identity"] == "subject:google-123"
    assert "access_token" not in merged[0].options
    assert "refresh_token" not in merged[0].options


def test_disabled_unmatched_oauth_gdrive_does_not_bootstrap():
    remote = [{
        "id": "11111111-1111-1111-1111-111111111111", "type": "gdrive",
        "name": "paused", "status": "disabled", "config": {"authMode": "oauth"},
    }]
    assert merge_selections([], remote) == []


def test_gdrive_remote_file_only_selection_removes_all_legacy_folder_aliases():
    local = Connection(
        name="docs",
        source="gdrive",
        project="legacy-project",
        access="external",
        options={
            "folder_id": "legacy-single",
            "folder_ids": ["legacy-many"],
            "file_ids": ["legacy-file"],
            "shared_drive_ids": ["legacy-drive"],
            "recursive": True,
            "service_account_key_path": "/local/key.json",
            "webhook_url": "https://example.test/watch",
            "project": "legacy-option-project",
            "access": "external",
        },
    )
    effective = effective_gdrive_connection(local, {
        "authMode": "oauth",
        "fileIds": ["authoritative-file"],
        "folderIds": [],
        "sharedDriveIds": [],
        "recursive": False,
        "selectionState": "selected",
        "projectSlug": "current-project",
        "access": "team",
    }, "integration-id")

    assert effective.options["file_ids"] == ["authoritative-file"]
    assert effective.options["folder_ids"] == []
    assert "folder_id" not in effective.options
    assert effective.options["shared_drive_ids"] == []
    assert effective.options["recursive"] is False
    assert "service_account_key_path" not in effective.options
    assert "project" not in effective.options
    assert "access" not in effective.options
    assert effective.options["webhook_url"] == "https://example.test/watch"
    assert effective.project == "current-project"
    assert effective.access == "team"


def test_gdrive_remote_explicit_empty_clears_selection_aliases_and_removed_project():
    local = Connection(
        name="docs",
        source="gdrive",
        project="must-not-survive",
        options={"folder_id": "old", "folder_ids": ["old"], "file_ids": ["old"]},
    )
    effective = effective_gdrive_connection(local, {
        "authMode": "oauth",
        "fileIds": [],
        "folderIds": [],
        "sharedDriveIds": [],
        "selectionState": "empty",
    }, "integration-id")

    assert effective.project is None
    assert effective.options["selection_state"] == "empty"
    assert effective.options["file_ids"] == []
    assert effective.options["folder_ids"] == []
    assert "folder_id" not in effective.options


def test_gdrive_auth_mode_is_decisive_for_oauth_and_service_account():
    local = Connection(
        name="docs",
        source="gdrive",
        options={
            "service_account_key_path": "/local/key.json",
            "credential_json": {"type": "service_account", "client_email": "sync@example.test"},
        },
    )
    common = {
        "fileIds": ["doc"], "folderIds": [], "sharedDriveIds": [],
        "selectionState": "selected",
    }

    oauth = effective_gdrive_connection(local, {**common, "authMode": "oauth"}, "oauth-id")
    assert oauth.options["auth_mode"] == "oauth"
    assert "service_account_key_path" not in oauth.options
    assert "credential_json" not in oauth.options

    service = effective_gdrive_connection(
        local, {**common, "authMode": "service_account"}, "service-id",
    )
    assert service.options["auth_mode"] == "service_account"
    assert service.options["service_account_key_path"] == "/local/key.json"
    assert service.options["credential_json"]["type"] == "service_account"


# --- unmatched local preserved ----------------------------------------------


def test_unmatched_local_connection_returned_unchanged():
    local = _slack_conn()
    before = copy.deepcopy(local.options)
    merged = merge_selections([local], [])
    assert merged[0].options == before


def test_disabled_remote_row_pauses_matching_local_connection_without_mutating_secret():
    local = _slack_conn()
    remote = [{
        "type": "slack",
        "name": "eng-slack",
        "config": {"channelIds": ["C_NEW"]},
        "status": "disabled",
    }]
    assert merge_selections([local], remote) == []
    assert local.options["token"] == "xoxb-LOCAL"


# --- backward compat / unconfigured ----------------------------------------


def test_empty_remote_returns_equivalent_connections_without_mutation():
    local = [_slack_conn(), _github_conn()]
    snapshot = [copy.deepcopy(c.options) for c in local]
    merged = merge_selections(local, [])
    assert len(merged) == 2
    for m, original_opts in zip(merged, snapshot):
        assert m.options == original_opts
    # originals not mutated (new objects via dataclasses.replace when matched; here
    # unmatched are returned as-is, but their options must remain unchanged)
    for c, original_opts in zip(local, snapshot):
        assert c.options == original_opts


def test_matched_merge_does_not_mutate_input_options():
    local = _slack_conn()
    remote = [
        {"type": "slack", "name": "eng-slack", "config": {"channelIds": ["C_NEW"]}, "status": "enabled"}
    ]
    merged = merge_selections([local], remote)
    # the original connection's options must be untouched (function returns a new object)
    assert local.options["channel_ids"] == ["C_OLD"]
    assert merged[0].options["channel_ids"] == ["C_NEW"]
    assert merged[0] is not local


def test_selections_enabled_default_false(monkeypatch):
    monkeypatch.delenv("AIOS_BRAIN_SELECTIONS", raising=False)
    assert _selections_enabled(False) is False
    assert _selections_enabled(True) is True


def test_selections_enabled_honors_env(monkeypatch):
    monkeypatch.setenv("AIOS_BRAIN_SELECTIONS", "1")
    assert _selections_enabled(False) is True
    monkeypatch.setenv("AIOS_BRAIN_SELECTIONS", "true")
    assert _selections_enabled(False) is True
    monkeypatch.setenv("AIOS_BRAIN_SELECTIONS", "no")
    assert _selections_enabled(False) is False


def test_unwired_type_translates_to_no_op():
    # plane/wise/notion have no consuming adapter field yet — a remote selection must not inject
    # keys the adapter would reject (translates to no-op, leaving the local options untouched).
    local = Connection(name="nt", source="notion", options={"token": "LOCAL"})
    remote = [
        {"type": "notion", "name": "nt", "config": {"database_id": "D1"}, "status": "enabled"}
    ]
    merged = merge_selections([local], remote)
    assert merged[0].options == {"token": "LOCAL"}  # unchanged — nothing injected
