# Copy the graph into staging, never re-extract it (STGENV-3)

Status: **DECLINED at design review — kept as the recorded alternative, with the safety argument
corrected so it cannot be re-imported.** Fable returned DECLINE and it was right on the point that
matters: **Decision 1's inversion was BACKWARDS.**

- On a **laptop** a wrong URL writes *nothing* to production, because a laptop reaches **neither** graph.
- **Inside production** is the ONE place in the topology where **both** graphs are writable — prod over
  internal DNS, staging over its proxy.
- And there is no "staging-only write credential" to fall back on: `NEO4J_AUTH` is **byte-identical**
  across both environments (fingerprint `94f7d69d7030`, measured), and Community edition has no RBAC, so
  the single password writes both.

So the shape I chose *created* the reachability I claimed it removed, and the marker was carrying the
entire defence alone. Two further findings independently justify the decline: **no runner was ever
named** (the only candidates were a human `railway ssh` into the prod container — prod's `DATABASE_URL`,
`SECRETS_KEY` and every API key in the same shell as a staging write — or a new Railway service the spec
said it would not create); and **the full-corpus copy has no consumer on staging**, since arcs and the
learning panel read most-recent-N, while `graph-query` and retrieval need `GRAPHITI_URL`, which this
spec deliberately keeps unset.

**Superseded by:** a bounded re-extraction through the projector's EXISTING `since` path
(`lib/graph/project.ts:690`, `lib/graph/run.ts:237`), gated on the Postgres `staging_marker` that
already exists — which turns STAGING-1's recorded hazard ("the day someone sets `GRAPHITI_URL`, the
whole corpus bills") into a refusal, for roughly $2–3 a refresh instead of ~$190.

---

Original status: **first draft, pre-code.** Sibling of STAGING-1, which brought prod-shaped Postgres to staging
and deliberately CUT the graph because enabling a TCP proxy on **production's** Neo4j was refused. That
refusal still stands. This slice reaches the same goal from the other side · Owner: chetan
· Tier build-with: unit (the pure refusal decision + guards) — the copy itself is a script, exercised
against a throwaway Neo4j in the existing neo4j tier

**Deps:** STGENV-1 merged (`c8123c1a`). One **human Railway change** is a hard precondition: a TCP proxy
on the **staging** `neo4j` service. Production's stays private.

**Increment:** ONE PR = `scripts/graph-copy.mjs` (a pure refusal decision + a bolt-to-bolt copier), its
guards, and the `docs/OPS.md` runbook entry. **No Railway change is made by this PR, no cron, no button,
and `GRAPHITI_URL` is NOT set on staging.**

---

## Problem

Staging shows **no narrative arcs**. Proven: `NEO4J_URL` is unset there, so `recentFacts` returns
`{facts: [], ok: true}` immediately (`lib/graph/learning.ts:76`) and arc synthesis returns empty before
generating any prose (`lib/graph/arcs.ts:760-769`). Staging's `neo4j` and `graphiti` services exist but
the app is not wired to them.

**Re-extracting is the expensive way to fix it, and the numbers are not close.** Measured from the
production ledger:

| fact | value |
|---|---|
| total LLM spend since 2026-07-24 | **$199.53** |
| of which graph | **$189.80 — 95%** |
| corpus | **3,049 `graph_episodes`, 2 `group_id`s, 3,070 items** |

Re-extraction repays ~$190 once and then ~$30/week forever, genuinely doubling the bill. **Copying costs
zero tokens.**

### The constraint that decides the design

Measured: **neither Neo4j is publicly reachable.** Both are `bolt://neo4j.railway.internal:7687`, no
public domain, no proxy. Railway's internal DNS is environment-scoped, so:

| a process running in | can read prod's graph | can write staging's graph |
|---|---|---|
| a laptop / GitHub Actions | ✗ | ✗ |
| **production** | **✓ (internal)** | only via a staging proxy |
| staging | ✗ | ✓ (internal) |

A laptop-run bolt-to-bolt copy — the obvious shape, and the one first proposed — **cannot run at all**
without exposing one of them. Exposing production's is what STAGING-1 refused.

---

## Decision

**1. The copy runs INSIDE production, and that inverts the risk.** Production reads its own graph over
internal DNS and writes to staging through staging's proxy. Two consequences, and the second is the
whole argument:

- **Production's graph is never publicly exposed.** The STAGING-1 refusal is honoured, not reinterpreted.
- **The job's only WRITE credential is for staging.** Invert the direction by mistake and you write
  *staging* — the harmless direction. Contrast the laptop shape, where a wrong URL writes production.
  This is the same reasoning `staging-refresh.sh` uses, applied one layer up: prefer a design where the
  dangerous action is *unreachable* over one where it is merely *checked*.

**2. The source is opened READ-ONLY, and never otherwise.** Every source session is
`session({ defaultAccessMode: READ })` and every source query runs through `executeRead`, mirroring
`lib/graph/neo4j.ts:91`. A write against the source is not "guarded"; there is no code path that opens a
write session against it. Criterion 3 pins that as an absence, because a guard that merely *checks* a
direction can be satisfied by a direction that is never exercised.

**3. The destination must carry a STAGING MARKER, or the copy refuses.** Direct analogue of
`staging_marker` in Postgres: a `(:StagingMarker)` node that exists **only** in staging, is created once
by a human, and is deliberately absent from production's graph and from `postgres/schema.sql`'s
equivalents. The copier reads the destination for it before writing anything. No marker, no write.

**Why a marker and not a hostname comparison** — STAGING-1 learned this the hard way and the lesson
transfers exactly: a URL is not a destination. libpq honoured `hostaddr` from a query string *and* the
environment, so a URL naming one host connected to another. Bolt has its own resolution and routing
behaviour; comparing hostnames proves the string, not the socket. The marker is read **through the same
connection that will do the writing**, so it describes the database actually reached.

**Residual, stated not hidden:** a production graph that somehow acquired a marker node is
indistinguishable from staging, because the marker *is* the discriminator. Mitigated by the marker being
absent from every schema and creation path, and by Decision 1 making the write credential staging-only —
not by a claim that it is impossible.

**4. Copy is REPLACE-then-fill, in that order, and is idempotent.** The destination's copied subgraph is
removed and rewritten rather than merged, so a re-run converges instead of accumulating. The marker node
itself is **never** deleted — deleting it would disarm the next run's own refusal.

**5. Bounded by `group_id`, which is the tier wall.** `group_id` is the SOLE enforcement of graph tier
isolation (CLAUDE.md §4). The copy enumerates source groups explicitly and writes each under the same
id, so a copy cannot silently widen what a staging viewer can see. Production has **2** today.

**6. NOT in this slice**, each with a reason:

- **The Railway proxy change** — outward-facing configuration, and the human precondition above.
- **Setting `GRAPHITI_URL` on staging** — ⚠️ staging's `graph_episodes` is **empty** while
  `GRAPH_PROJECT_ENABLED=true`, so all 3,049 items read as unprojected and wiring Graphiti would make the
  whole corpus eligible for fresh extraction. That is the ~$190 button firing with nobody pressing it.
  `GRAPH_PROJECT_ENABLED=false` must land first, and belongs with STGENV-4.
- **The cron and the button** — STGENV-4, and they depend on this script existing.
- **Copying `graph_episodes`** — the Postgres ledger is STAGING-1's refresh, not this one's.

---

## Scope

**In:** `scripts/graph-copy.mjs` (pure `copyDecision()` + a thin bolt shell); `test/guards/graph-copy.test.ts`;
a `docs/OPS.md` §12 runbook including the one-time marker creation.

**Cut:** everything in Decision 6.

---

## Acceptance criteria

1. **unit** — `copyDecision` in `scripts/graph-copy.mjs` is a PURE function of
   (sourceUrl, destUrl, destMarkerPresent, sourceMarkerPresent, groups) and returns `PROCEED` only when
   every refusal below passes.
2. **unit** — `copyDecision` REFUSES when the destination carries no staging marker, naming the marker as
   the reason — the analogue of `staging-refresh-decision.mjs`'s target-marker refusal.
3. **unit** — the source is never opened for writing: a guard asserts `scripts/graph-copy.mjs` contains no
   write-session or `executeWrite` call against the source handle, asserted as an ABSENCE over the source
   path specifically, not over the file as a whole (the destination legitimately writes).
4. **unit** — `copyDecision` REFUSES when the SOURCE carries a staging marker, because that means the two
   URLs are swapped and the copy would run backwards into production.
5. **unit** — `copyDecision` REFUSES when source and destination resolve to the same URL, and each refusal
   above fires ALONE for an input that triggers only it.
6. **unit** — the marker node is never deleted: a guard asserts the replace step excludes `:StagingMarker`,
   because removing it would disarm the next run's own refusal.
7. **unit** — every copied relationship keeps its source `group_id`, and a fixture with two groups proves
   they stay distinct — `group_id` is the sole tier wall, so a copy that merged them would widen what a
   staging viewer can see.
8. **neo4j** — against the throwaway Neo4j of the existing tier: a copy into a marked destination
   reproduces node and relationship counts, and a SECOND run leaves them unchanged (idempotent, not
   accumulating).
9. **unit** — the entry path exits NON-ZERO on any refusal, pinned at the call site, and runs only under an
   explicit `--run` token so importing it under test is silent.
10. **unit** — a guard asserts `docs/OPS.md` documents the one-time marker creation and states that
    production's Neo4j is never exposed.

---

## What would falsify this

- **A write reaching production's graph** — Decision 1's inversion failed, or a source session was opened
  for writing.
- **The copy running against an unmarked database** — criterion 2's refusal is not wired to the real
  connection.
- **Staging showing arcs from a group its viewer should not see** — criterion 7 failed and the tier wall
  moved.
- **A second run doubling the graph** — criterion 8's idempotency claim is wrong.
- **The corpus being extracted rather than copied** — `GRAPHITI_URL` was set before
  `GRAPH_PROJECT_ENABLED=false`, and the ~$190 fired.
