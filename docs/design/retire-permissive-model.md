---
access: team
---

# Membership is the sole access model — retiring permissive mode and the tier wall (PRET-1)

**Status:** proposed program design, encoding three operator rulings (2026-08-17, confirmed in
session):
1. **The fused per-project arcs panel IS the product** — the permissive model retires; the
   single tier-wide synthesis ("tier row") retires with it.
2. **An external collaborator is a member like any other** — project access ⇒ that project's
   graph, through the same machinery, no external-specific code path.
3. **The triad** — *content* is governed by project membership and nothing else; *people and
   structure* (roster, org chart, reporting lines) are visible to every member; *money and
   operations* (costs, admin, provisioning) are governed by role. "External" survives only as
   an **invite-time default** — do not auto-enroll this person in General — never as a second
   access system.

**Deps:** none — the prerequisite programs are merged and deployed, and each resolves to its
governing artifact in this repo: Phase C = `docs/design/phase-c-per-project-graphs.md` (substrate:
`lib/projects/context/backfill.ts`, `lib/graph/project-pointer.ts`, `lib/graph/partition-read.ts`),
per-project arcs = `docs/design/per-project-arcs.md` (fusion: `lib/graph/arc-fusion.ts`,
`lib/graph/arc-cache.ts`), the mirror-legs ruling = `docs/design/query-mirror-legs-classification.md`
(discriminant: `lib/query/retrieve.ts`), and the admin flag surface =
`lib/admin/access-enforcement.ts` (PR #578).
**Build with:** fable / high — this program retires an access model; every ordering mistake is
either a leak (wall removed before its membership gate exists) or a vanish (enforcement before
convergence).

**What THIS document's own increment is (scope ruling):** a PROGRAM design. Its PR changes
documentation only; the reviewable public surfaces are the slices (PRET-2..6), each of which
must open with its own narrow spec section naming its files, contracts, and tests before code —
this doc BINDS those slices to the contracts in §4 and the criteria in §7, and a slice may not
weaken them silently.

**Default-deny, stated as the program invariant (not implied):** every access question this
program touches fails CLOSED at every intermediate state — no membership ⇒ no content; an
unconverged team ⇒ no flip (stays permissive, loudly); an unknown/absent principal class ⇒
token semantics (the QMIR-1 positive-test rule); a failed convergence READ ⇒ treated as
unconverged. The existing HTTP wire contracts are unchanged through PRET-2..5 — including the
`/api/v1/*` tier-422 responses pinned by the http tier (`vitest.http.config.ts`, run via `npm run test:http`) — and are re-ruled
only by PRET-6's spec amendment, with the http-tier tests updated in that same slice.

## 1. The end state

One access question everywhere: *is this principal a member of this content's project?* The
`teams.access_enforcement` flag is gone — enforcing is the only behavior. `members.tier`
(`team`/`external`) stops gating anything; it becomes the invite default: an internal invite
auto-enrolls the member in General (the project that holds everything not deliberately
restricted), an external invite enrolls them in nothing. The external-shared built-in remains an
ordinary project whose members happen to be the external collaborators plus everyone. The
roster and org chart are visible to every member. Cost/admin surfaces gate on `members.role`,
as they largely already do. Arc panels are fused per-project for everyone; the tier-row
synthesis has no callers.

## 2. Measured starting state (verified 2026-08-16/17)

- The enforcement-mode consumers are bounded: `lib/access/enforce.ts` (owner:
  `teamEnforcesAccess`), `lib/access/inspect.ts`, `app/api/v1/items/route.ts`,
  `app/api/v1/query/route.ts`, `app/api/dashboard/query/route.ts`,
  `lib/dashboard/timeline-cache.ts`, plus the arcs read path's enforced branch.
- The tier WALL is wider: `isRestrictedTier` alone has 10+ consuming files
  (`lib/auth/visibility.ts` is the choke-point; `lib/query/retrieve.ts`,
  `lib/query/fts-search.ts`, `lib/query/dense-search.ts`, `lib/query/structured-extras.ts`,
  `lib/query/grounding.ts`, `lib/sync/decisions.ts`, `lib/access/agent-tokens.ts`,
  `lib/auth/admin-access.ts`, dashboard server components via `visibleItems`/`canSeeAccess`).
  PRET-4 enumerates them exhaustively by grep in its own spec; this doc deliberately does not
  pretend to.
- §11's backfill (`lib/projects/context/backfill.ts`) runs on scheduler ticks with a
  convergence short-circuit; its shape (team→General, external→external-shared) is dm-proven.
  Its documented promise: a CONVERGED team that flips to enforcing has byte-identical member
  visibility — General membership covers everything a team-tier read served.
- The fused arc path (PPARC) serves enforcing team-tier members today; permissive teams get
  the legacy tier-row synthesis; permissive reads deliberately never arm partitions
  (PCCC-6a: `arm:false`), so a permissive team's initiatives hold no `g:` rows yet.

## 3. The two hazards every slice is ordered around

- **H-VANISH — enforce before convergence.** An item with no membership fails CLOSED under
  enforcing. The flip is therefore GATED on the team's measured convergence, per team, and a
  team that cannot converge is a LOUD stuck-state (surfaced on the admin flag card), never a
  silent stay-permissive.
- **H-WIDEN — tear the wall before the gate exists.** Removing a tier conjunct from a surface
  whose membership gate is not yet live (or not yet leak-tested) fails OPEN. Per surface, the
  order is fixed: membership gate lands and is leak-suite-proven FIRST; the tier conjunct is
  removed SECOND; a guard pins the gate at the call site (the QMIR-1 discriminant lesson:
  pin the call site, not just the function). The roster/structure surfaces are the deliberate
  exception — the triad OPENS them to all members, so their tier gates are removed without a
  replacement gate, and the leak suite asserts the new posture (visible to an
  external-invited member) rather than the old.

## 4. Contracts declared up front (the interfaces precede the slices)
- **The flip gate is the REAL readiness assessment, never the count short-circuit** (cold-read
  H1): the sole permission-to-flip is the flip module's gated path (`assessEnforcementReadiness`
  → `setAccessEnforcement`; the module deleted WITH the subsystem in PRET-6 — its readiness scan
  survives as `lib/admin/access-health.ts`) — the per-item unpartitioned scan +
  full drain that `drainTeamContext`'s own header mandates for "a caller about to change what a
  whole team can see" (`lib/projects/context/backfill.ts:113-119`). The backfill's
  `memCount >= itemCount` short-circuit is satisfiable by multi-membership items while others
  sit unpartitioned — it is demoted to a WHEN-TO-TRY trigger only, never a flip input. (PRET-2's
  spec also names the latent sibling bug for its own fix-or-defer: the same inexact count can
  make the scheduler skip a team holding a genuinely unpartitioned item, `backfill.ts:168`.)
- **Convergence/readiness result** (PRET-2, from the assessment above): `{ ready: boolean;
  unpartitionedItems: number; checkedAt: string; error?: string }` — `error` present ⇒ NOT
  ready (default-deny).
- **Flip writer** (PRET-2): exactly one — `autoFlipIfReady(db, teamId)` in
  `lib/admin/access-enforcement.ts`, running the readiness assessment and, only on `ready`, the
  idempotent single-row
  `update teams set access_enforcement='enforcing' where id=$1 and access_enforcement='permissive'`;
  re-runs and concurrent callers converge on the same terminal state (SR14: no lock needed —
  last-writer-idempotent on a monotone transition; the drain is already single-flighted per
  team). Auto-flips are RATE-LIMITED per scheduler tick — `PRET_FLIP_MAX_PER_TICK`, default
  **3**, env-tunable (cold-read M1: bound the flip-day arm-on-read cost cliff), and the
  flip-day cost estimate — first-arming
  a formerly-permissive team's partitions at the measured per-episode rate — is produced IN
  PRET-2, before any flip, not after (the budgets already bounding the worst case:
  `PPARC_SYNTH_BUDGET_PER_READ`, `GRAPH_FANOUT_PUSH_MAX_PER_PASS`).
- **New teams** (PRET-2): created permissive and auto-flipped by the SAME gate immediately
  after their first drain — one path, no created-enforcing special case (cold-read M2: the demo
  seed writes through `ingestItem` directly, bypassing the items route's `after()` reconcile
  hook, so a team born enforcing and then seeded would show an empty brain until a scheduler
  tick; seed → drain → gated flip is the uniform order, named in PRET-2's spec alongside the
  accepted post-flip latency: a new item whose reconcile hook fails is invisible for up to one
  scheduler tick — accepted and stated, not rediscovered as a bug (cold-read L1)).
- **PRET-2's own release note** names the flip-day product change (cold-read M4): a converged
  team's arcs panel composition changes from the single tier-row narrative to the fused
  per-project panel — ruling 1's accepted change, surfaced at the slice that causes it, not
  four slices later.
- **Stuck-state** (PRET-2): no new table — surfaced through the surfaces that EXIST (the
  permission inspector `lib/access/inspect.ts` → `app/api/dashboard/access/inspect/route.ts`,
  and the `scripts/admin.ts` CLI; there is no admin enforcement card today — PR #578 was
  CLI-only). STUCK is ATTEMPTS-relative: blockers persisting across ≥2 auto-flip attempts
  (same deferral fingerprint); warning-deferred teams are AWAITING MANUAL FLIP, a decision
  state. Schema change: none until PRET-6 (the flag column is untouched through PRET-2..5).
- **Invite default AND the group-recompute disposition** (PRET-4; cold-read H3 — the
  mechanism the triad rides on, named): today General access is DERIVED from tier continuously
  — `lib/access/groups.ts` `syncBuiltinMembership` recomputes the `everyone`/`external` groups
  from `tier` on activation, tier change, and every scheduler tick, and General is granted to
  `everyone` (`lib/access/bootstrap.ts`). Leaving that recompute alive would keep tier a live
  access input through the WRITE route forever (the enforce-the-adjacent-write-route class) —
  "no read path consults tier" would be true and meaningless. PRET-4 therefore RETIRES the
  tier-derived recompute: built-in group membership becomes EXPLICIT state, written once at
  invite (the invite default: internal → the everyone group, external → the external group)
  and thereafter changed only by deliberate membership actions on the same admin surfaces as
  any project membership; existing members are migrated by materializing their current derived
  memberships verbatim (amended by PRET-4 §3.2, cold-read L2: proven in dm as
  ORACLE-VISIBILITY equality rather than row-set equality — the materialization deliberately
  also writes invited-member and non-human posture rows, all visibility-inert). `members.tier`
  keeps its column through PRET-5 as the invite-default record only — no read OR recompute
  path may consult it for access (guard-pinned by grep in PRET-4's spec); PRET-6 decides
  whether the column renames or drops.

## 5. Slice map (each slice = its own ticket, spec section, and full two-model loop)

Ticketing: PRET-1 (this design) is the parent row in the workspace `3-log/tasks.md`; each
slice opens its own `PRET-n` row there BEFORE its build starts (the task gate), projected to
Linear by the pm-sync path (`lib/pm-sync/`) on `aios push` — the slice's PR cites its own
row key in an `AIOS-Work:` trailer, never the Linear key.

- **PRET-2 — the convergence-gated flip.** Building on `lib/admin/access-enforcement.ts`: the
  real readiness assessment as the sole gate (§4), auto-flip for warning-free existing teams,
  new teams created PERMISSIVE and flipped by the same gate after their first seed+drain (one
  path — the §4 contract; an earlier draft of this bullet said "created enforcing", corrected
  per its own contract), the stuck-state surfaced loudly. After this slice every warning-free
  healthy team reads `enforcing`; warned teams await a manual flip with the warnings surfaced;
  the flag still exists (PRET-6 removes it) so a self-host that upgrades mid-program is never
  silently switched without the gate.
- **PRET-3 — arcs unification, for EVERY reader class** (cold-read H2: a retirement that
  fences a reader out must name their destination). The fused path becomes the ONLY arcs read:
  a team-tier member on an enforcing team fuses their oracle partitions (today's behavior); an
  EXTERNAL member fuses over their oracle-resolved scope — which until PRET-4/5 resolves to the
  external-shared built-in's partition (its grandfathered pointer group), leak-free and
  identical in content to their old tier row; a reader on a still-permissive (stuck or not-yet-
  flipped) team fuses over the built-in tier-group partitions their tier resolves to — the
  built-ins ARE pointer-carrying partitions, so fusion serves them without enforcement. The
  tier-row synthesis and the PCCC-6a permissive union then have NO reader in any mode and
  retire in this slice; AC2 (§7.2) is satisfiable for all reader classes at once. Arming
  semantics: member reads arm; the still-permissive fused read keeps `arm:false` until its
  team flips (a permissive read is still not a reader-signal — the PCCC-6a ruling stands until
  enforcement is real for that team).
- **PRET-4 — the tier-wall teardown, per the triad.** Surface by surface under H-WIDEN
  ordering: content legs' `isRestrictedTier` conjuncts replaced by membership gates;
  roster/structure surfaces (people pages, org chart, QMIR-1's org-structural query legs —
  whose external closure deliberately INVERTS) opened to all members; money/ops surfaces
  re-verified role-gated. `members.tier` re-scoped to the invite default (writes confined to
  invite/admin paths; no read path consults it for access), external API keys likewise.
- **PRET-5 — external members' project reads end-to-end.** Mostly falls out of 2–4; this
  slice is the proof: the leak suite exercising an external-invited member with membership in
  project X — sees X's items/graph/arcs and the roster; sees nothing of project Y; an
  attenuated token still sees only its scope (the QMIR-1 token posture is tier-independent
  and survives the program untouched).
- **PRET-6 — retirement.** The flag column and its dead branches removed; the spec's tier-era
  rows amended (§5.8b posture rows, the permissive carve-outs, QMIR-1's permissive-triple
  guard pin — which exists to preserve behavior this program deliberately changes);
  `docs/ARCHITECTURE.md` rows rewritten; self-host release notes with the deploy order.

Ordering constraints: 2 → 3 — no longer a hard dependency (the H2 fix makes fusion serve
still-permissive readers via the built-in pointer partitions) but BINDING for product
coherence: most teams should flip and change panels in one wave, priced by PRET-2's estimate,
rather than experience two separate transitions. 2 → 4, 4 → 5, everything → 6. PRET-3 and
PRET-4 may interleave per surface but never within one surface. Guard-lifecycle note
(cold-read L2): QMIR-1's permissive-triple pin (`test/guards/query-mirror-leg-allowlist.test.ts`,
the `enforce == null` rels arm) guards DEAD code from PRET-2's last flip until PRET-6 amends
it — accepted and named, so its vacuity in that window is not misread as coverage.

## 6. What would falsify this design

- **F1 — a team that cannot converge.** If real data produces a team the backfill cannot
  converge (pathological items with no assignable membership), the program stalls LOUDLY at
  PRET-2 for that team by design. If this affects the operator's own prod team, the program
  halts for re-design rather than shipping a permissive carve-out.
- **F2 — a surface whose tier semantics membership cannot express.** If PRET-4's enumeration
  finds a surface where "external-shared" meant something no membership set can reproduce, it
  gets a NAMED exception in the spec (SR18 discipline: state where the excluded case goes),
  never a silent tier survival. Named watch-list entry for that enumeration (cold-read L3):
  `app/api/v1/okf-bundle/route.ts` — the OKF link-redaction feature's `isRestrictedTier` use
  may encode exactly such semantics.
- **F3 — the byte-identical promise fails.** If a converged team's post-flip member reads
  differ from pre-flip (beyond the arcs panel change ruling 1 accepts), PRET-2's acceptance
  criterion catches it and the flip machinery does not ship until re-derived.

## 7. Program-level acceptance criteria (file names and commands BINDING on the slices)

1. `test/datamechanics/access-flip.datamechanics.test.ts` (PRET-2 must create exactly this
   file) — a seeded team with a converged backfill auto-flips to enforcing and a member's
   retrieve context is byte-identical pre/post flip (modulo the arcs panel, ruling 1); a seeded
   UNCONVERGED team does NOT flip; a convergence read that ERRORS does not flip; the admin data
   function returns the convergence result for both. Verify:
   `npm run test:datamechanics:iso test/datamechanics/access-flip.datamechanics.test.ts`
   exits 0.
2. After PRET-3: `grep -rn "visibleGroupIds\|getArcs(" app/ lib/ --include="*.ts" --include="*.tsx"`
   shows no production CALLER of the tier-row read path — the grep covers the call sites, not
   just the definition file (cold-read M3: the production caller is
   `app/api/brain/arcs/route.ts`, and a definition-file grep goes green with the whole legacy
   path still wired). PRET-3's guard file `test/guards/arcs-single-read-path.test.ts` pins the
   ROUTE to the fused entry for every reader class;
   `npx vitest run test/guards/arcs-single-read-path.test.ts` exits 0.
3. `test/datamechanics/membership-leak-suite.datamechanics.test.ts` (PRET-5 must create
   exactly this file) — the external-member matrix: membership in X ⇒ X's items, X's graph
   partition, X's fused arcs, and the roster; nothing of project Y; an attenuated token still
   sees only its scope. Every absence assertion mutation-verified against its own gate
   (omission-breaks-absence discipline; verdicts pasted in that slice's PR). Verify:
   `npm run test:datamechanics:iso test/datamechanics/membership-leak-suite.datamechanics.test.ts`
   exits 0.
4. After PRET-6: `grep -rn "access_enforcement" lib app postgres/schema.sql` exits 1 (no hits
   — migration files under `postgres/migrations/` are the sanctioned history and are excluded
   from the grep's paths by construction), and the amended governing spec passes its gate —
   preflight `test -x /opt/homebrew/bin/aios && test -f ~/Projects/chetan-workspace/.env`,
   then from the repo root
   `set -a && . ~/Projects/chetan-workspace/.env && set +a && /opt/homebrew/bin/aios spec eval
   docs/specs/project-context-classification-v1.md --tier deterministic --no-llm`
   prints `verdict: SPEC_READY`, exit 0; if preflight fails, record "spec gate: NOT RUN — CLI
   unavailable" in that PR body (never a silent skip).
5. Every slice PR body carries the two-model review attestation line
   (`Reviewed by <tool> — verdict <summary>`) and its mutation table — checked by the existing
   `pr-review-gate` CI (`.github/workflows/pr-review-gate.yml`, matcher
   `scripts/pr-review-gate.mjs`); a slice PR without them does not merge. Gate order per slice:
   the zero-LLM structural checks run and are recorded FIRST (`aios spec eval … --tier
   deterministic --no-llm`, tsc, lint, the tier suites), then the model reviews — a model
   verdict never substitutes for a structural gate.

## 8. Out of scope, named

Row-grain unit kinds beyond items (tasks/decisions/meeting-segment membership grains — Phase D
territory; until then those legs keep their existing source-item gates), the signal layer
(§13), delegated-token semantics (unchanged: always attenuated, tier-independent), and any
multi-team instance behavior (`team_id` scoping is unchanged by this program).
