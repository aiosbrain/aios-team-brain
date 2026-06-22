# Contributing — AIOS Team Brain

Thanks for building AIOS. This file is the human checklist for landing a change in the brain. Get
it running first with [`DEVELOPMENT.md`](DEVELOPMENT.md). The authoritative, agent-facing
conventions are in [`AGENTS.md`](AGENTS.md) — read it; the rules below are the short version a
reviewer will hold you to.

## The five things that gate a PR

1. **Work in a git worktree, never a feature branch in the primary checkout.** People work in the
   primary checkout concurrently; committing feature work there collides with them. From the repo:
   ```bash
   git fetch origin
   git worktree add -b feat/<short-task> ../aios-team-brain-<short-task> origin/main
   cd ../aios-team-brain-<short-task>
   ln -sfn ../aios-team-brain/node_modules node_modules   # share deps (or run npm install)
   ```
   Open the PR from the worktree branch; `git worktree remove <path>` after it merges.

2. **Spec-first tests, in the right tier.** Write the assertion from what the product *should* do
   (the brain-api contract, the tier intent, a scenario) — then run it. A spec-derived test that
   goes red found a real gap. Don't write tests that read the implementation and assert what it
   already does. Pick the tier that catches the failure mode (unit / data-mechanics / integration —
   see [`DEVELOPMENT.md`](DEVELOPMENT.md#tests--which-tier-catches-what) and [`AGENTS.md` §4](AGENTS.md)).
   Anything touching the DB or access control needs a **data-mechanics** test on real Postgres.

3. **Update the architecture map in the same PR.** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is
   the single fast reference for *where data lives, who writes it, who reads it*. Consult it before
   building; update it after. If you add/remove an API route, a table, or an ingestion source, update
   the `<!-- drift:* -->` blocks too or `npm run check:docs` (CI + the pre-push hook) fails.

4. **Respect the single-writer + tier invariants — there is no RLS backstop on Postgres.** Each
   sensitive table has exactly one legal writer module (e.g. `lib/ingest` for `items`,
   `lib/integrations/manage` for `integrations`) guarded by a build-failing test; don't write around
   it. Tier isolation (an `external`-tier principal never reads `team`/`admin` content; `admin`-tier
   content never crosses the API — 422) is enforced **in app code** and guarded. New read surfaces
   must add their own app-code gate + a guard test; new write paths must route through the owner.

5. **Green before you open it.** Run, and paste the output in the PR:
   ```bash
   npm run lint
   npm test                         # unit tier
   npm run check:docs               # drift guard
   npm run db:test:up && npm run test:datamechanics:local   # if you touched the DB / access
   ```

## The sync contract is pinned — don't drift it

`aios-workspace/docs/brain-api.md` is the **pinned `/api/v1` contract** between the brain and the
`aios` CLI. A protocol change is a *versioned* change in that file first — never a code change in
one repo that silently diverges. Additive, gracefully-degrading changes stay in v1; breaking
changes bump the major version.

## Where to start

- **Run it:** [`DEVELOPMENT.md`](DEVELOPMENT.md).
- **Understand it:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §1 (the sources-of-truth table),
  then the flow for the area you're changing.
- **Conventions:** [`AGENTS.md`](AGENTS.md) (test tiers, the build loop, access-control stance).
- **Pick something:** the GitHub issue tracker (look for `good first issue`), or ask a maintainer
  which Wave/epic needs hands.

## PR hygiene

- Branch name: `feat/…`, `fix/…`, `docs/…`, `test/…`, `chore/…`.
- Keep PRs small and single-purpose; describe the change and **paste verification output**.
- Don't commit secrets (no real DSNs, tokens, or `.env*`). Don't add a Vercel-only dependency —
  the brain is self-host portable (plain SQL schema, Postgres-backed rate limiting).
- Label status honestly: ✅ done-and-verified / 🟡 partial / 🔴 blocked. Never claim done without
  a green test or the observable outcome.

## Code of conduct

Be kind and direct. This is real work for real teams — assume good faith, prefer the durable fix
over the quick one, and leave the map (and the tests) better than you found them.

Maintainer: John Dass — iamjohndass@pm.me
