"""aios-ingest command line.

Examples:
  aios-ingest list-sources
  aios-ingest backfill --source github --opt repo=run-llama/llama_index --opt 'path_glob=*.md'
  aios-ingest sync --config connections.yaml
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

import click

from .brain_client import BrainClient, BrainError
from .config import BrainSettings, Connection, load_connections
from .engine import run_connection
from .selections import merge_selections
from .sources import available_sources

_TRUTHY = {"1", "true", "yes"}


def _selections_enabled(flag: bool) -> bool:
    """Effective opt-in: the CLI flag OR a truthy ``AIOS_BRAIN_SELECTIONS`` env var.
    Default (flag False, env unset) is False so behavior is unchanged."""
    if flag:
        return True
    return os.environ.get("AIOS_BRAIN_SELECTIONS", "").strip().lower() in _TRUTHY


async def _apply_brain_selections(
    settings: BrainSettings, conns: list[Connection]
) -> list[Connection]:
    """Fetch the brain's enabled selections and overlay them onto local connections.
    Resilient: on any brain error, log and fall back to the local connections so a
    selection-fetch failure never crashes a sync."""
    try:
        async with BrainClient(settings.base_url, settings.api_key, settings.team) as client:
            remote = await client.fetch_integration_selections()
    except BrainError as e:
        click.echo(f"warning: brain selection fetch failed ({e}); using local connections")
        return conns
    return merge_selections(conns, remote)


def _parse_opts(pairs: tuple[str, ...]) -> dict[str, Any]:
    """Turn `--opt key=value` pairs into a kwargs dict. Comma-splits list-like keys
    (channel_ids, page_ids, file_ids) and JSON-parses values that look like JSON."""
    out: dict[str, Any] = {}
    list_keys = {"channel_ids", "page_ids", "file_ids"}
    for pair in pairs:
        if "=" not in pair:
            raise click.BadParameter(f"--opt must be key=value, got '{pair}'")
        key, val = pair.split("=", 1)
        if key in list_keys:
            out[key] = [v.strip() for v in val.split(",") if v.strip()]
        else:
            out[key] = val
    return out


@click.group()
def main() -> None:
    """AIOS ingestion sidecar."""


@main.command("list-sources")
def list_sources_cmd() -> None:
    """List available source types."""
    for s in available_sources():
        click.echo(s)


@main.command()
@click.option("--source", required=True, help="source type (see list-sources)")
@click.option("--opt", "opts", multiple=True, help="source option key=value (repeatable)")
@click.option("--project", default=None, help="brain project slug (default: source name)")
@click.option("--access", default="team", type=click.Choice(["team", "external"]))
@click.option("--actor", default=None, help="provenance handle (default: <source>-sync)")
@click.option("--since", default=None, help="ISO cursor; only fetch changed since")
def backfill(source, opts, project, access, actor, since) -> None:
    """Fetch from one source and push into the brain."""
    settings = BrainSettings.from_env()
    conn = Connection(
        name=f"{source}-cli",
        source=source,
        options=_parse_opts(opts),
        project=project,
        access=access,
        actor=actor,
    )
    summary = asyncio.run(run_connection(settings, conn, since=since))
    click.echo(str(summary))


@main.command()
@click.option("--config", "config_path", required=True, help="connections.yaml path")
@click.option("--only", default=None, help="run only the named connection")
@click.option(
    "--use-brain-selections/--no-use-brain-selections",
    "use_brain_selections",
    default=False,
    help="overlay the brain's Admin → Integrations selections onto local connections "
    "by (source, name); secrets stay local. Also enabled by AIOS_BRAIN_SELECTIONS=1.",
)
def sync(config_path, only, use_brain_selections) -> None:
    """Run all configured connections (or one with --only)."""
    settings = BrainSettings.from_env()
    conns = load_connections(config_path)

    async def run_all() -> None:
        nonlocal conns
        if _selections_enabled(use_brain_selections):
            conns = await _apply_brain_selections(settings, conns)
        # Apply --only AFTER the merge so brain selections are honored first.
        run_conns = conns
        if only:
            run_conns = [c for c in conns if c.name == only]
            if not run_conns:
                raise click.ClickException(f"no connection named '{only}'")
        for conn in run_conns:
            summary = await run_connection(settings, conn)
            click.echo(str(summary))

    asyncio.run(run_all())


@main.command()
@click.option("--path", "repo_path", default=".", help="local git checkout to analyze")
@click.option("--slug", required=True, help="codebase slug (unique per team), e.g. aios-team-brain")
@click.option("--full-name", default="", help="owner/repo (enables GitHub metadata + issues)")
@click.option("--window", "window_days", default=90, type=int, help="analysis window in days")
@click.option("--backfill", default=0, type=int, help="also emit N weekly historical points (fills the trend)")
@click.option("--readiness-rubric", "rubric_path", default=None,
              help="path to an AEM agent-readiness rubric JSON (default: the vendored copy)")
def scan(repo_path, slug, full_name, window_days, backfill, rubric_path) -> None:
    """Analyze a local repo's git history + scaffolding and push metrics to the brain.
    GitHub enrichment (issues/PRs/metadata) uses the GITHUB_TOKEN env var if set
    (never pass tokens as flags). The brain computes the agentic/health scores; AEM
    agent-readiness is scored scanner-side against the rubric.

      GITHUB_TOKEN=… aios-ingest scan --path ../x --slug x --full-name org/x --backfill 12
    """
    from .analyzers import analyze_repo, analyze_history

    settings = BrainSettings.from_env()
    token = os.environ.get("GITHUB_TOKEN")  # read from env only; never logged
    payload = analyze_repo(
        repo_path, slug=slug, full_name=full_name, window_days=window_days,
        github_token=token, rubric_path=rubric_path,
    )
    history = (
        analyze_history(repo_path, slug=slug, full_name=full_name, window_days=window_days,
                        weeks=backfill, github_token=token)
        if backfill > 0
        else []
    )

    async def run() -> None:
        async with BrainClient(settings.base_url, settings.api_key, settings.team) as client:
            result = await client.push_codebase_scan(payload)
            click.echo(json.dumps(result))
            for hp in history:
                await client.push_codebase_scan(hp)

    m = payload["metrics"]
    readiness = (
        f"{m['readiness_level']} ({m['readiness_pct']}%)"
        if m.get("readiness_level") else "unscored"
    )
    click.echo(
        f"scanned {slug}: {m['commits_window']} commits ({m['ai_commits_window']} AI-assisted), "
        f"{len(payload['contributions'])} author-days, coverage="
        f"{m['test_coverage_pct'] if m['test_coverage_pct'] is not None else 'none'}, "
        f"readiness={readiness}"
        + (f"; +{len(history)} historical trend points" if history else "")
    )
    asyncio.run(run())


@main.command()
@click.option("--config", "config_path", required=True, help="connections.yaml path")
@click.option("--poll-interval", default=300, type=int, help="seconds between polls")
@click.option("--renewal-interval", default=1800, type=int, help="seconds between watch-channel sweeps")
@click.option("--state-db", default="aios_ingest_state.sqlite", help="sqlite path for cursors/channels")
def schedule(config_path, poll_interval, renewal_interval, state_db) -> None:
    """Run the background scheduler: poll connections + renew Drive watch channels."""
    from .scheduler import run as run_scheduler
    from .state import StateStore

    settings = BrainSettings.from_env()
    conns = load_connections(config_path)
    state = StateStore(state_db)
    click.echo(f"scheduling {len(conns)} connection(s), poll every {poll_interval}s — Ctrl-C to stop")
    run_scheduler(settings, conns, state=state, poll_interval=poll_interval, renewal_interval=renewal_interval)


if __name__ == "__main__":
    main()
