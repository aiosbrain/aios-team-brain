---
access: team
---

# PRET-6 — the retirement: enforcing becomes the only behavior (slice spec)

## 0. What and why

**What:** `teams.access_enforcement` and every branch it selected are DELETED — the permissive
posture walls, the mode-keyed arms PRET-3/4/5 built (each already carrying its enforcing
replacement), the PRET-2 auto-flip machinery (its job is complete when the flag dies), and the
PRET-4 marker-keyed legacy window. The governing spec's tier-era rows are amended, the QMIR
permissive-triple guard pin retires with the dead code it guarded, the latent backfill
count-skip bug is fixed, and self-host release notes carry the ORDERED upgrade path. The
merge/deploy is gated by a REFUSING precondition: a fleet with any permissive team cannot
take this release (H-VANISH made mechanical, not procedural).
**Why:** two access models cost double review forever, and the program's end state (PRET-1
§1) is one question everywhere. Every prerequisite is now shipped: the flip machinery
(PRET-2), the unified arcs read (PRET-3), the wall teardown + posture substrate (PRET-4), and
the external-member proof (PRET-5).

**Program:** `docs/design/retire-permissive-model.md` §5 slice 5, program AC4.
**Ticketing:** row `PRET-6` (parent `PRET-1`); the PR carries `AIOS-Work: PRET-6`.
**STACKED on PRET-5 (#596)**; retargets after the stack merges.
**MERGE PRECONDITION (the operator's call, logged as morning Q4):** every fleet team
`enforcing` — prod flips manually first. Encoded mechanically in §2.1; the PR must not merge
before it, and cannot deploy past it.
**Deps:** the full stack must land first, each resolving to its governing artifact in this
repo: PRET-2 (#583, merged — `lib/admin/access-enforcement.ts`, `lib/admin/auto-flip-pass.ts`,
spec `docs/design/pret2-convergence-gated-flip.md`), PRET-3 (#584, merged —
`lib/graph/partition-read.ts` `resolveArcScope`, spec `docs/design/pret3-arcs-unification.md`),
PRET-4 (#594, in review, this branch's base — `lib/access/posture.ts`, `lib/access/groups.ts`
`materializeBuiltinMembershipOnce`, spec `docs/design/pret4-tier-wall-teardown.md`), PRET-5
(#596, in review — `test/datamechanics/membership-leak-suite.datamechanics.test.ts`,
`lib/dashboard/work-timeline.ts` mode-keyed walls, spec `docs/design/pret5-leak-suite.md`);
plus the §0 merge precondition (every team enforcing). **Schema:** TWO dropped columns (`teams.access_enforcement`, `teams.autoflip_hold`) via
`postgres/migrations/` with the §2.1 refusing precondition, mirrored in `schema.sql`.
**Build with:** fable / high — a deletion slice's failure modes are the vanish (a branch
removed whose team still needed it — the precondition owns this) and the zombie (a "deleted"
path still reachable — the greps + guards own this).

## 0b. Wire-contract dispositions FIRST (the program's PRET-6 re-ruling clause — contracts precede the deletions, SR9)

The inspector's replacement payload is NAMED up front: `ItemVisibility` (in
`lib/access/inspect.ts`) keeps its name and drops `mode` and `autoFlip` — enforcing-only
semantics, same file, same consumers (the dashboard inspect route + CLI).

- The v1 tier-422 INGEST boundary is UNCHANGED (posture vocabulary survives; `pusherTier`
  semantics identical).
- The permission inspector's `mode` field retires (a diagnostic wire field; its consumers are
  the CLI + admin surfaces in this repo — updated in-slice). `autoFlip` stuck-state fields
  retire with the machinery.
- `lib/api/version.ts`: the enforcement capability row retires; brain-api doc amended.
- `docs/specs/project-context-classification-v1.md`: the §5.8b posture rows and permissive
  carve-outs amended to the membership-only model (program AC4's named doc), historical
  rulings marked superseded, kept as history (the QMIR §5 convention).
- No other route changes status codes or shapes: the permissive arms' READERS were mode-keyed
  branches inside handlers, not separate endpoints.

## 0c. Per-principal safety posture (SR7 — default-deny stated, permitted values named)

Post-retirement there is ONE mode. Posture values remain exactly `"team" | "external"`
(membership in the `everyone` built-in decides — `lib/access/posture.ts`); item `access`
values remain `team | external` with `admin`/`private` still 422-refused at ingest and an
unknown value 422 `invalid_payload` (the boundary logic is byte-unchanged). Every principal
row: a MEMBER reads their oracle projects, default-deny (no membership ⇒ nothing; a
resolution error ⇒ throw ⇒ 401/500, never a widened read); a delegated TOKEN stays
attenuated (`∩ scope`, empty scope ⇒ nothing) with no org-structural or graph legs; an
ABSENT/foreign principal takes token semantics (the QMIR positive-test rule, unchanged); a
CONNECTOR key reads through its member's oracle like any member; non-principals resolve ∅.
Meeting notes keep the posture gate (Phase D). Nothing in this slice changes a fail
direction — it deletes the branches that only ever fired for permissive teams, which the
§2.1 precondition guarantees no longer exist.

## 1. What deletes, exhaustively (the flag's consumer map, verified by grep)

| Site | Disposition |
|---|---|
| `lib/access/enforce.ts` `teamEnforcesAccess` + every `enforce == null` permissive arm downstream | the function DELETES; callers treat every team as enforcing (the null-enforce vocabulary survives ONLY as "no principal resolved yet" inside builders, renamed where ambiguity would linger) |
| `app/api/v1/items/route.ts` mode branch + permissive posture wall + the agent Phase-A project_id proxy arm | enforcing arm becomes the only path; the posture wall line deletes; the agent proxy deletes (tokens always oracle-attenuated) |
| `app/api/v1/query/route.ts` / `app/api/dashboard/query/route.ts` mode branches | enforcement always constructed; the permissive null arm deletes |
| `lib/query/retrieve.ts` permissive arms: the posture walls on items/recency/channel legs, `fetchGraphFacts`'s tier-group resolution (`visibleGroupIds` path), the permissive org-structural triple, `structured-extras`/decisions/tasks posture inputs | enforcing arms become unconditional; `visibleGroupIds`'s retrieve caller deletes; the org legs' allowlist becomes `["REPORTS_TO"]` flat (the triple's guard pin retires WITH it — the program's guard-lifecycle note) |
| `lib/query/fts-search.ts` / `dense-search.ts` posture `else if` arms | delete (visibleIds always present) |
| `lib/graph/partition-read.ts` `resolveArcScope` permissive arm (built-in pointer partitions, arm:false) | deletes; the enforcing arm is the function |
| `lib/dashboard/work-timeline.ts` `walled*` helpers' permissive arms + `lib/dashboard/timeline-cache.ts` tier-row keying (`viewKey`'s no-vis arm) | the vis-variant becomes the only row shape; the tier-row read/write arms delete; PAYLOAD_VERSION bumps (meaning narrows); old tier rows are dead rows collected by the existing TTL — plus a one-time cache purge in the migration's app-side sweep is NOT needed (regenerable, TTL-bounded) |
| `lib/access/posture.ts` + `lib/access/oracle.ts` marker-keyed LEGACY window (the members.tier reads) | delete — builtin rows are explicit state everywhere a supported upgrade path can land (§2.2); the §3.3 allowlist shrinks by two |
| `lib/access/inspect.ts` permissive mode arm | deletes; the inspector is oracle-only, `mode` field retires from its payload (wire note §0b) |
| `lib/admin/access-enforcement.ts`, `lib/admin/auto-flip-pass.ts`, `scripts/admin.ts` `set-access-enforcement`/`auto-flip`, the scheduler's `runAutoFlip` slot, `teams.autoflip_hold` | the whole flip subsystem deletes (its terminal state is reached); `assessEnforcementReadiness`'s BLIND-PRINCIPAL scan AND its unpartitioned-items scan both survive, re-homed as the standing health check (`lib/admin/access-health.ts` — the separability is verified: the scan reads `isPrincipal`/`visibleProjects`/`builtinMembershipBySlug` (see `lib/access/oracle.ts`, `lib/access/groups.ts`)/`findUnpartitionedItems`, none flip-machinery) surfaced through the permission inspector; the `tier-no-access-reads` allowlist entry for `BlindPrincipal.tier` moves to the new file path (the allowlist is file-keyed; the M3 tier MIRROR itself — `lib/access/groups.ts` `mirrorTierToPosture` — is untouched by this slice) |
| `lib/api/version.ts` | CORRECTED (cold-read M4): the reference at `version.ts:33` is a CHANGELOG COMMENT (the 1.19 entry), not a wire field — no capability exists and nothing wire-breaks; the historical line is reworded so AC1's grep passes, stated as exactly that |
| `docker/bootstrap.mjs` post-seed `auto-flip` spawn (cold-read H3) | replaced by a `scripts/admin.ts drain-context` spawn after seeding (→ `drainTeamContext`; `lib/projects/context/backfill.ts` survives) — the demo team is born enforcing with its seed rows partitioned before first serve, preserving the PRET-2 cold-read-M2 fix; `test/guards/autoflip-callsites.test.ts` deletes WITH the subsystem (re-homing table) |
| `scripts/pret-flip-estimate.mjs` (cold-read M1) | DELETED — it queries the dropped column and would zombie-crash; AC1's grep widens to `scripts/` with no extension filter to catch this class |
| `lib/ingest/leg-ledger.ts` / `pipeline-health.ts` `auto_flip` rows (cold-read M2) | KEPT as historical-source entries (`auto_flip: null`), commented as such — prod's `ingest_runs` history holds `auto_flip` rows forever, and deleting the threshold entry would re-inherit the 3h default and pin the banner red on a dead leg |
| `postgres/schema.sql` + the new migration | both columns drop; §2.1's precondition guards the replay |
| `lib/projects/context/backfill.ts` count-skip | SUPERSEDED IN THE MERGE (recorded, not silently dropped): this slice shipped a two-aggregate exact fix (DISTINCT covered `source_item_id`s vs `itemCount`), and TICKSTALL-2 slice A landed on main mid-flight, deleting the convergence short-circuit entirely — the `backfill-candidates` predicate is the exact check now, fixing the same named latent bug more thoroughly. The slice's two-aggregate code retired in the main merge; the PROPERTY (a multi-membership item can never mask an uncovered one) keeps this slice's dm pin, re-specified onto the candidates outcome (AC4) |
| `test/guards/query-mirror-leg-allowlist.test.ts` permissive-triple pin, the flip dm suites (`access-flip`, `access-enforcement-flip`), PRET-5's A8, posture-cutover's permissive arms, `tier-no-access-reads` (`test/guards/tier-no-access-reads.test.ts`) allowlist rows | guard surgery per AC5's re-homing table. A8's disposition is DELETION-WITH-REASON (its property — "the posture wall stands where enforcement is off" — dies WITH permissive; cold-read M3) plus a NEW differently-named arm: the INVITE-DEFAULT FLOOR (an external-invited member with no grants on an enforcing team sees only external-shared content, timeline through their own vis-variant). The complete amend-list (cold-read M6): `test/guards/enforce-retrieve-callsites.test.ts` INVERTS to pin unconditional enforcement construction — this inverted call-site pin is also the anti-zombie guard AC1's greps cannot be (a renamed mode source passes a grep; a call-site pin catches it); `test/guards/autoflip-callsites.test.ts` deletes whole; `test/guards/admin-cli-destructive-commands.test.ts` sheds its `set-access-enforcement` rows; `test/guards/access-bootstrap-callsites.test.ts` re-anchors its ordering pin (materialize-before-anything-assessing); `test/access-enforcement-noop-race.test.ts` deletes with its subject; the dm fixture suites (`access-agent-tokens`, `access-enforce-arcs`, `access-enforce-timeline`, `access-enforced-read`, `access-inspect`) shed their `access_enforcement` fixture writes (teams are enforcing by construction) |

## 2. The two safety mechanisms

### 2.1 The refusing precondition (H-VANISH made mechanical — and replay-derived, cold-read H1)

`scripts/pg-load-schema.mjs` replays EVERY migration file on EVERY deploy (no applied-ledger),
which the first draft's guard would have turned into a fleet-bricker: the old
`20260811160000_access_enforcement_flag.sql` re-creates the column (`default 'permissive'`)
on deploy N+1, re-defaulting every team → the guard refuses forever; and a bare
`exists(select … access_enforcement …)` errors `undefined_column` once the column is gone.
So, three coordinated pieces IN THE SAME PR:

1. **The two old migrations are NEUTERED to comment-only files**
   (`20260811160000_access_enforcement_flag.sql`, `20260817120000_autoflip_hold.sql`) — the
   replay-demands-editing rule `postgres/migrations/README.md` already sanctions; their text
   records what they did and points here.
2. **The MARKER refusal is UNCONDITIONAL; only the permissive scan + drop are existence-gated**
   (amended by the diff-review HIGH — the first shape nested the marker check inside the
   column gate, which silently skipped the PRE-FLAG-ERA fleet class):

```sql
do $$ begin
  if exists (select 1 from teams)
     and not exists (select 1 from migration_markers where name = 'pret4_builtin_materialize') then
    raise exception 'PRET-6 refused: the PRET-4 builtin materialization has not completed on this fleet — upgrade through the prior release first (see docs/RELEASE-NOTES-pret6.md)';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = current_schema() and table_name = 'teams' and column_name = 'access_enforcement') then
    if exists (select 1 from teams where access_enforcement = 'permissive') then
      raise exception 'PRET-6 refused: permissive team(s) remain — flip them first (see docs/RELEASE-NOTES-pret6.md)';
    end if;
    alter table teams drop column access_enforcement;
    alter table teams drop column if exists autoflip_hold;
  end if;
end $$;
```

   A replay after the drop: the marker exists (never deleted in production), the column gate
   takes the false branch — a clean no-op. A from-zero load: no teams at the first preDeploy
   (the marker check short-circuits), the column never exists (schema.sql amended in the same
   PR), and the boot materialization stamps the marker — even on a zero-team fleet — before a
   second deploy can meet a created team. The existence gate is schema-qualified so an
   operator's `backup.teams` copy cannot flip it true post-drop and wedge the replay.
3. **AC3's dm proof runs the real sequence TWICE** (the omitting-a-flag-isn't-skipping
   lesson): the full loader against a teams-holding enforcing DB, twice, diffing schema state
   — idempotence proven by execution, not asserted.

**What SURVIVES the flip-subsystem deletion, stated (cold-read H2):**
`materializeBuiltinMembershipOnce` and BOTH its trigger slots — the `instrumentation.ts` boot
run and the scheduler retry block (`lib/ingest/scheduler.ts`, a SEPARATE block from
`runAutoFlip`) — because they are the self-heal for a restored-from-backup DB or a fleet
whose sweep failed pre-upgrade, and the §2.1 marker precondition is what makes "explicit
builtin state everywhere" true rather than assumed. **The PRE-FLAG-ERA fleet (installed
before the flag migration existed — the column never on their DB) is covered by the
UNCONDITIONAL marker refusal**: the first draft waved this class through on the claim that
its teams were created by an explicit-state `createMember`, which is false — explicit-state
writes shipped with PRET-4, AFTER the flag column — so such a fleet has no builtin rows and
would go entirely dark at cutover; it now refuses until it upgrades through the prior
release (whose boot materializes and stamps the marker).

`pg:schema` is Railway's preDeploy hook — the chain, by repo path (SR16):
`railway.json` `deploy.preDeployCommand: "npm run pg:schema"` → `package.json` `pg:schema` →
`scripts/pg-load-schema.mjs` (which applies `postgres/schema.sql` then every
`postgres/migrations/*.sql` in filename order and exits non-zero on a raised exception) — so
a refused migration HALTS the release; the old code keeps serving, nothing flips blind. The same guard makes the migration replay-safe on a
from-zero load (a fresh DB has no teams). The from-zero replay passes by construction — in CI that
is `npm run pg:schema` against the workflow's fresh service Postgres (`.github/workflows/ci.yml`),
and locally `npm run db:test:up`, which resets the container first precisely so its replay really
is from zero (`scripts/db-test-up.sh`).

### 2.2 The supported upgrade path (release notes, verbatim obligation)

A self-host may not skip the flip era: the notes REQUIRE stepping through the prior release
(PRET-2..5 — its auto-flip converges warning-free teams; warned teams flip manually with the
CLI that release still carries), verifying `select count(*) from teams where
access_enforcement='permissive'` is zero, THEN taking this release. The §2.1 guard enforces
exactly this — an out-of-order upgrade fails loudly at preDeploy with the fix named. The
PRET-4 boot materialization ships in the prior release too, so by the time this release can
deploy, builtin rows are explicit state — which is what licenses deleting the legacy window.

## 4. Acceptance criteria (spec-first; exact commands)

1. Program AC4's grep, verbatim: `grep -rn "access_enforcement" lib app postgres/schema.sql`
   exits 1 (no hits — `postgres/migrations/` is the sanctioned history, excluded by
   construction), and `! grep -rn "teamEnforcesAccess\|autoFlipIfReady\|runAutoFlipPass" lib/ app/ scripts/ --include="*.ts"`
   exits 0.
2. `npm run db:test:up` (the from-zero replay incl. the new migration's guard) exits 0, and
   the full dm tier passes post-surgery: `npm run test:datamechanics:iso` exits 0 — with
   EXACTLY ONE tolerated exception, named in advance rather than classified after the fact
   (SR11): the pre-existing TZ-sensitive `task-update-action` date test that fails on
   non-UTC machines and is green in CI (`TZ=UTC npm run test:datamechanics:iso
   test/datamechanics/task-update-action.datamechanics.test.ts` exits 0 — the discriminating
   probe). ANY other failure blocks the slice.
3. The precondition REFUSES correctly, dm-pinned in
   `test/datamechanics/pret6-precondition.datamechanics.test.ts` (this slice creates exactly
   this file): applying the guard SQL against a DB holding one permissive team raises; against
   an all-enforcing fleet it passes (raw-SQL fixture — the migration file's own text is
   executed, never a paraphrase: the mutate-with-the-real-shape rule).
4. The count-skip property is dm-pinned in the existing backfill suite (as superseded — the
   TICKSTALL-2 candidates predicate is the mechanism now, §1's supersession row): a team with
   `memCount >= itemCount` but one unpartitioned item is NOT skipped (the latent-bug fixture the program
   names); `npm run test:datamechanics:iso test/datamechanics/context-backfill.datamechanics.test.ts`
   exits 0.
5. Suites adapt, not vanish (the re-homing table in the PR body): the flip suites delete WITH
   their subsystem (named, with the properties that survive — the blind-principal scan's new
   home gets its own dm arm in `test/datamechanics/access-health.datamechanics.test.ts`,
   created by this slice); the leak-suite matrix (PRET-5) passes UNCHANGED except A8's
   permissive control, which re-specifies to the precondition's world (a second ENFORCING
   team, same assertions through the oracle);
   `npm run test:datamechanics:iso test/datamechanics/membership-leak-suite.datamechanics.test.ts test/datamechanics/access-health.datamechanics.test.ts`
   exits 0.
6. Docs re-gate after amendment: `docs/ARCHITECTURE.md` (enforcement rows rewritten),
   `docs/specs/project-context-classification-v1.md`, this spec, and the program doc — for
   each: preflight `test -x /opt/homebrew/bin/aios && test -f ~/Projects/chetan-workspace/.env`,
   then from the repo root
   `set -a && . ~/Projects/chetan-workspace/.env && set +a && /opt/homebrew/bin/aios spec eval
   <file> --tier deterministic --no-llm` prints `verdict: SPEC_READY`, exit 0; preflight
   failure → "spec gate: NOT RUN — CLI unavailable" in the PR body, never a silent skip.
7. Release notes ship in-diff and are mechanically checked (SR2):
   `test -f docs/RELEASE-NOTES-pret6.md` exits 0, and
   `grep -c "set-access-enforcement" docs/RELEASE-NOTES-pret6.md` prints ≥1 (the one-command
   flip is named) while
   `grep -c "PRET-6 refused" docs/RELEASE-NOTES-pret6.md` prints ≥1 (the refusal message is
   explained where its reader will search for it).

## 5. Out of scope, named

- The UI phase (members panel, enforcement card, invite polish, view-as) — the program's
  post-PRET backlog, unchanged.
- The enforcement backlog (dashboard-list oracle gating, items-by-id, graph-query,
  `lib/query/grounding.ts`'s corpus statistic) — inherited from PRET-4 §5 verbatim.
- Phase D row grains; the okf-bundle membership expression (post-PRET-5 slice, still
  parked); `members.tier` KEEPS its column and name as the invite-default record (decided:
  renaming buys nothing — the wire serves it, the M3 mirror maintains it; re-open only if a
  future consumer misreads it as access state, which the `tier-no-access-reads` guard
  prevents).
- Old timeline/arc tier-row cache garbage: UNREACHABLE-and-harmless, not "TTL-collected"
  (cold-read L1 corrected: nothing deletes `work_timeline_cache` rows — the TTL governs
  staleness, and post-retirement `viewKey` only ever yields vis-variant keys, so tier rows
  are simply never read again); the PAYLOAD_VERSION bump makes any old row a MISS → inline
  rebuild, never a 500 or served-empty window (deploy-window fail direction verified), and
  the cache layer's `memberId == null` arm becomes always-throw (test-only callers, stated).
  Writer/expiry discipline (SR14):
  `work_timeline_cache` keeps its sole writer (`lib/dashboard/timeline-cache.ts`, 5-min TTL
  SWR — an unread tier row is never served post-retirement because `viewKey` only ever
  yields vis-variant keys, and unread rows are overwritten-or-ignored regenerable state);
  `arc_cache` likewise (`lib/graph/arc-cache.ts` sole writer, `arcTtlMs`); no lock changes.
