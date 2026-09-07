# Resetting staging's graph: the runbook ships, the service does not (STGENV-4)

Status: **the engineered reset is DECLINED for now.** Two designs were written and both were BLOCKED
twice, by two reviewers independently. What ships is the operator runbook that closes the hazard today
plus two guards, each tracing to something those reviews discovered. The engineered version moves to
STGENV-5, where it belongs with a real runner · Owner: chetan
· Tier build-with: unit (the guards) — no new runtime behaviour, no new capability

**Deps:** STGENV-3 merged (`d8c85c89`). **AIOS-Work:** STGENV-4.

---

## Problem

`scripts/staging-refresh.sh` touches **exactly one database**. It excludes `graph_episodes` DATA
(`scripts/staging-refresh-decision.mjs:76-85`), so staging's ledger comes back empty — and nothing
resets Neo4j. Once staging's graph is wired:

1. **Orphaned content.** Everything a previous run extracted stays in Neo4j with no ledger row owning
   it, and every delete path we have iterates `graph_episodes` — **the delete machinery is unreachable
   by construction after a refresh.**
2. **Duplicates, and paying for them.** `addEpisodes` does not overwrite by name
   (`lib/graph/reconcile.ts:134`), so the next bounded run re-pushes the overlap and Graphiti extracts
   it again.

---

## What ships

**1. An OPS §11 runbook step**: after a refresh, before re-projecting, a human clears staging's graph
with one command through the endpoint the sidecar already exposes.

**2. A guard that `/clear` is never a path literal in `lib/` or `scripts/`, except in the one
sanctioned owner.** The reviews found that
`POST /clear` is a **whole-graph wipe**, the sidecar carries **no auth at all**, and `GRAPHITI_URL` is
already in the app's environment — so an unscoped wipe has been one `fetch` away from the production
binary this whole time. Nothing in `lib/` calls it, and the one place that does — the runbook's
script — is named as the single owner, with a criterion that it still exists and that no app module
imports it.

**The first version of this guard enumerated call verbs and was evaded in seconds.** The review
dropped `this.post<void>("/clear", {})` into `lib/` — the idiomatic shape of the very client it
protects — and the guard stayed green, because a generic parameter sits between the method name and
the paren. My own mutation had used `` fetch(`${base}/clear`) ``, a shape nobody here writes. The rule
is now the **path**, not the caller: a string whose path ends at `/clear`, comments stripped. Prose
survives because prose keeps going (`"…and /clear between tasks"`), and `/clear-cache` is not
`/clear`.

**3. `railway ssh` added to the deny list.** The runbook step is human-only. The verb was in no list at all: the hook classified it
`allow · read-only` while the deny list refused it — two enforcement layers disagreeing. Both now
forbid it. This repo's own rule is guard > discipline (§2.2).

---

## Why the engineered reset was declined

Not because it is wrong — because two rounds of review turned a "wipe the graph" operation into a
service, and the thing it would automate is a command a human runs during a refresh they already run
by hand. STAGING-1 already ruled on exactly this: *"Ship it runnable by hand; schedule once it has been
boring."* The refresh is not yet boring.

Four findings are the substance, and each survives into STGENV-5 as a requirement:

- **Nothing in either design attested the graph being destroyed.** The `staging_marker` is a table in
  **Postgres**; the deletion happens in **Graphiti/Neo4j**. Adding `isStagingDeployment()` bound the
  platform, not the target — and **one event defeats both**: point staging's `GRAPHITI_URL` at a
  production sidecar given a public domain (one click, one variable). The binding that would work is
  refusing unless the host is `*.railway.internal`, plus gating on `RAILWAY_ENVIRONMENT_ID` rather than
  the operator-renameable name. Neither design had it.
- **The proposed script could not be built as specified.** "Pure node, `fetch` only" cannot take a
  Postgres advisory lease or read bolt, and `readStagingMarker`, `acquireProjectionLease`, `runRead`
  and the arc-cache helpers are TypeScript modules importing `server-only` — unreachable from a
  `.mjs`. The call-site pin and the execution shape contradicted each other.
- **The tier that would prove it has no sidecar.** `compose.test.neo4j.yml` and the CI job run
  `neo4j:5.26.2` only, so a `DELETE /group` route cannot be exercised there. Proving the wipe needs the
  upstream image added to the tier — a build-plan change, not a test.
- **The arc-cache fix was a 48-hour no-op.** `evictPartitionArcMemory()` mutates a module-local map, so
  calling it from a separate process evicts that process's empty cache; `priorArcs` is memory-first,
  and the empty-clobber guard holds a non-empty prior for up to 48h. The design changed nothing a user
  would see for two days.

---

## The runbook (OPS §11)

Ordering, and the reason for each step:

1. **Refresh Postgres** (`scripts/staging-refresh.sh`). The ledger comes back empty.
2. **Clear staging's graph** — one command, passing the remote command as ONE quoted argument, running
   `scripts/staging-graph-clear.mjs`.
3. **Restart the staging app**. Without it the serving process keeps a warm in-memory arc prior for up
   to 48h and will show pre-reset arcs as fresh — the caches are memory-first and no cross-process
   invalidation exists.
4. **Then** wire/keep `GRAPH_PROJECT_WINDOW_DAYS` and re-project.

**The command is a SCRIPT, not a shell line, and that is a correction.** The first version of this
slice put the whole thing inline in the runbook. The pre-push review proved — by running it — that it
never fired: the CLI joins everything after `--` with spaces and wraps the result in its own `sh -c`,
so an inner `sh -c 'echo … | grep … && curl …'` executed a bare `echo`, the grep saw an empty line, and
a **correctly configured** staging printed a refusal and exited 0. `curl` is not in the image either
(`node:20-bookworm-slim`, no `apt-get`). And `A && B || C` reported every request failure — sidecar
down, 5xx, missing binary — as "REFUSED: not an internal host", so the line called the whole safety
argument was also the line whose failure message lied.

A one-liner in a document cannot be tested. `scripts/staging-graph-clear.mjs` is the same operation
with `test/staging-graph-clear.test.ts` behind it: the host refusal, the endpoint construction, and
three distinct exit codes (0 cleared · 1 request failed · 2 refused) are all asserted, including that
a transport failure does **not** report as a host refusal.

**The host check parses, it does not substring-match.** `https://evil.com/?x=.railway.internal` and
`http://a.railway.internal.evil.com` both contain the suffix and are both refused.

**Do it in that order.** Clearing before the refresh leaves ledger rows whose graph content is gone,
which reconcile reads as mass disappearance and re-extracts. Clearing after re-projecting throws away
work just paid for.

**What this does not cover, stated rather than implied:** `POST /clear` wipes the WHOLE graph on that
sidecar, not a group — correct for staging, and the reason this must never become an app code path.
It also cannot be run while the sidecar's worker is still draining a pre-refresh queue; a late
`add_episode` will MERGE nodes back. There is no quiescence signal today, so the check is "re-run the
`curl` and see whether the graph comes back".

---

## Scope

**In:** the OPS §11 runbook step (ordering, the internal-host check, the restart, and what it does not
cover); a guard banning `/clear` as a request path in `lib/` and `scripts/`, with fixtures proving it
fires on the real shape and not on prose; `railway ssh` added to `.claude/settings.json`'s deny list
with a guard pinning it; a `docs/ARCHITECTURE.md` line naming the reset as an operator step.

**Cut, and handed to STGENV-5 with its four requirements above:** the engineered reset — the script,
the identity conditions, the enumeration, the lease, the ledger refusal, the self-verification, the
arc-cache invalidation, and the sidecar-in-the-neo4j-tier build change each of those would need.
Also cut: any change to `scripts/staging-refresh.sh` itself (it stays Postgres-only and says so), and
any automation or scheduling of the reset.

---

## Acceptance criteria

**The clear script (unit)**

1. It refuses unless `RAILWAY_ENVIRONMENT_NAME` is `staging`, and refuses when it is unset —
   asserted with an internal host, because the host check passes there and the point is that it
   proves the wrong thing alone. No request is issued.
2. It refuses unless `GRAPHITI_URL`'s host ends `.railway.internal`, PARSED not substring-matched:
   `https://evil.com/?x=.railway.internal` and `http://a.railway.internal.evil.com` both contain the
   suffix and both refuse.
3. The environment is checked BEFORE the URL, so a production shell is told the real problem.
4. Exit codes are distinct — 0 cleared · 1 request failed · 2 refused — and a transport failure
   reports `FAILED:` and NOT `REFUSED:`, asserted **per message** (a joined-string anchor cannot fail
   independently of the FAILED assertion).
5. The success path tells the operator about the restart, which the wipe alone does not accomplish.

**The guard (unit)**

6. `/clear` as a PATH LITERAL fails the build anywhere in the shipped binary — `lib/`, `scripts/`,
   `app/`, `components/`, `docker/` — except in the one sanctioned owner, which is asserted to still
   exist and to be imported by nothing in `lib/` or `app/`.
7. It fires on every evasion review found across four rounds: the generic form
   `this.post<void>("/clear", {})`, an ES2022 private method (`this.#post`), a trailing slash
   (`/clear/` — Starlette answers 307 and `fetch` follows it preserving POST, so a real wipe), a
   fragment, trailing whitespace the URL parser strips, a query string, a template expression after
   the path, the two-step `const p = "/clear"`, an uppercase scheme, the shell `${VAR%/}` and
   `${VAR#pat}` idioms, and an in-string ` // ` on the same line.
8. It stays silent on prose AND on ordinary product surface: the `/clear` in
   `lib/metrics/individual-maturity.ts`, a comment naming the endpoint, `/clear-cache`, and
   APPLICATION routes that merely end at the path (`"/api/notifications/clear"`,
   `<Link href="/settings/notifications/clear">`). The Graphiti endpoint is the ROOT path of a base
   URL; a route with segments before it is not it. Asserted, because a guard that reddens on honest
   feature work is a guard someone deletes.
9. The UNQUOTED shell form has its own fixture, so the shell branch is not silently dead — the quoted
   form is already caught by the path rule, which is how the first version's shell mutation was killed
   by a sibling.
10. `.claude/settings.json` denies the CLI's remote-shell verb, the policy module classifies it
    `block`, and the shipped hook exits 2 on it — including when chained — with a read-only verb still
    passing as a control. Two enforcement layers that disagree is the failure this pins.

**The docs (unit)**

11. `docs/OPS.md` §11 documents the reset, its ORDER (and what clearing early or late costs), the
    single-quoted-argument requirement, the script path, the internal-host check, and the restart —
    the last anchored to this section's own sentence, not a pre-existing "48h" elsewhere in the file.
12. It does not claim the reset is automated, scheduled, or safe mid-extraction.

---

## Mutation table

| # | mutation | must redden |
|---|---|---|
| MU1 | add `this.post<void>("/clear", {})` to a `lib/` module (review's own evasion) | C6 |
| MU1b | add a template-literal wipe to a `lib/` module | C6 |
| MU1c | add an UNQUOTED `curl … $GRAPHITI_URL/clear` to a shell script | C9 |
| MU1d | add `"/clear/"` — the 307 form | C7 |
| MU2 | relax the guard to a bare `/clear` substring ban | C8 (prose fixture) |
| MU3 | relax the guard to match nothing | C7 |
| MU3b | stop stripping comments | C8 |
| MU3c | strip comments with a regex instead of the quote-aware scanner | C7 (in-string ` // `) |
| MU3d | delete the `CLEAR_SHELL` branch | C7 (unquoted shell fixture) |
| MU3e | treat `#` as a comment in EVERY file type | C7 (`this.#post`) |
| MU3f | drop the root-path constraint | C8 (app-route negatives) |
| MU4 | drop the environment refusal from the script | C1 |
| MU4b | check the URL before the environment | C3 |
| MU5 | accept any host | C2 |
| MU6 | report a transport failure as `REFUSED:` | C4 |
| MU7 | delete the sanctioned owner script | C6 |
| MU8 | remove the deny entries | C10 |
| MU9 | remove the ordering paragraph from OPS §11 | C11 |
| MU10 | claim in OPS §11 that it is automated | C12 |
| MU11 | change `REQUIRED_ENVIRONMENT` so the two staging definitions disagree | C1 |

**Three of these exist because a FIX introduced them.** MU3e is the `#`-everywhere regression from
fixing shell scripts; MU3c is the regex comment-stripper an in-string ` // ` disarmed; MU3f is the
app-route false-positive class introduced by widening the scan. Each was found by review, not by me,
and each is now the mutation that keeps its own fix honest.

**Residuals, accepted and recorded rather than chased.** A `/clear` path assembled from two literals
(`"/cle" + "ar"`), a relative `new URL("clear", base)`, a multi-line template with the path on its own
line, and a shell variable assigned then curled on a later line all evade the guard. A regex literal
containing a quote or `/*` mis-syncs the scanner, which can suppress comment stripping later in that
file — the failure direction there is a false POSITIVE on a comment, never a false negative on a call.
Prose whose string ends exactly at `/clear` trips it. None is a realistic wipe path here, and a
tokenizer is not worth it for a guard whose job is to stop an accident.


## What would falsify this

- **A code path that can wipe the graph** — C6/C7 regressed, and the door the reviews found is open.
- **The script firing from a production shell** — C1 regressed. The host check does NOT catch this:
  `graphiti.railway.internal` resolves to production's own sidecar there.
- **The guard reddening on prose, or passing a real call** — C8/C7 regressed; a guard that cries wolf
  gets disabled, and one that matches nothing is ceremony.
- **An agent able to open a container shell** — C10 regressed.
- **An operator clearing before refreshing, or skipping the restart** — C11 regressed.
- **A reader believing this is automated** — C12 regressed. It is not, deliberately.
