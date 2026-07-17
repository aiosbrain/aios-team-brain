@AGENTS.md

# AIOS Team Brain — operating manual

**Skill/doc routing: see `RESOLVER.md`** — gates (architecture-map loop, Railway
read-only, tier isolation, brain-api, migrations, spec-first tests, Linear-only)
and skill routing.

This file is read at the start of every session. It encodes the durable conventions for
working in this repo. Follow it over generic habits.

---

## 1. The architecture-map build loop (REQUIRED — do this every change)

`docs/ARCHITECTURE.md` is the single fast reference for **where data lives, who writes it,
who reads it**. The map only pays off if it's trustworthy, so:

- **BEFORE building:** consult the map — the §1 sources-of-truth table and the relevant
  flow. Reason from the source of truth, never from a random call site.
- **AFTER building:** update the map **in the same PR**. A wrong map is worse than none.
- The enumerable surfaces (API routes, DB tables, ingestion sources) are **machine-guarded**
  by `scripts/check-docs-drift.mjs` (CI job *Docs drift guard* + the local `.githooks/pre-push`
  hook). If you add/remove a route, table, or source, update the `<!-- drift:* -->` blocks in
  the same change or the build fails. Hand-maintained prose/diagrams are on you — keep them honest.

---

## 2. Four operating principles (internalize these)

1. **Spec-first testing, never characterization-first.** Write the assertion from what the
   product *should* do (the brain-api contract, the tier intent, a scenario), then run it.
   A spec-derived test that goes **red** found a real gap — that's the point. Tests that read
   the implementation and assert what it already does are green by construction and forbidden
   as the default. For a confirmed-but-unfixed gap, use `it.fails(...)` so it stays green until
   fixed, then flips red. (FakeSupabase characterization is not a substitute for a real-DB
   outcome — see §4.)
2. **Single writer + a build-failing guard > discipline you have to remember.** When a rule
   matters ("only `lib/ingest` writes `items`"), make ONE owner the only legal writer and add a
   test that **fails the build** when anything else violates it.
3. **Verify to the observable outcome.** A claim isn't real until a red test reproduces the bad
   *outcome* (wrong row in the DB, a leaked cross-tier row, wrong state) — not a name, a proxy,
   or a call-site reading. Treat audits and AI-suggested bugs as hypotheses to re-derive.
4. **The architecture map is a required step in the build loop** (§1).

---

## 3. Stance: senior engineer + product builder

Default to thoroughness and honest "done." Report only what you've **verified to the outcome**;
label status ✅ / 🟡 / 🔴; surface gaps and shortcuts **first**. Never claim done without proof
(green test, a guard shown non-vacuous, the DB migrating from zero). Prefer the durable fix over
the near-term-satisfaction shortcut.

---

## 4. Test tiers — which failure mode each catches

Put a spec-derived test in the tier that catches *its* failure mode:

| Tier | Runs against | Catches |
|---|---|---|
| **unit** (`vitest.config.ts`) | nothing (pure) | parse/format boundaries, pure logic, **all drift/contract guards** |
| **data-mechanics** (`vitest.datamechanics.config.ts`) | **real Postgres, stubbed model** | persistence & access: write→store→read, dedup, diff-sync, tier isolation |
| **integration** (`vitest.http.config.ts`, `npm run test:http`) | the API over a **real socket** (`next start` + real Postgres) + the system-level `scripts/e2e.sh` | routing, auth, tier-422, cookies/headers, the JSON wire format, the cross-process sync loop |
| **eval** *(not built)* | real model API | model judgment (grounded-answer quality) — exercised live in `e2e.sh` step 9 |

Mental model: **unit = parse/guards · data-mechanics = persistence + access · integration =
routing/auth · eval = model judgment.** Don't let a tier that stubs the model + clean inputs give
false confidence for a data-pipeline change — put that test in data-mechanics.

**Why the real-DB tier matters:** the legacy in-memory `lib/ingest/fake-supabase.ts` is fast and fine
for orchestration shape, but it has no constraints, triggers, or the `search` generated column — so it
cannot verify persistence or access to the observable outcome. The real-Postgres data-mechanics tier
(`npm run db:test:up && npm run test:datamechanics`) is **built** and is authoritative for those.

---

## 5. Access control — tier isolation is an app-code invariant ⚠️

**Deployment model:** AIOS is **self-hosted per organization** — each org runs its own instance
against its own database; all rows belong to that one org. So there is **no shared multi-tenant
DB**, and cross-organization isolation is **not** a concern. The `team_id` scoping is purely
*internal* (separating teams *within* one org's DB) and only matters if an instance hosts more
than one team.

**What still matters regardless of multi-tenancy: TIER isolation.** An `external`-tier principal
(a client/consultant collaborator) must never read `team`/`admin` content; `admin`/`private`
content never leaves the workspace. This is a product feature (the `external` API tier, OKF link
redaction), independent of multi-tenancy.

There is **no RLS** — Postgres is the one and only backend, and tier isolation is enforced
**entirely in app code**. A missing `access`/tier filter has **no DB backstop**. Tier isolation
is therefore a **standing invariant** that the app code must guarantee on every read path.

> ✅ **Enforced (was a known gap, now closed):** API routes and `lib/query/retrieve.ts` re-apply the
> tier filter, and dashboard server-component reads (`app/t/[team]/*`) route through the
> **`lib/auth/visibility` choke-point** (`visibleItems`/`canSeeAccess`) — guarded by
> `test/guards/dashboard-tier-filter.test.ts` and proven by the data-mechanics tier. New dashboard
> surfaces (e.g. Codebases) must add their own app-code tier gate + guard; there is no RLS backstop.

---

## 6. Stack & key commands

- **Brain:** Next.js 16 (App Router) · React 19 · TypeScript · Vitest. DB via the `lib/db/pg` adapter
  (Postgres on Railway). LLM/reranker are provider-configurable (`docs/PROVIDERS.md`).
- **Sidecar:** `ingestion/` — Python connector service (LlamaHub/Unstructured), HTTP-only to the brain.

> **LLM routing convention (REQUIRED).** Never hardcode or pick an LLM provider/model inside a feature.
> Every text-**generation** task (Q&A, chat titles, meeting summary/attendee/action-item extraction,
> narrative arcs, social content, …) MUST go through the shared settings-aware primitive
> **`lib/llm/complete.ts`** (`completeText` / `completeTextOrNull`), with keys resolved via
> **`lib/query/answering.resolveAnsweringKeys`** and the backend chosen by **`selectLlmBackend`**. Do
> **not** open an Anthropic client, POST to `/chat/completions`, or read `LLM_BASE_URL`/model env
> directly in a feature — that bypasses the team's one global switch (**Admin → Active answering
> model** = `teams.answering_provider`, incl. OpenRouter) and silently pins a provider. The only
> sanctioned raw-transport files are `lib/llm/complete.ts`, the streaming answer path
> `lib/query/claude.ts`, and the cheap-title path `lib/chat/title.ts`; this is build-enforced by
> `test/guards/llm-single-caller.test.ts`. Embeddings / image generation / reranker are a **different
> model class** with their own config (`getProviderKey`/env) and are intentionally outside this path.

```bash
npm run dev            # next dev
npm test               # vitest (unit tier)
npm run check:docs     # docs drift guard (also runs in CI + pre-push)
npm run lint           # eslint
npm run pg:schema      # load postgres/schema.sql (canonical) into DATABASE_URL — also the prod rollout step
npm run db:test:up     # ephemeral test Postgres + load schema (migrate-from-zero = replay guard)
npm run test:datamechanics  # real-Postgres tier: persistence + tier isolation
bash scripts/e2e.sh    # system-level integration: seed → push → materialize → 422 → pull → live query
```

- **Schema:** canonical = `postgres/schema.sql` (idempotent; `npm run pg:schema` loads it and is the
  prod rollout step against Railway). Additive deltas live in `postgres/migrations/` (the only
  migrations directory; guarded by the `migrations-numbering` guard).
- **Adding a COLUMN to an existing table:** `schema.sql` is `create … if not exists`, so editing the
  `create table` body is a **no-op on a DB that already has the table** — prod keeps the old shape.
  Put the `alter table … add column if not exists` in **`postgres/migrations/`** (applied by
  `pg:schema` after `schema.sql`, in filename order) **and** mirror it into `schema.sql` for
  from-zero. See `postgres/migrations/README.md`. (A brand-new table needs no migration —
  `create table if not exists` in `schema.sql` covers it.)
- **Deploy:** Postgres on Railway (self-host portable). **Deploys happen ONLY by merging to `main`** —
  Railway's GitHub integration auto-builds AIOS → `aios-team-brain`. After a merge, run `npm run pg:schema`
  against prod for any schema change, and **confirm the platform started a new build** (`railway deployment
  list`; CI webhooks can be silently dropped) — re-trigger via the Railway dashboard if the latest deploy
  predates the merge.
- **Inspecting the prod DB (read-only, for diagnostics).** The internal `DATABASE_URL`
  (`postgres.railway.internal`) is unreachable from a laptop; use the **public TCP proxy** the Railway
  Postgres service exposes. Always confirm `railway status` shows **Project: AIOS** first, then:
  ```bash
  PUBURL=$(railway variables -s Postgres --json | python3 -c "import sys,json;print(json.load(sys.stdin)['DATABASE_PUBLIC_URL'])")
  psql "$PUBURL" -c "select count(*) from members;"     # e.g. host thomas.proxy.rlwy.net:33781
  ```
  This is the same DB the app uses (self-host = one Postgres). **Read-only for diagnosis** — do NOT
  run schema loads or migrations through it (that's `npm run pg:schema` as the deploy step). Treat any
  write as production data mutation: confirm with the user first.
- **⛔ NEVER run `railway up` / `railway redeploy` / `railway down` / `railway delete`.** The Railway CLI is
  **read-only** here (`status`, `logs`, `variables`, `deployment list`, `connect`). `railway up` deploys the current
  worktree's code to whatever project that directory is *linked* to (`~/.railway/config.json`, keyed by
  absolute path) — and a Conductor worktree that drifted to the wrong link (an aios worktree linked to the
  **Kula** project) once shipped this repo's code into Kula and took it down. The GitHub-merge path is bound
  to the right project and cannot do that. This is **guarded**: `.claude/settings.json` denies those verbs +
  a PreToolUse hook (`scripts/railway-deploy-guard.sh`) blocks them (incl. `cd other && railway up`). Before
  *any* Railway command, confirm `railway status` shows **Project: AIOS**; audit all worktrees with
  `bash scripts/railway-link-check.sh`.
- **Runtime backstop (`scripts/service-guard.mjs`).** The hook above only fires inside the agent's shell; it
  can't stop a human `railway up` or any other path that lands this code on a foreign service. So the schema
  loaders (`pg-load-schema.mjs` = the `preDeployCommand`, and `pg-load-vector.mjs`) call `assertServiceIdentity`
  **before** connecting: if `RAILWAY_SERVICE_NAME` is set and isn't an AIOS service (`aios` / `aios-*`, override
  via `AIOS_RAILWAY_SERVICES`), the load aborts non-zero and Railway halts the release — so this repo can never
  inject its schema into another project's DB again (the 2026-06-27 Kula incident). Mirrors Kula's
  `src/lib/service-guard.ts`; guarded by `test/guards/service-guard.test.ts`.

---

## 7. Choosing what to guard (meta-rule)

Build scaffolding upfront; build **guards and invariants reactively** — each must trace to a real
bug or a real contract. A guard with no failure mode behind it is ceremony. When you change a
class of thing the docs/contract describe, ask: *"is there a guard that would catch this drift,
and if not, that's what to build."*
