# aios-ingest — ingestion sidecar (Organ 2)

Pulls content from external systems (GitHub, Slack, Notion, Google Drive, Confluence,
Linear, web pages, local files, …)
using **open-source readers** ([LlamaHub](https://llamahub.ai), MIT; [Unstructured](https://github.com/Unstructured-IO/unstructured), Apache-2.0),
normalizes each document into the brain's `ItemPayload`, and **POSTs to `/api/v1/items`** —
reusing the brain's audited, dedup-by-sha256, tier-enforcing write path. No new write path;
the sidecar talks to the brain over HTTP only, so it can be split into its own repo later.

```
fetch (reader)  ─►  normalize (RawDoc → ItemPayload)  ─►  BrainClient.push  ─►  POST /api/v1/items
   ▲ webhook / poll / backfill                                                    (brain: dedup, version, audit, tier)
```

## Install

```bash
cd ingestion
uv sync                       # core only
uv pip install '.[github]'    # + a source extra (github needs no extra to run on public repos)
uv pip install '.[all]'       # everything (heavy: pulls Unstructured)
```

Readers are **opt-in extras** so the core installs light; an adapter raises a clear
"install the X extra" error if its reader is missing.

## Configure

```bash
cp .env.example .env          # BRAIN_URL, AIOS_API_KEY (issued to a connector member), AIOS_TEAM
cp connections.yaml.example connections.yaml
```

Create a dedicated **connector member** (e.g. `actor_handle: github-sync`, tier `team`) in the
brain admin UI and issue it an API key — that key goes in `AIOS_API_KEY`.

## Use

```bash
aios-ingest list-sources
# Backfill a public GitHub repo (no token needed):
aios-ingest backfill --source github --opt repo=run-llama/llama_index --opt 'path_glob=*.md'
# Run all configured connections:
aios-ingest sync --config connections.yaml

# Webhooks (Slack/GitHub/Notion-beta):
uvicorn aios_ingest.webhook_app:app --port 8088

# Scheduled polling + Drive watch-channel renewal:
aios-ingest schedule --config connections.yaml --poll-interval 300
```

`schedule` polls each connection on an interval (sha256 dedup makes re-polls cheap no-ops)
and, when a Drive `WatchManager` is wired, renews push-notification channels before they
expire. Cursors and channel state live in a local sqlite file (`--state-db`).

## How content maps (the "unit of knowledge")

| source | brain `kind` | `path` | `access` |
|--------|--------------|--------|----------|
| Slack / meeting notes | `transcript` | `slack/<channel>/<ts>.md` | per-connection (default `team`) |
| Drive / Notion / Confluence / GitHub | `deliverable` | `<source>/<external-id>.md` | per-connection |
| Granola (meeting **marker**) | `artifact` | `granola/<note-id>.md` | `team` — **no transcript**; see [docs/GRANOLA.md](../docs/GRANOLA.md) |

Provenance (`source`, `source_id`, `source_url`, `author`, `source_ts`) is stored in the
item's `frontmatter`. Re-reads of unchanged content are no-ops (sha256 dedup at the brain).

## Codebase scan & agent-readiness

`aios-ingest scan` analyzes a local git checkout and pushes metrics to the brain
(`POST /api/v1/codebases`). The brain derives `agentic_score`/`health_score`; **AEM
agent-readiness is scored scanner-side** (`aios_ingest/analyzers/readiness.py`) against a
vendored copy of the canonical rubric at `aios_ingest/rubric/agent-readiness.json`. It's
vendored so the deployed sidecar is self-contained; every scan records
`readiness_rubric_version` so a stale copy is observable.

- Refresh the vendored rubric from the canonical sibling repo:
  `scripts/refresh-rubric.sh` (copies from `../agentic-engineering-maturity/rubric/…`).
- Score against a different rubric ad hoc: `aios-ingest scan … --readiness-rubric PATH`.
- Readiness is scored on the live scan only; `--backfill` historical points carry null readiness.

## Limitations (MVP)

- **No deletes** — the brain has no DELETE endpoint yet; removing a source doc won't remove the item.
- **Notion webhooks** (beta) fire on page properties, not block edits → content relies on polling.
- **Drive watch-channels** expire and must be renewed by the scheduler.
- Large backfills are throttled under the brain's 120 POST/min/key limit.

See `THIRD_PARTY_LICENSES.md` for imported-dependency licenses. This package is MIT.
