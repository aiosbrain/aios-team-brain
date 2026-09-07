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
  by `scripts/check-docs-drift.mjs` (CI job _Docs drift guard_ + the local `.githooks/pre-push`
  hook). If you add/remove a route, table, or source, update the `<!-- drift:* -->` blocks in
  the same change or the build fails. Hand-maintained prose/diagrams are on you — keep them honest.

---

## Task gate — a Linear task + a written spec BEFORE you build a feature ⚠️

Every feature starts as a **real Linear task**, created through the **AIOS CLI**, with a **spec** —
not as a branch that acquires a justification afterwards.

- **Create the task first:** add a row to `3-log/tasks.md` in the AIOS workspace and
  `aios push 3-log/tasks.md` — the same file the Close gate below names. (This said `tasks-team.md`
  for a while; no such file exists.) The brain's `tasks` table is canonical and projects one-way into
  Linear (`lib/pm-sync/`), so this is the only path that yields a key both the brain and Linear agree
  on. Read the projected key back (`task_pm_links.provider_url`) and cite THAT in the branch, the PR,
  and the `AIOS-Work:` trailer.
- **Never invent or borrow a key.** A fabricated `AIO-xxx` links work to nothing; a real key grabbed
  because it exists links a week of work to someone else's ticket — both have happened here, and the
  second was worse, because an invented key resolves to nothing while a real-but-wrong one silently
  files your work under a stranger's name.
- **Write the spec before the code**, not after. For anything touching schema, money, or more than one
  surface, that means a short doc in `docs/design/` that states the problem, the decision, and what
  would falsify it — then a Fable plan review on that doc. Design review has caught a wrong data model
  (a column that should have been a table), a wrong migration shape, and a metric measured in the
  wrong unit — each of them cheaper to fix in prose than in a merged PR.
- **Why the order matters:** a task written afterwards is a description of what you did, which is
  never the same artefact as a decision about what to do. The spec is where the alternative you
  didn't take gets recorded, and that is the part future-you actually needs.

---

## Close gate — the merge is not done until the task says done ⚠️

**When you merge a PR, move its task to `done` in the SAME session.** Opening the ticket is half the
loop; a board full of shipped work still marked `in_progress` is worse than no board, because every
status on it stops meaning anything.

- **Set `Status` to `done` in the row in `3-log/tasks.md`, then `aios push 3-log/tasks.md`** (dry-run
  first — it is outward-facing). Then **read the status back** the way you read the key back when you
  opened it; a push that reported `ok` is not proof the row moved.
- **The merge automation does NOT close a workspace-pushed row today — by design.** `aios-work-sync`
  fires on a correct `AIOS-Work:` trailer and writes a `work_events` row, but the outcome that row gets
  decides everything (`lib/work-events/resolve-task.ts`):
  - `applied` — matched inside the PUSHED project (`AIOS_PROJECT: aios-team-brain`): the task IS
    completed and projected to the PM tool.
  - `linked` — matched only by the TEAM-WIDE fallback: `task_id` is recorded and the task is
    **deliberately left open**, with a `work_event.would_complete` audit row instead of the status
    write (`lib/work-events/ingest.ts`). Completing on a team-wide match would create duplicate Linear
    issues, clobber Linear-native edits, and close issues merely *mentioned* in a PR body.

  A row you pushed from `3-log/tasks.md` lives in the **workspace** project, so it resolves through
  that fallback and lands `linked` — which is why `GRAPHCOST-8` sat open on 2026-08-07 even though its
  PR (#490) carried the right trailer. Nothing reverted it; **nothing ever closed it.** Six tasks were
  in that state. So closing the row yourself is not belt-and-braces, it is the only thing that closes it.
- **Separately: a push overwrites status unconditionally.** `lib/ingest/tasks` writes `status` straight
  from the file row, so if a task ever IS auto-closed (`applied`) while your local row still says
  `in_progress`, the next `aios push` clobbers it back open. The file is not strictly one-way — brain-api
  1.13 has a `mode=sync-origin` RETURN LEG that merges brain/Linear status back into the markdown — but
  the push direction wins, so pull the return leg (or just fix the row) before pushing.
- **For a brain-native row, a trailer citing the LINEAR key resolves to nothing.** A `work_events` row
  for `AIO-821` sits in prod as `unresolved · no matching task row`: resolution matches on `row_key` and
  never consults `task_pm_links`, where the Linear key lives. (A Linear-*mirrored* task is the exception —
  its `row_key` IS the `AIO-*` key, so it resolves, as `linked`.) Cite the BRAIN row key (`PIPEFF-2`).
- **Filing late is better than not filing, and must be labelled.** Four PRs (#372/#435/#437/#501)
  shipped with no task at all and were retro-filed as `TLUX-1`, `TLSUM-1`, `COSTMETER-1`,
  `SLACKATTR-1`, each marked `RETRO-FILED (#nnn)` in its description so the board doesn't imply a
  discipline that wasn't followed. Retro-filing is the repair, not the routine.
- The CI check `PR references a brain task` is **advisory** — it warns and goes green with no key. It
  will not catch this for you, which is exactly why it is written down here.

---

## Review gate — a local review of the diff is REQUIRED before you push ⚠️

Many sessions/worktrees ship into this repo in parallel and merge fast — a pre-push review of the
branch diff catches tier leaks, sync-contract drift, and correctness bugs before they land. It keeps
catching the class of defect the author structurally cannot see: the **second-order bug introduced by
their own fix**, and the **call site that nothing pins** (a helper with a dozen green tests whose
wiring could be deleted with every one of them still passing). So this is not advisory:

- **Before you `git push` a PR branch:** resolve and fetch the contribution base, then review the diff with a local reviewer —
  **Fable `code-reviewer`** (Chetan — `Agent(subagent_type: "code-reviewer", model: "fable")`) or
  **Local Bugbot** (John, via Cursor). The gate is **tool-flexible but not optional**: any equivalent
  local diff review counts, skipping it does not.
  ```bash
  root="$(git rev-parse --show-toplevel)"
  base="$(node "$root/scripts/branches.mjs" --print contribution)"
  git -C "$root" fetch origin "$base"
  git -C "$root" diff "origin/$base...HEAD"
  ```
- **Address blocker/HIGH findings before pushing**; fix or consciously defer MEDIUM/LOW with a
  one-line reason in the PR body.
- **Record what reviewed the diff in the PR body** — exactly one line:
  `## Review — Reviewed by <tool> — verdict <one-line summary>`. **Never write that line for a review
  that didn't run** — a fabricated attestation is worse than an absent one, because it launders the
  gap. The `pr-review-attestation` skill walks the whole flow.
- **If no local reviewer is available:** say so, and apply the **`ready-for-review`** label so
  CodeRabbit reviews the PR instead. That is the sanctioned alternative — silence is not.
- **Enforced in CI.** `.github/workflows/pr-review-gate.yml` fails a non-draft PR that records neither
  an attestation nor the `ready-for-review` label (matcher: `scripts/pr-review-gate.mjs`, unit-tested;
  an unedited `<tool>` placeholder is rejected, because shape alone is not a check). Drafts are
  skipped — push a draft freely; the gate re-runs when you mark it ready.
- The local review examines the **diff you're about to ship**, not the bots' comments; it complements
  CI and label-gated CodeRabbit rather than replacing either.

---

## 2. Four operating principles (internalize these)

1. **Spec-first testing, never characterization-first.** Write the assertion from what the
   product _should_ do (the brain-api contract, the tier intent, a scenario), then run it.
   A spec-derived test that goes **red** found a real gap — that's the point. Tests that read
   the implementation and assert what it already does are green by construction and forbidden
   as the default. For a confirmed-but-unfixed gap, use `it.fails(...)` so it stays green until
   fixed, then flips red. (FakeSupabase characterization is not a substitute for a real-DB
   outcome — see §4.)
2. **Single writer + a build-failing guard > discipline you have to remember.** When a rule
   matters ("only `lib/ingest` writes `items`"), make ONE owner the only legal writer and add a
   test that **fails the build** when anything else violates it.
3. **Verify to the observable outcome.** A claim isn't real until a red test reproduces the bad
   _outcome_ (wrong row in the DB, a leaked cross-tier row, wrong state) — not a name, a proxy,
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

Put a spec-derived test in the tier that catches _its_ failure mode:

| Tier                                                           | Runs against                                                                                      | Catches                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **unit** (`vitest.config.ts`)                                  | nothing (pure)                                                                                    | parse/format boundaries, pure logic, **all drift/contract guards**                          |
| **data-mechanics** (`vitest.datamechanics.config.ts`)          | **real Postgres, stubbed model**                                                                  | persistence & access: write→store→read, dedup, diff-sync, tier isolation                    |
| **integration** (`vitest.http.config.ts`, `npm run test:http`) | the API over a **real socket** (`next start` + real Postgres) + the system-level `scripts/e2e.sh` | routing, auth, tier-422, cookies/headers, the JSON wire format, the cross-process sync loop |
| **neo4j** (`npm run test:neo4j`, CI job _Graph Neo4j tier_)   | **real Neo4j** (service container = `compose.test.neo4j.yml`)                                     | graph tier isolation (`group_id` is the SOLE enforcement) + the per-item episode lookup — Cypher/shape/driver drift the source guard cannot see; self-skips without `NEO4J_TEST=1`, and the CI job's `NEO4J_TIER_REQUIRED=1` turns that skip into a collection error |
| **eval** _(not built)_                                         | real model API                                                                                    | model judgment (grounded-answer quality) — exercised live in `e2e.sh` step 9                |

Mental model: **unit = parse/guards · data-mechanics = persistence + access · integration =
routing/auth · neo4j = the graph's tier wall against a real graph · eval = model judgment.** Don't let a tier that stubs the model + clean inputs give
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
_internal_ (separating teams _within_ one org's DB) and only matters if an instance hosts more
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
npm run pg:schema      # load schema.sql + migrations into DATABASE_URL. LOCAL/CI use — prod is rolled out by the deploy's preDeployCommand, never by hand (see Deploy below)
npm run db:test:up     # RESET + start the test Postgres, then load schema (migrate-from-zero = replay guard)
npm run test:datamechanics  # real-Postgres tier: persistence + tier isolation
npm run test:datamechanics:iso  # SAME tier, PER-WORKTREE isolated container (see below)
bash scripts/e2e.sh    # system-level integration: seed → push → materialize → 422 → pull → live query
```

- **Parallel worktrees + the dm tier — use `test:datamechanics:iso`.** `test:datamechanics:local`
  points every worktree at the ONE shared compose container (`localhost:5434`), so when two
  Conductor worktrees run the dm tier at once they contend on the same rows/locks and Postgres
  aborts transactions — surfacing as `deadlock detected` + `null.id` seed failures that read like
  product bugs but are pure collision. `npm run test:datamechanics:iso [files…]`
  (`scripts/dm-isolated.sh`) gives THIS worktree its own throwaway Postgres — a per-worktree-named
  container on a **docker-assigned** port (so two worktrees can't pick the same "free" port) —
  created + schema-loaded on first use and reused after; `npm run db:test:iso:down` removes it.
  Prefer `:iso` whenever another worktree might be running dm.

- **`db:test:up` is a RESET, and is re-runnable against any state.** It runs
  `scripts/db-test-up.sh`: `docker compose down -v` → `up -d --wait` → `pg:schema`. Compose `up`
  on an already-running container is a no-op, so without the explicit reset the schema replayed
  onto whatever the last run left behind — not the from-zero replay proof this command exists for,
  and able to abort part-way on the PRET-6 production guard (`PRET-6 refused: permissive team(s)
  remain`) because the dm tier's PRET-6 test re-adds the retired `teams.access_enforcement` column
  at its `'permissive'` default and the harness truncates ROWS, not DDL. **The guard is correct and
  unchanged** — it protects a real fleet (docs/RELEASE-NOTES-pret6.md); what changed is that a
  local test DB no longer takes a production-upgrade path with no way back to clean. Two things
  follow: the reset is **destructive to the shared :5434 DB** (use `:iso` if someone else may be
  running against it), and a failed schema load now **removes the container** instead of leaving it
  up half-loaded.

- **Schema:** canonical = `postgres/schema.sql` (idempotent; `npm run pg:schema` loads it, and the
  DEPLOY runs it as Railway's `preDeployCommand` — it is not a manual prod step, see Deploy above). Additive deltas live in `postgres/migrations/` (the only
  migrations directory; guarded by the `migrations-numbering` guard).
- **Adding a COLUMN to an existing table:** `schema.sql` is `create … if not exists`, so editing the
  `create table` body is a **no-op on a DB that already has the table** — prod keeps the old shape.
  Put the `alter table … add column if not exists` in **`postgres/migrations/`** (applied by
  `pg:schema` after `schema.sql`, in filename order) **and** mirror it into `schema.sql` for
  from-zero. See `postgres/migrations/README.md`. (A brand-new table needs no migration —
  `create table if not exists` in `schema.sql` covers it.)
- **Deploy:** Postgres on Railway (self-host portable). **Deploys happen ONLY by pushing a branch a Railway environment
  tracks.** There have been two environments since AIO-483; the 2026-09-06 cutover changed WHICH ONE
  ordinary merges reach — and that is the part this line used to get dangerously wrong. It said "ONLY by merging to `main`", so an agent that merged to `staging` (now
  the contribution base, where ordinary work lands) would have run the **production** schema load for code
  that is not on `main`.
  - **`staging` → the STAGING environment.** Ordinary merges land here. Its own Postgres, its own
    schema load; nothing to do against prod.
  - **`main` → PRODUCTION.** Post-cutover `main` advances only by fast-forward to a tagged release
    (`docs/RELEASING.md` §2 step 5).

  ⛔ **DO NOT run `npm run pg:schema` against prod by hand. `railway.json` already runs it as the
  `preDeployCommand`, from the DEPLOYED ARTIFACT'S tree.** A manual run reads YOUR checkout —
  `loadSchema({ cwd = process.cwd() })` in `scripts/pg-load-schema.mjs` — and post-cutover your checkout
  is routinely AHEAD of the release: tag `A` ships, local `staging` is already at `B`, and the manual
  run applies **B's unreleased migrations to production**. Pre-cutover this was near-safe because
  `main` was what you had just merged; the cutover is exactly what made it dangerous, and an earlier
  version of this very section still said to do it.

  **Instead, verify the release deployed:** confirm a new build started for the tagged commit and that
  its preDeploy step succeeded. If a manual load is ever genuinely required, `git checkout` the exact
  release tag first and say so out loud — the guarantee you need is that the tree equals the tag.

  Either way, **confirm the platform started a new build** (`railway deployment list`) — webhooks are
  silently dropped in practice, twice on 2026-09-05 — and re-trigger from the Railway dashboard if the
  latest deploy predates the push. **Deleting a Railway variable does NOT restart the container**: the
  running process keeps the old environment until something triggers a deploy.
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
- **⛔ NEVER run `railway up` / `railway redeploy` / `railway down` / `railway delete` / `railway ssh`.** The Railway CLI is
  **read-only** here (`status`, `logs`, `variables`, `deployment list`, `connect`). `ssh` joined the list for a
  DIFFERENT reason than the four deploy verbs (STGENV-4): it deploys nothing, but it opens a **write-capable shell
  inside a running container**, where `GRAPHITI_URL` plus one request is an unscoped whole-graph wipe against a
  sidecar that has no authentication. The staging graph-reset runbook uses it deliberately and is marked
  human-only — `docs/OPS.md` §11. A shell is read-only only if you never type anything into it. `railway up` deploys the current
  worktree's code to whatever project that directory is _linked_ to (`~/.railway/config.json`, keyed by
  absolute path) — and a Conductor worktree that drifted to the wrong link (an aios worktree linked to an
  unrelated project) once shipped this repo's code into that project and took it down (2026-06-27, the
  cross-project deploy incident). The GitHub-merge path is bound
  to the right project and cannot do that. This is **guarded**: `.claude/settings.json` denies those verbs +
  a PreToolUse hook (`scripts/railway-deploy-guard.sh`) blocks them (incl. `cd other && railway up`). Before
  _any_ Railway command, confirm `railway status` shows **Project: AIOS**; audit all worktrees with
  `bash scripts/railway-link-check.sh`.
- **Runtime backstop (`scripts/service-guard.mjs`).** The hook above only fires inside the agent's shell; it
  can't stop a human `railway up` or any other path that lands this code on a service it doesn't belong on. So
  the schema loaders (`pg-load-schema.mjs` = the `preDeployCommand`, and `pg-load-vector.mjs`) call
  `assertServiceIdentity` **before** connecting: on an AIOS deploy whose `RAILWAY_SERVICE_NAME` isn't an AIOS
  service (`aios` / `aios-*`, override via `AIOS_RAILWAY_SERVICES`), the load aborts non-zero and Railway halts
  the release. **It enforces only on deploys it can identify as AIOS's** — `RAILWAY_PROJECT_ID` matching AIOS's
  project (platform-injected, so it can't be pruned away and silently disable production protection), or an
  explicit `AIOS_RAILWAY_SERVICES`. That scoping is not timidity: this repo is public and self-hosted, and an
  unconditional check would turn "I named my Railway service after my company" into an unrecoverable failed
  release from a pre-deploy hook. The cross-**project** case is out of its reach by construction (that deploy
  inherits the other project's env) and belongs to the layers above. Read the module header before changing the
  marker; guarded by `test/guards/service-guard.test.ts`.
- **Demo seeding is opt-in on a public URL (`docker/bootstrap.mjs` + `scripts/setup/deploy-policy.mjs`).** The
  demo admin is a documented credential in a public repo, so on a production build whose `APP_URL` isn't
  localhost the demo seeds only for an explicit `SEED_DEMO=true` (and then with a generated password). Local
  `docker compose up` is unchanged. `TEAM_SLUG` is normalised (`Acme Corp` → `acme-corp`) and the change is
  reported, because a rejected slug used to mean die() → restart loop → failed deployment.

---

## 7. Choosing what to guard (meta-rule)

Build scaffolding upfront; build **guards and invariants reactively** — each must trace to a real
bug or a real contract. A guard with no failure mode behind it is ceremony. When you change a
class of thing the docs/contract describe, ask: _"is there a guard that would catch this drift,
and if not, that's what to build."_
