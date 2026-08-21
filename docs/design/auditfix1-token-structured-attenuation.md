# A delegated token's structured context must obey its scope — AUDITFIX-1

**Status:** spec, revised twice. Codex round 1 **BLOCKED** (3 HIGH, 2 MEDIUM); round 2 **BLOCKED** (2 HIGH, 3 MEDIUM); round 3 **BLOCKED** (1 HIGH, 3 MEDIUM). §5/5b/5c record all three.
**Build with:** opus / high — it changes a shared SQL predicate used by six call sites on the
authorization path, and the defect it closes is a confirmed, reproduced disclosure on a shipped route.

**Deps: none.** Slice 1 of the Phase A audit remediation (AIO-847/848/850/865/872).

---

## What and why

**What:** a delegated agent token stops receiving hand-entered tasks and decisions that its scope does
not cover.

**Why:** it receives all of them today. `provenanceRowSqlFromIds` admits an unsourced row on team
posture alone, with **no reference to `visibleItemIds`** — and every valid token is team-tier by
construction, so the arm is always open for tokens.

**REPRODUCED** (real Postgres, positive control): a principal with an empty visible-item set got
`sources: 0` and a populated `ctx.structured` containing a planted secret task. The control confirmed
a full-visibility principal legitimately sees the same row, so the fixture was not inert.

## 0. Terrain, measured before designing

| | |
|---|---|
| prod agent tokens (total / active) | **0 / 0** — the leak is live on a shipped route but unexploited |
| prod members in `external` built-in | **0** (all 10 in `everyone`) |
| hand-entered rows reachable by the arm (`source_item_id is null and created_by is not null`) | tasks **1**, decisions **0** |
| routes accepting an `aiosd_` bearer | exactly **2**: `app/api/v1/items/route.ts`, `app/api/v1/query/route.ts` |
| ctx construction sites feeding the id-array predicate | **9** — retrieve, timeline, pulse, identity/context, structured-windows, structured-extras, `lib/sync/decisions.ts:41` (missed in round 1), **`app/api/v1/tasks/route.ts:192`** and **`app/t/[team]/people/[handle]/page.tsx:100`** (see §5d) |
| owners of the provenance contract | **3** — `provenanceRowSqlFromIds` (id-array SQL), `provenanceRowSql` (semijoin SQL), `rowVisibleByProvenance` (TS twin) |

**What that means:** severity is CRITICAL by contract violation, not by current data loss. One task row
would leak today. The blast radius becomes real the moment tokens are minted — which is the entire
purpose of the slice that introduced them (AIO-848).

**Not measured:** whether any external consumer has already minted and used a token against a
non-prod install. Nothing in this repo can answer that.

## 1. The rule

**An unsourced row (`source_item_id is null`) is admitted on posture alone ONLY for a member
principal. For a token principal it is never admitted.**

A token's authority is its attenuated scope. A row with no source item cannot be tested against that
scope, so it cannot be shown to a token. Fail closed.

**This does NOT change member behaviour.** Admitting hand-entered rows at team posture is a settled,
deliberate ENFB-2 rule for members ("hand-typed at team posture"). This slice narrows tokens only.

## 2. The design: a POSITIVE principal check, in all three owners

Round 1 killed the first design (a required `unsourced: "include" | "exclude"` field). Two reasons,
both correct:

- **A required TypeScript field is not a runtime guarantee.** `tsc` disappears at runtime, existing
  tests already omit `principal`, and the natural spelling `ctx.unsourced === "exclude" ? closed :
  open` fails **OPEN** for `undefined`, `null`, or any foreign value.
- **`tsconfig.json:25` excludes `test/`**, so a missing field in a test helper never fails typecheck
  at all — the enforcement I claimed does not exist where the omissions actually live.

**The rule, as implemented:** the unsourced arm is emitted only on a positive test.

```ts
const admitUnsourced = ctx.principal === "member" && ctx.teamPosture === true;
```

Absent, `null`, `"token"`, and any foreign value all fail this and therefore **close**. This is the
idiom the codebase already uses for the org-structural legs (`lib/query/retrieve.ts:533`,
`serveOrgStructural = enforce?.principal === "member"`), so it is a consistency fix, not a new pattern.

**All THREE owners take the discriminator, not just the one the exploit runs through.** The module
header claims "one contract, two owners" and the agreement suite
(`enfb2-inquery-provenance.datamechanics.test.ts:109`) asserts the SQL and TS forms against the same
expected truth. Changing only the id-array form would delete one false claim and immediately make
another one false, and would leave a future token surface reusing `rowVisibleByProvenance` or the
semijoin form to silently reopen this. So:

| owner | change |
|---|---|
| `provenanceRowSqlFromIds` (id-array SQL) | ctx gains `principal`; unsourced arm on the positive check |
| `provenanceRowSql` (semijoin SQL) | same, via `ProvenanceSqlCtx` |
| `rowVisibleByProvenance` (TS twin) | gains a required `principal` argument; same positive check |

**Fail-closed defaults are preserved where they already exist.** `matchingDecisions` currently
defaults an absent `enforce` to `{visibleItemIds: new Set(), teamPosture: false}`
(`structured-extras.ts:67`) — that direction must survive, with an absent principal also closing.

### 2a. Token-capable code FORWARDS the discriminator; it never re-derives it

Round 2 killed the "six member-only sites" premise, and the way it killed it matters: **the fix I
proposed would have caused the leak it prevents.**

`matchingDecisions` IS token-reachable. `POST /api/v1/query` sets `principal: "token"` correctly
(`route.ts:137`), but `nativeRetrieve` rebuilds both provenance contexts from ids + `tier` and **drops
the discriminator** (`retrieve.ts:599`, `retrieve.ts:647`), and `structured-extras.ts:61` rebuilds it
a third time. A shared "member context" helper applied there — or any helper deriving principal from
`tier === "team"` — emits `principal: "member"` for a token and **opens the unsourced arm**.

So the rule is:

- **The two token-capable consumers (`retrieve`, `structured-extras`) COPY `enforce.principal`
  verbatim.** Every ctx construction inside `nativeRetrieve` threads the value it was given; none
  reconstructs it.
- **NEVER derive the discriminator from posture or tier.** `tier === "team" ? "member" : "token"` is
  the likely careless spelling and it is wrong: it mislabels every EXTERNAL MEMBER as a token. It
  happens not to change today's outcome (their posture is false anyway), which is exactly what makes
  it a landmine for the next refactor.
- **The shared member-context helper is for the five genuinely member-only consumers only**
  (`work-timeline`, `pulse`, `identity/context`, `structured-windows`, `sync/decisions` — the last two
  reachable only by `aios_` keys, which `authenticateApiKey` accepts and `aiosd_` fails,
  `lib/api/auth.ts:119`). A **guard enumerates its permitted call sites**, because a member-literal
  helper is an assertion, not authentication, and a future token surface could reuse it.

### 2b. The semijoin sites are member-only by convention, not by type

`visibleProjectRows` / `canSeeProjectRow` / `visibleProjectCards` take a `Principal`, and that type
permits `projectScope` — i.e. a token-shaped value (`oracle.ts:26`). Hardcoding `"member"` inside them
would open the unsourced arm for any future internal token caller. They take the discriminator from
their caller like everything else, and are documented + guarded as member-only rather than assumed.

### 2c. The TS twin's signature change reaches tests, which `tsc` does not see

`rowVisibleByProvenance` has four production callers (tasks page, decisions page, project detail,
work-timeline's decision defense) and many test callers. Because `tsconfig.json` excludes `test/`, an
omitted argument becomes `undefined` at runtime and silently CLOSES the arm — so existing
member-positive tests fail in their own tier rather than at typecheck.

**And the exposure is much wider than the TS twin** (round 3). Many data-mechanics tests construct a
`RetrieveEnforce` or a provenance ctx with no `principal`; under verbatim forwarding those become
`undefined`, the positive check closes, and **existing member-positive assertions go red**. Known
examples, to be updated as part of this slice rather than discovered as a mystery red suite:
`access-enforce-retrieve.datamechanics.test.ts:108,184`,
`access-agent-tokens.datamechanics.test.ts:373`, `graph-read-cutover.datamechanics.test.ts:237`,
`enfb2-inquery-provenance.datamechanics.test.ts:49`. The inventory covers every test context passed to
`retrieve`, `matchingDecisions`, either SQL owner, the structured windows and the TS twin.

### 2d. Absent enforcement closes — and the stale "permissive" doc goes with it

`retrieve()`'s public entry already throws when enforcement is absent (`retrieve.ts:1025-1031`), but
`nativeProvider.retrieve()` is independently callable and `RetrievalRequest.enforce` is optional and
still documented as "permissive" (`provider.ts:44,56`) — a comment left behind by PRET-6's retirement
of that model. **Absent enforcement yields `principal: undefined`, which CLOSES the unsourced arm; it
must never synthesise `"member"`.** The stale comment is corrected in the same change, because it is
the sentence that would justify re-adding a permissive default.

## 3. What this deliberately does NOT do

- **It does not let a token see hand-entered rows in projects it IS granted.** That needs the token's
  effective PROJECT set threaded into the structured legs (they carry item ids only). Fail-closed
  first; widening is a product decision with its own slice — **AUDITFIX-7**.
- The other audit findings, each its own slice: connector reconcile at ingest (**AUDITFIX-2**),
  system-project grant guard (**AUDITFIX-3**), membership-writer error handling (**AUDITFIX-4**),
  invite-default stranding (**AUDITFIX-5**), sweep-vs-curation (**AUDITFIX-6**, needs a product ruling).

## 4. Acceptance

- **AC1 — data-mechanics, `test/datamechanics/token-structured-attenuation.datamechanics.test.ts`:** a
  token with an **EMPTY** scope receives neither a hand-entered task nor a hand-entered decision in
  `ctx.structured`, while a **positive control** (member principal, team posture) receives both from
  the same fixture. Without the control this passes on an inert fixture — which is exactly how the
  original repro first passed.
- **AC2 — data-mechanics, same file — THE ONE THAT MATTERS:** a token with a **NON-EMPTY** scope
  simultaneously (a) receives its in-scope **sourced** task and decision, and (b) receives **no**
  unsourced row. Round 1 showed the whole suite otherwise passes an implementation reading
  `principal === "token" && visibleItemIds.size === 0`, which closes only the case I happened to
  reproduce and leaves every realistically-scoped token leaking. Non-empty scope is the NORMAL
  delegated case (spec §10 triple intersection).
- **AC3 — data-mechanics, same file:** a MEMBER principal is unchanged — hand-entered rows still
  appear at team posture. The regression half; this slice must not narrow the settled ENFB-2 rule.
- **AC4 — data-mechanics, same file:** with ONE visible sourced decision and ONE keyword-matching
  unsourced decision present in the SAME invocation, `matchingDecisions` for a non-empty-scoped token
  returns the sourced marker and excludes the unsourced marker. Stated as both halves because "obeys
  the rule" also passes an inert keyword fixture, a query that matches nothing, or an implementation
  that returns `[]` (round 2 MEDIUM).
- **AC5 — data-mechanics, `test/datamechanics/token-structured-route.datamechanics.test.ts`:** the
  assertion runs through the **real `POST /api/v1/query` handler** with a **minted `aiosd_` token`**,
  with only `streamAnswer` stubbed to capture `ctx.structured`. That exercises authentication, the
  route's own `principal: "token"` assignment, enforcement derivation and real retrieval.
  **Round 2 killed the http-tier version of this AC:** minting works there, but the http tier has no
  LLM configured, the route never exposes `ctx.structured` (only deltas and cited sources), and the
  existing socket test cancels the body after asserting `200` — so a still-leaking implementation
  passes it. The socket test stays as a transport/admission pin and is explicitly **not** the leak
  proof.
- **AC6 — unit, `test/access-provenance-principal.test.ts`:** the generated SQL contains the unsourced
  disjunct for `principal: "member"` + team posture, and omits it for **each** of: `"token"`,
  `undefined`, `null`, and a foreign string. The malformed/absent cases are the fail-open direction
  round 1 identified; asserting only the two valid literals would not catch it.
- **AC7 — unit, same file:** all three owners are asserted against an explicit TRUTH TABLE — sourced
  visible, sourced invisible, unsourced authored, unsourced unauthored — crossed with all FIVE principal inputs
  enumerated in AC6 (`"member"`, `"token"`, `undefined`, `null`, a foreign string) — round 3 caught
  that "four" here contradicted AC6's five and would let one malformed case vanish from the table. Round 2's point: "the owners agree" is satisfied by three identically WRONG
  implementations, so agreement is asserted against expected truth, not against each other.
- **AC9 — unit, `test/guards/provenance-principal-callsites.test.ts`:** guards the PROPERTY, not one
  spelling. Round 3's point: a token-capable path can obtain member semantics with a bare
  `principal: "member"` literal and never touch the helper at all, so counting helper references
  proves nothing about escalation. The guard therefore enumerates **every discriminator construction
  site**: any literal `principal: "member"` (or equivalent) in a provenance ctx must appear in an
  allow-list of member-only boundaries, and the two token-capable files (`lib/query/retrieve.ts`,
  `lib/query/structured-extras.ts`) must contain **no** member literal — they may only forward.
  Mutation-verified by planting a member literal in `lib/query/retrieve.ts` and confirming THIS test reddens.
- **AC8 — typecheck (honest scope):** `npx tsc --noEmit` covers **production** sources only
  (`tsconfig.json:25` excludes `test/`), so omission is caught in `lib/` and `app/` but **not** in test
  helpers. Recorded as a production-source check with that limitation stated, not as a durable
  type-level guard over the whole repo.

**Falsifier:** if a token with ANY scope receives a row it cannot attribute to a visible item, the
rule is not implemented, whatever the tests say.

## 5. Round 1 — what it changed

**BLOCKED**, and every finding held on re-derivation:

- **The acceptance suite passed a still-leaking fix.** Fixed by AC2/AC4 (non-empty scope) and AC5
  (route-level, real token).
- **The discriminator was caller-controlled with no runtime rule.** Fixed by the positive
  `principal === "member" && teamPosture` check, with AC6 pinning absent/null/foreign as closed.
- **The rule reached one of three owners.** Fixed by changing all three plus the agreement test (AC7).
- **A seventh consumer was missing** from the inventory (`lib/sync/decisions.ts`) — added to §0.
- **AC6 overstated `tsc`** — `test/` is excluded; rewritten as AC8 with the limit stated.

## 5b. Round 2 — attacking the fold

**BLOCKED**, and both HIGHs were second-order bugs in my own fix:

- **The shared helper would have caused this leak.** `matchingDecisions` is token-reachable and
  `nativeRetrieve` drops the discriminator; applying a member helper there emits `"member"` for a
  token. Fixed by §2a: forward, never re-derive, and never derive from tier/posture.
- **AC5 could not fail.** The http tier has no LLM and the route never exposes `ctx.structured`.
  Replaced with a handler-level dm test that stubs only `streamAnswer`.
- Three MEDIUMs folded: the semijoin sites are member-only by convention not by type (§2b); the TS
  twin's signature reaches test callers `tsc` cannot see (§2c); AC4 and AC7 restated as explicit
  truth conditions rather than "obeys the rule" / "agree".

## 5c. Round 3 — attacking the round-2 fold

**BLOCKED**; the findings narrowed from HIGH to mostly MEDIUM, which is what convergence looks like.

- **HIGH: AC9 guarded a spelling, not the property.** A token path can hardcode `principal: "member"`
  without referencing the helper. AC9 now guards every discriminator construction site and forbids a
  member literal in the two token-capable files.
- **MEDIUM: the test-side blast radius is far wider than the TS twin** — folded into §2c with the
  specific files named.
- **MEDIUM: the provider seam still documents "permissive"** — folded into §2d.
- **MEDIUM: AC7 said four inputs where AC6 has five** — enumerated.

## 5d. What the TEST TIERS found that four review rounds did not

Three defects survived every review round and were caught by running things. Recorded because the
loop's value is exactly this — the rounds narrow the design, the tiers judge the result.

- **The inventory said 7 consumers; there are 9.** `app/api/v1/tasks/route.ts:192` and
  `app/t/[team]/people/[handle]/page.tsx:100` both build a provenance ctx and neither was listed.
  Both are member-only boundaries (`authenticateApiKey` rejects `aiosd_`; a session page), so
  omitting the discriminator CLOSED the hand-typed arm for members: the tasks writeback feed
  silently dropped every UI-origin task, which reddened `tasks-sync-origin-feed` in the dm tier.
  A read of §0 alone would have shipped that. **Both are now on the AC9 guard's allow-list, so the
  inventory is enforced rather than asserted.**
- **`visibleProjectCards` builds a SECOND ctx for its counts** (`lib/access/enforce.ts:337`), separate from the
  row rule, and it too omitted the discriminator — a member's project card would have reported fewer
  tasks than the project page listed. Nothing caught it: the existing card test asserts `visibleItems`
  only and never seeds an unsourced row. A `visibleTasks` assertion was added with it.
- **AC9's guard scored my own code clean.** `lib/access/enforce.ts` names the value once
  (`MEMBER_ONLY_SURFACE = "member" as const`) rather than repeating a literal, and all of the guard's
  needles were literal-shaped — so `import { MEMBER_ONLY_SURFACE }` into a token-capable file and
  `principal: MEMBER_ONLY_SURFACE` would have passed. Round 3 killed the FIRST guard for measuring a
  spelling; naming a constant is just another spelling. The guard now asserts the
  spelling-INDEPENDENT property too: in the two token-capable files, every `principal` in a value
  position must BE the forwarded expression. Its first draft then flagged
  `enforce?.principal === "member"` — a comparison, not an assertion — and swallowed SCREAMING_SNAKE
  constants under a PascalCase-means-type heuristic; both are fixed and pinned as non-vacuity cases.

### 5e. And one mutation SURVIVED — reported as such

**M13: deleting retrieve's forward to `matchingDecisions` reddened nothing.** All four
data-mechanics assertions and every unit test still passed. The reason is worth stating precisely,
because "it fails closed so it doesn't matter" is the wrong conclusion: an absent discriminator
CLOSES the hand-typed arm, so a **token's** outcome does not change at all and every token assertion
still holds — what silently changes is the **member's**, whose keyword-matched hand-typed decisions stop
being served, and no test separates that leg from the recency window that serves the same rows.

A surviving mutation means the suite proves nothing there. Rather than build a fixture that can
distinguish two overlapping legs, the property moved to AC9's guard: in a token-capable file, every
provenance ctx must **carry** the discriminator, not merely be able to. M13 re-run now reddens, and
so do the two sibling omissions (M14, M15) that were equally unpinned.

**15 mutations: 14 reddened only their intended test on the first pass; 1 survived, was fixed, and
now reddens.**

Round 1 also **confirmed the core rule is right and not over-correction**: a hand-typed row
deliberately has no membership axis, and `tasks.project_id` is an ingestion project, not an access
project (`enforce.ts:174`) — so admitting unsourced rows to tokens by project would invent a second
access model.
