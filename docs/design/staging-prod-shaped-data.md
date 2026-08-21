# Staging on prod-shaped data (STAGING-1)

Status: **revised after a design review returned BLOCKED / build-differently** (Codex, pre-code: the
post-restore sanitise had an armed crash window; `SECRETS_KEY` divergence is not a boundary; reactive PM
writes survive a disabled scheduler; and my "only the projector writes to the graph" claim was false),
then **amended 2026-08-20 by an operator ruling: the prod Neo4j TCP proxy is NOT to be enabled** —
which removes the shared-graph half of the design entirely (Decision 4) — then **BLOCKED twice more**:
round 3 on a copied `graph_episodes` ledger driving a permanently-unclearable `graph_extract` alarm
(Decision 6) and on staging's live `RESEND_API_KEY` reaching real member addresses (Decision 7), round
4 on the second-order effect of that first fix — an emptied ledger turns the admin "Project to graph
now" button into a paid re-projection of the whole restored corpus (Decision 4, round-4 fold) — plus a
Sentry DSN shared with production. Round 5 returned **CLEAR-WITH-CONDITIONS** and its four conditions
are folded (Sentry's build-time upload vars, the confirmation-exemption observable, the third projection
entrypoint, and relabelling criterion 13 as a documentation-drift guard) · Owner: chetan
· Tier build-with: unit (the refuse/allow decision + every guard, pure)

**Deps:** none.

**Increment:** ONE PR = a refresh script that copies prod's Postgres into STAGING's own Postgres,
plus the staging variable set that keeps every writer off. **No graph at all in staging** — both graph
pointers (`GRAPHITI_URL`, `NEO4J_URL`) are unset, so staging neither reaches prod's graph nor pays to
build its own. No app-code change, no schema change, no new surface.

## Problem

Staging exists and serves, but cannot be used to look at a branch against real data.

Measured 2026-08-20 (prod read-only, Railway CLI):

| | staging | production |
|---|---|---|
| Railway env | `staging` (own `aios-team-brain` / `Postgres` / `graphiti` / `neo4j`) | `production` |
| URL | `https://aios-team-brain-staging.up.railway.app` → **HTTP 307** (healthy) | `…-production…` |
| Last deploy | **2026-07-25** | today |
| Branch | `staging` @ `05a771ff` — **221 commits behind `main`** | `main` |
| Postgres | 1 team / **10 items** / 5 members (demo seed) | 1 team / **2,833 items** / 10 members, **535 MB** |

Railway's `*.railway.internal` DNS is environment-scoped, so staging is fully self-contained today.
With 10 demo items the brain renders empty regardless of which graph it reads.

**Row counts measured in prod 2026-08-20** (read-only, public proxy) — every exclusion below is sized
against these rather than asserted:

| table | rows | why it is here |
|---|---|---|
| `integrations` | 5 | reversible secrets, reaches outward — **excluded** |
| `member_secrets` | **2** | write-capable Slack USER tokens — **excluded**, and the rows exist, so this is a live exposure and not a tidiness argument |
| `gateway_connections` | 0 | reversible secrets — **excluded on category grounds while empty today**, which is the point of a category |
| `graph_episodes` | **2,821** | the graph activity ledger — **excluded** (Decision 6); this count is exactly what pushes the false alarm past its "too few items to judge" floor |
| `ingest_runs` | 16,584 | **kept** (Decision 6) |
| `arc_cache` | 3 | **kept** — the arcs surface is worth having prod-shaped |
| `arc_corrections` | **0** | **kept**; matters because a non-zero corrections table makes every post-TTL arc view in staging run the LLM against zero facts (`lib/graph/arcs.ts:762`). Zero today — stated as a measurement with an expiry, not a property |

### What actually writes to the graph — and the claim I got WRONG first time

Two separate paths, and conflating them is what produced a false safety argument:

- **BOLT (the app → Neo4j): read-only, verified.** `lib/graph/neo4j.ts`'s `runRead` is the only
  driver use in the app; it opens `session({ defaultAccessMode: neo4j.session.READ })` and calls
  `executeRead`. There is no write helper, and `lib/graph/group.ts` — the only other bolt module —
  contains no write verbs. This *would have* made reading prod's Neo4j directly safe. **It is
  historical context only: this design no longer reads prod's Neo4j at all** (Decision 4), so nothing
  below rests on it — recorded so the killed shared-graph argument cannot be re-imported by a later
  reader who finds the verified half and assumes the conclusion.
- **HTTP (the app → Graphiti → Neo4j): the app DOES write.** I first wrote that "every graph write
  comes from the projector". **That is false.** `lib/graph/graphiti-client.ts:151,198` exposes
  `POST /messages` and `DELETE /episode`, and `lib/graph/arcs.ts:1485` calls `addEpisodes` for
  correction write-back entirely outside `lib/graph/project.ts` — so disabling the projector does NOT
  make the app a pure graph reader.

The safety property is therefore about the URL, not the code — and the operator ruling of 2026-08-20
(*no TCP proxy on prod's Neo4j*) settles it by topology instead: **staging reaches neither prod's
Neo4j nor prod's Graphiti**, because both are only addressable on environment-scoped internal DNS
(Decision 4). This subsection stays because the corrected claim is the reason the safety argument
moved off "the app can't write" — not because the shared-graph design survives.

## Decision

**Reordered after a design review returned BLOCKED / "build differently".** The first draft
sanitised the target AFTER restoring; three of its four blockers dissolve by never putting the
dangerous data in the dump.

**1. EXCLUDE every REVERSIBLE-SECRET table's DATA from the DUMP — as a CATEGORY, enforced by a scan.**
Not `--exclude-table-data=integrations`. That was round 1's fix and round 2 blocked it: I had excluded
one instance while asserting the category.

The category is **columns holding decryptable ciphertext**, and there are THREE — enumerated from
`postgres/schema.sql`, not from memory:

| table | column | how I found it |
|---|---|---|
| `integrations` | `secret_ciphertext` | the one I thought of |
| `member_secrets` | `secret_ciphertext` | the review found it |
| `gateway_connections` | `credential_ciphertext` | **neither of us — only the scan** |

The concrete wrong outcome that makes `member_secrets` a blocker rather than tidiness: it holds
per-member **write-capable Slack USER tokens**, and `GET /api/v1/me/slack-token`
(`app/api/v1/me/slack-token/route.ts:32`) authenticates with an `api_keys` row — which this refresh
deliberately keeps — then reads `member_secrets`, decrypts, and RETURNS the token. So a prod API key
pointed at staging would hand back a live prod Slack token the moment staging held a compatible
`SECRETS_KEY`. Same class as the mistake this spec already corrected once, one table over.

**A hand-maintained exclusion list would rot the same way.** So a guard SCANS `postgres/schema.sql`
for `*_ciphertext` columns and fails the build when the owning table is not in the script's exclusion
set. Precedent in this repo, and it worked within hours: `test/guards/ingest-leg-ledger` scans
`recordIngestRun` call sites, and PRET-4 declared its new leg rather than tripping over it.

**Inbound auth is KEPT, deliberately.** `auth_users`, `auth_tokens`, `api_keys`, `agent_tokens` hold
HASHES, not reversible secrets, and dropping them would leave nobody able to log into staging at all.
The consequence — a prod API key authenticates against staging — is acceptable for a single-operator
environment behind the same auth, and it is safe ONLY because the reversible tables above are gone:
authentication with nothing to retrieve. If a future table pairs inbound auth with a decryptable
payload, the scan is what catches it.

Why exclusion beats sanitising-after (round 1's blocker, kept because it is why this changed): with
disable-after, a crash between `pg_restore --clean` committing and the sanitation running leaves
staging LIVE with prod-shaped rows and usable credentials. "The next refresh refuses" is no help — the
harmful state already exists. Excluding removes the window instead of narrowing it.

It also closes two holes in the old reasoning, both verified:
- **`SECRETS_KEY` divergence is NOT a boundary.** Slack falls back to `process.env.SLACK_BOT_TOKEN`
  (`lib/ingest/run.ts:54,186`), GitHub imports PUBLIC repos with no token at all
  (`lib/ingest/run.ts:611`), provider keys fall through to env (`lib/integrations/manage.ts:273`).
- **A disabled scheduler does NOT stop outbound PM writes.** `INGEST_POLL_ENABLED=false` only skips
  scheduler registration (`instrumentation.ts:55`); `projectTask` runs from REACTIVE write paths and
  `linearAdapter` issues real `issueUpdate`/`issueCreate` (`lib/pm-sync/project.ts:95`,
  `lib/pm-sync/linear.ts:423,443`). With no enabled integration rows the path resolves nothing.

**2. The staging MARKER survives the restore — because `--clean` only drops what the archive
contains.** `pg_restore --clean` emits DROP only for objects it is about to recreate, so a
`staging_marker` table that exists ONLY in staging (never in `postgres/schema.sql`, never in prod) is
untouched. That removes the first draft's check→restore→re-stamp ordering entirely: the marker is
durable, the guard is a plain precondition, and there is no re-stamp step to fail. **The script must
therefore never pass `--create`**, which would drop and recreate the database and take the marker with
it — pinned by a guard.

**3. Follow the restore procedure this repo ALREADY documents** (`docs/OPS.md` §Restore), rather than
inventing one: `pg_restore --clean --if-exists --no-owner` (`--no-owner` because Railway roles differ
across environments) followed by `npm run pg:schema` against the target to replay any migration that postdates the dump —
**from a plain laptop shell with `DATABASE_URL` set to staging's public URL, NOT via `railway run`.**
That distinction is load-bearing and `docs/OPS.md` currently gets it wrong for this case: the loader
calls `assertServiceIdentity` before touching the DB (`scripts/pg-load-schema.mjs:37`), which no-ops
off-Railway when `RAILWAY_SERVICE_NAME` is unset (`scripts/service-guard.mjs:119`) but REFUSES under
`railway run -s Postgres`, which injects a non-AIOS service name plus the project marker. Following the
existing runbook literally would abort the replay. `postgres/schema.sql` and `postgres/migrations/` are idempotent by design. Watch
`citext` (required, `schema.sql:19`), the generated `items.search` tsvector (`schema.sql:1134`), and
pgvector, which is optional and not in the base schema — the replay must preserve whatever prod has.

**4. GRAPH — CUT. Staging does not touch prod's graph at all** (operator ruling, 2026-08-20:
*"don't enable the TCP proxy on prod's Neo4j"*).

Reaching prod's Neo4j from staging required a public TCP proxy on the prod `neo4j` service, because
Railway's `*.railway.internal` DNS is environment-scoped. That proxy is refused, so the shared-graph
arrangement is not reachable and is out of this slice. Nothing is deferred here in the hope of doing
it later; **there is no graph work in this PR.**

Two things this makes better rather than worse:

- The safety property collapses from a claim about code behaviour into a claim about topology.
  Round 2 replaced *"the app can't write the graph"* (false — `lib/graph/graphiti-client.ts:151,198`
  exposes `POST /messages` / `DELETE /episode`, and `lib/graph/arcs.ts:1485` calls `addEpisodes`
  outside `lib/graph/project.ts`) with *"staging's `GRAPHITI_URL` must never be prod's"*. With the
  proxy refused, **neither of staging's graph pointers can resolve prod at all** — `neo4j.railway.internal`
  and `graphiti.railway.internal` resolve inside staging's own environment by construction. The
  boundary is now Railway's DNS, not a variable someone has to keep correct.
- Prod's production datastore is not exposed to the public internet, which is the thing the proxy
  would have done. The `DATABASE_PUBLIC_URL` proxy this script does use already exists and is already
  how `docs/OPS.md` backs prod up; this slice adds no new public surface.

**The cost, stated plainly rather than discovered later.** Staging renders prod-shaped *Postgres*, and
its graph is its own near-empty one. Concretely, in staging after a refresh:

| surface | source | in staging after a refresh |
|---|---|---|
| Pulse, timeline, items, tasks, decisions, meetings, codebases | Postgres | **prod-shaped** — the substance of what this slice buys |
| Narrative arcs | Postgres `arc_cache`, computed from graph facts | **two stages, not one** (review round 3, verified): served fresh until `ARC_CACHE_TTL_MS` = 4h (`lib/graph/arc-cache.ts:22`); after that a background recompute finds no facts (`lib/graph/arcs.ts:762`) and `commitArcs` KEEPS the prior rather than clobbering it while it is younger than `EMPTY_CLOBBER_MAX_AGE_MS` = **48h** (`lib/graph/arcs.ts:106,1146`) — so prod arcs linger, stamped stale-but-real, for up to 48h from their snapshot time and only then blank |
| Learning panel | direct bolt reads (`lib/graph/learning.ts`) | **empty** — self-gates on `neo4jConfigured()` and degrades rather than 500 (`lib/graph/neo4j.ts:20`) |
| Extraction-health cards + the Pulse pipeline banner | Postgres `graph_episodes` ledger **×** Neo4j facts | **was the round-3 HIGH — see Decision 6.** Left alone this is not "empty", it is a *permanently loud false alarm*. Fixed by excluding the ledger's data. |
| Graph-backed answering / `GET /api/v1/graph-query` | Graphiti HTTP | staging's own graph — effectively empty; the retrieval graph leg degrades to `[]` (`lib/query/retrieve.ts:156`) |

**Round-4 fold (HIGH, re-derived and confirmed): staging's graph POINTERS are unset, and
`GRAPH_PROJECT_ENABLED=false` is not the boundary I thought it was.** This is a second-order bug in my
own round-3 fix, which is the class this loop exists to catch:

1. Decision 6 empties `graph_episodes` — and that table IS the projector's idempotency state
   (`lib/graph/project.ts:441,464`: the projector reads it to decide what has already been pushed).
   An empty ledger against a full `items` table means **every restored item looks unprojected**.
2. `GRAPH_PROJECT_ENABLED=false` only stops the interval poller (`lib/graph/scheduler.ts:21`). The
   admin **"Project to graph now"** button calls `runGraphProjection` directly
   (`app/t/[team]/admin/integrations/actions.ts:446`), which gates on `client.configured` — i.e. on
   `GRAPHITI_URL` — and nothing else (`lib/graph/run.ts:137`).
3. Measured on staging today: `GRAPHITI_URL=http://graphiti.railway.internal:8000`,
   `GRAPH_PROJECT_ENABLED=true`, and live `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.

So after a refresh, **one admin click pushes up to `GRAPH_PROJECT_LIMIT`=500 restored items into
staging's Graphiti** (`lib/graph/run.ts:71`) and bills real extraction — the ~99%-of-the-LLM-bill path
— with the scheduler draining the remaining ~2,300 over the following ticks if it is left on.

The fix is the master switch, not another flag: **the runbook unsets `GRAPHITI_URL` on staging.**
Unset, `GraphitiClient().configured` is false and `runGraphProjection` returns before it opens the
database at all — and that is not an assumption, it is already pinned by an existing unit test
(`lib/graph/run.test.ts:9`, "never touches the DB"), so no new test is owed here. The admin action then
reports "not configured" (`app/t/[team]/admin/integrations/actions.ts:460`), `GET /api/v1/graph-query`
returns 503 (`app/api/v1/graph-query/route.ts:45`), and the retrieval graph leg degrades to `[]`
(`lib/query/retrieve.ts:156`).

**`NEO4J_URL` is unset too, and for a weaker reason that is worth separating.** `GRAPHITI_URL` is the
safety boundary; `NEO4J_URL` is honesty — staging's own Neo4j still holds July's demo-seed graph, and
leaving it wired would render *demo* facts in the learning panel beside *prod-shaped* content, which is
worse than an empty panel. If someone later wants that panel populated in staging, re-wiring
`NEO4J_URL` is safe on its own; re-wiring `GRAPHITI_URL` is the one that costs money.

**The residual hazard, stated because no code can close it:** the day someone sets `GRAPHITI_URL` on
staging to "make the graph work", the emptied ledger makes the whole restored corpus look unprojected
and the first click or tick starts paying for it. `docs/OPS.md` and the script's completion message both
say so at the point where someone would do it.

There are **three** non-test entrypoints, enumerated rather than assumed (round-5 finding, confirmed):
the interval scheduler (`lib/graph/scheduler.ts:34`), the admin button
(`app/t/[team]/admin/integrations/actions.ts:446`), and `scripts/graph-window-battery/run-projection.ts:28`,
which calls `runGraphProjection()` against whatever `DATABASE_URL` and `GRAPHITI_URL` the shell holds.
**Refuting the other half of that finding:** a call-site ledger guard for `runGraphProjection` would add
nothing to the boundary, because all three funnel through the same `client.configured` gate
(`lib/graph/run.ts:137`) and are equally inert when `GRAPHITI_URL` is unset. What the enumeration buys
is the honesty that the hazard is not "one button" — it is "any of these, if the variable comes back".

So staging is a **Postgres-shaped** preview environment, not a graph one. If a branch's behaviour
depends on graph substrate, staging cannot validate it, and this spec does not claim it can. The
upgrade path if that becomes a real need is named in Scope, and it is **not** the TCP proxy: it is
projecting staging's own Graphiti over the restored corpus (costly — graph extraction is ~99% of the
LLM bill) or a private network peering that does not put prod's Neo4j on the internet.

**5. Writers off, as defence in depth, not as the boundary.** `INGEST_POLL_ENABLED=false`,
`GRAPH_PROJECT_ENABLED=false`, `AUTO_FLIP_ENABLED=false`, `SEED_DEMO=false`. Each is a distinct layer
from decision 1 and is pinned separately — a stack tested only through its outcome lets one layer rot
invisibly.

**And `GRAPH_PROJECT_ENABLED=false` is explicitly NOT the projection boundary** (round-4 fold): it
gates the interval poller only (`lib/graph/scheduler.ts:21`) and the admin button walks straight past
it. The boundary is `GRAPHITI_URL` being unset (Decision 4). This line exists so the flag is never
again read as the thing that stops projection.

**Measured on staging today, and it is not the state this assumes** (`railway variables -s
aios-team-brain -e staging`, 39 vars): `GRAPH_PROJECT_ENABLED` is **`true`**, and `INGEST_POLL_ENABLED`
/ `AUTO_FLIP_ENABLED` are **unset, which means ON by default**. So all three are changes to make, not
settings to confirm — the runbook says so rather than assuming a clean start.

**6. EXCLUDE the graph ACTIVITY LEDGER's data too — `graph_episodes` (round-3 review, HIGH,
re-derived and confirmed).** This is a different category from decision 1 and had to be found the same
way: by following what the copied rows *drive*, not by looking at what they *contain*.

The chain, verified end to end:

1. `readLedger` reads `graph_episodes` from **Postgres** (`lib/graph/extraction-health.ts:432`) — prod
   holds **2,821** rows (measured 2026-08-20), so staging inherits a full ledger.
2. Staging's own Neo4j is empty, so `readTeamFacts` returns `facts: 0`
   (`lib/graph/extraction-health.ts:365`) and `readEpisodicLiveness` returns `none` (`:565`).
3. `deriveExtractionVerdict` (`:248`) passes its "too few items to judge" floor (`:253`) *because the
   copied ledger is large*, takes the `facts === 0` → `no-facts` branch (`:264`), passes the age gate
   on **prod's** `first_seen_at` (`:267`), finds no worker liveness to excuse it (`:306`), and returns
   **stalled**.
4. `getPipelineHealth` then appends a synthetic `graph_extract` **failing** leg
   (`lib/ingest/pipeline-health.ts:433`) carrying `failureClass: "confirmed"` (`:446`), which is
   **the only confirmation-exempt leg in the system** — verified: one occurrence in that file. Exempt
   means no staleness threshold can ever clear it. It renders on Pulse (`app/t/[team]/page.tsx:202`)
   and Admin → Integrations (`app/t/[team]/admin/integrations/page.tsx:167`).

So a straight copy gives staging a **permanently red "graph extraction is broken" banner that nothing
can clear** — the exact `pret3_sweep` shape this repo shipped a hotfix for on 2026-08-18, reproduced
deliberately by our own refresh. Excluding the table's data returns `items = 0`, below the floor at
`:253`, and the verdict is quiet.

**The category, not the instance** (this spec has now made the instance mistake once, at decision 1):
exclude the activity ledger of a subsystem staging deliberately does not run **when the alarm derived
from it is exempt from the staleness thresholds**, because that is the alarm no configuration can
turn off. Today `graph_episodes` is the only such table.

**`ingest_runs` is KEPT, and this is the line that decides it.** Its legs go stale in staging (the
scheduler is off), so the banner will say ingestion is stale — but that is *thresholded*, *true of
staging*, and clears the moment someone turns ingestion on. It also carries TICKSTALL-1's durable
backfill cursor in `meta`. Prod holds 16,584 rows. A thresholded true alarm is not the same object as
an unclearable false one, and this spec refuses to blur them.

**7. Two credential facts measured on staging that the earlier drafts got wrong.** Staging's live
variable set contains `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `EMBEDDINGS_API_KEY` — so "staging has
no credentials" is false for the LLM providers, which is why decision 1 stopped relying on
`SECRETS_KEY` divergence. Those cost money on use and nothing on idle, which is acceptable.

`RESEND_API_KEY` is the one that is not: **staging can send real email to the real member addresses
this refresh copies** — and measured 2026-08-20, staging's key is byte-identical to prod's, with
`RESEND_FROM` set to a verified domain (`noreply@updates.john-ellison.com`), so delivery is real, not
sandboxed. `members` is copied deliberately (decision 1's Scope note), so an invite or a
magic-link login triggered in staging reaches a real person from a staging box. The runbook therefore
**unsets `RESEND_API_KEY` on staging** — an outbound path that survives every other layer here, found
by reading the variables rather than reasoning about the design. Verified non-breaking: password login
is the default and needs no mailer, and `magicLinkAvailable()` (`lib/auth/mailer.ts:127`) then stops
*offering* magic-link rather than failing sign-in; `deliver()` drops with a logged error and never
throws (`lib/auth/mailer.ts:82`).

**Round-4 fold: the invariant is "no mail PROVIDER", not "no Resend key."** `deliver()` tries Resend
*then* SMTP (`lib/auth/mailer.ts:38,59`) and `mailerConfigured()` is true for either
(`lib/auth/mailer.ts:97`), so unsetting one variable is a boundary only while the other happens to be
unset. Measured: `SMTP_URL` is unset on staging today — which is exactly the "protection by accident"
shape this spec has already refused twice. The runbook and criterion 11 therefore state **both**
`RESEND_API_KEY` and `SMTP_URL` unset.

**Round-4 fold: staging reports to PROD's Sentry project.** Measured 2026-08-20 — staging and
production carry the **identical** `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN`
(`a86a2ee3…@o4510314175397888`). Two concrete costs, one of them process-critical: staging-only errors
raise noise in prod's alerting, and this repo **verifies prod deploys by reading the running app's
Sentry release tag** (done twice in the sessions that produced TICKSTALL-1/BANNERFLAP-2) — a staging
instance publishing releases into the same project degrades the one signal used to prove which commit
is live. The runbook unsets both DSNs on staging. Whether Sentry event context would carry copied prod
row values is **unverified**, and is deliberately not claimed as the reason.

**Round-5 fold: the DSNs are only the RUNTIME half of Sentry.** Release and source-map upload happen at
BUILD time and are driven by `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN`
(`next.config.ts:70-76`), not by the DSN — and measured 2026-08-20 staging carries all three, with
`SENTRY_PROJECT` set to the very same project as production (`aios-team-brain`, org `pravos-llc`). So
unsetting the DSNs alone would have stopped staging's *events* while leaving its *builds* creating
releases in prod's project — which is precisely the signal the release-tag argument above rests on. The
runbook therefore also unsets **`SENTRY_AUTH_TOKEN`**, which `next.config.ts:63` documents as the
switch ("with no `SENTRY_AUTH_TOKEN`, the build skips the upload step and proceeds normally");
`SENTRY_ORG`/`SENTRY_PROJECT` are inert without it and are left alone rather than padding the list.
This is the second time in this spec that a boundary turned out to be one variable narrower than
claimed.

**8. The script must REFUSE on a client/server version mismatch — because the default toolchain on
this machine cannot run this design at all.** Measured 2026-08-20, before writing a line:

| | version |
|---|---|
| prod Postgres server | **18.4** |
| staging Postgres server | **18.4** (same major — an 18 archive restores cleanly) |
| `pg_dump` on `PATH` | **14.19** (`/opt/homebrew/bin`, Homebrew `postgresql@14`) |
| available but keg-only | `postgresql@18` → `/opt/homebrew/opt/postgresql@18/bin/pg_dump` 18.3 |

`pg_dump` aborts when the server's major exceeds its own, so the runbook as written would have failed
on its first invocation — an hour of confusion, not a data risk, but the kind of thing that gets a
runbook labelled unreliable. Two consequences, both in scope:

- The script resolves its binaries: an explicit `PG_BIN` override, else a discovered
  `postgresql@<major>` prefix matching the SERVER's major, else **refuse with the remedy named**
  (`brew install postgresql@18`, or run the dump in `docker run --rm postgres:18`; Docker 28 is
  present). Refusing beats proceeding: a mismatched client is exactly how you get an archive that
  restores *partially*.
- The comparison is a **pure function** (`clientMajor >= serverMajor`) and is unit-tested, so the
  refusal cannot rot into a string match on one machine's paths.

## Scope

**In:** `scripts/staging-refresh.sh`; the pure refuse/allow decision it calls; the staging variable
set; a `docs/OPS.md` runbook section; tests for each guard layer separately.

**Cut, each with the reason:**
- **The prod Neo4j TCP proxy, and with it the whole shared-graph arrangement** — **refused by the
  operator on 2026-08-20**, not deferred. Exposing a production datastore to the public internet is a
  human decision and the human said no. The consequence (staging is Postgres-shaped, not
  graph-shaped) is priced in Decision 4 rather than left to be discovered.
- **Making staging's graph real by other means** — projecting the restored corpus through staging's
  own Graphiti would work, and is the named upgrade path, but graph extraction is ~99% of the LLM
  bill and this slice's purpose is looking at a branch against real data, not validating graph
  behaviour.
- **A PITR/fork-based copy.** The reviewer's suggestion — restore prod to a NEW sibling Postgres
  service, sanitise there, then wire staging to it — is genuinely safer (prod's live DB is never the
  source of a destructive command) but adds a service and a manual PITR step per refresh. Named as the
  upgrade path if the dump route proves risky in practice.
- **Scheduling the nightly cron.** Ship it runnable by hand; schedule once it has been boring.
- **Excluding other sensitive tables** (`api_keys`, `members` emails). Copied deliberately: staging is
  behind the same auth, operated by the same person, and the brain is unusable without members. Stated
  so it is a decision, not an oversight. `integrations` is excluded because it reaches OUTWARD.

## Acceptance criteria

1. **unit** — the dump excludes the DATA of every table carrying a `*_ciphertext` column, and a guard
   SCANS `postgres/schema.sql` and fails when one is missing from the exclusion set. The categorical
   form is the point: round 1 excluded `integrations` alone and two more tables existed.
2. **unit** — the scan is proven NON-VACUOUS: it finds the three known tables by name, so a broken
   pattern cannot report "nothing missing" and read as a clean bill of health.
3. **unit** — the guard REFUSES when the target lacks the staging marker, and names the marker.
4. **unit** — the guard REFUSES when source and target resolve to the same host, independently of the
   marker, so the copy-paste case dies before any connection is opened.
5. **unit** — each guard layer is asserted to fail ALONE, so a defence-in-depth stack cannot rot behind
   a sibling that happens to catch everything.
6. **unit** — a guard fails the build if the script gains a DEFAULT for either URL, or ever passes
   `--create` (which drops the database and takes the durable marker with it).
7. **unit** — a guard fails the build if `staging_marker` appears in `postgres/schema.sql` or
   `postgres/migrations/`: the moment it ships to prod it enters the dump archive, `--clean` drops it,
   and the durable-marker property silently dies.
8. **unit** — the restore flags match `docs/OPS.md` §Restore (`--clean --if-exists --no-owner`) and the
   replay is pinned to a NON-`railway run` invocation, since the service guard refuses the other one.
9. **unit** — a guard pins that `scripts/staging-refresh.sh` performs **no Railway mutation of any
   kind**: no `railway variables --set`, no `railway up`/`redeploy`/`down`/`delete`. The refresh
   touches one database and nothing else. *(Round 3 narrowed this: the draft also banned the script
   from naming `NEO4J_URL`/`GRAPHITI_URL`, and the reviewer was right that with variable writes banned
   and no public proxy on prod's Neo4j, the name-ban has no reachable failure mode behind it —
   ceremony by CLAUDE.md §7. The variable-write ban keeps a real one: the obvious future "convenience"
   edit that makes the refresh set staging's flags for you.)*
10. **unit** — `graph_episodes` is in the exclusion set (Decision 6) as its own assertion, and a
    SEPARATE guard keeps the *reason* live: exactly one **hardcoded** `failureClass: "confirmed"`
    exists under `lib/`, and it is the `graph_extract` leg. Rounds 4 and 5 both attacked the observable
    and the second one produced it: a free-text scan for "confirmed" is vacuous-or-noisy because
    ordinary confirmed failures exist by design — but they are *derived*, from `classifyFailure(...)`
    into a variable (`lib/ingest/pipeline-health.ts:409`), while an exemption can only be written as a
    LITERAL. Verified: that literal occurs exactly once in `lib/` + `app/` today. So the guard reds
    when a second unclearable alarm is hardcoded anywhere, and does not red when the derived path is
    refactored — and comments are stripped before counting, so it cannot be satisfied or broken by
    prose.
11. **unit** — the refresh script never sends mail and never enables a mailer: a guard pins that it
    does not set `RESEND_API_KEY`/`SMTP_URL`, and the runbook's variable table lists **both** as
    **unset on staging** — the invariant is "no mail provider", since `deliver()` falls through Resend
    to SMTP (`lib/auth/mailer.ts:38,59`). Verified safe: password login does not need it, and
    `magicLinkAvailable()` (`lib/auth/mailer.ts:127`) simply stops offering magic-link rather than
    breaking sign-in.
12. **unit** — a pure `pg_dump`-version decision refuses when the client major is below the server
    major (Decision 8), names the remedy in the refusal, and is asserted to ACCEPT an equal or higher
    client — so a refusal that fires on everything cannot pass as a working check.
13. **unit, and it is a DOCUMENTATION-DRIFT guard — not a check on Railway's actual state**
    (round-5 correction; labelling it honestly is the point, because a guard mistaken for the stronger
    thing is worse than none). It machine-checks the runbook's staging variable table against the
    script's declared list — `GRAPHITI_URL`, `NEO4J_URL`, `RESEND_API_KEY`, `SMTP_URL`, `SENTRY_DSN`,
    `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN` **unset**; `INGEST_POLL_ENABLED` /
    `GRAPH_PROJECT_ENABLED` / `AUTO_FLIP_ENABLED` / `SEED_DEMO` **`false`** — so a variable dropped
    from the prose cannot silently drop from the design. The real state lives in Railway, so the
    runbook makes a `railway variables -s aios-team-brain -e staging` READ-BACK a required step, the
    same way this repo reads a pushed ticket back rather than trusting that the push said ok. **No new test is owed for the
    projector gate itself**: `lib/graph/run.test.ts:9` already pins that an unconfigured Graphiti means
    `runGraphProjection` never touches the DB, which is what makes "unset `GRAPHITI_URL`" a boundary
    rather than an assumption (Decision 4).
14. **unit** — the script's completion message names the residual hazard in Decision 4 — that the
    emptied `graph_episodes` ledger makes the whole restored corpus look unprojected, so setting
    `GRAPHITI_URL` on staging later starts billing real extraction. A hazard no code can close is
    stated where the person who would create it is looking.

15. **unit** — the script uses no bash-4-only builtin (`mapfile`/`readarray`, associative arrays,
    `${x,,}`), because the operator's macOS shell is **bash 3.2** — measured, not assumed. The first
    draft used `mapfile` and would have aborted at the DUMP step, *after* connecting to production.
    Same class as Decision 8's version trap, and the same remedy: refuse or avoid, never discover.
16. **unit** — an EMPTY exclusion list is a REFUSAL, not an empty set of `--exclude-table-data` flags.
    An empty list produces a perfectly valid `pg_dump` invocation that copies every reversible-secret
    table, so "nothing to exclude" and "the exclusion step broke" must not be the same observable.

## What would falsify this

- **A refresh that writes to prod** — the catastrophic direction. Nothing else on this list matters as
  much.
- Staging connectors reaching Slack/Linear/GitHub after a refresh, which would mean the excluded
  `integrations` data came across after all.
- **Any email leaving staging** to a copied member address (Decision 7).
- **The Pulse banner in staging showing a `graph_extract` failure** after a refresh — Decision 6
  predicts quiet, and a red one means the ledger exclusion did not take.
- **Any graph projection running in staging after a refresh** — a `graph_project` row in staging's
  `ingest_runs`, or Graphiti extraction spend on staging's keys. Decision 4 predicts none, because
  `GRAPHITI_URL` is unset; one means the master switch is not the boundary it is claimed to be.
- **A staging-originated error or release appearing in prod's Sentry project** after the runbook has
  been applied (Decision 7).
- Staging's brain still rendering empty after a refresh — the copy did not achieve its purpose.
- The staging app **500ing** rather than degrading on its graph-backed surfaces once staging's own
  graph is empty against a prod-shaped corpus. Decision 4 predicts empty panels, not errors, on the
  strength of the `neo4jConfigured()` self-gates; an error means that prediction is wrong and the
  Postgres-only arrangement is less usable than claimed.
- Narrative arcs going empty in staging **sooner than the 4h cache TTL**, which would mean the
  degradation Decision 4 prices is larger than stated.
- The `preDeployCommand` running `pg:schema` against prod — meaning `DATABASE_URL` was repointed after
  all, against decision 2.
