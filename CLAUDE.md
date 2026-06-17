@AGENTS.md

# AIOS Team Brain — operating manual

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
   product *should* do (the brain-api contract, the tier/RLS intent, a scenario), then run it.
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
| **integration** | API route handlers over a real DB + the system-level `scripts/e2e.sh` | routing, auth, tier-422, the cross-process sync loop |
| **eval** *(not built)* | real model API | model judgment (grounded-answer quality) — exercised live in `e2e.sh` step 9 |

Mental model: **unit = parse/guards · data-mechanics = persistence + access · integration =
routing/auth · eval = model judgment.** Don't let a tier that stubs the model + clean inputs give
false confidence for a data-pipeline change — put that test in data-mechanics.

**Why the real-DB tier matters:** the legacy in-memory `lib/ingest/fake-supabase.ts` is fast and fine
for orchestration shape, but it has no constraints, triggers, or the `search` generated column — so it
cannot verify persistence or access to the observable outcome. The real-Postgres data-mechanics tier
(`npm run db:test:up && npm run test:datamechanics`) is **built** and is authoritative for those.

---

## 5. Access control — what RLS is (and isn't) for here ⚠️

**Deployment model:** AIOS is **self-hosted per organization** — each org runs its own instance
against its own database; all rows belong to that one org. So there is **no shared multi-tenant
DB**, and cross-organization isolation is **not** a concern. The `team_id` scoping in the RLS
policies is purely *internal* (separating teams *within* one org's DB) and only matters if an
instance hosts more than one team.

**What still matters regardless of multi-tenancy: TIER isolation.** An `external`-tier principal
(a client/consultant collaborator) must never read `team`/`admin` content; `admin`/`private`
content never leaves the workspace. This is a product feature (the `external` API tier, OKF link
redaction), independent of multi-tenancy, and it must hold on **both** backends:

- **`postgres`** (the default + deployed target, Railway) — there is **no RLS**; tier isolation is
  enforced **entirely in app code**. A missing `access`/tier filter has **no DB backstop**.
- **`supabase`** (legacy opt-in) — the `items` RLS policy enforces tier isolation in the DB
  (`my_tier(team)='team' OR access='external'`); the app-code checks are then defense-in-depth.

So: RLS is just *the legacy supabase mechanism* for tier isolation — **tier isolation itself is a
standing invariant** that the app code must guarantee on the postgres target.

> ✅ **Enforced (was a known gap, now closed):** API routes and `lib/query/retrieve.ts` re-apply the
> tier filter, and dashboard server-component reads (`app/t/[team]/*`) route through the
> **`lib/auth/visibility` choke-point** (`visibleItems`/`canSeeAccess`) — guarded by
> `test/guards/dashboard-tier-filter.test.ts` and proven by the data-mechanics tier. New dashboard
> surfaces (e.g. Codebases) must add their own app-code tier gate + guard; there is no RLS backstop.

---

## 6. Stack & key commands

- **Brain:** Next.js 16 (App Router) · React 19 · TypeScript · Vitest. DB via the `lib/db/pg` adapter
  (default; Postgres on Railway) or `@supabase/supabase-js` (legacy). LLM/reranker are
  provider-configurable (`docs/PROVIDERS.md`).
- **Sidecar:** `ingestion/` — Python connector service (LlamaHub/Unstructured), HTTP-only to the brain.

```bash
npm run dev            # next dev (DB_BACKEND=postgres by default)
npm test               # vitest (unit tier)
npm run check:docs     # docs drift guard (also runs in CI + pre-push)
npm run lint           # eslint
npm run pg:schema      # load postgres/schema.sql (canonical) into DATABASE_URL — also the prod rollout step
npm run db:test:up     # ephemeral test Postgres + load schema (migrate-from-zero = replay guard)
npm run test:datamechanics  # real-Postgres tier: persistence + tier isolation
bash scripts/e2e.sh    # system-level integration: seed → push → materialize → 422 → pull → live query
# legacy supabase backend only (DB_BACKEND=supabase): `supabase start` / `supabase db reset`
```

- **Schema:** canonical = `postgres/schema.sql` (idempotent; `npm run pg:schema` loads it and is the
  prod rollout step against Railway). `supabase/migrations/` is the **legacy/derived** RLS schema, used
  only when `DB_BACKEND=supabase`; its `migrations-numbering` guard is now legacy-scoped.
- **Deploy:** Postgres on Railway (self-host portable). After a merge, run `npm run pg:schema` against
  prod for any schema change, and **confirm the platform started a new build** (CI webhooks can be
  silently dropped); re-trigger if the latest deploy predates the merge.

---

## 7. Choosing what to guard (meta-rule)

Build scaffolding upfront; build **guards and invariants reactively** — each must trace to a real
bug or a real contract. A guard with no failure mode behind it is ceremony. When you change a
class of thing the docs/contract describe, ask: *"is there a guard that would catch this drift,
and if not, that's what to build."*
