# Running the episode-window battery (PIPEFF-2 / AIO-821)

The spec is [`docs/design/graph-episode-window.md`](../../docs/design/graph-episode-window.md). This
is the operational sequence. Read the spec's **decision function** and **rerun policy** first — the
numbers this produces bind, and a second session needs a committed amendment.

**Everything up to step 5 costs nothing.** Step 5 is the only step that spends.

---

## What the topology is, and why each piece is there

```
  projector (local brain)  ──push episodes──►  graphiti (arm variant)  ──►  neo4j (fresh per rep)
                                                     │
                                            OPENAI_BASE_URL
                                                     ▼
                                              capture tap  ──►  brain /api/internal/llm/v1/*
                                                (JSONL)              │
                                                                     ▼
                                                            llm_usage in the battery Postgres
                                                                     │
                                                                     ▼
                                                        scripts/graph-ingest-cost.mjs
```

The tap forwards **byte-for-byte**. Metering has to traverse the production path
(`graph-proxy` → `classifyGraphCall` → `recordLlmUsage`) so the `llm_usage` rows the cost harness
reads are the real ones — a tap that normalised anything would measure a pipeline that does not
exist, and the harness would then be reading a second, divergent cost model.

The arms differ in **exactly one file**, bind-mounted over the image's copy:

| arm | file | patch |
|---|---|---|
| `W10` | `graphiti.w10.py` | none — the incumbent |
| `SAME` | `graphiti.same.py` | +17 lines, 0 removed: carry only the same item's prior chunks |
| `W1` | `graphiti.w1.py` | `last_n=RELEVANT_SCHEMA_LIMIT` → `last_n=1` |

Bind-mounting rather than building three images is deliberate: it makes "the arms differ in one
file" checkable with `diff` rather than a claim about three Dockerfiles. **Before Phase C, assert the
shipped Dockerfile produces a byte-identical `graphiti.py` to the arm that won** — the spec requires
the sed that ships to be the sed that was measured.

---

## 1. Secrets and env (free)

```bash
railway status                     # MUST print Project: AIOS before anything else
export SECRETS_KEY=$(railway variables -s aios-team-brain --json | python3 -c "import sys,json;print(json.load(sys.stdin)['SECRETS_KEY'])")
export GRAPH_LLM_PROXY_SECRET=$(openssl rand -hex 24)   # local only; any ≥ MIN_SECRET_LEN value
export GRAPH_LLM_TEAM=aios
export PROD_URL=$(railway variables -s Postgres --json | python3 -c "import sys,json;print(json.load(sys.stdin)['DATABASE_PUBLIC_URL'])")
```

`SECRETS_KEY` is needed because the provider key is copied **still encrypted** — the battery never
decrypts it, the local brain does, in-process, exactly as prod does. Without the other two the stack
boots and quietly extracts nothing: `authorizeGraphProxy` fails **closed** on an unset secret, and
`resolveGraphProxyTeamId` refuses rather than guessing.

## 2. Battery Postgres — its own container (free)

```bash
docker rm -f gwb-pg 2>/dev/null
docker run -d --name gwb-pg -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=battery \
  -p 0:5432 --tmpfs /var/lib/postgresql/data postgres:16
export BATTERY_URL="postgres://app:app@localhost:$(docker port gwb-pg 5432/tcp | head -1 | sed 's/.*://')/battery"
DATABASE_URL="$BATTERY_URL" npm run pg:schema
```

**Its own container, on an ephemeral port.** The shared test Postgres has previously made concurrent
runs look like product bugs, and a battery run is long enough to collide with anything else.

## 3. Seed from prod, read-only (free)

```bash
SOURCE_DATABASE_URL="$PROD_URL" TARGET_DATABASE_URL="$BATTERY_URL" \
  node scripts/graph-window-battery/seed-local.mjs
```

Record the **pinned item ids** it prints — the spec requires them in the session log, and they are
what makes a later session comparable rather than merely similar.

Check its three outputs before continuing: `episode budget: within range` (outside 90–120, Q5's band
is not valid and needs a committed amendment first), any `divergent` items, and the extraction target
the arms must match.

## 4. Phase A, part 1 — structural, free

```bash
DATABASE_URL="$PROD_URL" node scripts/graph-window-battery/phase-a-structural.mjs
```

Already run 2026-08-06; its numbers are in the spec. Re-run if the corpus is re-drawn.

## 5. Per arm × 2 reps — **this is the step that spends**

For `ARM` in `W10`, `SAME`, `W1`, and `REP` in `1`, `2` — always a **fresh Neo4j**, since a
carried-over graph makes the second rep measure a different question:

```bash
# 5a. fresh graph + the arm's single patched file
docker compose -p gwb-$ARM-$REP -f graphiti/docker-compose.yml down -v
docker run ... neo4j:5.26.2 ...
docker run ... aios-graphiti:0293-pinned \
  -v $PWD/graphiti.$ARM.py:/app/.venv/lib/python3.12/site-packages/graphiti_core/graphiti.py:ro \
  -e OPENAI_BASE_URL=http://host.docker.internal:3099/v1 \
  -e OPENAI_API_KEY=$GRAPH_LLM_PROXY_SECRET

# 5b. the tap
ARM=$ARM CAPTURE_FILE=/tmp/gwb/capture-$ARM-$REP.jsonl BRAIN_URL=http://localhost:3000 \
  node scripts/graph-window-battery/capture-tap.mjs &

# 5c. the brain, against the battery Postgres
DATABASE_URL="$BATTERY_URL" GRAPHITI_URL=http://localhost:8001 \
  GRAPH_LLM_PROXY_SECRET=$GRAPH_LLM_PROXY_SECRET GRAPH_LLM_TEAM=$GRAPH_LLM_TEAM SECRETS_KEY=$SECRETS_KEY \
  npm run build && npm start &

# 5d. drive the REAL projector run path — not a bespoke pusher
#     (this is what writes ingest_runs.meta.episodes, without which Q5 is unmeasurable
#      and C1 loses its guard against a retry-rate shift masquerading as a token saving)
curl -X POST localhost:3000/api/v1/integrations/graph/project   # or the Admin "Project to graph" button
```

Then **wait for the queue to drain** — Graphiti returns 202 and extracts later, so measuring early
measures a partial graph. Watch `llm_usage` go quiet for the harness's drain window.

## 6. Read out (free)

```bash
# cost — the same instrument, the same refusals, as the prod baseline
DATABASE_URL="$BATTERY_URL" node scripts/graph-ingest-cost.mjs <since> <until>

# predecessor block size (Phase A part 2)
npx tsx --conditions react-server scripts/graph-window-battery/phase-a-predecessors.ts /tmp/gwb/capture-W10-1.jsonl

# quality — Q1/Q2/Q3/Q4/Q6 out of Neo4j + the seeded Postgres
NEO4J_URL=bolt://localhost:7688 NEO4J_PASSWORD=... DATABASE_URL="$BATTERY_URL" \
  npx tsx --conditions react-server scripts/graph-window-battery/measure.ts
```

**If the harness refuses, or the cross-check is unavailable, the session is INVALID.** Not "report
with suspicion" — a null cross-check is not a refusal *in the harness*, which is exactly why
`assessSession` makes it one here.

## 7. Judge — never by reading the table

```js
import { assessSession, decide } from "./decision.mjs";
decide({ session: assessSession({...}), incumbent, arms: [{name:"SAME",...}, {name:"W1",...}] })
```

`decision.mjs` is the decision function. Reading the numbers and forming a view is the failure this
whole workstream exists to prevent — the procedure is code so the readout cannot be reinterpreted
after the numbers exist. It throws rather than defaulting when a safety input is missing, so a
readout that runs at all is one where every gate was actually measured.

Append the outcome to the spec's **session log** — pass, fail *or invalid*, with the pinned item ids
and the cause. The first valid session's verdict **binds**.

---

## What to do with the result

- **SHIP** → Phase C in the spec: the sed into `graphiti/Dockerfile` (after the pip install RUN, with
  a post-all-installs assertion), the recorded deployment id, the empty-start-command precondition,
  `docs/ARCHITECTURE.md` in the same PR, and verification **in the ledger, not the logs**.
- **NO_SHIP** → commit the negative result to the spec. If `SAME` failed on Q1-high or Q6 (the
  fragmentation direction) but passed Q4 and C1, the spec already names the successor: a hybrid that
  keeps a small dedupe context only for items with no predecessors of their own. It gets its own task
  and its own session under an amendment — it does not get bolted onto this one.
- **INVALID** → fix the instrument, not the rules. More than two consecutive invalidations without a
  committed amendment blocks further sessions.

---

# The SMALL-MODEL arm (GRAPHSMALL-1)

Spec: [`docs/design/graph-small-model-activation.md`](../../docs/design/graph-small-model-activation.md).
Same topology, tap, corpus and reps as above. **Read the differences below — three of them are the
kind that silently invalidate a session rather than fail it.**

## What differs from the window battery

| | window battery | small-model arm |
|---|---|---|
| arms differ by | a bind-mounted `graphiti.py` (checkable with `diff`) | a team CONFIG field, `extraction_small_model` |
| cost gate | `C1` — input tokens/episode | **`C2` — USD/episode** |
| extra quality metrics | — | **Q10** summary health, **Q11** temporal coverage |

**`C1` is NOT the gate here, and this is the trap.** C1 is `ratio-fall` on input TOKENS: it demands
the arm SEND 25% fewer. This lever sends the *same* tokens to a cheaper model, so C1 cannot pass by
construction. Judging this arm on C1 pre-registers a guaranteed STOP. Use
`smallModelMetrics({ addressableShare })` from `decision.mjs`; C1 is worth reading as a diagnostic
(tokens should sit roughly FLAT) but gates nothing.

## Step 0 — the pre-flight (FREE, and it sets the ship threshold)

Do this before anything paid. It answers a question the code only *asserts*: which call kinds does the
DEPLOYED image actually ask to downgrade?

```bash
# with the tap running (steps 1-4 above), replay a projection, then:
node scripts/graph-window-battery/small-marker-preflight.mjs /tmp/gwb/capture-*.jsonl
```

Read `addressableShare` off the output and pass it to `smallModelMetrics({ addressableShare })`:

- `node_summaries_batch` **marked** → ~28.7% addressable → C2 band **15%**.
- `node_summaries_batch` **not marked** → ~18.7% → C2 band **10%**. A flat 15% there would need ~80%
  realisation and would STOP a clean run that captured most of what was reachable.

`missing` names a kind the code claims is eligible but which never carried the marker (shrinks the
prize). `unexpected` names one that carried it but is not in `SMALL_ELIGIBLE_KINDS` — unclaimed
savings, and a sign the prompt table has drifted from the image.

## Step 5′ — seed each arm's config EXPLICITLY

```js
import { armConfig, effectiveSnapshot, assertArmsDiffer } from "./small-model-arms.mjs";
armConfig("STRONG");                      // { extraction_small_model: null }  — set, never inherited
armConfig("SMALL", "<model from EXMODEL-1's probe>");
```

**Why `STRONG` writes an explicit `null`:** `seed-local.mjs` copies the whole `teams` row and
sequential arms SHARE the battery DB. A `STRONG` run after a `SMALL` run inherits the field, both arms
route small, and the delta collapses — the session then reads as *"no savings, quality equal"*, which
is indistinguishable from a real negative result. That is the worst failure this battery has.

After both arms, snapshot what each **resolved** to (not what it intended) and gate on it:

```js
const v = assertArmsDiffer(effectiveSnapshot("STRONG", strongResolved), effectiveSnapshot("SMALL", smallResolved));
if (!v.ok) throw new Error(v.reason);   // INVALID session — not a result
```

`*Resolved*` means `selectSmallExtractionBackend(...)?.model ?? null`. An arm whose model name was set
but which still resolves to `null` (e.g. its provider is not configured) is a strong arm wearing a
small label — only the resolved value can tell you.

## Model selection

Do **not** pick from a price list. `EXMODEL-1` found candidates that 400 outright, or collapse to 1–3
entities, *while advertising structured outputs*. Run its probe first; a model that fails it produces a
broken battery, not a battery result.

## Q10/Q11 are now readable — and may declare themselves UNINFORMATIVE

`measure.ts` reads `(:Entity){name, summary}` plus each entity's own adjacent `RELATES_TO.fact`
(`summaryRows`) and every fact edge's `valid_at` (`temporalEdges`); `harvest.ts` scores them with the
same pure functions the judge bands, so the readout cannot drift from the judged definition.

**Read the `uninformative` list on the verdict before reading anything else.** A metric pinned at a
structural floor or ceiling on this corpus is EXCLUDED from gating and listed there — it is *not* a
pass. This matters most for **Q11**: graphiti backdates `valid_at` to the episode's work time
(`lib/graph/extraction-health.ts:348`), so coverage may be ~1.0 on every arm, which is the same shape
of trap that made Q3 a structural zero and burned a live session. Feed the incumbent's reps through
`assessInformativeness(reps, { bandMargin })` and pass the excluded keys to `decide({ uninformative })`.

If Q11 comes back uninformative, that is a real result about the corpus, not a failure — the summary
and cost questions still answer.
