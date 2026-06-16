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
| **data-mechanics** *(planned)* | **real Postgres, stubbed model** | persistence & access: write→store→read, dedup, diff-sync, tier isolation |
| **integration** | API route handlers over a real DB + the system-level `scripts/e2e.sh` | routing, auth, tier-422, the cross-process sync loop |
| **eval** *(not built)* | real model API | model judgment (grounded-answer quality) — exercised live in `e2e.sh` step 9 |

Mental model: **unit = parse/guards · data-mechanics = persistence + access · integration =
routing/auth · eval = model judgment.** Don't let a tier that stubs the model + clean inputs give
false confidence for a data-pipeline change — put that test in data-mechanics.

**The current gap:** brain tests run against an in-memory `lib/ingest/fake-supabase.ts`. That is
fast and fine for orchestration shape, but it has no RLS, constraints, triggers, or the `search`
generated column — so it cannot verify persistence or access to the observable outcome. The
real-DB data-mechanics tier (in progress) is authoritative for those.

---

## 5. Dual backend — the access-control parity invariant ⚠️

The brain runs on **two interchangeable backends**, selected by `DB_BACKEND`
(default `supabase`; `postgres` for self-host). A query-builder makes the data API identical, but
**access control is enforced differently**, and that is the sharpest risk in the codebase:

- **`supabase`** — tier/team isolation is enforced by **Postgres RLS** in the DB; app-code checks
  are defense-in-depth.
- **`postgres`** — there is **no RLS**; isolation is enforced **entirely in app code** (the auth
  guard + the `access`/tier filters in queries). A missing filter has **no DB backstop**.

**Invariant (must hold on BOTH backends): an `external`-tier principal never reads `team`/`admin`
content; `admin`/`private` content never leaves the workspace.** When the data-mechanics tier
lands, every access assertion is run against **both** backends — a parity gate. Treat any
access-control change as dual-backend until proven otherwise.

> Status: the dual-backend implementation lands via the `dual-db-backend` PR. Until it is merged
> to `main`, the live code here is supabase-mode (RLS); this section is the standing contract the
> parity tier will enforce once both backends are on `main`.

---

## 6. Stack & key commands

- **Brain:** Next.js 16 (App Router) · React 19 · TypeScript · Vitest. DB via `@supabase/supabase-js`
  (and the pg query-builder in postgres mode). LLM/reranker are provider-configurable (`docs/PROVIDERS.md`).
- **Sidecar:** `ingestion/` — Python connector service (LlamaHub/Unstructured), HTTP-only to the brain.

```bash
npm run dev            # next dev
npm test               # vitest (unit tier)
npm run check:docs     # docs drift guard (also runs in CI + pre-push)
npm run lint           # eslint
supabase start         # local Supabase stack (db :55422, api :55421) — the e2e/data-DB target
supabase db reset      # migrate from zero (replay guard) + seed
bash scripts/e2e.sh    # system-level integration: seed → push → materialize → 422 → pull → live query
```

- **Migrations:** plain SQL in `supabase/migrations/` (timestamp-prefixed; applied transactionally
  by the Supabase CLI). `supabase db reset` migrates from zero — that's the replayability guard.
- **Deploy:** self-host portable (Railway/Vercel). After a merge, **confirm the platform started a
  new build** (CI webhooks can be silently dropped); re-trigger if the latest deploy predates the merge.

---

## 7. Choosing what to guard (meta-rule)

Build scaffolding upfront; build **guards and invariants reactively** — each must trace to a real
bug or a real contract. A guard with no failure mode behind it is ceremony. When you change a
class of thing the docs/contract describe, ask: *"is there a guard that would catch this drift,
and if not, that's what to build."*
