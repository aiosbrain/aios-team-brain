---
access: team
---

# The graph-mirror query legs are tier-classed, not partition-classed (QMIR-1)

**Status:** proposed — supersedes the `group_id` widening promised in
`docs/specs/project-context-classification-v1.md` §5.8b (the "Phase C widening" row) and named in
`docs/design/phase-c-per-project-graphs.md` ("Beyond this phase").
**Governing spec:** `docs/specs/project-context-classification-v1.md` §5.8b (structured-context
legs), §11 Phase B ("legs OMITTED for attenuated/partitioned principals").
**Prerequisite state:** Phase C complete (PCCC-1..7) and per-project arcs complete (PPARC-1..4,
PR #565) — the spec's stated blocker ("unticketed until the PCCC-6 read cutover lands") is gone.
**Deps:** none — every prerequisite slice is merged and deployed; this slice builds on current `main`.
**Build with:** fable / high — one slice, but it re-rules a spec promise and touches an enforced
read path (a wrong conjunct here is a leak with no DB backstop).

## 1. Problem, against the measured payload

Spec §5.8b promises: *"the Postgres mirrors gain a `group_id` column in the Phase C widening.
Until that widening lands, these two legs are OMITTED from query context for every attenuated or
partitioned principal."* Phase C is complete; the widening never happened; the omission is live at
`lib/query/retrieve.ts:548` (`omitGraph = enforce != null`) and gates three legs
(`lib/query/retrieve.ts:681-707`): commitments, relationships, actors.

What the two tables actually hold (prod, measured 2026-08-16, read-only proxy):

| table | rows | types present |
|---|---|---|
| `graph_entities` | 8 | `actor` only |
| `graph_relationships` | 1 | `REPORTS_TO` only |

The sole production writer is `lib/graph/company-actors.ts` (single-writer guarded,
`docs/ARCHITECTURE.md` "Company graph" row): one `actor` entity per real member, written on member
lifecycle events (invite, role change, manager change, disable), plus the `REPORTS_TO` edge kept
in lock-step with `attrs.reports_to`. The `commitment` / `workflow` / `decision` / `value_object`
entity types and the other relationship types have **no production writer** —
`scripts/seed-demo.ts` fixtures are the only source that ever mints them.

These tables are the org chart. They are not mirrors of item-derived graph content, and no such
content exists to widen.

## 2. The category error the widening would commit

A `group_id` partition axis presumes rows whose DERIVATION SCOPE is a partition — prose or facts
computed from one initiative's items, meaningless or leaky outside it. An `actor` row derives from
team membership; a `REPORTS_TO` edge derives from org structure. No initiative membership,
restriction, or fan-out changes who is on the team or who reports to whom. Stamping these rows
with a partition would assign every one of them "General" by fiat — tier-classing re-implemented
as a schema migration, plus a column every future reader must pretend means something.

The data is **team-structural**, and the codebase already treats it that way everywhere except the
query path: `lib/dashboard/work-timeline.ts:203` serves the full active-member roster to every
team member's timeline (the §5.8 visibility variant filters WORK evidence, not member identity),
the people surfaces gate on tier (`canSeeCodebases(tier)` in
`app/t/[team]/people/[handle]/page.tsx`), not on initiative membership — and
**`app/api/v1/company-graph/route.ts` already serves every team-tier API key the full actor
roster plus edges, membership-blind and enforcement-blind** (a fourth serving surface of these
exact tables, cold-read finding H1; note its entity read is type-UNFILTERED, which §3.6 must
therefore cover). An enforcing team-tier member sees the roster on every dashboard surface and
through the stakeholder-map API, and then loses "who reports to whom" only when they ask the
brain a question. The omission is a consistency gap, not a protection.

What §5.8b's omission DOES correctly protect — and must keep protecting — is the delegated-token
case (the round-3 Codex Critical): an `aiosd_*` token scoped to one project must not receive
team-wide entities/relationships. That protection is tier-independent and stays absolute.

## 3. Decision

Reclassify the two mirrors as **tier-classed, team-structural data**, and serve them accordingly.
No `group_id` column is added — the widening is explicitly retired as a non-change, because the
axis it partitions by does not exist in this data (§2).

1. **`RetrieveEnforce` gains a `principal: "member" | "token"` discriminant**
   (`lib/query/retrieve.ts:172`), set by both constructing routes (`app/api/v1/query/route.ts`,
   `app/api/dashboard/query/route.ts`). Absent (`enforce == null`) stays the permissive path,
   unchanged. **Default-deny rule, specified as the gate condition itself** (cold-read M1): the
   ONLY serve condition the reopened legs may compile is `enforce.principal === "member"` —
   never a negation (`!== "token"` fails OPEN for a future constructor that omits or miscasts
   the field through `as`). A missing or unrecognized value therefore takes token semantics by
   construction, and criterion 3 tests exactly that arm. The v1 query route's existing refusals
   are untouched: 403 `delegation_not_supported` where it applies today, and the tier-422 wire
   contract pinned in the http tier.
2. **An enforcing TEAM-tier member regains the ORG-STRUCTURAL legs**: the actors leg
   (`entity_type = 'actor'`) and the relationships leg **narrowed to `REPORTS_TO` only** for this
   principal class. Their enforcement continues to narrow item/graph partitions — it never
   narrowed org visibility, per §2.
3. **Delegated/attenuated tokens (`principal: "token"`) keep the fail-closed omission of all
   three legs, absolutely** — tier-independent, exactly today's behavior.
4. **External tier keeps its omission** (`isRestrictedTier` conjunct, audit H1) — unchanged.
5. **The commitments leg stays omitted for every enforcing principal**, and the enforcing rels
   filter is an ALLOWLIST (`REPORTS_TO`), not today's permissive triple: those types have no
   production writer, and the moment one lands its rows are item-derived and must be
   **partition-classed from birth** (a membership join or a `group_id` stamped at write). The
   allowlist is what keeps a future writer's rows from silently flowing to enforcing members
   through the reopened legs — the inverse criterion, guard-pinned (§5).
6. **Spec amended at EVERY home of the retired promise, and the obligation covers EVERY serving
   surface** (cold-read H1+H2). The edit sites are enumerated — a partial amendment ships a spec
   that asserts both the omission and its retirement:
   - spec §5.8b row (~line 569): the widening promise → this ruling;
   - spec §11 Phase B (~lines 1113-1116): the bolded "legs OMITTED" restatement → cite the ruling;
   - `docs/ARCHITECTURE.md` Access-enforcement row (~line 53, "unpartitionable legs OMITTED under
     enforcing — graph (entities/relationships, …)") AND the Company-graph row's reader column;
   - the recorded obligation names ALL serving surfaces of the two tables — `lib/query/retrieve.ts`
     AND `app/api/v1/company-graph/route.ts` (whose read is entity-type-unfiltered today): a
     future item-derived writer must partition-class its rows at write AND no serving surface may
     serve the new types to a scoped principal. Permissive reads are byte-identical to today
     throughout.

## 4. What would falsify this design

- **F1 — a production writer of NON-ACTOR entity types or non-org edges exists.** Checked
  2026-08-16: the writers are `lib/graph/company-actors.ts`, `scripts/seed-demo.ts` (fixtures),
  and `postgres/migrations/20260707120100_backfill_graph_actors.sql` (one-shot member-derived
  actor/REPORTS_TO backfill — a known third writer, in premise) — none mints non-actor entity
  types or non-org edges in production. The tripwire is scoped to that: a writer of item-derived
  types found at build time means the classification premise is wrong — stop and re-design.
  (Cold-read M2: the earlier two-writer phrasing made the backfill migration a false trip.)
- **F2 — any surface hides the ROSTER from enforcing members by membership.** Checked: the
  timeline and people surfaces gate by tier only, and `/api/v1/company-graph` serves the roster
  enforcement-blind (§2). If a membership-scoped roster surface exists, the consistency argument
  collapses.
- **F3 — a token reaches the reopened legs.** The dm criteria below plant the leak and assert
  its absence; if the discriminant can be forged from the wire (a token request constructing
  `principal: "member"`), the design is broken — the routes, not the caller, assign it.

## 5. Acceptance criteria (spec-first; tier, exact file, and verification command per criterion)

1. `test/datamechanics/query-mirror-legs.datamechanics.test.ts` — an ENFORCING team-tier member's
   `nativeRetrieve` context contains the team's actor roster and the `REPORTS_TO` edge (real
   Postgres, `teams.access_enforcement = 'enforcing'`, oracle scope narrower than tier — the
   exact population that loses the legs today), AND the answer path stays open to it: the same
   test asserts the prompt's abstention note still permits structured-context answers
   (`lib/query/claude.ts` — a pure roster question has zero item sources, so
   `retrieve.ts:833` sets `grounded=false`; the note must not forbid answering from the roster —
   cold-read L3). Verify:
   `npm run test:datamechanics:iso test/datamechanics/query-mirror-legs.datamechanics.test.ts`
   exits 0.
2. `test/datamechanics/query-mirror-legs.datamechanics.test.ts` — the same enforcing read with a
   planted `commitment` entity and a planted `OWNS` edge contains NEITHER (the type allowlist —
   the inverse of criterion 1), while a PERMISSIVE team member's read in the same file still
   serves both, byte-equal legs to today. Same command as (1), exits 0; deleting the allowlist
   conjunct must redden exactly this test (mutation-verified, verdict pasted in the PR).
3. `test/datamechanics/query-mirror-legs.datamechanics.test.ts` — a token read
   (`principal: "token"`), a `principal`-ABSENT enforce payload, and an UNRECOGNIZED
   `principal` value (both default-deny arms, cold-read M1) with the same seeded rows each
   contain none of: actors, relationships, commitments; an external-tier read likewise. Same
   command as (1), exits 0.
4. `test/guards/query-mirror-leg-allowlist.test.ts` — the enforcing-path relationship filter is
   pinned to exactly `["REPORTS_TO"]`, the entity filter to `'actor'`, and the discriminant test
   to `=== "member"`. Verify: `npx vitest run test/guards/query-mirror-leg-allowlist.test.ts`
   exits 0; widening any of the three reddens it (mutation-verified).
5. The amended spec passes the gate, and no stale copy of the retired promise survives.
   Preflight: the AIOS CLI must be installed and its workspace env readable — check
   `command -v aios || test -x /opt/homebrew/bin/aios`, and
   `test -f ~/Projects/chetan-workspace/.env`. If BOTH hold, run from the repo root:
   `set -a && . ~/Projects/chetan-workspace/.env && set +a && /opt/homebrew/bin/aios spec eval
   docs/specs/project-context-classification-v1.md --tier deterministic --no-llm`
   → prints `verdict: SPEC_READY`, exit 0. If either preflight fails (a builder without the
   operator's workspace), the decidable fallback is the grep half alone plus recording
   "spec gate: NOT RUN — CLI unavailable" in the PR body — never a silent skip. In both branches:
   `grep -rn "gain a .group_id. column" docs/specs/` must return no hits (exit 1 from grep) —
   scoped to the promise's home, because THIS design doc quotes the retired text as history
   (the measuring-a-corpus-you-edit rule: exclude the file that quotes the thing it retires).
6. `docs/ARCHITECTURE.md` — the "Company graph" row's reader column records the new
   enforcing-member posture in the same PR; `npm run check:docs` exits 0 (drift rule,
   CLAUDE.md §1).

## 6. Slice plan

One slice (QMIR-1, this ticket): the discriminant, the two reopened legs with their allowlists,
the spec amendment at every §3.6 site, the dm/unit tests above, the ARCHITECTURE.md rows. No
schema change, no migration. Also in the slice, from the cold read:

- **The `omitGraph` name/comments stop being true** once member principals regain two legs
  (L1): the reopened pair gates on its own named condition (e.g. `serveOrgStructural`,
  `enforce.principal === "member"` ∧ team tier), `omitGraph` keeps gating only the aggregate
  legs it still truthfully describes, and the now-false comments at `retrieve.ts:170`, `:542`,
  and `:984` are corrected in the same change.
- **`test/datamechanics/access-enforce-retrieve.datamechanics.test.ts:64`** pins today's
  omission ("commitments/actors are OMITTED" under enforcing) — the actors half INVERTS with
  this design and is amended to assert presence; the commitments half survives verbatim (L2).
- **The seed-demo flow assumes a permissive team** (L4): a demo team flipped to enforcing loses
  fixture commitments/OWNS from query context while `/api/v1/company-graph` keeps serving them —
  fictional data, accepted and named here rather than special-cased. Out of scope, named: partition-classing for item-derived entity types (no writer
exists; obligation recorded in the spec per §3.6), the git/people activity digests and task-count
aggregates that `omitGraph` also gates (item-grained — they need the membership join §5.8b already
prescribes, a different mechanism from this ruling), and Graphiti facts (already partition-served
via PCCC-6a: `lib/graph/partition-read.ts` resolves the reader's ready partitions and
`lib/query/retrieve.ts` `fetchGraphFactsForGroups` searches exactly those group ids).
