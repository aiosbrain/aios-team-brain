---
access: team
---

# NEO4JCI-1 — the real-Neo4j tier runs in CI (and its wiring is guarded)

Deps: GRAPHSAT-1 (PR #633 — it repaired the tier's seven rotted assertions and added the four
lookup arms; this slice makes that tier fail the build when it breaks again). Build-with: fable /
medium (a CI job + a wiring guard; the risk is a guard that greens on nothing). Reviewers: Codex
gpt-5.6-sol on the spec and the diff; Fable on the diff.

## 0. What and why

`test/graph-neo4j-tier.test.ts` is the ONLY behavioural proof that graph tier isolation holds:
Graphiti has no tier awareness, `group_id` in the Cypher is the sole enforcement, and there is no
RLS backstop (CLAUDE.md §5). Since GRAPHSAT-1 it is also the only real-database proof of the
per-item episode lookup that now drives ledger mutations. It self-skips unless `NEO4J_TEST=1`
(`test/graph-neo4j-tier.test.ts`), `npm test` therefore reports it as skipped, and no job in
`.github/workflows/ci.yml` sets the variable or starts a Neo4j — so it runs only when a developer
remembers `npm run db:test:neo4j:up && npm run test:neo4j`.

**Measured rot.** `recentFacts` changed its return shape to `{ facts, ok }` on **2026-07-26**; the
test file's last change before GRAPHSAT-1 was #330. Seven of its eleven assertions were red for
~4 weeks — `facts.map is not a function` — and nothing saw it until GRAPHSAT-1 ran the tier by hand
on 2026-08-21. The repair was three lines; the invisibility was the defect. A tier that proves the
access invariant must fail the build when it breaks (CLAUDE.md §2.2: "a build-failing guard >
discipline you have to remember"; §7: a guard must trace to a real bug — this one does).

The unit guard `test/guards/graph-tier-filter.test.ts` is the fast SOURCE check (every Cypher block
carries its scope term); it cannot see a wrong property name, a driver upgrade, or a shape change in
what the module returns. Only the real tier can.

## 0b. Decidables

- **D1 — a dedicated CI job, not a step bolted onto the dm job.** `neo4j-tier-tests` in `ci.yml`
  with a `neo4j:5.26.2` service container (the SAME image `compose.test.neo4j.yml` pins, so local
  and CI prove the same server), `NEO4J_AUTH=neo4j/testtest1`, port `7688:7687` (matching the
  `test:neo4j` npm script, which is the single owner of the env incantation — the job runs
  `npm run test:neo4j`, never a hand-written env line), with a `cypher-shell` health check so the
  tests start only against a ready server. Separate job because the dm job is already the long
  pole and a Neo4j boot (~20 s) must not lengthen it, and because a red Neo4j job must read as
  "the graph tier broke", not "dm broke".
- **D1b — the dedicated job FAILS ON SKIP (Codex design round 1 HIGH).** A static guard can
  prove a job exists and a script has a string; it cannot prove the tier RAN. So the dedicated
  job sets a sentinel, `NEO4J_TIER_REQUIRED=1`, and the tier file throws AT COLLECTION when the
  sentinel is set but the tier is not enabled — a behavioural red, not a source-regex red. ONE
  predicate, `neo4jTierEnabled = process.env.NEO4J_TEST === "1"`, drives BOTH the `describe`
  selection and the throw (round 2 M1: today's truthiness check would have let `NEO4J_TEST=0`
  run the tier while the sentinel rejected it). `npm test`
  / `npm run coverage` (the `brain-tests` job, deliberately without Neo4j) never set the sentinel
  and keep the silent `describe.skip`; a developer without Neo4j still sees a green `npm test`.
  The wiring guard asserts the job sets the sentinel (D3).
- **D2 — the job is REQUIRED.** `main`'s required status checks gain `Graph Neo4j tier (real
  Neo4j)`. A required-check change is a repo setting (outward-facing, reversible) — it is made
  AFTER the PR merges and the job has run green once on `main`. An in-repo test cannot
  self-enforce branch protection (reading it needs admin scope, and a check not itself required is
  bypassable — the honest ceiling is operator action plus VERIFIED closure, Codex round 1 M3): the
  PR body carries the step, the ticket row stays `in_progress` until the required-check list has
  been read back with the new name in it, and only then closes. Precedent followed, then
  documented stale: ARCHITECTURE:795 still says the NDA gate "must be added" while today's list
  shows it IS — noted, not corrected here (round 2 L1: unrelated). Until the step lands the job runs and
  reports; it cannot block.
- **D3 — the wiring is GUARDED, because "it's in CI" is the claim that rotted last time.** A unit
  guard `test/guards/neo4j-tier-wiring.test.ts` parses `ci.yml` AND `compose.test.neo4j.yml`
  STRUCTURALLY with `yaml` (declared as a direct devDependency — it is in the tree only
  transitively today, and a guard must not ride another package's dependency graph; Codex round 1
  M1 — a regex over the whole workflow cannot associate a service and a run step with the SAME
  job and mishandles multiline `run`, reordered fields and duplicate strings). The validator is a
  PURE function over the two parsed objects + `package.json` (`validateNeo4jTierWiring(ci,
  compose, pkg)` → a list of violations), so it is mutation-tested as data, not by editing files.
  It asserts: (a) `jobs["neo4j-tier-tests"]` exists with the exact check name `Graph Neo4j tier
  (real Neo4j)`; (b) a step whose `run` is exactly `npm run test:neo4j`; (c) `services.neo4j`
  exists and its `image`, `NEO4J_AUTH` and the bolt port mapping EQUAL compose's (read from the
  compose object — the service contract is more than the image, Codex round 1 M2: auth/port drift
  reads as a red tier, but a deleted health check reads as a timing flake); (d) the health
  contract is NORMALIZED, not equated (round 2 M2 — compose has a `healthcheck` object, Actions
  has Docker flags in `options`): the `options` string must carry `--health-cmd` containing
  compose's probe command (`cypher-shell -u neo4j -p testtest1 'RETURN 1'`) and
  `--health-interval`/`--health-timeout`/`--health-retries` equal to compose's `interval`/`timeout`/
  `retries` values; (e) the job's `env` sets `NEO4J_TIER_REQUIRED: "1"` (D1b); (f) the npm script
  is checked EXACTLY (round 2 HIGH: the tier's `beforeAll` is destructive, so "contains
  `bolt://localhost:`" would pass a script with a second, later `NEO4J_URL=` assignment pointing
  elsewhere): the validator parses the script's leading `KEY=value` words and requires exactly one
  `NEO4J_URL` = `bolt://localhost:7688`, `NEO4J_TEST` = `1`, `NEO4J_USER` = `neo4j`,
  `NEO4J_PASSWORD` = `testtest1`, and the command `vitest run graph-neo4j-tier`. Non-vacuity arms
  mutate the PARSED objects, ONE per invariant (round 2 M5): job deleted; check name changed; run
  step removed; service removed; image drift; `NEO4J_AUTH` drift; port drift; health cmd drift;
  health retries drift; sentinel removed; script URL duplicated/pointed elsewhere; `NEO4J_TEST`
  dropped; user/password drift; filter changed — each yields exactly its named violation. Folded
  from the two diff reviews: the validator ALSO rejects what turns the job green without running
  or without mattering — job/step `if`, job/step `continue-on-error`, a step env blanking the
  sentinel (Fable M1), `needs` (a skipped prerequisite makes this job report SUCCESS to branch
  protection — Codex M1), and a `shell` override at workflow/job/step scope (Codex M2); the
  health command is compared by normalized EQUALITY, not `includes` (Codex L1: `true # probe`).
  31+ arms in total, one per violation code; two compound arms assert their full code sets.
- **D4 — the tier's own cleanliness.** The tier's `beforeAll` wipes the graph (`MATCH (n) DETACH
  DELETE n`) — fine against a throwaway service container, and the job must never be pointed at
  anything else: the guard asserts the npm script's URL is `bolt://localhost:` (D3(f)). No change
  to the tier's ASSERTIONS in this slice; its header comment ("this tier is not in CI") becomes
  false and is rewritten (Codex round 1 L2).

## 1. The surface table

| Surface | Change |
|---|---|
| `.github/workflows/ci.yml` | new job `neo4j-tier-tests` ("Graph Neo4j tier (real Neo4j)"): neo4j service (image/auth/port/health = compose), `env.NEO4J_TIER_REQUIRED: "1"`, `npm ci`, `npm run test:neo4j` |
| `test/graph-neo4j-tier.test.ts` | throws at collection when `NEO4J_TIER_REQUIRED=1` and `NEO4J_TEST !== "1"`; header comment corrected |
| `scripts/neo4j-tier-wiring.mjs` (new file, to create) | `validateNeo4jTierWiring(ci, compose, pkg)` — pure, returns violations |
| `test/guards/neo4j-tier-wiring.test.ts` (new file, to create) | parses the real files with `yaml`, asserts zero violations; mutation arms over the parsed objects |
| `package.json` + `package-lock.json` | `yaml` as a direct devDependency, lockfile updated by `npm install` (round 2 M3: it is only Vite's optional peer today; `npm ci` rejects a package/lock mismatch) |
| `docs/ARCHITECTURE.md` | CLAUDE.md §4's tier table is in CLAUDE.md; ARCHITECTURE's test-tier prose gains the Neo4j tier row + "runs in CI" |
| `CLAUDE.md` §4 | the tier table gains the **neo4j** tier (real Neo4j; catches Cypher/shape/driver drift) |
| Schema | **NONE** |

## 2. Mechanism notes

- The service container is reachable at `localhost:7688` from the runner's steps (port mapping,
  like the Postgres service at `5434`). The tier's driver connects with `NEO4J_USER=neo4j`,
  `NEO4J_PASSWORD=testtest1` — test-only credentials already committed in `compose.test.neo4j.yml`
  and `package.json`; nothing new is secret.
- Neo4j 5 community starts in ~15–25 s on a GitHub runner; the health check
  (`cypher-shell -u neo4j -p testtest1 'RETURN 1'`) with `--health-retries 40` at 3 s mirrors
  the compose file.
- The job needs no Postgres and no build; `npm ci` + the one vitest filter. Expected wall time
  under a minute.

## 3. Acceptance criteria (spec-first; exact commands)

1. `npx vitest run test/guards/neo4j-tier-wiring.test.ts` exits 0: the real `ci.yml` +
   `compose.test.neo4j.yml` + `package.json` validate with ZERO violations against D3(a)–(f); and
   one non-vacuity arm per violation code over the parsed objects (job/step conditionals and
   continue-on-error, needs, shell overrides at three scopes, sentinel removal/override, service
   image/auth/port/health drifts incl. a commented-out probe, every npm-script field incl. a
   duplicated URL) — each yields exactly its named code(s) and nothing else.
1b. `NEO4J_TIER_REQUIRED=1 npx vitest run graph-neo4j-tier` (NO `NEO4J_TEST`) exits NON-zero with
   the collection error naming both variables — the fail-on-skip contract (D1b); and plain
   `npx vitest run graph-neo4j-tier` (neither set) exits 0 with 15 skipped (a developer without
   Neo4j is not reddened).
2. `npm run test:neo4j` (after `npm run db:test:neo4j:up`) exits 0 locally — 15/15 (unchanged
   assertions).
3. CI on the PR shows the new job **`Graph Neo4j tier (real Neo4j)`** green with 15 passed, 0
   skipped — and by D1b a job that somehow ran without `NEO4J_TEST` would be RED (collection
   error), not green-with-15-skipped.
4. Mutations, verdicts verbatim in the PR (via `scripts/mutate.mjs`): (a) make the validator skip
   the run-step check → the guard's mutation arm reddens; (b) make the tier's collection throw
   conditional on nothing (never throw) → AC1b's red arm goes green = the guard for it reddens
   (pinned by a unit that spawns the local vitest entrypoint on the exact tier path with a
   CONSTRUCTED env — `NEO4J_TIER_REQUIRED=1`, `NEO4J_TEST` explicitly DELETED, not inherited from
   a developer's shell (round 2 M4) — with a timeout, asserting non-zero exit AND the
   collection-error text);
   (c) drop `NEO4J_TEST=1` from the npm script → the real-file validation reddens.
5. `npm test` · `npm run check:docs` green; CLAUDE.md §4 + ARCHITECTURE updated in the same PR.
6. Post-merge operator step, stated in the PR body AND tracked on the ticket (it stays
   `in_progress` until closed): add `Graph Neo4j tier (real Neo4j)` to `main`'s required status
   checks once it has run green on `main`, then READ BACK the required-check list
   (`gh api repos/…/branches/main/protection/required_status_checks`) and record the name in the
   ticket. (The stale NDA sentence at ARCHITECTURE:795 is NOT this slice's — round 2 L1; noted
   for a docs cleanup.)

## 4. Out of scope, named

- Running the tier against the deployed graphiti image's Neo4j (a different question — the
  server our Dockerfile builds; `compose.test.neo4j.yml` already pins the same major).
- A generic "every test file on disk runs somewhere" guard (the `test-ci-wiring-audit` skill covers
  it as an audit; a build-failing generic guard is its own record).
- Any change to the tier's assertions, the learning queries, or the lookup.
