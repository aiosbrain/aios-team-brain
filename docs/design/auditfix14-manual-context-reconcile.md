---
eval_tier: deterministic
spec_gate: block
---

# AUDITFIX-14 — reconcile project context after manual imports

Status: accepted by Astra after completed Fable specification reviews (round 2 CLEAR), 2026-09-07. Brain task **AUDITFIX-14**;
[Linear AIO-1147](https://linear.app/je4light/issue/AIO-1147/phase-a-lane-b-item-14-reconcile-project-context-after-manual-sync-and).
Baseline: staging `754bcb93bdf7f28ab49a5b13af47ebc52e059cf9`.
Parent: `docs/specs/project-context-classification-v1.md` (internally V2), §11.2 and Phase A;
work order: `docs/design/phase-a-remediation-plan.md`, Lane B **17 → 14 → 18**.

**Build-with:** Opus / high. Astra owns specification/decisions, Fable reviews spec and code,
fresh Astra / high performs final review. CLI spec gate is deterministic with `--no-llm`;
substantive model reviews remain separate prerequisites.

**Deps:** AUDITFIX-17 is complete (Brain PR #697 on staging, companion PR #683 on main).
No further slice, external contract change, migration or product ruling blocks this work.
Accepted spec and SPEC_READY precede implementation. This PR targets **staging**.

## Scope and intended outcomes

Add one bounded project-context pass after the chat `/sync` operation and each of the four admin
“Run now” actions (Slack, Plane, Linear, GitHub). Small eligible backlogs become readable through
existing project permissions without waiting for a scheduled tick. Larger backlogs report that
more work may remain and can progress through repeated manual runs even with the poller disabled.
A successful provider import is not a guarantee that every imported item is immediately visible.

In scope: the shared manual reconciliation helper, wiring at these five entry points, honest
context/partial-failure summaries, necessary revalidation, focused tests and architecture update.
Out of scope: item-ID threading or importer return-shape changes, reverse-import/writer discovery
(AUDITFIX-18 next), scheduling/admission/concurrency redesign, unbounded drain, automatic latency
promises, new UI controls, broader connector reporting cleanup and permission-policy changes.
`scripts/connectors.ts:verify` already calls `runManualSync` and inherits this same pass and summary;
no new caller argument or separate CLI implementation is needed. The five hook locations remain
unchanged. `app/api/v1/codebases/route.ts` and admin access drain remain separate paths.

## Re-derived behavior and sources of truth

- `lib/ingest/manual-sync.ts:runManualSync` awaits four runners in parallel, then optional Linear
  inbound processing. It records/returns a provider summary but never calls context backfill.
  Its `safe` helper turns thrown runs into null, which is also treated as unconfigured; error-only
  results with zero integrations can disappear from the text. Do not let a new successful context
  line conceal such an already-failed import.
- `app/t/[team]/admin/integrations/actions.ts:syncSlackNow`, `syncPlaneNow`, `syncLinearNow` and
  `syncGithubNow` authorize, invoke the runner, and return. None reconciles. Slack revalidates
  before its returned-error branch because a failed private-channel run can purge rows; the other
  three return errors before revalidation. All four catch thrown failures.
- `lib/ingest/run.ts` writes via `ingestItem`. Returned errors can follow committed items from
  earlier sources/documents; a thrown operation is not proof of no writes. A runner's
  `skipped: true` means process single-flight prevented that import, not “already up to date.”
  GitHub manual calls already use `force: true`; preserve it. Do not change runner concurrency.
- `lib/projects/context/backfill.ts:backfillTeamContext` already bootstraps system topology,
  selects only candidates through `backfill-candidates.ts`, and reconciles item units/memberships.
  It accepts a cutoff and batch size, needs **no item IDs**, and preserves completed items on a
  partial failure. `cursor !== null` means a full page or a failure resume point; it is not an
  exact count of remaining work. The default 500 is too broad for the deliberately small manual pass.
- `items` remains the ingest-owned source. `project_context_units` and
  `project_context_memberships` remain owned by the existing context primitives; reconciliation
  uses the same item-lock/transaction protocol as AUDITFIX-13. Candidate exclusions, human standing
  exclusions, retracted-unit behavior, and no-widening rules remain unchanged. The permission
  oracle, not a row count or tier label alone, decides whether a member can read an item.
- The scheduler already reconciles after its connector legs. The manual/admin omission is a
  separate gap, indefinite when the poller is disabled. Historical zero manual-run records do not
  prove admin actions unused: those actions do not currently record provider runs. No current
  fleet prevalence or latency measurement was taken for this specification.

The architecture source table and `docs/design/auditfix2-writer-inventory-guard.md` §0a/§4/§8
support this boundary. The old “needs ID threading” deferral is refuted by the existing helper.
Installed Next documentation was read at
`node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-server.md` and
`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/revalidatePath.md`: actions remain
server-side and authorize before mutations; `revalidatePath` works in Server Functions. No new
`after()` hook or streaming protocol is required.

## Decision: one team, one candidate page, after imports settle

Create `lib/ingest/manual-context.ts` (new file) as the shared owner of the manual pass and its
context status/message. Each authorized invocation awaits it exactly once, after its relevant
runner(s) settle and after the existing optional Linear inbound stage for chat `/sync` settles.
Run it even when imports return errors, throw, are skipped, report zero changes, or are unconfigured:
committed partial imports and older candidate backlog cannot be inferred from returned counts.
Unauthorized admin actions invoke neither import nor reconciliation.

The helper calls once after imports settle:

`backfillTeamContext(db, teamId, { batchSize: 25, afterId: null })`

Omit `createdBefore`: this is a single candidate query, not a drain whose corpus needs a fixed
cutoff. `ingestItem` explicitly stamps `items.created_at` from the application clock, so a
Postgres-clock cutoff could exclude just-imported items under clock skew. No timestamp read or
clock-comparison policy is needed. Future-dated eligible rows can be selected. Candidates committed
before the selection statement's snapshot are eligible; later commits may wait for another pass.
Existing item locks handle concurrent reconciliation. A complete result describes this eligible
query pass, not a snapshot of all content at response time. Keep the scheduler's cutoff unchanged.

**Why 25:** a manual response waits for this work. An explicit page of 25 is one quarter of the
scheduler's existing 100-item page and one twentieth of the helper default 500, limiting added
per-invocation reconcile calls while letting ordinary small imports complete. This is an engineering
work bound, not a measured optimal value or a wall-clock limit. Bootstrap, candidate SQL and an
individual reconcile can take arbitrarily long; the existing query route's `maxDuration=120` is
not a guarantee this workflow finishes in 120 seconds. Add no timeout race, new env knob or loop.

Do not call `backfillAllTeams` or `drainTeamContext`. Each manual pass starts at null; successfully
repaired rows cease to be candidates, so repeated runs progress without a stored manual cursor.
Do not consume or overwrite the scheduler cursor. A permanent failure can block progress at an
item; report it rather than skipping it or claiming eventual completion. Concurrent operations
still rely on existing idempotent item reconciliation; this change adds no fleet allocation.

## Outcomes, diagnostics and recovery

Return an internal context outcome with status `complete | pending | failed`, the known scanned/
unit/membership counts, and a shared human-readable message. It need not change either public
return shape: `ManualSyncResult` remains summary/created/updated/errors, and admin actions remain
`{ ok, error?, message? }`.

| Context result | Meaning and required message content |
| --- | --- |
| `ok: true`, null cursor | Complete **eligible candidate query pass**. Report scanned and memberships created; never “all items are visible.” Excluded/retracted content is deliberately outside this claim. |
| `ok: true`, non-null cursor | Reached the 25-candidate limit. Report “more project-context work may remain” and “run sync again to continue/check.” A full final page can require a further zero-work pass to establish completion. |
| `ok: false` or thrown failure | Reconciliation failed. Preserve known counts when returned; report “imported data was kept,” failure and retry guidance. A thrown result has unknown progress, not an asserted zero writes. |

A pending/failed message must explain that some imported content may not yet be readable. Mention
the scheduled pass only conditionally (“the scheduler can also continue when enabled”), not as a
promise: disabled scheduling is a principal reason for this fix. Re-running invokes the same
idempotent imports and bounded candidate pass; it never reverses an already-committed import.

Record one best-effort context `ingest_runs` row per pass through `recordIngestRun`:
`teamId`, `source: "context_backfill"`, `trigger: "manual"`; `created` is memberships created,
and meta names entrypoint (`manual_sync`, `slack`, `plane`, `linear`, `github`), status, known
counts and informational cursor. `manual_sync` covers both dashboard and CLI callers. Pass source as the literal string above or a scanner-resolvable named constant;
trigger must be the literal `"manual"` because the ledger guard does not resolve trigger constants. `startedAt` is
the context-stage start, so duration excludes provider imports. Failed rows carry the corresponding diagnostic and `ok: false`;
complete and pending rows carry `ok: true` with `errors: []`, distinguished by `meta.status`.
Routine bounded pending work is not an outage: `pipeline-health.ts` reads verdicts and failure
streaks across all triggers. One failed pass is an `unconfirmed` failure; two consecutive failures
confirm it. A successful pending manual row deliberately breaks a standing scheduler failure
streak: the bounded pass succeeded, although backlog may remain. It does not refresh the
scheduler-only staleness clock. Unknown progress is null in metadata, not a fabricated measurement. The scheduler reader
filters `trigger="scheduler"`; manual records must
not alter its durable cursor/rotation state. The ledger writer already swallows failures, so the
caller result must remain useful even if logging fails. Do not add a new logging reliability system.

For chat `/sync`, append one **Project context** line to the existing per-source summary. Preserve
provider created/updated counts; reconciliation counts are not additional imported items. Count a
pending/failed context outcome as one issue in the existing `errors` total and use an incomplete/
issues headline instead of unconditional “Scrape complete.” Retain original provider errors and
source labels even when a source throws or returns errors with zero integrations; do not replace
them with “no connectors configured.” Preserve minimal skipped/busy information with retry guidance.
Treat an attempted Linear inbound throw similarly, while retaining its existing opt-in/ordering.
This is local outcome bookkeeping, not a redesign of connectors, retries or inbound processing.
When everything is genuinely unconfigured, preserve that explanation alongside the context result.

For admin actions, preserve the provider's existing count message on a clean result and append the
context message. Return `ok: true` only when the provider pass is successful/non-skipped and the
context outcome is complete. For a provider error, skipped import, or incomplete/failed context,
return `ok: false` and put **both** the primary import diagnostic (if any) and context outcome in
`error`; never overwrite one with the other. The GitHub repository panel ignores successful
`message` fields and only renders errors, so pending work must not be hidden in `{ok:true,message}`.
When the provider succeeded but context is pending, lead with “Import succeeded” before explaining
the remaining context work. A skipped provider instead says the import was skipped/busy; never
claim an import succeeded when it did not.
After every authorized attempted operation, revalidate the existing integrations path after the
context stage, including partial/failed imports; this preserves Slack's purge behavior and lets
committed state refresh. No new UI component or changes to unauthorized behavior are needed.

## Acceptance criteria and observable tests

Tests begin from these outcomes and must reproduce the missing behavior against the baseline.
Do not call the new helper manually after an entry point in a test that purports to prove wiring.

- **AC14-01 — five real entry points:** For chat `/sync` and each of the four exported admin
  actions, a provider stub performs a real `ingestItem` of a small fresh item then returns counts.
  On entry-point completion, real Postgres has its active item unit and correct current system
  include membership, and the existing oracle allows the authorized fixture principal to read it.
  Assert no membership/read for a second team's item. This must fail before wiring is added.
- **AC14-02 — correct sequencing/selection:** Multiple chat provider promises settle independently;
  include a final provider write and a synthetic inbound-stage stub write (production inbound is
  not an item writer). The single context pass includes their eligible items and occurs after all
  settle, even if a leg reports failure. A future-dated eligible item is also reconciled in a small
  real-DB fixture. Spies pin exactly one call with batch 25, null start and no cutoff. Insert another
  candidate after selection using a narrow test seam: it may remain for the next pass, and the first
  response must not claim all content is visible. No concurrent-write drain is required.
- **AC14-03 — bounded progress:** Seed an independent literal 26 eligible candidates and have
  imports report zero changes. First real entry-point call reconciles at most 25, leaves one,
  reports pending without “all visible,” and records pending. A second call handles the remaining
  candidate and reports complete; no scheduler runs. Prove empty input is not a change-count gate.
- **AC14-04 — partial/throw/busy outcomes:** Parameterized orchestration tests cover returned
  provider errors, throw-after-write, zero-integration error, busy/skipped and inbound throw.
  Reconciliation still runs once; original diagnostics survive; successful other providers/counts
  remain. At least one real-DB partial-error and one throw-after-write case proves committed items
  become eligible/readable rather than merely asserting a helper call.
- **AC14-05 — context failure/recovery:** Simulate returned partial backfill failure
  and thrown reconciliation. Callers report failure/unknown progress honestly, keep import counts
  and combine primary errors. With real Postgres and a narrowly injected reconcile failure after
  one successful candidate, completed membership survives, failed candidate remains, and a later
  run retries/reconciles it. Never require a whole-operation rollback or skip the failing item.
- **AC14-06 — permissions/standing decisions:** A denied admin action calls neither runner nor
  context helper and does not revalidate. Real-DB manual repair preserves human target exclusions,
  retracted units and other-team context rows; complete means eligible candidates only. Use the
  existing backfill/permission fixtures and oracle, not invented membership-count equivalence.
- **AC14-07 — ledger and consumers:** Real persisted manual context row has correct team, trigger,
  entrypoint, status and counts for complete/pending/failed results. Complete/pending rows have
  `ok:true` and empty errors; failed rows have `ok:false` and a diagnostic. Assert routine pending
  does not create a failure. With a fresh scheduler heartbeat to isolate staleness, one failed pass
  gives an `ok:false`, `unconfirmed` leg with its diagnostic; two consecutive failures place that leg
  in `failing`. A later successful pending manual row breaks the failure streak, including a streak
  from scheduler rows, without refreshing the scheduler heartbeat. An existing scheduler cursor
  remains unchanged when read through `readTeamBackfillState`. Failed logging does not remove the
  caller message. Admin pending is `ok:false` with visible error text under both existing consumers;
  errors revalidate the integrations path. Chat preserves its result shape and surfaces context
  status through the existing SSE summary path; GitHub calls retain `force:true`.
- **AC14-08 — non-vacuous regression controls:** Removing each of the five context calls must fail
  its corresponding wiring/outcome test. Moving the pass before import completion, gating
  it on nonzero counts or success, changing batch 25 to unbounded/default 500, dropping the context
  error from the return, or marking admin pending success must each redden the relevant tests. Keep these
  as reversible test mutations, not a new whole-program source guard; AUDITFIX-18 owns that work.

Primary tier: focused `test/datamechanics/` tests against this worktree's isolated Postgres,
with remote providers/model calls stubbed but ingest/context/oracle/ledger real. Unit tests own
orchestration faults, summaries, authorization and revalidation spies. Existing dashboard query
sync tests verify the SSE delegation; extend only if needed to prove the new summary reaches it.
UI rendering assertions may use the existing consumers' `ok/error` branch; no browser redesign.
Snapshot relevant complete rows where asserting preservation, not just selected IDs or counts.

## Implementation sequence, compatibility and rollout

1. Add spec-derived tests for the five missing call paths and the observable partial/bounded cases;
   coordinator records intended baseline failures before implementation.
2. Add the shared manual helper, then wire chat and four actions after imports settle. Preserve
   existing source ownership, GitHub force mode, authorization and inbound sequencing.
3. Update `docs/ARCHITECTURE.md` and stale descriptions of these manual entry points to name
   bounded manual coverage and its limitations; do not add AUDITFIX-18 reverse-import machinery.
4. Run focused unit/data-mechanics tests and mutation controls, existing context/backfill and
   dashboard-sync regressions, TypeScript/lint/docs checks; complete required model reviews.

No new tables, migrations, API version, or companion contract changes: this is internal manual
orchestration and result text using existing shapes. Merge to staging and verify that environment's
deployment before claiming live behavior. Production changes only through the separate release
process. Rollback removes the new hooks/helper/reporting and restores scheduler-only coverage;
already-correct memberships remain valid and require no data rollback. While bounded work remains,
a disabled scheduler needs repeated manual attempts; a failing candidate needs its error resolved.
No current fleet measurements or real-DB test execution are claimed by this proposed spec.
