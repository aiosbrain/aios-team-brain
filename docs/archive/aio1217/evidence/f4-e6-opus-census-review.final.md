# AIO-1217 F4-E6 — bounded source census report

**Verdict (source inspection only):** `notRunReason` cannot reach the public DTO, client, or UI by the code as written, and the exact F4 failure fits the existing button failure branch. E6 is **not** complete: nothing here is execution, render, or transport evidence, and several gaps are listed below.

## 1. Identities and parent guard status

| Item | Value | Status |
|---|---|---|
| Base | `c5e832c2ff179ee5c99f95966fba1ed9ce77ae3e` | Parent-verified; not recomputed |
| Pre-fix | `ceb184db9991dc9c6bb5ba3cb3b249cf6c480834` | Parent-verified; not recomputed |
| Candidate | `cd0387e8f6315199f0497d64a4f2134ca02f6ad4` | Parent-verified; not recomputed |
| All SHA-256 values, diff bytes (82494), clean worktree, auth/model/tool flags | as in manifest and `final-status.json` | Parent-verified; I cannot hash or run Git |

What I could observe with Read/Grep, without it being a guard:
- The diff has exactly 5 `diff --git` headers and 37 hunks, covering the five files named in the manifest.
- The candidate files I read match the diff post-image (`actions.ts:94-98`, `reconcile.ts:56-58` and `:83-93`).
- The only production hunks are in `actions.ts` (+5) and `reconcile.ts` (+3, +12/−1), the two owners v7 §4 allows.

Package notes, not blockers:
- Required input `08-…parent-launch-request.json` is the superseded pre-repair request. It says `PREFLIGHT_BLOCKED_REPAIR_REQUIRED` and "do not launch this version". The repaired request under `opus/` says `READY_ONLY_AFTER_ALL_GUARDS_PASS`; I read it although it is not marked required.
- Required inputs `06` and `07` are likewise the pre-repair manifest and prompt.

## 2. Inspected artifacts

`S` = `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-e4-e6-package-repair`
`W` = `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree`

**Support, required, read in full (12):**
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-e4-e6-package-repair/opus/f4-e6-opus-census-manifest.json`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-e4-e6-package-repair/inputs/01-CURRENT.json`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-e4-e6-package-repair/inputs/06-f4-e6-opus-census-manifest.json`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-e4-e6-package-repair/inputs/07-f4-e6-opus-census-review.prompt.md`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-e4-e6-package-repair/inputs/08-f4-e6-opus-census-parent-launch-request.json`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-e4-e6-package-repair/inputs/09-AGENTS.md`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-e4-e6-package-repair/inputs/10-aio1217-server-action-auth.md` (539 lines, three pages)
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-e4-e6-package-repair/inputs/11-aio1217-server-action-auth-v7.md`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-e4-e6-package-repair/inputs/12-next-use-server.md`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-e4-e6-package-repair/inputs/13-next-use-client.md`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-e4-e6-package-repair/inputs/14-next-server-actions.md`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-e4-e6-package-repair/diffs/ceb184db9991dc9c6bb5ba3cb3b249cf6c480834..cd0387e8f6315199f0497d64a4f2134ca02f6ad4.patch` (1421 lines, two pages)

**Support, not required, read in full (2):**
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-e4-e6-package-repair/opus/f4-e6-opus-census-parent-launch-request.json`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-e4-e6-package-repair/final-status.json`

**Support, not opened:** `repair-request.prompt.md`, `inputs/02`–`05`, `astra/*`, `opus/f4-e6-opus-census-review.prompt.md`, `package-manifest.json`, `final-report.md`, `checksums.sha256`, `checksums.sha256.digest`.

**Candidate, required, read in full (11):**
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree/app/t/[team]/admin/pm-sync/actions.ts`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree/lib/pm-sync/reconcile.ts`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree/app/t/[team]/admin/pm-sync/reconcile-button.tsx`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree/app/t/[team]/admin/pm-sync/page.tsx`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree/app/t/[team]/admin/pm-sync/project-board-button.tsx`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree/lib/pm-sync/inbound.ts`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree/lib/pm-sync/project.ts`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree/lib/pm-sync/index.ts`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree/test/datamechanics/aio1217-pm-reconcile-action-native.datamechanics.test.ts` (2239 lines)
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree/test/datamechanics/reconcile-divergence.datamechanics.test.ts`
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree/test/actions/aio1217-admin-operations-auth.test.ts` (2822 lines)

**Candidate, beyond the manifest:**
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree/test/http/pm-sync-divergence.http.test.ts` (full)
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree/test/datamechanics/aio1217-admin-guard-association.datamechanics.test.ts` (partial: lines 150–189, 276–385, 795–869)
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree/docs/ARCHITECTURE.md` (partial: 1118–1135)
- `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree/test/guards/server-action-auth.test.ts` (partial: 96–119)

## 3. Queries and result counts

Counts are matching lines / unique files. Grep honours ignore rules, so `.context`, `node_modules`, `.next` and ignored files were not searched. A zero is a bounded search result, not proof of absence.

**Glob**

| # | Root | Pattern | Files |
|---|---|---|---|
| G1 | `S` | `**/*` | 27 |
| G2 | `W` | `app/t/\[team\]/admin/pm-sync/**/*` | 4 |
| G3 | `W` | `lib/pm-sync/**/*` | 12 |
| G4 | `W/test` | `**/*{reconcile,pm-sync,pm_sync}*.{ts,tsx,spec.ts,mjs}` | 23 |
| G5 | `W/test` | `**/*.{spec,e2e}.{ts,tsx,js,mjs}` | **0** |

**Grep** (root `W`, no glob, unless stated)

| # | Pattern (scope) | Lines / files |
|---|---|---|
| Q1 | `reconcileProviderState` | 69 / 10 |
| Q2 | `ReconcileResult` | 23 / 8 |
| Q3 | `reconcileDivergenceAction` | 40 / 12 |
| Q4 | `ReconcileResultDto` | 7 / 3 |
| Q5 | `notRunReason` | 17 / 6 |
| Q6 | `projectBoardAction` | 42 / 13 |
| Q7 | `task_pm_links` | 287 / 70 |
| Q8 | `pm-sync/reconcile` (glob `*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}`) | 18 / 6 |
| Q9 | `from ["']\./reconcile["']\|from ["']\.\./pm-sync/reconcile["']\|export \* from` (root `W/lib/pm-sync`) | **0 / 0** |
| Q10 | `admin/pm-sync/actions\|from ["']\./actions["']` (same glob as Q8) | 33 / 12 |
| Q11 | `ReconcileButton\|ProjectBoardButton` | 6 / 3 |
| Q12 | `primary PM integration is unavailable\|integration_unavailable\|Reconcile failed` | 22 / 7 |
| Q13 | `DivergenceRow\|isDiverged` (glob `*.{ts,tsx}`) | 10 / 3 |
| Q14 | `provider_seen_status` (glob `{app,lib,components,scripts,postgres}/**`) | 30 / 7 |
| Q15 | `fetchSeenStates\|loadInboundRows\|classifyInboundRow\|runInboundForTeam\|runLinearInbound` (glob `{app,lib,components,scripts}/**`) | 21 / 8 |
| Q16 | `team\.reconcile_divergence` | 13 / 6 |
| Q17 | `admin/pm-sync` (glob `{app,lib,components,scripts,e2e,tests,playwright}/**`) | 2 / 1 |
| Q18 | `reconcile-button\|ReconcileButton\|Check for divergence\|Checked ` (root `W/test`) | 5 / 4; one relevant line (`pm-sync-divergence.http.test.ts:82`); **0** for `reconcile-button` or `ReconcileButton` |
| Q19 | `import\(\s*["'\`][^"'\`]*pm-sync\|require\(\s*["'\`][^"'\`]*pm-sync` (same glob as Q8) | 13 / 5, all type-position `typeof import(…)` in tests; **0** in production |
| Q20 | `pm-sync` (glob `{app,components,scripts}/**/*.{ts,tsx,mjs,js}`) | 18 / 11 |
| Q21 | `\.\.\.result\|console\.\|JSON\.stringify\|structuredClone\|Object\.assign` (root `W/app/t/[team]/admin/pm-sync`) | **0 / 0** |
| Q22 | `\.\.\.\|console\.\|JSON\.stringify` (file `W/lib/pm-sync/reconcile.ts`) | **0 / 0** |
| Q23 | `from\(["']task_pm_links["']\)\|(update\|insert into\|delete from)\s+task_pm_links` (glob `{app,lib,components,scripts}/**`) | 28 / 11 |
| Q24 | `Next-Action\|next-action` (root `W/test`) | **0 / 0** |
| Q25 | `^` (file `W/test/actions/aio1217-admin-operations-auth.test.ts`, line count) | 2822 / 1 |
| Q26 | `^diff --git\|^@@` (the patch file) | 42 / 1 (5 headers + 37 hunks) |

Q2 breakdown: the PM-sync `ReconcileResult` appears in `lib/pm-sync/reconcile.ts` (2) and `test/actions/aio1217-admin-operations-auth.test.ts` (4). `ReconcileResultDto` substring hits are `actions.ts` (2), `reconcile-button.tsx` (2) and the v7 doc. The remaining hits are same-named unrelated types in `lib/graph/arc-continuity.ts` (2), `lib/projects/context/units.ts` (3) and `lib/codebases/finding-ledger.ts` (4, `FindingReconcileResult`). I classified those three from grep lines only; none appears in Q8.

## 4. Consumer census (conclusion 1)

| Consumer | Use | Can `notRunReason` cross? |
|---|---|---|
| `lib/pm-sync/reconcile.ts` | Owner. Declares the optional marker (`:56-58`) and sets it on one return only (`:83-93`), keyed on `primary.integration === null`, not on reason text. Null-provider (`:80-82`), unsupported-adapter (`:95-97`), no-link (`:106`) and normal (`:137`) returns are unmarked literals. | Internal origin |
| `app/t/[team]/admin/pm-sync/actions.ts` | **Sole production caller** (`:9`, `:92`). Reads the marker at `:96`. All four returns are explicit literals (`:89`, `:93`, `:97`, `:111`); no spread, no return of `result` (Q21 zero, confirmed by full read). Audit meta at `:107` carries provider, seenUpdated and a divergence count only. | **No.** The F4 return is the two-key literal at `:97`, before audit (`:100`) and `revalidatePath` (`:110`) |
| `app/t/[team]/admin/pm-sync/reconcile-button.tsx` | Client. Imports the action and `type ReconcileResultDto` (`:5`), stores the return (`:14`, `:19`), reads `ok`, `provider`, `divergences`, `seenUpdated`, `error`. | No; it sees only the DTO, which the diff did not change |
| `app/t/[team]/admin/pm-sync/page.tsx` | Server page. Composes the button with `teamSlug` and `primaryProvider` (`:105-108`). Imports neither `actions.ts` nor `reconcile.ts`. | No |
| `lib/pm-sync/inbound.ts` | Imports only `isDiverged` (`:27`). Has its own, separate integration-null return of type `InboundResult` (`:567-569`). | No; not a `ReconcileResult` consumer |
| `lib/pm-sync/index.ts` | Does not re-export `reconcile` (`:8-22` read in full; Q9 zero). | No wrapper or re-export found |
| `app/t/[team]/admin/pm-sync/project-board-button.tsx` | Separate action and type. | Not a consumer |
| `test/datamechanics/reconcile-divergence.datamechanics.test.ts` | Calls the owner directly; `toStrictEqual` with the marker on six cells; key lists and `toStrictEqual` on unmarked returns. | Internal assertions only |
| `test/datamechanics/aio1217-pm-reconcile-action-native.datamechanics.test.ts` | Pass-through wrapper over the real owner (`:250-254`, `:594-610`); asserts owner key lists and the public key list separately. | Asserts the two-key public shape |
| `test/actions/aio1217-admin-operations-auth.test.ts` | Replaces the module with `{ reconcileProviderState }` (`:305`); imports `type ReconcileResult` (`:341`); group R (`:1846-1955`) and group A exact object (`:1094`). | Asserts absence by `toStrictEqual` and key list |
| `test/datamechanics/aio1217-admin-guard-association.datamechanics.test.ts` (partial read) | Original module plus an unmarked double (`:162-165`, `:372-375`); exact result at `:854`. | Unmarked double is compatible with the optional field |
| `test/guards/helpers/server-action-auth.ts:1452`, `test/guards/server-action-auth.test.ts:110` | Registry: two exports for this module. F4 adds no export. | Not applicable |
| `test/http/pm-sync-divergence.http.test.ts` | GET of the page only; never invokes the action. | Not applicable |
| Four other `aio1217-pm-*` datamechanics files (Q1, Q3) | Prose or TODO mentions by grep line; not opened. | Not established |

## 5. PASS findings

**PASS-1 — Marker containment.** By source, `notRunReason` reaches neither `ReconcileResultDto`, the audit row, nor the client. The public F4 result is exactly `{ ok: false, error: "primary PM integration is unavailable" }`, with no `provider`, `seenUpdated`, `divergences`, `reason` or marker key. This matches v7 §3 and §4.

**PASS-2 — Button/page compatibility. `SOURCE INSPECTION ONLY`.**
- The button is disabled only on `pending || !primaryProvider` (`reconcile-button.tsx:29`). `primaryProvider` is `teams.primary_pm_provider` (`page.tsx:24`, `:107`), so a named primary with an unusable integration leaves the button enabled.
- The F4 return takes the existing `result.ok` false branch (`:47-52`), which reads only `result.error` under the heading "Reconcile failed". The object is type-compatible with the unchanged DTO.
- The F4 path returns before `revalidatePath`. The installed guide says an action that triggers no revalidation "carries only its return value, and the current route is not re-rendered". That is guide text plus source, not observed behaviour.

**PASS-3 — Scope containment.** No production file other than the two owners is in the diff. The DTO interface, both buttons, the page, `inbound.ts`, `project.ts` and `index.ts` are absent from it.

**PASS-4 — No other production caller found.** Bounded by Q1, Q8, Q9, Q19 and Q20: no script, API route, scheduler, re-export or dynamic import calls `reconcileProviderState`.

## 6. NOT VERIFIED — E6 gaps (conclusion 3)

1. **Execution evidence.** I observed no run. The `01-CURRENT.json` figures (30 PASS / 13 TODO; 139 PASS / 14 TODO; lint; mutant kills) are parent-recorded. By source count only, the native and owner suites hold 16 + 14 = 30 cases and 13 `it.todo`, and the unit file holds 14 `it.todo`; that is consistent with those figures but proves no run.
2. **UI states not covered by any test I found.**
   - No test references `ReconcileButton` or `reconcile-button` (Q18), and there is no spec or e2e file (G5).
   - The only page test is a GET asserting the divergence list.
   - The "Reconcile failed" branch, the success branch and the pending state have no render evidence.
3. **Server Action wire.** No `Next-Action` test exists (Q24). POST dispatch, Flight serialization of the DTO, and the no-revalidation response are unestablished.
4. **Button/action reachability mismatch (pre-existing, unchanged by F4).**
   - With the primary unset and one usable integration, the action resolves through the sole-enabled fallback, but the button is disabled with "Set a primary PM tool first."
   - The null-provider refusal is likewise reachable only by direct POST or a stale render.
5. **Page state after a refusal.**
   - The divergence table reads persisted Linear links only (`inbound.ts:164-167`), regardless of the configured primary.
   - After an F4 refusal it keeps showing previously stored rows (or "No divergence detected.") beside "Reconcile failed".
   - The page gives no pre-click sign that the integration is unusable.
6. **Thrown errors.** `run()` has no catch (`reconcile-button.tsx:16-21`), so a rejecting action (for example a decrypt throw) is unhandled there. This is the "RECONCILE ERROR POLICY" TODO in the native test.
7. **Association-registry paths not exercised by F4 evidence.**
   - *Refusal path:* the owner's link read (`reconcile.ts:99-104`) and write (`:119-122`) are skipped by source order.
   - *Other `provider_seen_status` writers:* `inbound.ts:261-270`, `:293-296` and `:465-486`, driven by `lib/ingest/scheduler.ts:157` and `lib/ingest/manual-sync.ts:108`. They are independent of `ReconcileResult` and skip quietly on a null integration (`:567-569`, `:655`).
   - *Outbound missing-integration path:* writes `last_error` on the link (`project.ts:286-292`).
   - *Remaining touchers:* of the 11 production files in Q23, seven were not opened.
8. **Exact-object boundaries.** The association file was only partly read, and the four other `aio1217-pm-*` files were not opened. I cannot confirm that every affected suite was rerun against the candidate.
9. **Pre-edit census sequencing.** v7 §6 requires a census on the pre-edit snapshot before any runtime edit. Nothing in the required inputs shows one was recorded; this report is the candidate recheck only.
10. **Release and rollback wording (v7 §8).** The F4 string appears only in the two owners, tests and the v7 doc (Q12). `docs/ARCHITECTURE.md:1123-1131` is silent on the refusal. This is a publication-gate item.
11. **Typecheck, build, docs checks.** Not run by me and not claimed in `01-CURRENT.json` beyond five-path lint.
12. **Search bounds.** Ignored and untracked files, build output and anything outside `W` were not searched.

## 7. OUT OF SCOPE — kept separate (conclusion 4)

- **R1, Plane unsupported reconciliation.**
  - The owner returns an unmarked reason at `reconcile.ts:95-97`; the action drops it, audits, revalidates and returns `ok: true`.
  - By source, the button would then show "✓ Checked plane".
  - It is pinned as current, not endorsed, by native cases 6 and 8 and the unit "unmarked" case.
  - It is not an F4 marker case and not evidence that a Plane board was read.
- **R2, `projectBoardAction` false success.**
  - `projectAllTasks` returns a named provider with a reason (`project.ts:519-521`).
  - `actions.ts:50` passes `reason: provider ? undefined : reason`, and `:54` only fails when the provider is null.
  - It is pinned by the unit case at `:1913-1954`, is untouched by the diff, and is distinct from R1.
- **Excluded by v7 §4:** `resolvePrimaryProvider`, integration and secret management, adapters, ADM policy, inbound apply, ingest runs, AIO-1225 to AIO-1228.

I recommend no runtime change under F4. Gaps 4, 5 and 9 are the ones that could bear on scope; they go to Astra to decide, not to the builder.

## 8. Stale committed prose (conclusion 5)

Unchanged and unearned; I made no edits.
- The native test header (`:181-186`) and its Z TODOs (`:2212`, `:2233`) still say "NOT RUN" and that neither a RED nor any mutant was observed.
- The unit test header (`:247-254`) and its Z TODO (`:2817`) say the same.

These conflict with the parent-recorded run and mutant outcomes in `01-CURRENT.json`. Per that file, changing the prose requires focused reruns.

## 9. Not claimed

No browser rendering, live Server Action POST, serialization or transport behaviour, cache revalidation behaviour, provider behaviour, executed tests, E4 fulfilment, E6 completion, final review, PR, merge or deployment.