# aios-ingest — ingestion sidecar (Organ 2)

Pulls content from external systems (Notion, Google Drive, Confluence, RSS feeds, web
pages, local files) using direct provider APIs where completeness matters (Google Drive/Docs) and
**open-source readers** elsewhere ([LlamaHub](https://llamahub.ai), MIT; [Unstructured](https://github.com/Unstructured-IO/unstructured), Apache-2.0),
normalizes each document into the brain's `ItemPayload`, and **POSTs to `/api/v1/items`** —
reusing the brain's audited, dedup-by-sha256, tier-enforcing write path. No new write path;
the sidecar talks to the brain over HTTP only, so it can be split into its own repo later.

> **Not here:** Slack, GitHub, Linear and Plane are ingested by the brain's own in-app runners
> and are configured in **Admin → Integrations**, not in this sidecar. The sidecar's `slack`
> source is a registered no-op kept only so a legacy `connections.yaml` degrades to a warning
> (same for `granola`, whose connector was removed). There is no sidecar GitHub source at all.

```
fetch (reader)  ─►  normalize (RawDoc → ItemPayload)  ─►  BrainClient.push  ─►  POST /api/v1/items
   ▲ webhook / poll / backfill                                                    (brain: dedup, version, audit, tier)
```

## Install

```bash
cd ingestion
uv sync                       # core only
uv pip install '.[gdrive]'    # + direct Drive/Docs API clients and legacy reader compatibility
uv pip install '.[docs]'      # + a source extra (see pyproject's optional-dependencies)
uv pip install '.[all]'       # everything (heavy: pulls Unstructured)
```

Readers are **opt-in extras** so the core installs light; an adapter raises a clear
"install the X extra" error if its reader is missing.

## Configure

```bash
cp .env.example .env          # BRAIN_URL, AIOS_API_KEY (issued to a connector member), AIOS_TEAM
cp connections.yaml.example connections.yaml
```

Create a dedicated **connector member** (e.g. `actor_handle: notion-sync`, tier `team`) in the
brain admin UI and issue it an API key — that key goes in `AIOS_API_KEY`.

## Use

```bash
aios-ingest list-sources
# Backfill one source (e.g. a Notion database) — every option the adapter needs is a --opt:
aios-ingest backfill --source notion --opt token=$NOTION_TOKEN --opt database_id=<id>
# Run all configured connections:
aios-ingest sync --config connections.yaml

# Webhook receiver — a validated Drive notification marks its stream dirty (one mark per stream,
# however many arrive); payload bodies are never trusted as document content. Other registered
# sources remain pull-only.
uvicorn aios_ingest.webhook_app:app --port 8088

# Scheduled polling:
aios-ingest schedule --config connections.yaml --poll-interval 300
```

`schedule` polls each connection on an interval (sha256 dedup makes re-polls cheap no-ops).
Drive baseline/change tokens, page obligations and overlapping watch channels live in a local SQLite
file (`--state-db`). Tokens remain opaque and are namespaced by team, immutable integration,
credential, selected drive and the brain-issued monotonic generation. SQLite is resumable work state,
not write authority: the brain owns the active generation/lease fence and rejects stale content,
reconciliation and progress commits. Pause/resume is a control-state transition: it advances the
fence and invalidates the lease while retaining generation, cursor, traversal and pending work.
Selection, account or credential changes advance the content generation and start a new namespace.

> Drive push delivery is an accelerator, not the cursor authority. The scheduler always polls for
> recovery. The production `schedule` command wires watch creation/renewal for Drive connections
> that set `webhook_url`; operators must expose the webhook receiver at that HTTPS callback. Each
> channel receives a random verification token whose hash is persisted. Old and replacement channels
> overlap until expiry so renewal cannot create a notification gap.

## Google Drive / Docs setup

Admin → Integrations distinguishes the `gdrive` content connector from the `google` Gemini key.
OAuth offers two explicit modes: individual-file authorization uses `drive.file`; folder and Shared
Drive discovery uses broader `drive.readonly`. Broader consent permits discovery but does not widen
the saved file/folder/drive selection. The authenticated account and granted scope set are recorded;
refresh credentials are encrypted through the integration-secret path and never returned by the
non-secret integrations API.
For individual files, Admin uses Google Picker/GIS. The browser obtains Picker's short-lived token
directly from Google; the brain never returns one. The callback sends only selected IDs, and the
server's encrypted credential must independently read and verify every Google Doc before an atomic
selection save. Pasted IDs use the same accessibility proof. Configure `GOOGLE_DRIVE_PICKER_API_KEY`
and `GOOGLE_DRIVE_APP_ID` (the Cloud project number) beside `GOOGLE_DRIVE_CLIENT_ID`; otherwise the
UI keeps the reconnect path and reports Picker as unavailable.

The HTTP-only sidecar acquires a fenced execution for the immutable integration ID, then asks the
dedicated token broker for a short-lived Google access token. The brain performs refresh from the
encrypted secret and returns only the access token, expiry, granted scopes and stable account
identity. Refresh tokens and client secrets never cross this boundary; access tokens are memory-only
and never enter SQLite, selection JSON, logs or diagnostics. `GET /api/v1/integrations` remains
strictly non-secret. In Admin → Integrations, use **Provision connector key** once (and **Rotate** on
replacement) and place the one-time value in the sidecar's `AIOS_API_KEY`. This audited Admin action
is the only binding path for the immutable integration/team and dedicated team-tier
`actor_handle: gdrive-sync` principal. Acquire never self-binds; ordinary, external, unbound,
cross-team, revoked, and replaced keys are deliberately rejected. Rotation fences active workers
without erasing their durable cursor/progress.

Every run rebuilds its effective Drive connection from the acquired server config: selection,
project, access and `authMode` are authoritative, so removed projects and explicit empty selections
cannot inherit old local folder aliases. OAuth is always broker-backed even when a legacy local
service-account key remains on disk; explicit `service_account` mode alone may use compatible local
key material. Before every Drive/Docs request, pagination step and watch call, the sidecar rechecks
the live execution fence. Pause, revocation or replacement is run-terminal before another provider
read. Watch renewal takes its cursor and account/drive/generation namespace from acquired server
progress, never from a stale SQLite channel, and releases every successfully acquired authority in a
best-effort `finally` path.

OAuth access grants are held only by an expiry-aware in-memory provider shared by the Drive and Docs
clients. It validates the stable account and granted scopes, refreshes through the fenced broker
before expiry, and retries one provider request after an unexpected 401. Google transport-owned
401 refresh is disabled, so the transport never attempts to use a local refresh secret and the
actual provider 401 reaches this bounded broker path; authority loss, broker
failure, account/scope mismatch, or a persistent 401 stops the run. Progress checkpoints have an
independent quota sized above the 100/min ingestion envelope, carry an expected server revision, and
retry bounded 429/5xx responses using `Retry-After`; identical replay is accepted without advancing
or regressing state. Release uses separate cleanup capacity. Shared Drive watch creation sends the
authoritative `driveId` with its cursor, while My Drive omits it.

For a service account, enable the Drive and Docs APIs, share each selected file/folder/Shared Drive
with the service-account email, and configure either `service_account_key_path` or `credential_json`
only in the sidecar's local secret configuration. A minimal direct-mode connection is:

```yaml
connections:
  - name: product-docs
    source: gdrive
    project: product-docs
    access: team
    options:
      api_mode: docs
      service_account_key_path: ${GOOGLE_SERVICE_ACCOUNT_FILE}
      folder_ids: ["provider-folder-id"]
      recursive: true
      selection_state: selected
```

The Admin integration with the same name supplies the immutable integration ID and authoritative
selection/generation. All Drive invocations, including legacy service-account connection entries,
now migrate through this coordinator and therefore require that Admin row plus explicit connector-key
provisioning; local service-account credentials remain local. OAuth integrations require no matching
local connection: enabling brain selections bootstraps them from the non-secret Admin row and obtains
credentials through the broker. Under `schedule`, `--use-brain-selections` (or
`AIOS_BRAIN_SELECTIONS=1`) re-reads the Admin rows on every poll interval, so an OAuth integration
created after the scheduler started is polled, and its **Run now**/**Retry** requests are consumed,
without a restart or a local entry. A name that is configured locally stays with that connection.
Create the Admin row with `authMode=service_account`; its status remains pending until the matching
sidecar performs a real provider identity call under the current execution fence. The brain then
stores only the verified non-secret service-account email. Admin never accepts the JSON key, and a
missing/incompatible local key cannot run or mark the connection verified.

An absent selection refuses to run. `empty` is an explicit complete zero-item selection; `denied`
and `partial` remain visible failures and never establish deletion. A complete authorized snapshot
or a positive Drive removal/trash/access-denial event reconciles through the brain's shared purge
owner, including retained versions, search/context derivatives and graph retirement. Pause retains
credentials, items and cursor state but stops scheduled reads. Disconnect stops credential use and
watch renewal; it is not an implicit data purge. Operators must use an explicit retention/purge
decision rather than treating disconnected material as current.

A selected file or folder that lives inside a Shared Drive is read through that drive's change
stream: at the start of a scope generation the sidecar looks up, once and durably, which drive
contains each selected root. That does not select the drive — only the root is in scope. Until every
root can be read nothing is enumerated (`selection_root_unresolved`).

A selected file or folder stays selected when it is moved to another drive. The old drive then
reports it — and everything under it — as removed, and lists it as empty; neither is treated as a
deletion. Before a removal retires anything, and before a selected folder is listed, the sidecar
reads where that root is now. Found in another drive, its documents stay in the brain, the old
stream goes on with its other roots, and the new drive's stream takes the root over on the next run
— after capturing that drive's start token, and enumerating only that root. If the root's location
cannot be read (`selection_root_unverified`) nothing is concluded: the stream stays partial and the
same change is read again next run. The connection is reported complete only once every stream has
re-verified the roots it now holds.

If a selected root lives in a Shared Drive whose change log the account cannot open (the file was
shared, the drive was not), that one stream is reported as `stream_start_unavailable` with the
provider's 403/404, and is retried every run. The other streams keep syncing; the connection is
not complete until that drive can be read.

A document that one drive reports removed may only have moved into another selected folder, so a
removal is held (`cross_stream_move_pending`) until every other stream of the connection has read
past it — including a stream the brain knows about that this sidecar's local state does not, and
the drive a moved folder is on its way to. While one of those streams cannot be read at all, the
sidecar reads the document itself: if Google says it no longer exists, is trashed, or is no longer
accessible to the connected account, it is removed from the brain right away; if it is still
readable, or the read fails any other way, it stays until that stream recovers.

A run has one absolute deadline. Brain writes and reconciliations never wait past it: a rate-limit
or outage wait that does not fit is deferred to a later run with the retry time the brain gave, and
the work stays queued. A complete snapshot of more than 10,000 documents is uploaded in pages and
may take several runs; each run continues after the pages the brain already holds, and reports a
non-zero backlog until the brain has acknowledged the last page.

The Admin **Run now** and **Retry pending work** controls enqueue a durable request; the sidecar polls
that queue and runs it through the same generation/fence coordinator as scheduled and notification
work. Requests coalesce while one is pending/running, survive a process restart, and share one durable
reporting ledger with scheduled runs. The Admin status shows last attempt/proven success, all document
counts including skipped, nullable backlog and cursor age, and reconnect/pause state. A busy worker is
deferred; zero counters never imply completion without terminal stream/snapshot/drain evidence.

## How content maps (the "unit of knowledge")

| source | brain `kind` | `path` | `access` |
|--------|--------------|--------|----------|
| Slack / meeting notes | `transcript` | `slack/<channel>/<ts>.md` | per-connection (default `team`) |
| Drive / Notion / Confluence | `deliverable` | `<source>/<external-id>.md` | per-connection |

Provenance (`source`, exact `source_id`, `source_url`, `authors`, `source_ts`) is stored in the
item's `frontmatter`. Re-reads of unchanged content are no-ops (sha256 dedup at the brain).
Google Docs additionally retain ordered tab metadata, extraction completeness, connection/scope
generation and source-supported revision contributions. Unsupported-but-readable elements are
disclosed without claiming missing content; malformed blocks/tabs, failed required subreads and limits
are incomplete, remain retryable, and cannot overwrite a prior complete item. Ownership and local
service-account identity are diagnostic provenance rather than authorship. Missing contributor
identity/time and a latest-editor-only history fallback are recorded explicitly for Admin repair.

An explicitly supplied `tabs` value must be a non-empty list, every root/child tab must be an object,
and a present `childTabs` must be a list. Null/scalar/malformed supplied tab containers produce
location-aware blocking diagnostics and never fall back to a legacy root body; an absent `childTabs`
remains valid.

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

## Testing the connectors without an account

We have no Notion / Drive / Confluence org accounts, so connectors are covered in
two tiers — neither needs a credential, and the pairing is what makes either one worth trusting:

| tier | file | proves |
|------|------|--------|
| adapter | `tests/test_reader_adapters.py` | `fetch()` end to end against stand-in readers swapped in at the `lazy_reader` seam — reader construction, branch selection (`space_key` vs `page_ids`, …), and the metadata → `RawDoc` mapping incl. **work-time**, whose absence silently drops a doc from the timeline |
| conformance | `tests/test_reader_api_conformance.py` | every kwarg those adapters pass **exists on the real installed reader class**, and the stand-ins in `tests/_reader_fakes.py` accept nothing the real class rejects |

The conformance tier needs the reader extras and CI installs them
(`.[dev,radar,notion,gdrive,confluence]`); locally without them it skips, and a guard fails the
build if CI ever loses them so the checks can't vanish into a green run. It earns its keep: it
caught `NotionPageReader.load_data` having no `database_id` (only `database_ids`, a list) — the
branch `connections.yaml.example` ships, which raised `TypeError` and, since `sync` has no
per-connection try/except, would have aborted the operator's entire run.

**What these tiers cannot prove:** that a credential authenticates, that the live Google APIs return
the expected corpus, or that push delivery and revocation work in a real Workspace. AIO-1167's live
sandbox manifest/query/revocation/restart/24-hour-soak certification remains a separate release gate;
green mocks do not close it.

## Limitations (MVP)

- **Notion webhooks** (beta) fire on page properties, not block edits → content relies on polling.
- Drive watch-channels expire and must be renewed; polling remains required even when notifications
  are enabled.
- Drive revision history exposes only provider-supported observations. The connector retains those
  exact source-time contributions and roles; it does not infer a complete editing history.
- Large backfills are throttled under the brain's 120 POST/min/key limit.

## License

This package is **Apache-2.0** (see `LICENSE` and `NOTICE` in this directory) — a deliberate
exception to the repository default of AGPL-3.0-only, because the sidecar is meant to run inside
other people's systems. See [`../LICENSING.md`](../LICENSING.md).

Because this directory is Apache-2.0, it must never import from the AGPL portions of the
repository. It doesn't today: it's a separate Python package that reaches the brain over HTTP.

See `THIRD_PARTY_LICENSES.md` for imported-dependency licenses.
