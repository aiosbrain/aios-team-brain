# AIOS Team Brain

**The collective organ of [AIOS](https://aiosbrain.dev) — the operating system for teams of humans and agents.**

Every person on a team runs their own [AIOS Workspace](https://github.com/aiosbrain/aios-workspace):
a structured, governed, versioned workspace that lives in their terminal, for them and everything
they run. Team Brain is the other half — **a shared context layer for humans and agents.** Work flows
up into it from every workspace and every connected tool; that ground truth flows back down to every
person and every agent.

It turns the scattered exhaust of a working team — commits, tickets, docs, Slack threads, meeting
transcripts, decisions — into one context layer you can query like a colleague, and a dashboard that
shows who did what, what it was in service of, and what the team has learned.

**MIT licensed. Self-hosted. Private by default.** Postgres is the only required backend. Nothing
leaves your instance unless you push it, and it runs fully on-machine at $0 if you want it to.

---

## Contents

1. [What you need before you start](#1-what-you-need-before-you-start)
2. [Setup, in dependency order](#2-setup-in-dependency-order)
3. [Environment variable reference](#3-environment-variable-reference)
4. [What happens once it's running](#4-what-happens-once-its-running)
5. [Troubleshooting](#5-troubleshooting)
6. [Architecture and contributing](#6-architecture-and-contributing)

---

## 1. What you need before you start

### 1.1 Local tooling

| Tool | Version | Why |
|---|---|---|
| **Node** | **≥ 20** (`package.json` engines; CI pins 20) | the app |
| **npm** | bundled with Node | there is no pnpm/yarn lockfile — `package-lock.json` only |
| **Postgres** | **16** | the only required backend |
| **Docker** | any recent | only for the throwaway test database, or to run Postgres locally |
| **psql** | matching your server | used by `scripts/e2e.sh`; handy for diagnostics |
| **Python** | **≥ 3.11** (CI uses 3.12), with [`uv`](https://docs.astral.sh/uv/) | **optional** — only for the `ingestion/` sidecar (Notion, Google Drive, Confluence, Granola, RSS, local files) |

There is no `.nvmrc` or `.node-version` in the repo.

### 1.2 Services

| Service | Required? | Notes |
|---|---|---|
| **Postgres 16** | **Required** | Local Docker, Railway, or any managed provider. Self-host portable — plain SQL schema, no vendor lock-in. |
| **Railway** | Optional | Our production target. Nothing depends on it; there are no Vercel- or Railway-only APIs. |
| **Neo4j 5.26.2** + **Graphiti** | Optional | Powers narrative arcs, the "what the brain is learning" panel, and graph-grounded answers. Everything else works without it. Self-hosted via `graphiti/docker-compose.yml`. **Neo4j Aura is untested** — no code path references `neo4j+s://`, so treat cloud Aura as unverified. |
| **Email (Resend or SMTP)** | Recommended | Magic links and invites. Without it, in non-production the login link is printed to the server console; **in production, login mail silently goes nowhere.** |

There is no Supabase dependency. It was removed — if you see Supabase env vars anywhere in your
notes or in a stale `.env.local`, they are read by nothing.

### 1.3 API keys, and what each costs

Get **one** text-generation option working. Everything else is optional.

| Key | Needed for | Where to get it | Cost |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Default answering model | [console.anthropic.com](https://console.anthropic.com) | 💲 **Paid** |
| *or* `LLM_BASE_URL` | Any OpenAI-compatible endpoint (Ollama, llama.cpp, LM Studio, vLLM) instead | your own machine | **Free** |
| *or* an **OpenRouter** key | Set per-team in Admin → Integrations | [openrouter.ai](https://openrouter.ai) | 💲 **Paid** |
| `OPENAI_API_KEY` | Embeddings (if hosted), OpenAI answering, social image generation | [platform.openai.com](https://platform.openai.com) | 💲 **Paid** |
| `RESEND_API_KEY` | Magic-link/invite email | [resend.com](https://resend.com) | 💲 Paid (free tier exists) |
| **Graphiti's own** `OPENAI_API_KEY` | Entity/edge extraction inside the graph service — **separate from the app's key** | as above | 💲 **Paid** |
| `E2B_API_KEY` | Sandboxed action runner | [e2b.dev](https://e2b.dev) | 💲 **Paid** — and `@e2b/code-interpreter` is **not** in `package.json`, so this is opt-in and unshipped |

**Two secrets you generate yourself, not obtain:**

| Secret | Needed for | Generate with |
|---|---|---|
| `AUTH_SECRET` | Signing session cookies. **Hard requirement, ≥ 16 chars** | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `SECRETS_KEY` | AES-256-GCM encryption of connector tokens at rest. **Must decode to exactly 32 bytes.** Required the moment you save any connector in Admin → Integrations | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |

> ⚠️ `SECRETS_KEY` is **absent from `.env.example`** and throws only when you first save a connector
> secret. If saving a Slack token 500s, this is why.

### 1.4 Connector credentials

All connector APIs are free. Cost shows up downstream in embeddings and LLM spend.

| Connector | Credential | Where | Configured in |
|---|---|---|---|
| **Slack** | Bot token `xoxb-` | Slack app → OAuth & Permissions | Admin UI (env `SLACK_BOT_TOKEN` as fallback) |
| **GitHub** | PAT — **optional**; public repos work token-free | github.com → Settings → Developer settings | Admin UI |
| **Linear** | API key | Linear → Settings → API → Personal API keys | Admin UI **only** |
| **Plane** | API token | Plane → Workspace settings → API tokens | Admin UI **only** |
| **Granola** | `grn_…` API key | Granola | **Sidecar** `.env` (`GRANOLA_API_KEY`) |
| **Notion** | Internal integration token | notion.so/my-integrations | **Sidecar** `.env` (`NOTION_TOKEN`) |
| **Confluence** | API token | Atlassian account | **Sidecar** `.env` (`CONFLUENCE_API_TOKEN`) |
| **Google Drive** | Service-account JSON key | Google Cloud Console | **Sidecar** `connections.yaml` (path option) |
| **RSS/Radar**, **Web**, **Local files** | none | — | **Sidecar** `connections.yaml` |

Slack scopes the code actually needs: **`channels:history`**, **`channels:read`**, **`users:read`**,
and optionally **`users:read.email`** (enables automatic identity mapping; without it you map members
by hand). A missing `channels:read` is diagnosed by name in the ingest error.

> **Slack ingests public channels only, and fails closed.** A channel it cannot *prove* is public is
> skipped — private content never enters the process. There are exactly two tiers (`team` /
> `external`) and no stricter one, so anything from a private channel would become readable by the
> whole team, which isn't what "private" means to the people in it.

> **Notion and Granola tokens pasted into the Admin UI are write-only.** The UI will encrypt and
> store them, but only the Slack/GitHub/Linear/Plane runners ever read stored secrets. Configure
> those two in the sidecar's own `.env`. A `wise` option also appears in the Admin dropdown — it has
> no connector behind it and produces nothing. Ignore it.

---

## 2. Setup, in dependency order

Each step explains *why*, so you can tell when something has gone wrong rather than pattern-matching
on green output.

### Step 0 — Clone and install

```bash
git clone https://github.com/aiosbrain/aios-team-brain.git
cd aios-team-brain
npm install
```

`npm install` also runs `prepare`, which points git at `.githooks/` — that's what gives you the
pre-push docs-drift check.

### Step 1 — Configure the environment

```bash
cp .env.example .env.local
```

Fill in, at minimum:

```bash
DATABASE_URL=postgres://user:pass@host:5432/dbname
AUTH_SECRET=<64 hex chars from the command in §1.3>
APP_URL=http://localhost:3000
ANTHROPIC_API_KEY=sk-ant-...        # or LLM_BASE_URL for a local model
SECRETS_KEY=<32 bytes base64>       # not in .env.example — add it
```

> ⚠️ **`.env.local` is only auto-loaded by `next dev`.** This repo has **no `dotenv` dependency**, so
> `npm run pg:schema`, `npm run admin`, and `npm run embed:backfill` read the *shell* environment and
> will fail with `DATABASE_URL is required` if you only put it in the file. Export it for your
> session:
>
> ```bash
> set -a; . ./.env.local; set +a
> ```
>
> Do this once per terminal before running any of the CLI steps below.

### Step 2 — Provision the database

```bash
npm run pg:schema
```

**What this actually does** — and it is not what the command name suggests. It runs
`postgres/schema.sql` (canonical, every object `create … if not exists`), **then replays every file
in `postgres/migrations/` in filename order, on every run.** There is no `schema_migrations` ledger
and no "applied" tracking; all migrations are required to be idempotent.

Two consequences worth internalising:

- **First install and a later upgrade are the same command.** Run it again after every `git pull`
  that touched the schema.
- **Adding a column requires two edits.** `schema.sql` is `create table if not exists`, so editing
  the table body is a no-op against a database that already has the table. You need an
  `alter table … add column if not exists` file in `postgres/migrations/` *and* the mirrored change
  in `schema.sql` for from-zero installs. See `postgres/migrations/README.md`.

The loader sets a `lock_timeout` (default 15s) before any DDL so a stuck reader fails the release
fast instead of queueing every query behind it, and it refuses to run against a non-AIOS Railway
service.

**pgvector is deliberately not installed by default**, so a stock install needs no extensions. See
Step 5 if you want semantic search.

### Step 3 — Create your team and your first admin

```bash
npm run admin -- create-team acme --name "Acme Robotics"
npm run admin -- create-member you@acme.com --name "Your Name" --handle you --role admin --team acme
```

> **`create-member` prints a generated password once and never again.** Copy it. This is the primary
> way to log in; the docs elsewhere imply magic links are, but the password is what you get by
> default. Pass `--password` to choose your own.

Other ways in:

```bash
npm run admin -- login-link you@acme.com --team acme    # one-time magic link
```

And for a machine (the `aios` CLI, CI, the sidecar):

```bash
npm run admin -- issue-key you@acme.com --name "laptop" --team acme
# → aios_<key_id>_<secret>   shown once, sha256 at rest
```

`npm run admin -- help` lists the rest (`list-members`, `list-keys`, `revoke-key`,
`link-github`, `link-identity`, …).

### Step 4 — First run

```bash
npm run dev
```

Open `http://localhost:3000`. In development only, `http://localhost:3000/auth/dev-login?email=you@acme.com`
signs you straight in — the route 404s when `NODE_ENV=production`.

**Optional: load the demo dataset** instead of starting empty. It seeds a fictional team
("Northwind Robotics"), four members, fixtures pushed through the *real* ingest path, and a company
graph:

```bash
npm run dev:seed     # sources .env.local for you
```

It prints an API key once and also writes it to `.aios-demo-key` (gitignored). It asserts that ≥ 8
tasks and ≥ 20 decisions materialised, so it doubles as a regression test of the write path.

### Step 5 — Semantic search (optional)

Skip this and retrieval still works — it just uses ranked keyword full-text search plus structured
context. Nothing errors, nothing warns; you simply get lower recall on paraphrased questions.

```bash
npm run pg:schema:vector    # loads postgres/optional/pgvector.sql — needs the `vector` extension
```

Then set an embeddings backend, either per-team in **Admin → Integrations → Embeddings model**
(OpenAI or OpenRouter), or by env:

```bash
EMBEDDINGS_URL=https://api.openai.com/v1
EMBEDDINGS_MODEL=text-embedding-3-small
EMBEDDINGS_API_KEY=sk-...
```

> **The vector column is hardcoded `vector(1536)`.** To use a different-dimension model you must edit
> `postgres/optional/pgvector.sql` *before* first loading it and set `EMBEDDINGS_DIM` to match. A
> model returning the wrong width throws loudly at index time and is counted and surfaced on the
> retrieval-health card — but at *query* time the same error degrades **silently** to zero dense hits.

Backfill existing content: `npm run embed:backfill`.

### Step 6 — Graph memory: Neo4j + Graphiti (optional)

This is the most involved part of the setup and the easiest to get subtly wrong. Skip it entirely if
you don't need narrative arcs or the learning panel — the app is fully functional without it.

**Topology.** Three processes. The Next.js app talks to Graphiti over REST (writing episodes,
searching facts) *and* to Neo4j directly over bolt, read-only, for the learning panel — the Graphiti
REST API can't answer "recent typed facts by time". Graphiti talks to Neo4j and to an
OpenAI-compatible LLM for extraction.

```
app ──REST──> graphiti ──bolt──> neo4j
 └───────────────bolt (read-only)──┘
```

**6a. Configure the graph stack.**

```bash
cd graphiti
cp .env.example .env
```

```bash
OPENAI_API_KEY=sk-...          # Graphiti's OWN key, for extraction
MODEL_NAME=gpt-4o
NEO4J_USER=neo4j
NEO4J_PASSWORD=<choose one>
```

> ⚠️ **Never set an optional variable to an empty string.** The image treats `OPENAI_BASE_URL=""` as
> *set*, which breaks every LLM call and hangs the ingest queue with no error. Leave optional vars
> commented out. This is exactly why the compose file uses `env_file:` rather than `${VAR:-}`
> interpolation.

**6b. Build the patched image — do not use the upstream one.**

`graphiti/Dockerfile` builds from a **digest-pinned** `zepai/graphiti` and patches one constant:

```dockerfile
RUN CONFIG=/app/.venv/.../graphiti_core/llm_client/config.py \
 && grep -q 'DEFAULT_MAX_TOKENS = 8192' "$CONFIG" \
 && sed -i 's/DEFAULT_MAX_TOKENS = 8192/DEFAULT_MAX_TOKENS = 16384/' "$CONFIG"
```

**Why this matters.** Graphiti extracts entities and edges with its own LLM, and that call's *output*
is hard-capped at `DEFAULT_MAX_TOKENS`, which is 8192 in every published image. A dense episode whose
extraction overflows raises inside the worker — and getzep's worker loop catches only
`CancelledError`, so **any other exception kills the worker for the whole process.** The HTTP API
keeps returning `202`. Episodes are accepted, nothing is extracted, and narrative arcs quietly go
blank. That failure hit production three times. There is no env var to raise the cap; 16384 exists
only on unreleased upstream `main`.

The `grep -q` before the `sed` is a build gate: if a future base image renames the constant the build
**fails loudly** rather than silently shipping an unpatched image.

The digest pin is also deliberate — it guarantees the Neo4j schema our Cypher depends on and the REST
API our projector uses are byte-identical to what's been running; only the token ceiling moves.

```bash
docker compose up -d          # from graphiti/ — brings up graph + neo4j
```

**6c. Point the app at it.** These go in the *brain's* `.env.local`, not `graphiti/.env`, and **none
of them are in `.env.example`**:

```bash
GRAPHITI_URL=http://localhost:8000
NEO4J_URL=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=<same as above>
```

`GRAPHITI_URL` is the master switch: unset, the projector never starts and every graph read is inert.

**6d. Understand the extraction limits.** Items are **chunked**, not truncated:

| Constant | Default | Env override |
|---|---|---|
| `CHUNK_CHARS` | **2500** chars per episode | `GRAPH_CHUNK_CHARS` |
| `MAX_EPISODE_CHUNKS` | **16** episodes per item | `GRAPH_MAX_EPISODE_CHUNKS` |

So 40,000 characters per item maximum; beyond that content is dropped as a runaway backstop (the full
text still lives in `items`, FTS, and pgvector — only the graph projection is bounded). Chunking keeps
each extraction well under the patched 16384-token ceiling.

> If you have seen `MAX_EPISODE_CHARS` (4000, or 6000, or 2000) referenced anywhere — in older notes
> or docs — **it no longer exists.** It was deleted and replaced by chunking. Don't set it.

**6e. Know the `group_id` rule.** Tier isolation in the graph is the `group_id` and nothing else —
there is no RLS backstop. The format is `<teamSlug>_<tier>`, and the separator is an underscore
because Graphiti's validator permits only `[A-Za-z0-9_-]`. A `:` raises an error that propagates out
of the ingest worker and **silently kills it for the whole process**. The code validates before
posting and throws rather than sending a bad id.

> `postgres/schema.sql` still documents this column as `'<teamSlug>:<tier>'`. That comment is wrong —
> the colon form is precisely the one Graphiti rejects.

### Step 7 — Verify it worked

```bash
bash scripts/e2e.sh
```

Reset → seed → start the dev server → scaffold a real spoke repo and `aios push` from it → assert a
re-push says "nothing to push" → check tasks materialised → assert an `admin`-tier push is rejected
**422** → pull → optionally run the Python sidecar backfill → optionally run a live NL query that
must ground in a specific seeded decision. Prints `E2E PASSED`.

It needs Docker, a populated `.env.local`, nothing on port 3000, `psql`, and a checkout of
`aios-workspace` at `$OPS_DIR` (default `~/Projects/aios-workspace`). It forces
`DATABASE_URL` to the throwaway test container twice, deliberately, so it can never touch a real
database.

Lighter checks:

```bash
npm test            # unit tier — pure logic, parse boundaries, all drift/contract guards
npm run typecheck
npm run lint
npm run check:docs  # architecture-map drift guard (also runs pre-push)
```

### Step 8 — Deploy (Railway)

The only deploy path is **merging to `main`** — Railway's GitHub integration builds automatically.
`railway.json` is three lines whose entire content is:

```json
{ "deploy": { "preDeployCommand": "npm run pg:schema" } }
```

So **every deploy applies the schema and all migrations before the new version goes live**, and a
schema failure aborts the release rather than shipping app code ahead of its database. Set
`PGSSL=require` for managed Postgres.

Services you need: the app (its Railway service name must be `aios` or `aios-*` — a guard aborts the
schema load otherwise, so this repo can never inject its schema into another project's database), a
Postgres service, and optionally `graphiti` + `neo4j`.

---

## 3. Environment variable reference

### Required

| Var | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string. Throws at first query without it. |
| `AUTH_SECRET` | Signs session cookies. **≥ 16 chars enforced.** Without it nobody can log in. |

### Required in practice

| Var | Notes |
|---|---|
| `APP_URL` | Absolute base URL. No throw, but invite/magic links are built in server actions where there is no request origin — without it they come out broken. |
| `SECRETS_KEY` | 32 bytes, base64 or hex. **Throws** the first time you save a connector secret. Not in `.env.example`. |
| One LLM path | `ANTHROPIC_API_KEY`, or `LLM_BASE_URL` (+ `LLM_MODEL`), or an OpenRouter key set per-team in Admin. |
| One email path | `RESEND_API_KEY` + `RESEND_FROM`, or `SMTP_URL` + `SMTP_FROM`. Dev logs the link to console instead; **production sends nothing**. |

### Optional subsystems

| Var | Default | Purpose |
|---|---|---|
| `GRAPHITI_URL` | unset → graph off | Master switch for graph memory |
| `NEO4J_URL` / `NEO4J_USER` / `NEO4J_PASSWORD` | unset / `neo4j` / `""` | Direct bolt reads for the learning panel |
| `GRAPH_PROJECT_ENABLED` | on | `false` disables the projector even with a URL |
| `GRAPH_PROJECT_MINUTES` | `60` | Projector interval |
| `GRAPH_CHUNK_CHARS` / `GRAPH_MAX_EPISODE_CHUNKS` | `2500` / `16` | Episode chunking |
| `EMBEDDINGS_URL` / `EMBEDDINGS_MODEL` / `EMBEDDINGS_DIM` / `EMBEDDINGS_API_KEY` | unset → dense off | Semantic search |
| `RERANK_URL` / `RERANK_MODEL` / `RERANK_TOKEN` | unset → off / `qwen3-reranker-0.6b` | Cross-encoder reranking. **Env only — no per-team setting.** |
| `LLM_BASE_URL` / `LLM_MODEL` | unset → Anthropic | Local OpenAI-compatible endpoint |
| `INGEST_POLL_ENABLED` / `INGEST_POLL_MINUTES` | on / `30` | Connector poller |
| `SLACK_BOT_TOKEN` | unset | Env fallback if no Admin-stored Slack token |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_OAUTH_REDIRECT` | unset | Per-member Slack OAuth ("act as me"), **not** ingestion |
| `GITHUB_TOKEN` | unset | Member provisioning, profile sync, codebase scans — **not** the ingest runner |
| `PGSSL` / `PGSSLMODE` | unset | Set to `require` for managed Postgres |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, … | unset | Fully inert when unset |
| `DOC_TASK_INFER_INTERVAL_HOURS` | `12` | Cooldown on the paid doc→task inference pass |

Also read but rarely needed: `PG_POOL_MAX`, `PG_STATEMENT_TIMEOUT_MS`, `PG_IDLE_TX_TIMEOUT_MS`,
`PG_CONNECT_TIMEOUT_MS`, `PG_MIGRATION_LOCK_TIMEOUT_MS`, `FTS_CANDIDATE_LIMIT`,
`SOURCE_RECENCY_LIMIT`, `DENSE_MAX_DISTANCE`, `TIMELINE_ITEM_LIMIT`, `BRAIN_DEFAULT_TIMEZONE`,
`CONTEXT_PROVIDER`, `RETRIEVAL_AUGMENT_*`, `ARC_*`, `SOCIAL_*`, `AIOS_GATEWAY_INTERNAL_ENABLED`,
`GATEWAY_REQUEST_ENVELOPE_KEY`, `AIOS_RAILWAY_SERVICES`.

### Not setup variables

`DATABASE_TEST_URL`, `PGVECTOR_TEST`, `NEO4J_TEST`, `HTTP_TEST_PORT` are for the test tiers only.
`NODE_ENV`, `NEXT_RUNTIME`, `CI`, `RAILWAY_SERVICE_NAME` are set by the platform.

### Known gaps in `.env.example`

It is incomplete and partly stale. It **omits** `SECRETS_KEY`, every `GRAPHITI_*`/`NEO4J_*`/`GRAPH_*`
var, every `EMBEDDINGS_*` var, and all the connector env fallbacks. Its `PLANE_*` block is **read by
no code in this repo** — it belongs to `aios-workspace`.

### Sidecars have their own env files

`ingestion/.env` (needs `BRAIN_URL`, `AIOS_API_KEY`, `AIOS_TEAM` — all three hard-required) and
`graphiti/.env`. Neither is read by the Next.js process.

---

## 4. What happens once it's running

**There is no cron and no worker service.** All background work runs on `setInterval` timers started
once at server boot from `instrumentation.ts`. That means the cadence below assumes **one instance** —
the single-flight guards are in-process only, so a multi-replica or scale-to-zero deploy changes the
effective behaviour.

| Poller | Starts | Interval | Gate |
|---|---|---|---|
| Ingest | +20s after boot | **30 min** | on unless `INGEST_POLL_ENABLED=false` |
| Graph projector | +30s | **60 min** | inert unless `GRAPHITI_URL` set |
| Social jobs | +15s | 30 s | opt-in, `SOCIAL_JOBS_ENABLED=true` |

**Each ingest tick, strictly in this order:** Slack → Plane → Linear → Linear inbound (sequenced
*after* Linear so it sees fresh mirror tasks) → GitHub → auth cleanup (24 h cooldown) → meeting-notes
backfill → deterministic task↔evidence linking → **LLM doc→task inference** (12 h cooldown) → dense
embedding index (100 items per run).

**Everything else is triggered by a page view, not a timer** — deliberately, so LLM calls only happen
for teams someone is actually looking at:

- **Work timeline** — 5 min TTL, serve-stale-while-revalidate. A cold miss builds the ledger inline
  and fast, with **no per-person-day summaries**; those arrive on a later view once the background
  pass writes them.
- **Narrative arcs** — **4 h** TTL, 7-day fact window. A fact-hash check skips the model entirely when
  nothing relevant changed. Arcs need graph facts, so on a fresh install the panel is legitimately
  empty until the projector has run.
- **PM projection** — reactive, not scheduled: a task write schedules a projection *after* the
  response. Inbound Linear→brain is opt-in per team (`inboundApply`) and runs on the 30-min tick.

### After your first `aios push`

| When | What lands |
|---|---|
| **Immediately** | The item is stored and keyword-searchable; the response is `201`. Tasks project to Linear/Plane right after the response is sent. |
| **Next page view** | Work timeline — without per-person-day summaries on the very first build. |
| **≤ 30 min** | Connector pulls, meeting notes, deterministic task links, first embeddings batch. |
| **≤ 60 min** | Graph projection — after which arcs become possible. |
| **≤ 4 h** | First narrative arcs. |

### Where to look to confirm it's working

**Admin → Integrations** is the health surface:

- **Pipeline health banner** — the loud verdict.
- **Recent ingestion runs** — the last 30 rows of `ingest_runs`, one per scheduler tick, manual sync,
  and codebase scan, with created/updated/unchanged counts and errors. `slack`/`linear`/`github` rows
  record on *every* tick, so their age is a genuine heartbeat; `dense`, `graph_project`, `pm_sync`
  and others record only when they did something, and are never flagged on age.
- **Retrieval health card** — dense (`off`/`healthy`/`building`/`degraded`) and graph
  (`off`/`on`/`degraded`), including explicit quota wording when embeddings start failing.
- **Provider keys** — which are stored and enabled, and the *resolved effective* answering, reasoning
  and embedding backends. Nothing is ever decrypted to display.

**Admin → Usage** shows spend. Note the interactive query caps, which are hardcoded: **20 queries per
member per day** and **$10 per team per day**, plus 10 queries/minute. Background generation (arcs,
summaries, meeting extraction) is metered but **not capped**.

---

## 5. Troubleshooting

### `DATABASE_URL is required` from `pg:schema` / `admin`, but it's in `.env.local`

Expected. Those are plain Node scripts and this repo has no `dotenv` dependency; only `next dev`
auto-loads `.env.local`. Run `set -a; . ./.env.local; set +a` first.

### Saving a Slack/GitHub token 500s

`SECRETS_KEY` is missing or isn't 32 bytes. It isn't in `.env.example`. Generate with
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

### Graph accepts everything but no facts appear — arcs blank

**The signature failure of this stack, and it is silent.** Graphiti returns `202` on every episode,
`graph_project` stays green in `ingest_runs`, the health check is fine — and the graph is empty.

Causes, in the order to check them:

1. **Unpatched image.** If `DEFAULT_MAX_TOKENS` is still 8192, a dense episode overflows and kills the
   worker for the whole process. Rebuild from `graphiti/Dockerfile`, don't use `zepai/graphiti` directly.
2. **`OPENAI_BASE_URL=""`** in `graphiti/.env`. An empty string reads as *set* and breaks every LLM
   call, hanging the queue. Comment it out instead.
3. **Invalid `group_id`.** Anything outside `[A-Za-z0-9_-]` raises inside the worker and kills it.
4. **Bad timestamp or missing `role`** in a posted episode → `422` on every push, wedging the projector.

The app has a dedicated probe for this: it compares episode count in Postgres against `RELATES_TO`
count in Neo4j and flags "stalled" at ≥ 25 episodes with 0 facts, with an operator-facing reason
naming the token cap. Check the `graphiti` service logs for `Output length exceeded max tokens`.

**Recovery:** the graph is fully regenerable from Postgres — clear `graph_episodes` and let the
projector re-run.

### Graphiti won't come up after a restart or redeploy

Two known traps. The image declares a non-root `USER app` but its default CMD launches via `uv` at
`/root/.local/bin/uv`, which `app` can't execute once the platform runs the container as the declared
user — this broke a production restart. And a redeploy that rebuilds from the wrong source
reintroduces the unpatched 8192 cap. If it doesn't come healthy, roll back to the last-good deployment
in the dashboard rather than iterating on a live service.

### Semantic search returns nothing / "degraded"

- pgvector schema not loaded → `npm run pg:schema:vector`.
- No embeddings backend resolved → set `EMBEDDINGS_URL` or pick a provider in Admin.
- **Dimension mismatch.** The column is `vector(1536)`. A model of another width throws at index time
  (counted and surfaced) but degrades **silently to zero hits** at query time. `EMBEDDINGS_DIM` is
  *not* validated against the actual column width.
- Provider quota exhausted → the retrieval-health card says so explicitly.

### Slack connects but ingests nothing

Almost always the public-channel gate. A channel it can't *prove* is public is skipped. Confirm the
bot has `channels:read` (a total scope failure is diagnosed by name in the run error) and that the
channel is public in the workspace. Only a *confirmed*-private channel triggers a purge of already-
ingested content; an unverifiable one is skipped without deleting anything.

### Login link never arrives

No email transport configured. In development the link is printed to the server console. In
production, set `RESEND_API_KEY` + `RESEND_FROM` (a verified domain — Resend's `onboarding@resend.dev`
only delivers to the account owner) or `SMTP_URL` + `SMTP_FROM`. Also confirm `APP_URL` is set, or
links are built against nothing.

### My local model is ignored

`LLM_BASE_URL` is only **third** in the auto-precedence: OpenRouter (stored key) → `LLM_BASE_URL` →
Anthropic. If any team has an OpenRouter key saved in Admin, it wins. To force local, set the team's
answering provider to **Local** in Admin → Integrations.

### Deploy succeeded but nothing changed

Confirm Railway actually started a build — webhooks are occasionally dropped. Also remember
`preDeployCommand` runs `npm run pg:schema`; if that fails the release aborts by design.

---

## 6. Architecture and contributing

- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — the single fast reference for where data lives,
  who writes it, who reads it. Its enumerable surfaces (routes, tables, ingestion sources) are
  machine-guarded against drift.
- **[`DEVELOPMENT.md`](DEVELOPMENT.md)** — local setup and the four test tiers.
- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — the PR checklist.
- **[`docs/PROVIDERS.md`](docs/PROVIDERS.md)** — every LLM/embeddings/reranker switch.
- **[`docs/OPS.md`](docs/OPS.md)** — deploys, diagnostics, incident history.
- **[`SECURITY.md`](SECURITY.md)** — private vulnerability reporting.

**The API contract is pinned in the other repo:** `aios-workspace/docs/brain-api.md`. This server
implements **v1.14**, asserted by a build guard.

### Security posture

Tier isolation is enforced **entirely in app code — there is no RLS.** Every read path goes through
the `lib/auth/visibility` choke-point, with filters re-applied in `/api/v1/items*` and the retrieval
layer. `admin`-tier content is rejected at the API with **422** and never reaches the database. All
sync writes funnel through one audited module (`lib/ingest`). API keys are `aios_<key_id>_<secret>`,
sha256 at rest, shown once. The audit log is append-only and trigger-backed; rate limits live in
Postgres.

Known accepted risk: machine sync writes have no database-level tier backstop — mitigated by the
narrow single-writer module and the contract-level 422.

---

MIT licensed. See [`LICENSE`](LICENSE).
