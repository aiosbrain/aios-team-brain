# AIOS — Parallel Agent Handoff Prompts

> **Status:** Wave 1 (`F3`–`F5`, `W1.1`–`W1.4`) below has shipped and merged; the prompts are kept
> as a worked template for how to structure a parallel-agent handoff. PM tracking has moved from
> Plane to **Linear** (Plane is retired — see `docs/ARCHITECTURE.md` "PM tool decision (resolved)");
> the tracking instructions below reflect that. Wave 2 (`W2.*`) was **superseded 2026-06-29** by the
> V1.0 Operator Loop roadmap — see the note under "Parallelization waves".

Each prompt below is **self-contained**: copy one verbatim into a **fresh Claude Code session**.
Every agent works in its **own git worktree** off `origin/main` (never the primary checkout) and
tracks its progress in **Linear** (the canonical PM tool; the brain-tasks CLI is the brain→Linear
projection path) — that's the workflow we're testing.

## Parallelization waves (respect dependencies)
- **Wave A — start in parallel now (no cross-deps):** `F3`, `W1.1`, `W1.2`, `W1.4`
- **Wave B — after `F3` merges:** `F4`, `F5`
- **Wave C — after `F5` merges:** `W1.3`
- **Wave 2** (`W2.*`: external AI cost, Slack bidirectional, Wise finance, PM bake-off, Pencil
  design, connector rename) was **superseded 2026-06-29** by the V1.0 Operator Loop roadmap — do
  not generate new prompts from this template for it. `W2.4` (the Plane-vs-Linear PM bake-off) did
  complete before the supersession — Linear was chosen as the canonical PM tool (see
  `docs/ARCHITECTURE.md` "PM tool decision (resolved)"). Current work is tracked in Linear; see
  `aios-workspace/docs/v1-operator-loop/` for the V1.0 roadmap that superseded Wave 2.

## Shared caveats for parallel runs
- **Worktrees:** name each uniquely — `../aios-team-brain-<epic>` (e.g. `-f3`, `-w1.1`).
- **Shared test Postgres:** `npm run db:test:up` **resets** the shared DB on port 5434. Don't run it
  concurrently from two agents. Either (a) one agent brings it up and others just run
  `npm run test:datamechanics:local`, or (b) give an agent its own DB:
  `docker compose -f compose.test.yml -p <epic> up -d` on a different port. Data-mechanics tests seed
  random team ids, so they don't collide once the schema is loaded — only the reset step is destructive.
- **Linear** is the canonical PM tool (Plane is retired). Track work via the brain-tasks CLI
  (brain→Linear projection) — do not use the Plane MCP.
- Some `F3` scaffolding (encrypted-secret storage in `lib/integrations/manage.ts`) may already exist on
  `main` — **read main first and reconcile**, don't blindly recreate.

---

## Common preamble (already embedded in each prompt below — shown once for reference)

> You are a senior engineer on **AIOS Team Brain** (Next.js 16 App Router · React 19 · TypeScript ·
> Postgres via `lib/db/pg`). **First, read** the root `~/Projects/aios/CLAUDE.md`
> (it MANDATES git worktrees — follow it), this repo's `CLAUDE.md` + `AGENTS.md`, and
> `docs/ARCHITECTURE.md` §1. Then set up your worktree:
> ```bash
> cd ~/Projects/aios/aios-team-brain
> git fetch origin
> git worktree add -b feat/<epic> ../aios-team-brain-<epic> origin/main
> cd ../aios-team-brain-<epic>
> ln -sfn ~/Projects/aios/aios-team-brain/node_modules node_modules
> ```
> **Linear tracking (brain-tasks CLI, brain→Linear projection):** find the issue and its sub-issues;
> assign them to yourself; move the issue to **In Progress** when you start; move each sub-issue to
> **Done** as you finish it; when you open the PR, **reference the issue key** in the PR body (see
> `.github/pull_request_template.md`) so `aios-work-sync` closes it on merge.
> **Engineering rules:** spec-first **red** tests (unit = parse/guards; data-mechanics = persistence/tier;
> over a real DB); **single-writer + build-failing guard** for any new write surface; **tier/role
> isolation is app-code only** (no RLS on postgres) — add a scoped read helper + guard test per new table;
> update `docs/ARCHITECTURE.md` `drift:*` blocks in the same PR; **version
> `aios-workspace/docs/brain-api.md` first** for any `/api/v1` or ingest-contract change.
> **Verify before PR:** `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run check:docs`, and (if you
> touched persistence) `npm run db:test:up && npm run test:datamechanics:local`. **Open the PR from your
> worktree branch against `main`.** Do all commits in the worktree, never the primary checkout.

---

## F3 — Integrations auth surfaces + contract bump  (Wave A)

```
You are a senior engineer on AIOS Team Brain (Next.js 16 App Router, React 19, TypeScript, Postgres via lib/db/pg). Read ~/Projects/aios/CLAUDE.md (it MANDATES git worktrees — follow it), this repo's CLAUDE.md + AGENTS.md, and docs/ARCHITECTURE.md §1 before coding.

Set up your worktree:
  cd ~/Projects/aios/aios-team-brain
  git fetch origin
  git worktree add -b feat/f3-integrations-auth ../aios-team-brain-f3 origin/main
  cd ../aios-team-brain-f3
  ln -sfn ~/Projects/aios/aios-team-brain/node_modules node_modules

Track progress in Linear (brain-tasks CLI, brain→Linear projection): find issue "F3 — Integrations auth surfaces + contract bump" and its sub-issues (F3.1–F3.4). Assign them to yourself. Move the issue to In Progress now; move each sub-issue to Done as you complete it; reference the issue key in the PR body so aios-work-sync closes it on merge.

OBJECTIVE: give the integrations framework two auth surfaces WITHOUT touching the pinned /api/v1 write contract. Note: lib/integrations/manage.ts already exists (single writer + config validation) and may already have encrypted-secret storage — read it on main first and reconcile; do not duplicate.

SCOPE (sub-issues):
- F3.1 Dashboard session-auth WRITE: a server action (or app/api/dashboard/integrations/route.ts, matching the existing app/api/dashboard/query session-auth pattern) that calls lib/integrations/manage.ts. Admin-gated exactly like app/t/[team]/admin/layout.tsx (role==="admin"). NO new /api/v1 write route.
- F3.2 GET /api/v1/integrations (API-key auth via lib/api/auth.ts): returns the team's NON-SECRET selections only (never secrets). This is the documented contract the sidecar consumes.
- F3.3 Version aios-workspace/docs/brain-api.md FIRST (add the new read endpoint, bump the version note), then add the route to docs/ARCHITECTURE.md drift:routes. npm run check:docs must pass.
- F3.4 Tests: data-mechanics (real PG) — a non-admin dashboard write is rejected; the API-key read returns only non-secret fields and is team-scoped. Spec-first/red-first.

CONSTRAINTS: single-writer stays lib/integrations/manage.ts; tier/role isolation is app-code (no RLS); secret-like keys must never appear in non-secret selections.

VERIFY: npx tsc --noEmit; npm run lint; npm test; npm run check:docs; npm run db:test:up && npm run test:datamechanics:local. Then open a PR from feat/f3-integrations-auth against main referencing the Linear issue key.
```

## F4 — Sidecar consumes selections  (Wave B — after F3 merges)

```
You are a senior engineer on AIOS (the Python ingestion sidecar in aios-team-brain/ingestion + the brain). Read ~/Projects/aios/CLAUDE.md (MANDATES worktrees), this repo's CLAUDE.md/AGENTS.md, docs/ARCHITECTURE.md §1, and the ingestion source pattern (ingestion/aios_ingest/sources/registry.py, engine.py, brain_client.py). Requires F3 (GET /api/v1/integrations) merged to main — confirm it exists before starting.

Worktree:
  cd ~/Projects/aios/aios-team-brain
  git fetch origin
  git worktree add -b feat/f4-sidecar-selections ../aios-team-brain-f4 origin/main
  cd ../aios-team-brain-f4
  ln -sfn ~/Projects/aios/aios-team-brain/node_modules node_modules

Linear: issue "F4 — Sidecar consumes selections" (F4.1–F4.3). Assign them to yourself. Issue → In Progress; sub-issues → Done as completed; reference the issue key in the PR body.

OBJECTIVE: close the "table does nothing" gap — the ingestion engine fetches brain-side NON-SECRET selections and merges them with LOCAL secrets.
SCOPE:
- F4.1 engine.py + brain_client.py: GET /api/v1/integrations; merge selections (repos, channel ids, project slug) with local secrets from env/connections.yaml keyed by (type, name). Selection from brain, tokens local — the brain NEVER stores secrets.
- F4.2 connections.yaml.example note + docs. Backward-compatible: if selection-fetch isn't configured, behave exactly as today.
- F4.3 Python tests: merge precedence + the backward-compat (unconfigured) path.

VERIFY: run the ingestion Python tests; npm run check:docs if you touch ARCHITECTURE. PR from feat/f4-sidecar-selections → main referencing the Linear issue key.
```

## F5 — Admin Integrations UI + tier guards  (Wave B — after F3 merges)

```
You are a senior engineer on AIOS Team Brain. Read ~/Projects/aios/CLAUDE.md (MANDATES worktrees), this repo's CLAUDE.md/AGENTS.md, docs/ARCHITECTURE.md §1 and §5 (tier isolation), and these existing patterns: components/admin/admin-tabs.tsx, app/t/[team]/admin/layout.tsx (admin gate), lib/auth/visibility.ts, test/guards/codebases-tier-filter.test.ts. Requires F3 merged.

Worktree:
  cd ~/Projects/aios/aios-team-brain
  git fetch origin
  git worktree add -b feat/f5-integrations-ui ../aios-team-brain-f5 origin/main
  cd ../aios-team-brain-f5
  ln -sfn ~/Projects/aios/aios-team-brain/node_modules node_modules

Linear: issue "F5 — Admin Integrations UI + tier guards" (F5.1–F5.5). Assign them to yourself. Issue → In Progress; sub-issues → Done; reference the issue key in the PR body.

OBJECTIVE: admin-gated Integrations surface + per-table tier/role guards (NO RLS backstop on postgres).
SCOPE:
- F5.1 Add {slug:"integrations",label:"Integrations"} to components/admin/admin-tabs.tsx + app/t/[team]/admin/integrations/page.tsx (inherits the admin-only gate). Calls the F3 server action to create/enable/disable integrations.
- F5.2 lib/integrations/read.ts — role/tier-scoped reads for the surface.
- F5.3 test/guards/integrations-tier-filter.test.ts modeled on codebases-tier-filter.test.ts (non-vacuous).
- F5.4 The Integrations surface works against the Postgres backend (the only backend); no legacy-backend gating.
- F5.5 Data-mechanics: integrations persist; an external-tier viewer cannot read admin config.

VERIFY: npx tsc --noEmit; npm run lint; npm test; npm run check:docs; npm run db:test:up && npm run test:datamechanics:local. PR from feat/f5-integrations-ui → main referencing the Linear issue key.
```

## W1.1 — Granola → decisions (sanitized, consented)  (Wave A)

```
You are a senior engineer on AIOS (the Python ingestion sidecar + the transcript→decision workflow). Read ~/Projects/aios/CLAUDE.md (MANDATES worktrees), this repo's CLAUDE.md/AGENTS.md, the source pattern (ingestion/aios_ingest/sources/registry.py + base.py + an existing source like slack.py), and the existing granola-digest + transcript-decisions skills. There is already a granola-mcp server configured — reuse its pull/parse logic; do not re-write transcript fetching.

Worktree:
  cd ~/Projects/aios/aios-team-brain
  git fetch origin
  git worktree add -b feat/w1.1-granola ../aios-team-brain-w1.1 origin/main
  cd ../aios-team-brain-w1.1
  ln -sfn ~/Projects/aios/aios-team-brain/node_modules node_modules

Linear: issue "W1.1 — Granola → decisions (sanitized, consented)" (W1.1.1–W1.1.5). Assign them to yourself. Issue → In Progress; sub-issues → Done; reference the issue key in the PR body.

OBJECTIVE: ingest Granola meetings as DECISION ROWS ONLY — NO verbatim transcript synced team-tier. Privacy is the point.
SCOPE:
- W1.1.1 ingestion/aios_ingest/sources/granola.py implementing the Source protocol; register in registry.py; add `granola` to docs/ARCHITECTURE.md drift:sources.
- W1.1.2 Privacy gate: a meeting ALLOWLIST (match "AIOS" topic or participants John/Chetan) + per-note consent. No verbatim transcript leaves admin-tier.
- W1.1.3 Pull matching transcripts to the workspace (local, admin-tier) only — reuse granola-digest.
- W1.1.4 Wire the transcript-decisions workflow: extract candidate decisions → HUMAN review → append to decision-log.md → aios push → materializeDecisions (lib/ingest) → decisions table.
- W1.1.5 Python tests: registry wiring + normalize + MOCKED API pagination/rate-limit.

VERIFY: ingestion Python tests; npm run check:docs (drift:sources). PR from feat/w1.1-granola → main referencing the Linear issue key.
```

## W1.2 — Token + cost per member (brain spend)  (Wave A)

```
You are a senior engineer on AIOS Team Brain. Read ~/Projects/aios/CLAUDE.md (MANDATES worktrees), this repo's CLAUDE.md/AGENTS.md, and these SHIPPED pieces you build on: lib/auth/visibility.ts (scopeQueryLog — query_log is role-scoped), lib/identity/resolve.ts (shared identity resolver), lib/metrics/pulse.ts (JS day-bucketing pattern), and the codebases contributor-table/chart components.

Worktree:
  cd ~/Projects/aios/aios-team-brain
  git fetch origin
  git worktree add -b feat/w1.2-cost-per-member ../aios-team-brain-w1.2 origin/main
  cd ../aios-team-brain-w1.2
  ln -sfn ~/Projects/aios/aios-team-brain/node_modules node_modules

Linear: issue "W1.2 — Token + cost per member (brain spend)" (W1.2.1–W1.2.4). Assign them to yourself. Issue → In Progress; sub-issues → Done; reference the issue key in the PR body.

OBJECTIVE: per-member LLM cost from query_log (brain spend only; external providers are Wave 2).
SCOPE:
- W1.2.1 lib/metrics/members.ts getPerMemberCosts(client, teamId, range, {isAdmin, memberId}) aggregating query_log by member_id THROUGH scopeQueryLog (admins team-wide; others self).
- W1.2.2 app/t/[team]/admin/usage/page.tsx (ADMIN-ONLY, under the admin layout) reusing the contributor-table + charts.
- W1.2.3 Throughput-vs-cost: join code_contributions (mapped via lib/identity/resolve.ts) × query_log spend → "$ per AI commit / per contributor".
- W1.2.4 Tier/role guard test + a data-mechanics aggregation test.

VERIFY: npx tsc --noEmit; npm run lint; npm test; npm run db:test:up && npm run test:datamechanics:local. PR from feat/w1.2-cost-per-member → main referencing the Linear issue key.
```

## W1.3 — GitHub native UI (selection + manual scan)  (Wave C — after F5 merges)

```
You are a senior engineer on AIOS Team Brain. Read ~/Projects/aios/CLAUDE.md (MANDATES worktrees), this repo's CLAUDE.md/AGENTS.md, and reuse (do NOT fork): lib/codebases/github.ts (fetchGithubUser/listOrgMembers/linkGithub), lib/codebases/ingest.ts (single writer), lib/codebases/visibility.ts (canSeeCodebases). Requires F5 (integrations UI) and F4 (sidecar consumes selections) merged. Heed memory codebase-scan-deploy-race.

Worktree:
  cd ~/Projects/aios/aios-team-brain
  git fetch origin
  git worktree add -b feat/w1.3-github-ui ../aios-team-brain-w1.3 origin/main
  cd ../aios-team-brain-w1.3
  ln -sfn ~/Projects/aios/aios-team-brain/node_modules node_modules

Linear: issue "W1.3 — GitHub native UI (selection + manual scan)" (W1.3.1–W1.3.4). Assign them to yourself. Issue → In Progress; sub-issues → Done; reference the issue key in the PR body.

OBJECTIVE: dashboard repo selection + member→GitHub linking on the Integrations surface. NO server-triggered scan in Wave 1 — selection persists and the sidecar consumes it; scans run via the documented aios-ingest CLI.
SCOPE:
- W1.3.1 Repo selection persisted to integrations (type=github, config.repos); reuse lib/codebases/github.ts.
- W1.3.2 Member → GitHub login linking UI (reuse linkGithub).
- W1.3.3 Show last-scan SHA vs main HEAD + a clearly-labelled "run a scan" panel documenting the aios-ingest command.
- W1.3.4 Respect lib/codebases/visibility.ts (team-tier only).

VERIFY: npx tsc --noEmit; npm run lint; npm test; npm run check:docs; data-mechanics if persistence touched. PR from feat/w1.3-github-ui → main referencing the Linear issue key.
```

## W1.4 — Ops hardening (Sentry, CodeRabbit, BugBot)  (Wave A)

```
You are a senior engineer on AIOS Team Brain (Next.js 16 + Turbopack). Read ~/Projects/aios/CLAUDE.md (MANDATES worktrees) and this repo's CLAUDE.md/AGENTS.md. AGENTS.md warns this Next.js has breaking changes — read node_modules/next/dist/docs as needed.

Worktree:
  cd ~/Projects/aios/aios-team-brain
  git fetch origin
  git worktree add -b feat/w1.4-ops ../aios-team-brain-w1.4 origin/main
  cd ../aios-team-brain-w1.4
  ln -sfn ~/Projects/aios/aios-team-brain/node_modules node_modules

Linear: issue "W1.4 — Ops hardening (Sentry, CodeRabbit, BugBot)" (W1.4.1–W1.4.4). Assign them to yourself. Issue → In Progress; sub-issues → Done; reference the issue key in the PR body.

OBJECTIVE: error logging + AI code review.
SCOPE:
- W1.4.1 Sentry: @sentry/nextjs >=10.13 (Turbopack source-map upload). Add instrumentation-client.ts, sentry.server.config.ts, sentry.edge.config.ts, onRequestError in instrumentation.ts, app/global-error.tsx (app root), withSentryConfig in next.config.ts. DSN + source-map auth token via env (.env.example entries; do NOT commit secrets). Confirm no custom webpack plugins (Turbopack ignores them).
- W1.4.2 CodeRabbit: document installing the GitHub App on the public AIOS repos (free for public repos). This is a config/ops step — capture instructions in the PR.
- W1.4.3 BugBot: document John (org owner) approving the Cursor app at AIOS-alpha → Settings → Third-party Access (manual).
- W1.4.4 Sentry smoke: a client error and a server error both produce events with resolved source maps (note how to verify).

VERIFY: npx tsc --noEmit; npm run lint; npm run build (Turbopack) succeeds with Sentry wired. PR from feat/w1.4-ops → main referencing the Linear issue key.
```

---

## Wave 2 — superseded 2026-06-29

`W2.1` external AI cost (usage_costs table + Anthropic/Cursor sources) · `W2.2` Slack bidirectional ·
`W2.3` Wise finance · `W2.4` PM bake-off (ingest Linear + Plane into the brain) · `W2.5` Pencil design
system · `W2.6` connector→integration rename (versioned blueprint migration).

This wave was **superseded 2026-06-29** by the V1.0 Operator Loop roadmap — do not generate prompts
from this template for it. `W2.4` (the PM bake-off) is the one item that did complete beforehand:
Linear was chosen as the canonical PM tool over Plane (see `docs/ARCHITECTURE.md` "PM tool decision
(resolved)"). For current planned work, see `aios-workspace/docs/v1-operator-loop/` and Linear.
