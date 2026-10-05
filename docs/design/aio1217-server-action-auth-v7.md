# AIO-1217 — Proposed v7: Server Action authority and PM reconciliation refusal

Status: **PROPOSED v7; specification review/readiness and exact Linear attachment/readback pending. F4-dependent PM reconciliation acceptance is BLOCKED.** This document is a design, not a runtime change or an acceptance report.

Authoring reference snapshot: `730eb34e75fe92f6e1262f6b60cf502c7600d2c4`. Target for subsequent authorized work: `staging`. Ticket: AIO-1217. Snapshot identity and hashes below are supplied by the authoring manifest; this bounded authoring run does not independently attest them through Git or hashing commands.

## 1. Authority, revision boundary and retained v6 contract

The accepted v6 design remains immutable at [aio1217-server-action-auth.md](./aio1217-server-action-auth.md), SHA-256 `be9788fb508518ec22cdaf7a3433419c3c7040a0595ff50f37a67cd6d108cdec`. Its full normative requirements, inventory, stable AC-01–AC-14 identifiers, ownership restrictions, compatibility decisions, deferrals and evidence qualifications are incorporated by reference without amendment except for the explicitly stated prospective F4 reconciliation requirement below. Its historical status entries retain their original snapshot scope. This successor does not retroactively edit v6 or recertify earlier work.

The controlling F4 decision is the sanitized `f4-v7-astra-decision-evidence.md` supplied in the authoring manifest, SHA-256 `888f30e658c9d2b52ae8ef807d8c6cdffaddc567c99f50dbbfda577fa9c576e5`. It records fresh Astra HIGH adjudication from `f4-pm-reconcile-astra-decision.final.md`, SHA-256 `735e99e2a1dd447b828b66e4eae7fb9bfe004b85f2768a9bf9d2df4256563ebe`. The scope is `f4-v7-astra-spec-author-scope.md`. These are decision provenance, not completed implementation or evidence gates.

In this document, **must**, **required**, and gate tables describe proposed normative v7 requirements. Statements headed **Snapshot facts** describe inspected source and test definitions only. No application checks, tests, native evidence, mutations, caller census beyond the manifest, reviews, attachment or publication were executed during authoring.

The retained task contract includes finite Server Action discovery and genuine guard invocation; actual action refusal and admitted controls; approval team/state binding; People tenant/resource ownership; account protocols; the bounded v6 visibility-error propagation correction and its PR714 ownership/integration gate; all affected caller obligations; durable evidence, validation and independent reviews. The v6 inventory baseline of 20 modules, 96 runtime actions, 13 erased exports and zero inline actions is historical inventory context, not a new census. F4 adds no action or guard-family registration. AIO-1225–1228 remain explicit deferred siblings, never passed protections. No discovery, People, approval, visibility, account or deferred-boundary requirement is relaxed by this proposal.

Independent v6 work and earned evidence remain valid within their recorded snapshots and scope. F4 blocks **dependent PM reconciliation acceptance only**; it neither erases independent evidence nor confers full-task acceptance. Checks invalidated by a later runtime diff must be rerun. Existing unrelated holds remain in force.

## 2. Snapshot facts and defect

The installed `use-server.md` guide requires authentication and authorization before sensitive operations and bounded serialized return values. The inspected PM action is a module-level Server Action; its client button is not an authorization boundary.

At the reference snapshot:

1. `reconcileDivergenceAction` calls `requireTeamAdmin` as `requireAdmin`, returns `{ ok: false, error: "admins only" }` on a null context, acquires the admin client, and calls `reconcileProviderState(db, ctx.teamId)` without options.
2. `resolveIntegrationsAdmin` in `lib/integrations/read.ts` resolves the slug, active membership bound to team and authenticated user, and membership-derived admin posture. Role and posture both matter. A legacy `members.tier` value does not replace current membership-derived posture.
3. `resolvePrimaryProvider` in `lib/pm-sync/project.ts` reads enabled integrations for the supplied team and that team's configured primary. A configured Linear or Plane primary with no matching integration holding a usable secret returns a **named provider with `integration: null`**. With no configured primary, the existing sole-enabled-provider fallback may resolve successfully; no usable candidate or ambiguity yields `provider: null`.
4. `getEnabledIntegrationsWithSecrets` in `lib/integrations/manage.ts` filters by `team_id` and enabled status, then decrypts stored secrets. Resolution can therefore legitimately include same-team integration reads/decryption before determining that the configured provider is unavailable. It must not read/decrypt a foreign team's secret.
5. `reconcileProviderState` returns early for a null provider or null integration with `provider`, `seenUpdated: 0`, `divergences: []`, and `reason`. There is no `notRunReason` field. This occurs before the link scan or provider fetch.
6. The action tests only `result.provider === null`. A named-provider/no-integration result therefore falls through to a `team.reconcile_divergence` audit, path revalidation and `{ ok: true, provider, seenUpdated: 0, divergences: [] }`, losing the owner's reason. This is the source-derived false-success branch; it is not an author-run RED result.
7. Resolved no-link reconciliation returns before provider fetch. Resolved linked reconciliation reads provider states, updates changed `provider_seen_status` bookkeeping and its timestamp, surfaces divergences, and does not write brain task fields or the provider board. An unchanged rerun performs no link updates but the action still audits and revalidates. This action creates no ingest run.

The native action fixture currently defines Linear changed/unchanged controls and selected real ADM denials. Its explicit TODOs exclude F4, Plane, no-link and no-primary branches, wider caller proof, and executed mutants. The association fixture exercises real posture with a substituted reconciliation owner; the action unit fixture likewise uses lower-owner seams. The owner divergence fixture is not action-level proof. Their presence and assertions are useful context, not passing v7 evidence.

## 3. F4 decision and exact observable outcomes

After ADM admission and the existing same-team resolution prerequisites, a configured named **Linear or Plane** primary whose enabled usable integration cannot be resolved because it is **missing, disabled or secret-less** must return exactly:

```ts
{ ok: false, error: "primary PM integration is unavailable" }
```

The public result must omit `provider`, `seenUpdated`, `divergences`, `reason` and the internal marker. Do not include those keys with `undefined`, extra diagnostics, provider names or secret/configuration data. The error string and two-key object are part of the contract.

| Condition | Required public outcome | Required ordering/effects |
| --- | --- | --- |
| ADM refuses | Existing exact `{ ok: false, error: "admins only" }` | Stop after applicable guard prerequisites; no service client, reconciliation resolution, link/provider work, audit, revalidation or run creation |
| Existing resolver returns `provider: null` | Existing `{ ok: false, error: result.reason ?? "no primary PM provider configured" }` | Preserve refusal and reason behavior; no link/provider/audit/revalidation/run effects |
| Named Linear/Plane primary has no usable integration | Exact F4 failure above | Resolve only after ADM; stop before link scan, provider request, audit, revalidation or run creation |
| Resolved integration, no eligible links | Existing `{ ok: true, provider, seenUpdated: 0, divergences: [] }` | Preserve bounded link scan, no provider request or link update, then existing audit and revalidation |
| Resolved integration, changed provider states | Existing success fields and divergence rows | Preserve same-team/provider scan, provider reads and changed-link bookkeeping, then audit, revalidation, return |
| Resolved integration, unchanged board | Existing success, `seenUpdated: 0`, current divergences | Provider reads still occur for eligible links; no link update; preserve audit and revalidation |

“No primary” means a null resolution result, not merely an unset configuration field. The sole-enabled fallback is retained. Legitimate zero-work/zero-update successes must not be converted into errors by testing `seenUpdated`, an empty divergence list or an empty link set. “Zero effect” on an admitted no-link or unchanged reconciliation means zero reconciliation mutation, **not** absence of its established success audit/revalidation.

No foreign-team integration may rescue the configured primary, and no same-team alternate provider may rescue it. Keep the configured provider decision; do not change configuration, switch provider, invent a fallback, or return success based on another team's usable integration.

## 4. Bounded future runtime owners

Only the following two production changes are proposed for F4, after all admission gates:

1. **`lib/pm-sync/reconcile.ts`:** add the optional additive field `notRunReason?: "integration_unavailable"` to `ReconcileResult`. Set it only on the early result where a primary provider is named but its integration is null. Retain that result's existing `provider`, `seenUpdated`, `divergences` and `reason` semantics. Leave the marker absent on null-provider results and on all resolved success paths. Determine the condition from structured resolution state, never from human-readable `reason` text.
2. **`app/t/[team]/admin/pm-sync/actions.ts`:** have `reconcileDivergenceAction` consume that marker and return the exact F4 failure before the existing audit/revalidation sequence. Preserve the null-provider refusal, guard ordering, server-resolved team argument, successful DTO construction and all admitted audit fields/order. Do not spread the owner object into the public DTO.

The marker must be optional so existing valid owner results and test doubles without it remain compatible. It is internal provenance for one not-run state, not a new public result field, broad error taxonomy or exception wrapper.

The admitted sequence remains: ADM → existing same-team resolution → bounded link scan/provider read/link bookkeeping → owner return → audit → revalidation of `/t/${teamSlug}/admin/pm-sync` → success DTO. Audit continues to use `ctx.teamId` for team/target, `ctx.memberId` for member, member actor kind, action `team.reconcile_divergence`, target type `team`, and metadata `{ provider, seenUpdated, divergences: result.divergences.length }`. The existing literal path call has no added `type` argument. F4 must return before this audit, not emit a failure audit or audit success with zero counts.

**Excluded:** edits to `resolvePrimaryProvider`, integration selection/secret management, ADM policy, adapters, transport/exception policy, schemas/migrations, projection (`projectBoardAction`, `projectTask`, `projectAllTasks`, run recording), ingest-run behavior, task/content policy, retries or general error handling. No new run record on success or failure. Do not reinterpret a decryption throw, provider exception, database error or audit failure as F4. Existing adapter unsupported behavior is not a new marker case. A material issue in an excluded path returns to specification adjudication rather than expanding this implementation.

Before the future runtime edit, the coordinator must verify one implementation owner for the two production paths and affected behavior, active-worktree/PR overlap, branch/checkpoint and integration order. A sent coordination message is not agreement. Existing ownership holds are not waived. That operational work is outside this authoring run.

## 5. Native evidence and refusal prerequisites

All evidence below is **required future work, currently unearned in this proposal**. Invoke the actual action export through real session/guard, resolver, integration owner, reconciliation owner and native Postgres adapter. Use synthetic secrets and a recording synthetic provider transport, not live services. Do not replace the guard, resolver or reconciliation result with an F4 stub and call that native proof. Supplementary unit/owner tests may isolate the marker and DTO, but cannot replace the native cases.

### F4-E1 — Six refusal cells, repetition and non-rescue

Execute each row independently for both providers:

| Named primary | Missing matching row | Matching row disabled | Matching enabled row secret-less |
| --- | --- | --- | --- |
| Linear | Required | Required | Required |
| Plane | Required | Required | Required |

Each cell must establish the actual stored condition, admit an active same-team role-admin with unrestricted membership-derived posture, and exercise real same-team resolution. Seed eligible links/tasks so skipping the link scan is meaningful. Include an enabled usable same-provider integration in another team and an enabled usable alternate-provider integration in the acting team as non-rescue controls. Record that the named unavailable primary still fails; no foreign credentials, identifiers, links or results enter the acting request.

Assert the exact two-key public DTO and internal marker provenance. Observe zero `task_pm_links` scan and zero link writes; zero provider request (read or write); zero audit invocation/insertion; zero revalidation; and zero ingest-run creation. Successful prerequisite reads and any existing same-team resolution decryption are permitted and must be distinguished from forbidden subsequent work. A global assertion of zero database activity would be incorrect for this late refusal.

Compare complete durable pre/post rows for both teams' links (including timestamps), integrations, configuration, tasks, audit log and run history; all must remain unchanged. Repeat the same actual invocation without changing configuration and require the same exact failure, trace boundary and unchanged durable state. Row counts alone, `seenUpdated: 0` alone, or absence of provider writes alone are insufficient: the current bug already avoids provider work while falsely reporting success and auditing.

### F4-E2 — Admitted and no-primary controls

For both Linear and Plane, execute resolved no-link, changed-state and unchanged-board controls through the actual action/native owners. Check exact public and internal successful shapes, absence of the marker, same-team/provider bindings, no foreign rows/secret exposure, expected read-only provider requests, changed-link-only bookkeeping, divergence contents, and the exact audit-then-revalidation sequence. Compare timestamps and durable rows on unchanged reruns; preserve the legitimate new audit row. Brain task fields, provider board, integrations/configuration and run history remain unchanged.

Exercise null-provider refusal for no usable candidates and ambiguous unconfigured primaries, with exact existing reason mapping and no success effects. Exercise the existing unset-primary/sole-enabled resolution as a compatible admitted control. An unset field is not sufficient evidence of refusal. Controls must demonstrate that the fixture can reach real provider reads and expected effects; a universally refusing fixture cannot pass.

### F4-E3 — Each ADM conjunct and tenant confinement

Keep the action's exact `admins only` denial. Establish applicable earlier checks and valid enabled feature inputs, then separately discriminate missing/invalid session, unknown team, missing or foreign membership, inactive membership, non-admin role (member and lead), and restricted membership-derived posture. Assert the guard's allowed reads and no subsequent service-client acquisition/resolution, provider/link work, audit/revalidation/run effects or durable changes. A helper-only predicate assertion is insufficient: the action must honor the verdict.

Retain admitted active same-team admin controls, two-team binding and both stale legacy-tier directions: legacy `team` without builtin Everyone membership refuses; legacy `external` with valid builtin Everyone membership admits. Removing/restoring the relevant association must affect a fresh invocation. Existing owner/association evidence can support individual semantics only with exact case/snapshot attribution; substituted owner cases do not establish native F4 behavior. Preserve current guard-fault outcomes without broadening exception policy. No new task-level viewer-policy or concurrent revocation guarantee is inferred.

## 6. Caller and DTO compatibility gate

**Snapshot caller facts:** `reconcile-button.tsx` imports the action and `ReconcileResultDto`, stores the returned value, renders success on `result.ok`, and otherwise renders “Reconcile failed” with `result.error`. A named primary does not disable the button merely because its integration is unavailable. The proposed failure fits the existing failure branch by source inspection; this is not executed UI proof or a complete caller census.

Before runtime readiness/publication, verify the actual production and test consumers of `reconcileProviderState`, `ReconcileResult`, `reconcileDivergenceAction` and `ReconcileResultDto` against the exact implementation snapshot. The decision does not certify caller counts. Record each consumer's outcome and exact-object/serialization assumptions. If wider consumers require material changes beyond these two runtime owners, return to Astra for scope/readiness adjudication rather than silently changing them.

Required checks:

- Keep `ReconcileResultDto` compatible; introduce no mandatory field and leak no internal marker/reason. Successful action objects remain exactly `{ ok: true, provider, seenUpdated, divergences }`; existing ADM/no-primary failures retain their existing shapes. F4 is the one intended public behavior change.
- Preserve existing exact-object expectations in `test/actions/aio1217-admin-operations-auth.test.ts` and `test/datamechanics/aio1217-admin-guard-association.datamechanics.test.ts`; their successful substituted results have no marker and must still work. Preserve native successful owner/action expectations and `reconcile-divergence.datamechanics.test.ts` outcomes. Do not loosen assertions broadly to accommodate an optional field.
- Check internal exact-object consumers: the named unavailable owner result intentionally gains one property; null-provider and successful owner objects do not. Test key presence as well as values so an everywhere-present `undefined` field cannot masquerade as absence.
- Verify the UI caller renders the exact F4 message in its failure branch and preserves successful controls. No UI rewrite is proposed. Type checking and source inspection alone do not prove rendered behavior; record the actual caller evidence used and its limits.

## 7. Regression, mutations and verification records

### F4-E4 — Actual RED → GREEN

Before runtime correction, run the new native refusal assertions against the exact unchanged reference implementation and retain the actual outcomes. They must expose the intended defect: named provider/no integration returns success and proceeds to audit/revalidation while owner link/provider work is absent. Record all six provider/state cells and admitted baselines. Source reading or an old TODO cannot substitute for that execution. If the claimed RED does not reproduce, investigate before editing; do not manufacture or backdate evidence. Then run the same cases against the bounded implementation and require exact F4 failures and non-effects.

### F4-E5 — Isolated-copy executable mutations

Mutate isolated copies of the exact candidate and invoke the actual imported mutated code. Keep original runtime files intact during falsification. Required mutants omit the owner's marker, ignore its verdict in the action (restoring current false success), and allow audit and/or revalidation before returning the failure. Include an overbroad marker/refusal mutant on legitimate no-link or unchanged success. The refusal/trace/durable-state assertions must kill the corresponding mutants for the intended behavioral reason. Also retain affected v6 ignored-ADM and tenant-binding falsification obligations; F4 does not replace them.

A compile/import failure, fixture setup failure, skipped test or mutation never reached is not a kill. Record candidate identity, precise isolated mutation, actual command/exit result, reached branch and discriminating assertion, with unmodified controls passing. Merely retaining a guard identifier in an AST registry does not prove its verdict is obeyed or a late refusal stops effects.

### F4-E6 — Validation and durable evidence

Run scoped marker/action/caller tests, all required native F4 and admitted cases, the existing native reconciliation action and owner suites, affected admin unit/association suites, and regressions invalidated by the two-file runtime diff. Retain v6 AC-13 validation obligations including typecheck, lint, docs checks, build and required unit coverage; report actual commands, environment/seams, results, timeouts, skips and limitations. Do not infer full datamechanics or Server Action wire coverage from selected direct-export tests.

Store sanitized durable evidence with exact source snapshot/hashes, case names, real database premises, prerequisite/effect traces, precise DTO keys, before/after durable comparisons, repetition results, non-rescue and admitted controls, caller census and mutation outcomes. Preserve task checkpoints and remote backups under the agreed workflow when that work is authorized. No credentials/private provider data belong in artifacts. Synthetic provider responses prove bounded local behavior, not provider service semantics, live authorization, pagination, Next transport security, cache invalidation or general outage handling.

## 8. Acceptance mapping and ordered admission gates

Stable v6 IDs remain intact. F4 extends the PM-reconciliation portion of AC-04 (actual action refusal/non-effects), AC-05 (ADM and caller compatibility), AC-11 (bounded ownership), AC-12 (RED and mutation evidence), AC-13 (affected validation), and AC-14 (fresh review/readiness/attachment). It does not alter AC-06 or other independent requirements and does not convert their historical evidence into new passes.

| Gate | Completion requirement | Status of this proposal |
| --- | --- | --- |
| Specification | Fresh independent subscription Opus 5.5 HIGH specification review; resolve confirmed findings and complete v7 readiness, retaining applicable fresh Astra design review requirements | PENDING |
| Exact attachment | Attach full exact reviewed v7 Markdown to AIO-1217, preserve unrelated ticket content and immutable v6 history, verify complete readback and matching hash | PENDING |
| Runtime admission | Both preceding gates complete before any runtime writer; verified sole owner, scope/caller readiness, recoverable checkpoint and workflow capacity/authentication requirements | BLOCKED pending gates |
| Runtime correctness | Only the two bounded production changes; exact F4 return before forbidden effects; preserved no-primary/admitted/ADM contracts | NOT IMPLEMENTED by this document |
| Evidence/compatibility | F4-E1–E6 and exact caller/DTO checks complete on candidate; all pending/skipped items honest | UNEARNED |
| Code/final review | Independent subscription Opus code review and fresh Astra HIGH final review of exact candidate, affected callers, native outcomes and mutants; resolve confirmed in-scope blockers | PENDING |
| Dependent PM acceptance | All runtime, evidence, compatibility and review gates complete | BLOCKED; no acceptance claim |

Sequence: freeze this proposal → fresh specification review and readiness → exact full-text v7 Linear attachment/readback → admitted owner/caller and pre-runtime RED work → bounded sole-writer implementation → native and compatibility evidence plus isolated-copy mutations/validation → exact-candidate independent code and fresh final review. Any material revision after review or attachment requires renewed affected review/readiness and exact attachment/readback before dependent runtime work. Earlier v6 reviews or attachment do not cover v7.

No runtime writer is authorized by the existence of this file. The present authoring scope forbids workers, runtime edits, application checks, Git, network and credentials; those operations are not performed here. No PR, merge, deployment, release, ticket completion or full-task acceptance follows from authoring. Subsequent publication, if separately admitted under the workflow, targets `staging`; merging and deployment still require their own authorization.

## Author handoff

Sole file changed by this authoring run: `docs/design/aio1217-server-action-auth-v7.md`. The accepted v6 document and all runtime, test, metadata, manifest and artifact files remain untouched. **Fresh Opus specification/readiness review plus exact v7 Linear attachment and complete readback are required before any runtime writer.** F4-dependent PM acceptance remains blocked until the runtime, evidence, compatibility and review gates above are earned.
