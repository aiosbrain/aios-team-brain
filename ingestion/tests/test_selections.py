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
from aios_ingest.selections import merge_selections
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


def _granola_conn() -> Connection:
    return Connection(
        name="team-granola",
        source="granola",
        options={"api_key": "grn-LOCAL", "topics": ["old"], "participants": ["a@x.com"]},
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


# --- github repos -> repo ---------------------------------------------------


def test_github_single_repo_maps_and_preserves_secrets():
    remote = [
        {"type": "github", "name": "eng-handbook", "config": {"repos": ["org/a"]}, "status": "enabled"}
    ]
    merged = merge_selections([_github_conn()], remote)
    opts = merged[0].options
    assert opts["repo"] == "org/a"
    assert opts["token"] == "ghp-LOCAL"
    assert opts["webhook_secret"] == "wh"
    # the camelCase `repos` list must NOT leak into options (build_source would crash)
    assert "repos" not in opts


def test_github_multi_repo_uses_first_and_no_repos_leak():
    remote = [
        {
            "type": "github",
            "name": "eng-handbook",
            "config": {"repos": ["org/a", "org/b"]},
            "status": "enabled",
        }
    ]
    merged = merge_selections([_github_conn()], remote)
    opts = merged[0].options
    assert opts["repo"] == "org/a"
    assert "repos" not in opts


# --- granola mapping --------------------------------------------------------


def test_granola_keywords_and_participants_map():
    remote = [
        {
            "type": "granola",
            "name": "team-granola",
            "config": {"matchKeywords": ["aios", "brain"], "participantEmails": ["x@y.com"]},
            "status": "enabled",
        }
    ]
    merged = merge_selections([_granola_conn()], remote)
    opts = merged[0].options
    assert opts["topics"] == ["aios", "brain"]
    assert opts["participants"] == ["x@y.com"]
    assert opts["api_key"] == "grn-LOCAL"  # secret preserved


# --- build_source compatibility: merged options are adapter-valid -----------


def test_merged_slack_options_construct_without_typeerror():
    remote = [
        {"type": "slack", "name": "eng-slack", "config": {"channelIds": ["C1"]}, "status": "enabled"}
    ]
    conn = merge_selections([_slack_conn()], remote)[0]
    src = build_source(conn.source, conn.options)  # must not raise TypeError
    assert src is not None


def test_merged_github_options_construct_without_typeerror():
    remote = [
        {"type": "github", "name": "eng-handbook", "config": {"repos": ["org/a"]}, "status": "enabled"}
    ]
    conn = merge_selections([_github_conn()], remote)[0]
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


# --- unmatched local preserved ----------------------------------------------


def test_unmatched_local_connection_returned_unchanged():
    local = _slack_conn()
    before = copy.deepcopy(local.options)
    merged = merge_selections([local], [])
    assert merged[0].options == before


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
    # linear/plane/wise/notion have no consuming adapter field yet — must not inject
    # keys the adapter would reject.
    local = Connection(name="lin", source="linear", options={"api_key": "lin-LOCAL"})
    remote = [
        {"type": "linear", "name": "lin", "config": {"teamId": "T1", "projectId": "P1"}, "status": "enabled"}
    ]
    merged = merge_selections([local], remote)
    assert merged[0].options == {"api_key": "lin-LOCAL"}
    # constructs cleanly (only api_key passed)
    assert build_source("linear", merged[0].options) is not None
