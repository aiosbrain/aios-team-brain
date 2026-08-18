---
access: team
---

# PRET-4 — the tier-wall teardown: membership replaces tier on every read path (slice spec)

**What:** every read path that consults `members.tier` for access cuts over to
membership-derived state (explicit built-in group membership for the two-bucket wall, the
oracle for enforcing reads), the tier-derived group recompute retires in favor of explicit
invite-time enrollment, roster/org-structure opens to every member, and money/ops surfaces
re-verify on role.
**Why:** the operator's confirmed triad (2026-08-17) makes membership the sole access model —
but leaving tier live as a read input anywhere (the oracle's builtin-tier conjunct, the
recompute's write route, ~40 read surfaces) would keep a second, contradictory access system
alive indefinitely; PRET-5's external-member proof and PRET-6's flag retirement are both
impossible until this slice lands. An external collaborator granted a project still cannot
see it today (the wall conjunct blocks ruling 2); that is the user-visible defect this slice
fixes.

**Program:** `docs/design/retire-permissive-model.md` (PRET-1) §5 slice 3, bound by its
contracts — ruling 3 (the triad: content→membership, people/structure→every member,
money/ops→role) is what this slice makes true, and ruling 2 (an external collaborator is a
member like any other) is what it unlocks on the query path.
**Ticketing:** row `PRET-4` in the workspace `3-log/tasks.md` (parent `PRET-1`), projected via
pm-sync; this slice's PR carries `AIOS-Work: PRET-4`.
**Deps:** PRET-2 merged (#583 — the fleet is converging to enforcing) and PRET-3 merged (#584 —
arcs already read mode-keyed, tier-free). ONE schema-adjacent change: no new tables/columns;
one marker-guarded app-code data reconcile (§3.2 — the single-writer guard forbids SQL DML on
access tables by design, so there is no `postgres/migrations/` file in this slice).
**Build with:** fable / high — this slice changes what every read path consults for access;
the failure modes are a leak (a wall removed before its replacement gate is live — H-WIDEN), a
vanish (a reader class losing content silently), and a silent no-op (retiring the write-side
recompute while the oracle's read-side tier conjunct re-derives it — §1c).

## 0. What and why — the mechanism in one paragraph

`members.tier` today carries three loads at once (content wall, structure wall, ops wall) and
is consulted at read time in ~40 surfaces. This slice splits the loads per the triad, with one
mechanism doing most of the work: **viewer posture**. Every content read that today keys on
`members.tier` keys instead on POSTURE — `"team"` iff the member holds a row in the `everyone`
built-in group, else `"external"` — resolved once at the auth boundary and threaded through the
EXISTING tier plumbing unchanged (the posture vocabulary `"team" | "external"` is deliberately
identical to the tier vocabulary, so `visibleItems`/`canSeeAccess`/the timeline cache's
group_key namespace/the meetings-codebases-maturity gates all survive verbatim with a changed
input). Built-in group membership stops being tier-derived (the recompute retires) and becomes
explicit state: written at invite from the invite-time default, edited thereafter only by
deliberate membership actions. Tier leaves every read path; the permissive two-bucket wall
stands identically for un-flipped teams (H-WIDEN satisfied); PRET-6 deletes the permissive
branch together with the flag.

## 1. The four moves (each with its hazard named)

### 1a. Posture replaces tier at the auth boundaries (content wall input)

- New: `resolveViewerPosture(db, teamId, memberId): Promise<"team" | "external">` in
  `lib/access/posture.ts` — `"team"` iff a `group_members` row exists for the team's
  `everyone` built-in; else `"external"`. Fail direction: a READ ERROR throws (the boundary's
  existing 401/500 handling — never a silent widen or narrow); a structurally-absent row is
  `"external"` (default-deny). No eligibility re-check here: the auth boundaries refuse
  non-active members before posture is consulted (`lib/api/auth.ts` rejects non-active;
  session loads likewise), and the enforcing oracle applies its own eligibility independently
  (§1c). NOTE active CONNECTOR keys DO authenticate and read today
  (`lib/admin/access-enforcement.ts` documents "a connector key can read the corpus today";
  prod has 4) — connectors are therefore posture-carrying principals in this design, §3.2
  materializes their rows, and §2's table has a row for them (cold-read H1).
- **Cutover window discipline (cold-read H2 — the deploy fails CLOSED, not open):** until the
  materialization marker is CONFIRMED (a process-cached read of
  `migration_markers['pret4_builtin_materialize']`, set by the boot-time run or the tick
  retry), the posture resolver AND the oracle's builtin-row acceptance apply the LEGACY tier
  conjunct — pre-slice semantics exactly, so a stale `everyone` row from a failed recompute
  hook sync (the class `lib/access/groups.ts:130-136` documents, kept inert today only by
  `lib/access/oracle.ts:85`) is never served live before the sweep's DROP has run. After
  confirmation, rows are authoritative and tier is never consulted. The confirmation flag
  flips once per process, monotonically — no per-request marker read after it is set.
- Cutover at the auth boundaries only — the places a `members.tier` column read becomes a
  `memberTier`/viewer-tier value, enumerated (cold-read L4): `lib/api/auth.ts:145`
  (`authenticateApiKey`'s member select), `lib/auth/guard.ts:24` (`currentMember`),
  `lib/auth/team-context.ts:46` (`resolveTeamContext`), `lib/integrations/read.ts`
  (`resolveIntegrationsAdmin`), `app/api/brain/arcs/route.ts:47`, and
  `app/api/dashboard/query/route.ts`'s member load. Downstream files keep their `memberTier`
  parameters and semantics; the VALUE is now posture. (This includes `pusherTier` on the
  items POST path: an external-POSTURE key pushes `access='external'` rows — same wire
  behavior for every member whose posture equals their tier, which at cutover is every
  member, §3.2. All `canAccessAdmin` callers receive member data from these already-async
  loaders, so the posture input forces no sync-to-async plumbing.)
- What this makes true with zero per-file edits: the meetings gate (`canSeeMeetingNotes`),
  codebases (`canSeeCodebases`), maturity (`canSeeMaturity`), identity context
  (`canSeeMemberContext`), social (`visibleByAccess`), pulse aggregates, dashboard server
  components (`visibleItems`/`visibleTasks`/`visibleDecisions`/`canSeeAccess`), and the
  timeline cache keying (`lib/dashboard/timeline-cache.ts` — tier is a group_key namespace;
  identical vocabulary ⇒ no invalidation event) all become membership-derived without their
  files changing. The `test/guards/dashboard-tier-filter.test.ts` choke-point guard stays
  green by construction.

### 1b. The enforcing wall conjunct drops (ruling 2 lands on the query path)

On ENFORCING reads the legacy conjunct is now WRONG, not redundant: an external member granted
project X must see X's `access='team'` rows (ruling 2), and the tier/posture conjunct is the
only thing blocking that today. Per content leg the shape becomes: `enforce != null` → the
oracle filter alone; `enforce == null` (permissive) → the posture wall alone.

- Legs where the oracle filter is already in-query and the conjunct simply drops on the
  enforced arm: `app/api/v1/items/route.ts:241` (the "legacy-tier conjunct — always" comment
  retires with it), `lib/query/retrieve.ts:327/641/663` (items legs),
  `lib/query/dense-search.ts:63`, `lib/query/fts-search.ts:45`.
- Graph legs (the external-graph unlock): `lib/query/retrieve.ts:586-589` drops
  `tier !== "team"` — every MEMBER principal with `graphProjectIds` gets
  `selectEnforcedGraphPartitions(visibleProjectIds)`; both constructing routes
  (`app/api/v1/query/route.ts:151`, `app/api/dashboard/query/route.ts`) drop the
  `memberTier === "team"` condition on supplying `graphProjectIds`. Tokens unchanged
  (`principal: "token"` never gets graph legs — existing posture, pinned).
  The permissive arm (`visibleGroupIds(slug, tier)`) takes posture as its input — same
  two-bucket group resolution, membership-derived.
- Phase-D-grain legs (decisions/tasks/meeting-notes — no membership row exists; program §8
  keeps their existing gates): the audience/tier conjuncts SURVIVE with posture as input, both
  modes — named, not silently widened: `lib/query/retrieve.ts:675` + post-filters,
  `lib/query/structured-extras.ts:25/67`, `lib/sync/decisions.ts:49`,
  `app/api/v1/tasks/route.ts:196`, the meetings gates. The commitments leg's exact surviving
  predicate, stated to remove the ambiguity (cold-read M5):
  `isRestrictedTier(posture) || omitGraph` — the posture conjunct is the ONLY permissive wall
  on commitments (`omitGraph` is false when `enforce == null`) and it stays.
- Surfaces with NO oracle today keep their posture wall in BOTH modes (H-WIDEN: no removal
  without a live gate; their oracle gating is PRET-5-or-later work, named in §5):
  `app/api/v1/items/[id]/route.ts:29`, `app/t/[team]/library/[itemId]/page.tsx:36`, all
  dashboard list pages, `app/api/v1/graph-query/route.ts:50` (posture input),
  `lib/query/grounding.ts:37` (posture input; its enforcing-mode `visibleIds` omission is a
  pre-existing volume side channel, named in §5 — not widened by this slice).
- `app/api/v1/okf-bundle/route.ts` — the program's F2 watch-list entry, resolved as a NAMED
  EXCEPTION (SR18): the bundle keeps its two-bucket semantics wholesale with posture as the
  ceiling input (the `tier` request param keeps its name and vocabulary — wire-compatible; a
  caller's voluntary downgrade downgrades posture). Full membership expression is deferred
  with the reason written down: link redaction requires a per-path visibility map that
  membership can only express via an oracle join this route does not have, and "voluntary
  downgrade" has no membership analogue yet. Destination: its own slice after PRET-5 proves
  external membership end-to-end.

### 1c. The recompute retires; built-in membership becomes explicit state

The write route (PRET-1 §4's H3 contract) — and the read conjunct that would silently undo the
retirement:

- **The oracle's builtin-tier conjunct retires in the same slice** (`lib/access/oracle.ts:85`,
  `member.tier === requiredTier`) — behind the §1a marker confirmation (cold-read H2): with it
  standing forever, an explicitly-enrolled member's builtin row is re-derived away at read
  time and the whole slice is a no-op; with it dropped before the sweep, stale rows go live.
  What REMAINS unchanged and permanent: the `isBuiltinEligible` read-side check
  (agents/connectors/offroster/inactive resolve builtin rows to nothing under enforcing) — so
  the slice-2 planted-agent dm pin
  (`test/datamechanics/access-groups.datamechanics.test.ts`) survives VERBATIM, and a
  materialized agent/connector row is grant-inert under enforcing while carrying permissive
  posture (§1a) — the two meanings are stated, not smuggled. ALSO permanent (cold-read M6):
  the unknown-builtin-slug fail-closed — a builtin row whose slug is outside
  `{everyone, external}` contributes nothing; AC6's grep is scoped to the tier equality so
  this branch survives the retirement.
- `syncBuiltinMembership` is DELETED with all five trigger classes: the `ensureBuiltins`
  tail-call (this alone disarms the scheduler/team-create/backfill/flip triggers), both
  `lib/auth/pg-login.ts` activation hooks (+ the `syncBuiltinMembershipSafe` helper), both
  `lib/admin/members.ts` hooks. `test/guards/access-bootstrap-callsites.test.ts` is amended in
  the same commit (it currently REQUIRES all five sites).
- **Invite writes the state** (the invite-time default doing its one job, at WRITE time —
  the sanctioned tier consumer): `lib/admin/members.ts createMember` writes the builtin row
  for EVERY member it creates — humans, agents, AND connectors, per their tier (cold-read H1:
  posture parity with today for every kind; the rows are grant-inert for non-humans via the
  oracle's unchanged eligibility) — internal → `everyone`, external → `external`, at CREATE
  (status `invited`; the row is inert until activation via the oracle's `isPrincipal`, so
  activation hooks become removable, not replaceable). On UPSERT the builtin row is
  reconciled ONLY when the upsert's tier actually changed (a stated tier change is a
  deliberate posture move; a no-op upsert never clobbers a deliberate cross-enrollment). The
  invite surfaces gain the choice the program mandates: the v1 invite route accepts an
  optional `tier: "team" | "external"` field (default `team`, unchanged wire behavior when
  absent), and the admin invite form gets the internal/collaborator select
  (`components/admin/invite-member.tsx` + `app/t/[team]/admin/actions.ts inviteMember`) — the
  one UI element this slice carries, because the checkbox has to exist somewhere.
- **Deliberate membership actions get their first surface**: `addMemberToGroup` /
  `removeMemberFromGroup` relax the `is_builtin` refusal for HUMANS ONLY — a builtin-target
  add requires `isBuiltinEligible`, not merely `isPrincipal` (cold-read H3: `isPrincipal`
  admits agents, and a human-editable agent-into-`everyone` door would reopen the round-3
  Critical's posture half; non-human posture is set ONLY by the invite-default at creation,
  exactly like tier today). The singleton refusal stays. `scripts/admin.ts` gains
  `add-group-member` / `remove-group-member` (slug-addressed, audited via the existing
  writer). CLI-only is the PRET-2 precedent; the members panel UI is the UI phase.
  **Posture moves keep the invite-default record in sync** (cold-read M3): a deliberate
  builtin move on a human ALSO updates `members.tier` to the resulting posture (in `everyone`
  → `team`, else `external`; one action, one audit row) — so the token layer
  (`lib/access/agent-tokens.ts` mint/verify) and Linear provisioning, which read the record
  live, can never diverge from posture. Tier becomes a maintained mirror of builtin state,
  never an independent access input.
- **Member lifecycle without the recompute**: deactivation leaves rows in place —
  access-inert read-side (`isPrincipal` in the oracle; auth refuses disabled principals
  before posture) — and hard delete cascades via the existing composite FK
  (`postgres/schema.sql`, table `group_members`: `foreign key (team_id, member_id) references
  members (team_id, id) on delete cascade` — a standing contract in the canonical schema,
  verifiable by grep, no migration needed). A tier change stops being a
  membership event: the CLI upsert path no longer moves groups; moving a member between
  postures IS `add/remove-group-member` (one deliberate action, audited).
- **The readiness scan re-expresses** (`lib/admin/access-enforcement.ts:139-149`): the
  blind-human blocker derives each member's required floor from their EXPLICIT builtin
  membership (in `everyone` → [general, external-shared]; in `external` → [external-shared];
  in NEITHER → the lockout warning) instead of from tier — otherwise every legitimately
  cross-enrolled member red-flags after the model changes. AND the cheap agent/connector
  warning scan plus `placedMemberIds` (`lib/access/groups.ts:387-399`) count only placements
  the ORACLE would honor — builtin rows are excluded for non-humans (cold-read M4: otherwise
  every materialized agent row reads as "placed", the cheap warning goes silent, and a
  never-flippable team pays the full prepare→drain every tick forever).

### 1d. Structure opens; money/ops re-gate on role

- **Org-structural query legs invert** (the program's named QMIR-1 inversion; the classifying
  doc's §3.4 is marked superseded, kept as history): `lib/query/retrieve.ts:710/:719` drop the
  `isRestrictedTier(tier) ||` disjunct, leaving `!serveOrgStructural` — the guard's four
  positive pins survive untouched and `test/guards/query-mirror-leg-allowlist.test.ts` gains
  NEGATIVE pins (the tier disjunct is gone from the two org legs — while the commitments leg
  at `:699` keeps its stated predicate, §1b). The PERMISSIVE rels arm narrows for
  external-posture readers: the newly-opened restricted-posture audience gets `["REPORTS_TO"]`,
  not the permissive triple (cold-read L3 — `OWNS`/`BLOCKS` have no production writer and a
  newly-opened audience gets the same allowlist the enforcing narrow grants; the
  team-posture permissive triple survives unchanged, guard-pinned).
  `test/datamechanics/query-mirror-legs.datamechanics.test.ts`: the two external
  arms INVERT (rewritten to assert actors + REPORTS_TO present, commitments absent — the
  enforcing-external arm was built to catch exactly this rewrite; inverting it deliberately is
  the point); the token/absent/foreign arms survive VERBATIM as the token-semantics proof.
- **Roster surfaces open to every member**: `app/api/v1/members/route.ts:28` and
  `app/api/v1/identities/resolve/route.ts:26` drop their tier 403s (a new dm arm pins the
  external key's 200 — no test pins the old 403; the roster payload's `tier` field keeps
  serving the invite-default record, a named non-access wire field, cold-read M2);
  `app/api/v1/company-graph/route.ts:41` drops its tier 403 with the payload OTHERWISE
  UNCHANGED (cold-read H4 corrected an earlier draft: the route's edge read is the ownership
  triple `OWNS/TOUCHES/PRODUCES` ONLY — `REPORTS_TO` is never served as an edge; it reaches
  clients via actor `attrs` in `people[]` — so there is nothing to "tighten to REPORTS_TO"
  without corrupting the stakeholder map, and the entity read's type filter cannot move
  server-side without breaking the ownership join's workflow targets. QMIR §3.6's
  server-side-filter obligation stays recorded, untouched by this slice; prod measurement:
  1 REPORTS_TO row, zero ownership rows, so the newly-opened audience receives what team
  callers receive today — asserted as payload EQUALITY between an external and a team key in
  `test/datamechanics/company-graph.datamechanics.test.ts`, whose 403 arm inverts and whose
  401 arm survives). The work-timeline roster is already tier-blind (verified — at target).
- **People pages stay posture-gated this slice, ruled and named**: `canSeeMemberContext` /
  `canSeeCodebases` / `canSeeMaturity` serve MIXED payloads — roster identity (structure)
  fused with per-person productivity metrics (derived content: commit counts, AI-adoption
  scores). Opening them wholesale hands every client collaborator the engineering
  scoreboard; splitting the payloads is real product surface work. This slice takes the
  posture input swap only; the identity/metrics payload split is recorded as the UI-phase
  item with the triad obligation attached (SR18: the excluded case's destination).
- **Money/ops**: `app/t/[team]/costs/page.tsx:51` drops its tier gate — the page's EXISTING
  role scoping (`scopeLlmUsage`: admin → team-wide, member → own rows) then delivers ruling 3
  verbatim ("a client-member sees their own usage, not the company bill") with no new UI;
  `app/api/v1/costs/route.ts` re-gates the same way (role-scoped, tier gate dropped).
  `canAccessAdmin` (`lib/auth/admin-access.ts:16`) keeps its two conjuncts with the tier
  conjunct's INPUT becoming posture: `role === "admin" && posture === "team"` — the
  defense-in-depth against a lone bad `role` write survives as a membership check (making a
  collaborator a real admin = role + deliberate `everyone` enrollment, two writes), and
  `test/admin-access.test.ts` keeps its denial pin with the posture input. The v1 capability
  403s that are ops-shaped (`attribution`, `pm-sync/health`, `work-events`, `subscriptions`,
  `projects`, `metrics`, `codebases`) keep their existing gates with posture as input this
  slice — reclassifying each is PRET-6 spec-amendment territory; none of them serves roster
  or unlocks ruling 2.
- **The arcs note redaction** (`app/api/brain/arcs/route.ts:149` — internal LLM config/error
  detail): ops information, re-gated on ROLE (`admin` sees the note), tier consult gone.
- **The permission inspector moves with the wall** (cold-read H5 — it was absent from the
  first draft, and an inspector that disagrees with enforcement is worse than none;
  `lib/admin/access-enforcement.ts` quotes the agreement rule): `lib/access/inspect.ts` takes
  posture as its viewer input and mirrors the real read exactly — ENFORCING → the oracle
  factor alone decides (the tier/posture conjunct is no longer a factor, matching §1b's
  wall drop, so an external member granted project X inspects as VISIBLE on X's team rows);
  PERMISSIVE → the posture wall alone. `findLeaks` follows the same composition (no false
  leaks on ruling-2 reads). The `via: "builtin_tier"` label renames to `via: "builtin"`
  (the derivation it named is retired). Its docstring's "the tier conjunct is ALWAYS a
  factor" contract is rewritten to the mode-keyed rule; its tests re-home in AC7's table.

## 2. Per-principal posture table (SR7 — every class, both modes, fail direction)

| Principal | Permissive team | Enforcing team | Fail direction |
|---|---|---|---|
| Human in `everyone` (today's team-tier) | posture `team` — byte-identical reads | oracle projects; wall conjunct gone (no behavior change: `canSeeAccess(team, ·)` was already universal) | posture read error → boundary 500/401; absent row → `external` (default-deny) |
| Human in `external` only (today's external-tier) | posture `external` — byte-identical two-bucket reads | oracle projects — including `access='team'` rows of granted projects (ruling 2, THE new capability, leak-suite-pinned here and proven end-to-end in PRET-5) | same |
| Human in NEITHER builtin (new state, possible post-retirement) | posture `external` | oracle: only explicitly granted projects | default-deny by construction |
| Standing agent (materialized row per pre-cutover tier) | posture per its row — TODAY'S behavior preserved (no stealth-flip ahead of the operator's manual flip; the row is the posture source) | builtin rows grant-INERT (`isBuiltinEligible` unchanged — the planted-agent pin survives verbatim); explicit project placements only | default-deny |
| Active connector (key-holding; materialized row per pre-cutover tier — cold-read H1) | posture per its row — a team-tier connector's corpus pull is byte-identical (the repo documents "a connector key can read the corpus today"; prod has 4, and connector-warned teams are exactly the still-permissive ones, so a silent narrow here would bite prod at deploy) | builtin rows grant-inert (`isPrincipal` refuses connectors in the oracle — unchanged); reads resolve ∅ | default-deny |
| Offroster / disabled / invited | auth refuses (no key auth for non-active; sessions likewise) — no posture consulted | oracle resolves ∅ (unchanged) | closed |
| Delegated token (`aiosd_*`) | UNCHANGED — attenuated, tier-independent, `principal: "token"`, no org-structural legs, no graph legs beyond scope (program §8) | UNCHANGED | closed (existing pins survive verbatim) |

The write-side wire contract is untouched: the v1 tier-422 ingest boundary
(`test/http/items.http.test.ts` — 422 `forbidden_tier` on admin/private, 403 on cross-tier
modify) survives by construction (posture has the same vocabulary; the boundary logic is
unchanged). Read-side 403→200 changes are exactly the four roster/money openings named in
§1d — each with its dm arm inverted or added in this slice, none pinned by the http tier
(verified: no http test pins the members/company-graph 403s).

## 3. Sequencing inside the slice (H-WIDEN discipline) and the reconcile

### 3.1 Build order (gate first, wall second — per surface)

1. Posture resolver + explicit-state writes (invite, CLI, sweep) + oracle tier-conjunct
   retirement land FIRST, with the recompute still running — the recompute's output and the
   explicit writes agree by construction (same predicate), so the intermediate tree is safe.
2. The recompute + its five trigger classes delete, guards amended, in the same PR.
3. Wall edits (§1b/§1d) land LAST, each with its replacement input already live.

### 3.2 The materialization is a marker-guarded boot reconcile, not a SQL migration

The single-writer guard forbids access-table DML in `postgres/**` by design (migrations never
seed access), so the materialization lives INSIDE `lib/access/groups.ts` (the sole legal
writer): `materializeBuiltinMembershipOnce(db)` — marker `pret4_builtin_materialize` in
`migration_markers`, invoked from the scheduler tick strictly post-activation (old writers
gone — the retired recompute cannot re-clobber deliberate edits made after the sweep).
**Marker discipline (SR14 — deliberately NOT the PRET-3 claim-first pattern): the reconcile
runs first and the marker is written LAST, only after every team succeeded.** The reconcile
is idempotent per team (set-diff against the same predicate), so a crash mid-run retries in
full on the next tick, and two replicas racing the un-claimed marker merely repeat
converging idempotent statements — a permanently-suppressed half-materialization (marker
claimed, reconcile dead) is impossible by construction. The deliberate-edit clobber window
this opens (an admin edit between activation and a late-succeeding sweep could be reverted
by the sweep's tier-derived diff) is accepted and bounded: the CLI edit surface ships in the
same deploy, the window is ticks-until-first-success, and the sweep's audit row names every
row it moved. One-time, fleet-wide, per team:

- ADD the rows the recompute's predicate implies for HUMANS (including `invited` — the new
  ruling: rows exist from invite, inert until active) and, once, for standing AGENTS and
  CONNECTORS per their pre-cutover tier (the posture source, grant-inert under enforcing —
  §1c; cold-read H1);
- DROP builtin rows the tier predicate refutes — the LAST legal tier-derived write, closing
  the stale-row class (a tier-downgraded member's surviving `everyone` row) that today is
  kept inert only by the oracle conjunct this slice retires;
- audit one summary row per changed team (`access.builtin_materialized`), and record a LOUD
  failure via `recordIngestRun` (source `pret4_materialize`) — an unswept fleet keeps
  functioning on rows the old recompute maintained until the sweep succeeds, bounded and
  stated.

Where it runs (cold-read L1 + H2): FIRST in `instrumentation.register()` — awaited before the
scheduler starts, so on a healthy boot the fleet is materialized before the first tick — and
as the retry, the scheduler-tick slot the PRET-3 sweep occupies (`lib/ingest/scheduler.ts` —
after `runAccessBootstrap`, BEFORE `runAutoFlip`, so a first-tick flip never assesses ahead
of the sweep). Deploy-window safety: old code's recompute keeps rows converged until
activation; on the ADD side the only divergence is a member CREATED in the gap by old code
whose sync failed, closed by the sweep's ADD; on the DROP side, stale rows in the gap are
kept inert by the §1a marker-keyed legacy conjunct (fail-closed to pre-slice semantics — the
window does NOT fail open, and an errored sweep extends the legacy conjunct, never the
exposure). The verbatim promise (PRET-1 §4) is proven in dm as ORACLE-VISIBILITY equality,
not row-set equality (the invited-member rows are a deliberate row-set diff with no
visibility effect; the program doc's "no-op diff by construction" sentence is amended to
this formulation in the same PR — cold-read L2).

### 3.3 `members.tier` after this slice

The column stays through PRET-5 (program contract) as the invite-default record, maintained
as a MIRROR of builtin posture by the deliberate-move actions (§1c, cold-read M3). Its
sanctioned consumers, exhaustively (cold-read M2 closed the first draft's gaps):
`createMember` (write: the default → the builtin row), `scripts/admin.ts` (write/CLI flag),
the invite surfaces (write), the posture-move actions (the mirror write), the materialize
sweep (the one-time read, marker-bounded), the §1a marker-keyed LEGACY conjunct in the
oracle/posture resolver (pre-confirmation only, dies at confirmation),
`lib/provisioning/linear.ts` (external-system seat mapping — non-access, named),
`app/api/v1/members/route.ts` (SERVES `tier` as a roster wire field — the invite-default
record as metadata, not an access input; unchanged), `app/t/[team]/layout.tsx` (renders the
record — display, not access), `lib/admin/access-enforcement.ts` (`BlindPrincipal.tier` — a
DIAGNOSTIC payload field in the readiness report; the scan's floor derivation moves to
explicit membership per §1c), and the token/gateway layer (`lib/access/agent-tokens.ts`
mint/verify, `lib/gateway/persistence.ts:988`, `lib/gateway/admin-persistence.ts`,
`lib/gateway/policy.ts`, `gateway_executions.tier_snapshot` — delegated-token semantics,
program §8 out of scope, UNTOUCHED). Everything else is a guard violation (§4 AC4/AC5).

## 4. Acceptance criteria (spec-first; exact files and commands)

1. `test/datamechanics/posture-cutover.datamechanics.test.ts` (this slice creates exactly this
   file) — on a PERMISSIVE team, with the seeded principal classes ENUMERATED (cold-read H1's
   green-by-construction fix): a team-tier human, an external-tier human, an ACTIVE TEAM-TIER
   CONNECTOR key, a standing agent, an invited human, a disabled human — each class's read
   outcomes (items list leg, tasks leg, decisions leg through the route-level readers) are
   byte-identical pre/post cutover (posture == materialized tier; the connector arm is the
   one H1 proved a naive build silently narrows); removing a human from `everyone` via the
   writer flips their posture to `external` on the NEXT read with no recompute resurrecting
   the row (the retirement's observable — mutation target M-A); adding an external-invited
   human to `everyone` grants team posture (the new deliberate action) AND mirrors
   `members.tier` to `team` (the M3 sync). Verify:
   `npm run test:datamechanics:iso test/datamechanics/posture-cutover.datamechanics.test.ts`
   exits 0.
2. `test/datamechanics/enforcing-wall-drop.datamechanics.test.ts` (this slice creates exactly
   this file) — on an ENFORCING team: an external member with membership in project X reads
   X's `access='team'` items through `/api/v1/items` and the retrieve items/fts/dense legs
   (ruling 2 — the wall conjunct is gone); sees NOTHING of project Y (absence, mutation-
   verified against its own gate); their query carries `graphProjectIds` and the graph leg
   resolves X's partition; a delegated token on the same team still gets no graph and no
   org-structural legs (verbatim posture). Verify:
   `npm run test:datamechanics:iso test/datamechanics/enforcing-wall-drop.datamechanics.test.ts`
   exits 0.
3. `test/datamechanics/query-mirror-legs.datamechanics.test.ts` — the two external arms
   inverted (actors + REPORTS_TO present, commitments absent, both modes; the permissive
   external rels arm asserts the `["REPORTS_TO"]` narrow, not the triple — §1d), token/
   absent/foreign arms byte-unchanged; `test/datamechanics/company-graph.datamechanics.test.ts`
   — the external-key arm inverted to 200 asserting payload EQUALITY with a team key's
   response (cold-read H4: the honest assertion — the opened audience receives exactly what
   team callers receive, nothing tightened, nothing widened), the 401 arm unchanged.
   Verify: `npm run test:datamechanics:iso test/datamechanics/query-mirror-legs.datamechanics.test.ts test/datamechanics/company-graph.datamechanics.test.ts`
   exits 0.
4. `test/guards/tier-no-access-reads.test.ts` (this slice creates exactly this file) — a
   unit-tier source scan pinning THE REAL READ SHAPES (cold-read M1 — the mutate-with-the-
   real-shape rule): outside the §3.3 allowlist files, no `lib/`/`app/` production source
   reads tier by property access (`.tier`, `member.tier`, `m.tier`, `memberTier` sourced
   from a members select) OR by SELECT STRING (a `.from("members")`/members-table select
   list containing `tier`, the shape every real boundary read uses —
   `lib/auth/team-context.ts:46`, `lib/api/auth.ts:145` are the templates). The allowlist is
   enumerated IN the guard with each entry's §3.3 reason string, so a new consumer must
   argue its case in the diff. Verify:
   `npx vitest run test/guards/tier-no-access-reads.test.ts` exits 0.
5. Guard surgery lands green in the same PR: `test/guards/access-bootstrap-callsites.test.ts`
   re-pins the NEW call-site set (createMember's explicit write; the sweep's scheduler site;
   the pg-login hooks' ABSENCE), `test/guards/query-mirror-leg-allowlist.test.ts` gains the
   negative tier-disjunct pins, `test/guards/access-single-writer.test.ts` passes UNCHANGED
   (the materializer lives in the writer). Verify:
   `npx vitest run test/guards/access-bootstrap-callsites.test.ts test/guards/query-mirror-leg-allowlist.test.ts test/guards/access-single-writer.test.ts`
   exits 0.
6. The recompute is gone by grep (complete commands, inverse discipline):
   `! grep -rn "syncBuiltinMembership" lib/ app/ scripts/ --include="*.ts"` exits 0 (no
   production caller or definition), and the oracle's tier EQUALITY conjunct is gone —
   scoped so the unknown-slug fail-closed SURVIVES (cold-read M6):
   `! grep -n "member.tier === requiredTier" lib/access/oracle.ts` exits 0, while the
   builtin-slug allowlist check remains (its own dm pin: a direct-written foreign-slug
   builtin row still contributes nothing).
7. Existing suites adapt, not vanish (the re-homing table): every deleted/inverted `it(` from
   the tier-era suites (`access-groups` sync tests, the mirror-legs external arms, the
   `access-flip`/`access-enforcement-flip` sync-dependent fixtures, `admin-access` input swap,
   the `inspect.ts` tier-conjunct tests — cold-read H5)
   appears in the PR body with its replacement test name or written reason;
   `npm run test:datamechanics:iso test/datamechanics/access-groups.datamechanics.test.ts test/datamechanics/access-flip.datamechanics.test.ts test/datamechanics/access-enforcement-flip.datamechanics.test.ts`
   exits 0 post-surgery.
8. `docs/ARCHITECTURE.md` access rows updated in the same PR; `npm run check:docs` exits 0;
   `docs/design/query-mirror-legs-classification.md` §3.4 marked superseded (kept as
   history); `docs/design/retire-permissive-model.md` §4's "no-op diff by construction"
   materialization sentence amended to the §3.2 oracle-visibility-equality formulation
   (cold-read L2). The amended docs re-gate: preflight
   `test -x /opt/homebrew/bin/aios && test -f ~/Projects/chetan-workspace/.env`; if BOTH hold,
   from the repo root
   `set -a && . ~/Projects/chetan-workspace/.env && set +a && /opt/homebrew/bin/aios spec eval
   docs/design/pret4-tier-wall-teardown.md --tier deterministic --no-llm`
   prints `verdict: SPEC_READY`, exit 0 (same for every other doc this slice amends); if
   either preflight fails, record "spec gate: NOT RUN — CLI unavailable" in the PR body —
   never a silent skip.

## 5. Out of scope / named residuals (each with its destination)

- **The external leak suite end-to-end** — PRET-5 (`membership-leak-suite.datamechanics.test.ts`,
  program AC3); this slice's AC2 pins the unlock, PRET-5 proves the matrix.
- **The flag, the permissive branches, the posture resolver's permissive arm, and the v1
  capability-403 reclassification** — PRET-6.
- **Oracle gating for the surfaces that have none** (items by-id, library detail, dashboard
  list pages, graph-query, tasks/decisions writeback): they keep their posture walls both
  modes (H-WIDEN); membership enforcement for them is the enforcement backlog's next entry,
  recorded here so it is fenced IN somewhere, not out.
- **`lib/query/grounding.ts`'s enforcing-mode corpus statistic** (no `visibleIds` — a pre-existing
  volume side channel, not widened by this slice): named for the enforcement backlog.
- **The work timeline's enforcing evidence walls** (cold-read M7 — classified, not silently
  fenced out): the vis-variant keeps its posture walls on evidence legs, so ruling 2 does
  NOT land on timeline evidence in this slice — an external member granted X sees X's team
  rows via items/query/arcs but not X's team-access work evidence on the timeline or
  `GET /api/v1/timeline`. Fail-closed; destination: PRET-5 alongside the leak-suite proof
  (the timeline joins the matrix there or gets its own follow-on, decided in that spec).
- **The people-pages payload split** (roster identity vs productivity metrics) — UI phase,
  with the triad obligation recorded (§1d).
- **okf-bundle's membership expression** — its own post-PRET-5 slice (§1b's named exception).
- **The members panel / group-membership UI** — UI phase (CLI is this slice's surface).
- **Phase D row grains** (tasks/decisions/meeting-segments) — unchanged source-item gates.
- **Gateway/token tier persistence** (`tier_snapshot`, `subject_tier`, mint/verify) —
  delegated-token semantics, program §8, untouched.
