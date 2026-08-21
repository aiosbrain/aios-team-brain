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
per-item episode lookup that now drives ledger mutations. It self-skips unless `NEO4J_TEST` is set
(`test/graph-neo4j-tier.test.ts:13`), `npm test` therefore reports it as skipped, and no job in
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
- **D2 — the job is REQUIRED.** `main`'s required status checks gain `Graph Neo4j tier (real
  Neo4j)`. A required-check change is a repo setting (outward-facing, reversible) — it is made
  AFTER the PR merges and the job has run green once on `main`, and it is stated in the PR as the
  operator's follow-through, not assumed. Until then the job runs and reports; it cannot block.
- **D3 — the wiring is GUARDED, because "it's in CI" is the claim that rotted last time.** A unit
  guard `test/guards/neo4j-tier-wiring.test.ts` parses `ci.yml` and asserts: a job exists whose
  steps run `npm run test:neo4j`; that job declares a `neo4j:` service whose image equals the one
  in `compose.test.neo4j.yml` (read from the file, not restated); and `package.json`'s
  `test:neo4j` script still sets `NEO4J_TEST=1` and targets `graph-neo4j-tier`. Non-vacuity: each
  assertion is shown to redden on a mutated copy of the workflow text (a job with the service but
  no run step; a run step with no service; an image drift). Also: the tier file's `describe.skip`
  fallback stays (a developer without Neo4j must not see a red `npm test`), and the guard asserts
  the skip is keyed on `NEO4J_TEST` exactly as the npm script sets it — the two halves of the
  contract pinned together so they cannot drift apart silently again.
- **D4 — the tier's own cleanliness.** The tier's `beforeAll` wipes the graph (`MATCH (n) DETACH
  DELETE n`) — fine against a throwaway service container, and the job must never be pointed at
  anything else: the guard also asserts the job's `NEO4J_URL` (via the npm script) is a
  `localhost` bolt URL. No change to the tier's assertions in this slice.

## 1. The surface table

| Surface | Change |
|---|---|
| `.github/workflows/ci.yml` | new job `neo4j-tier-tests` ("Graph Neo4j tier (real Neo4j)"): neo4j service, `npm ci`, `npm run test:neo4j` |
| `test/guards/neo4j-tier-wiring.test.ts` (new file, to create) | the wiring guard (D3/D4), with mutation arms over workflow text |
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

1. `npx vitest run test/guards/neo4j-tier-wiring.test.ts` exits 0: (a) `ci.yml` has a job whose
   `steps[].run` includes `npm run test:neo4j`; (b) that job's `services.neo4j.image` equals the
   image in `compose.test.neo4j.yml`; (c) `package.json` `scripts["test:neo4j"]` contains
   `NEO4J_TEST=1`, a `bolt://localhost:` URL, and `graph-neo4j-tier`; (d) the tier file keys its
   skip on `process.env.NEO4J_TEST`; (e) non-vacuity arms: a workflow text with the run step but
   no service → red; with the service but no run step → red; with a different image → red.
2. `npm run test:neo4j` (after `npm run db:test:neo4j:up`) exits 0 locally — 15/15 (unchanged
   assertions).
3. CI on the PR shows the new job **`Graph Neo4j tier (real Neo4j)`** green with 15 passed, 0
   skipped (the job's vitest output is the proof the tier RAN, not merely that the job exists — a
   `NEO4J_TEST` unset in the job would show 11 skipped and green; AC1(c) plus this line catch it).
4. Mutations, verdicts verbatim in the PR: (a) delete the run step from the job → AC1(a) reddens;
   (b) change the service image tag → AC1(b) reddens; (c) drop `NEO4J_TEST=1` from the npm script
   → AC1(c) reddens.
5. `npm test` · `npm run check:docs` green; CLAUDE.md §4 + ARCHITECTURE updated in the same PR.
6. Post-merge operator step, stated in the PR body: add `Graph Neo4j tier (real Neo4j)` to
   `main`'s required status checks once it has run green on `main`.

## 4. Out of scope, named

- Running the tier against the deployed graphiti image's Neo4j (a different question — the
  server our Dockerfile builds; `compose.test.neo4j.yml` already pins the same major).
- A generic "every test file on disk runs somewhere" guard (the `test-ci-wiring-audit` skill covers
  it as an audit; a build-failing generic guard is its own record).
- Any change to the tier's assertions, the learning queries, or the lookup.
