# AIOS Team Brain

Mission control for agentic teamwork. Contributor repos (built on
[Agentic Team Ops](https://github.com/your-github-org/aios-workspace)) sync
tier-tagged content here via the `aios` CLI; the dashboard surfaces tasks,
projects, decisions, deliverables, transcripts, and a grounded natural-language
query over the team's shared memory.

**The pinned API contract lives in the contributor repo:**
`aios-workspace/docs/brain-api.md` (v1). Both repos build against that file.

## Stack

Next.js 16 (App Router) · **configurable database backend** (`DB_BACKEND`) —
**Postgres by default** (the deployed target, e.g. Railway; tier isolation
enforced in app code) or **Supabase** (legacy; managed Postgres + Auth + RLS) ·
**pluggable LLM** for query — Anthropic by default, or any local
OpenAI-compatible endpoint (Ollama/Hermes/llama.cpp), plus an optional
local/cloud reranker (see [docs/PROVIDERS.md](docs/PROVIDERS.md)) · Tailwind v4
with Prism Light tokens. Self-host portable: plain SQL schema, Postgres-backed
rate limiting, no Vercel-only dependencies.

## Architecture in one paragraph

Members authenticate with magic-link/OAuth (invite-only; admin creates the
member row, first login links it). Machines authenticate with per-member API
keys (`aios_<key_id>_<secret>`, sha256-at-rest, shown once). Sync writes go
through one narrow audited module (`lib/ingest`) using the service role;
everything the dashboard reads is tier-gated — in Postgres mode by an app-code
choke-point (`lib/auth/visibility`), in legacy Supabase mode by RLS — enforcing
access tiers (`team` sees all, `external` sees only external; `admin`-tier
content is rejected at the API with 422 — it never reaches the database).
Markdown task/decision tables materialize into structured rows (diff-sync by
`row_key`; UI-created tasks survive pushes). The query pipeline retrieves
tier-filtered FTS hits + structured context (decisions, tasks, Company-Graph
entities) and streams a cited answer; cost guards cap per-member and per-team
daily spend in `query_log`.

## Local development

```bash
npm install
cp .env.example .env.local     # set DATABASE_URL (Postgres), AUTH_SECRET + your Anthropic key
npm run pg:schema              # load postgres/schema.sql (canonical) into DATABASE_URL
npx tsx --conditions react-server scripts/seed-demo.ts   # demo team + Northwind + Veridian graph
npm run dev
```

> **New contributor?** [`DEVELOPMENT.md`](DEVELOPMENT.md) is the full local-setup + test-tier walkthrough
> (prereqs, `.env.local`, `AUTH_SECRET`, troubleshooting); [`CONTRIBUTING.md`](CONTRIBUTING.md) is the
> PR checklist (worktrees, spec-first tests, the architecture-map loop). Start there.

> Legacy Supabase backend: set `DB_BACKEND=supabase`, run `supabase start`, fill
> `.env.local` from `supabase status -o env`, and `supabase db reset` to migrate.

**Run it local or cloud.** By default queries use the Anthropic API. To answer
fully on-machine ($0), set `LLM_BASE_URL` (and optionally a local `RERANK_URL`)
in `.env.local` — no rebuild. See **[docs/PROVIDERS.md](docs/PROVIDERS.md)** for
every switch, and **[docs/LOCAL_AI_WORKSTATION.md](docs/LOCAL_AI_WORKSTATION.md)**
to stand up the whole local stack (Ollama + Hermes + llm-wiki + GBrain).

The seed prints a demo API key once. Use it from a contributor repo:

```bash
export AIOS_API_KEY=aios_…
aios push          # from an aios-workspace scaffolded repo with brain_url set
aios query "what's blocking sprint 1?"
```

## Verification

`scripts/e2e.sh` runs the full loop: reset → seed (asserts 8 tasks + 20
decisions materialize through `lib/ingest`) → real `aios push` from a freshly
scaffolded spoke → idempotent re-push → materialization check → admin-tier 422
→ pull → live NL query that must ground in the advisory-gates decision.

## API surface (v1)

- `POST /api/v1/items` — upsert synced content (Bearer key + `X-AIOS-Team`)
- `GET  /api/v1/items?since=` — tier-filtered pull, keyset-paginated
- `GET  /api/v1/tasks?since=` — dashboard task changes for `aios pull` writeback
- `GET  /api/v1/members` — team roster + cross-tool identities (team-tier); filters `?email=` `?handle=` `?provider=`
- `GET  /api/v1/identities/resolve?provider=slack&external_id=U…` — resolve an external id (or `?email=`/`?handle=`) to a member + their canonical contacts (team-tier; 404 on miss)
- `POST /api/v1/query` — SSE: `delta` / `sources` / `done`
- `POST /api/dashboard/query` — same pipeline, session-authenticated

## Security posture

RLS default-deny everywhere; helper fns in an unexposed `private` schema;
`key_hash` column-revoked from clients; audit log append-only (trigger-backed);
rate limits in Postgres; the service-role path is confined to `lib/ingest` +
route handlers and audited on every write. Known accepted risk: sync writes
bypass RLS by design (machine auth) — mitigated by the narrow module and the
contract-level tier rejection; a `security definer` ingest function is the
post-MVP hardening step.
