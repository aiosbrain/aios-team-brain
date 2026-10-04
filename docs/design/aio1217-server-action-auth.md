# AIO-1217 — Server Action authority inventory and target binding

Status: PROPOSED v1. Specification author: GPT-6.1 Sol, high reasoning. Implementation has not begun. Base: `c5e832c2ff179ee5c99f95966fba1ed9ce77ae3e` (`staging`, after PR 741). Target: `staging`. Ticket: [AIO-1217](https://linear.app/je4light/issue/AIO-1217/prove-authentication-and-authorization-guards-for-team-brain-server), verified In Progress / High. Stable acceptance IDs below survive revision. This document becomes ACCEPTED only after independent subscription Claude Opus 5.5 specification review, fresh Astra permissioning design review, readiness, and exact full-text Linear attachment/readback. The user’s current model instructions override older model names in the workflow.

## Problem and intended behavior

Server Actions are independently callable POST boundaries. A page, layout, hidden button, action ID encryption, or a comment does not establish authority. AIO-1208’s route-file inventory deliberately excludes them. At this base an AST inventory of 1,617 repository source files finds **20 module-level directive files, 96 exported runtime actions, 13 erased type/interface exports, and zero inline/nested action directives**. Ninety-five runtime actions require identity or tenant authority; `signOutAction` is an intentional own-cookie protocol exception. These counts describe current source, not 96 proven vulnerabilities.

The change records every action and its exact authority chain, adds a development-only regression gate for real invocation, and pins denial before protected effects with executing action/owner tests. It also corrects two source-derived target-binding classes on unowned paths: a team A administrator can currently send team B’s legacy approval ID into a resolver with no caller-team input; and People actions authorize a supplied member ID while their writers can modify a different member’s resource or accept a foreign-team member ID. Runtime regressions must reproduce these paths on the unchanged base before implementation; no runtime reproducer has been executed during specification authoring.

Preserve current active-member, membership-derived admin, content visibility, self-account, and deliberate public protocol behavior. In particular, People editing retains `canEditMemberContext`’s self-or-admin rule; this task does not add an Everyone/team-posture prerequisite to that editor or reinterpret leads/external members. Projects remain creatable by current active members. Existing task/decision writer and project visibility predicates remain necessary. Registered pure predicates never authenticate on their own.

## Installed framework and source authority

Read before proposing this design: installed Next **16.3.0** `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-server.md`, `01-app/02-guides/server-actions.md`, and `01-app/02-guides/authentication.md`. Module directive prologues expose exported async Server Functions; inline function directive prologues are another declaration form, including nested closures. Untrusted serialized arguments/FormData cannot supply the authenticated identity or establish ownership. POST/origin checks and closure encryption supplement application authorization. Client-side sequential dispatch does not serialize independent requests. Our discovery is conservative source inventory, not proof that every source is bundled or reachable over the wire.

The Postgres target has no RLS authorization backstop (`lib/db/types.ts`, `docs/ARCHITECTURE.md`). `currentMember` in `lib/auth/guard.ts` binds the session’s auth-user to an **active** member in the requested team and resolves current viewer posture through `resolveViewerPosture`. `requireTeamAdmin` delegates to `lib/integrations/read.ts:resolveIntegrationsAdmin`: team slug, active same-team member, `role=admin`, and unrestricted membership-derived posture. `canAccessAdmin` alone is a co-predicate, not identity. `getSessionUser` identifies an auth account; account password setup/change intentionally does not require a currently active tenant membership. `authorizeGatewayAdmin` now uses the AIO-1208 same-connection membership-derived guard; delegated gateway token semantics remain unchanged.

## Ownership and scope

Actual PR/worktree ownership records were read before selecting changes. PRs **733/734/735 against main** own `app/actions/decisions.ts` and governed decision/note consumers. PR **714 draft against staging** owns `app/t/[team]/admin/members/actions.ts`, `lib/access/enforce.ts`, and related identity/password/admin services. PRs **738/739 against staging** own membership materialization/bootstrap behavior. The active stagingmark5 worktree overlaps `lib/access/groups.ts`. Hold production edits to these areas. Inventory registration, source inspection and executing regression tests can cover their current behavior without becoming a parallel implementation. A newly demonstrated defect there requires an explicit recorded owner/integration decision before code; this task must not copy pending PR fixes.

The new checker/tests and targeted runtime changes below do not overlap those recorded owners: approvals action, `lib/actions/index.ts`, People actions, `lib/identity/profile.ts`. No new schema/migration or membership writer is planned. Recheck ownership before implementation and publication. Read-only census shows `resolveApproval` has **one** production caller (the approvals action) and four existing unit test call sites; profile mutations have only the People production action caller and existing direct data-mechanics tests. `getMemberAvatar` is a reader and remains compatible. The profile single-writer boundary remains in its existing owner file.

Expected implementation paths: new `test/guards/server-action-auth.test.ts`, new `test/guards/helpers/server-action-auth.ts`, new focused action denial fixtures under `test/actions/` (split by existing modules where useful), new `test/datamechanics/server-action-target-binding.datamechanics.test.ts`, the four targeted runtime files above, and `docs/ARCHITECTURE.md` for precise discovery/proof bounds. Existing `lib/actions/actions.test.ts` and `test/datamechanics/member-profile.datamechanics.test.ts` may be updated for required internal inputs and compatible import controls. The existing AIO-1208 helper may expose a small shared **development-only** invocation primitive if that avoids a second analyzer; preserve all its 150 regressions and route policy intact. Do not move runtime auth into a test helper, build a general CFG/import evaluator, or rewrite action families to fit checker convenience.

## Finite discovery and invocation gate

Discover filesystem source, including untracked files, rather than only a regex over known action filenames. Parse TS/TSX/JS/JSX/MTS/CTS/MJS/CJS source across the repository, explicitly including `app`, `src`, `pages`, `components`, and `lib`. An executable directive in another first-party source root is an unsupported/unclassified action location until reviewed, not silently ignored. Do not enter repository-root generated/dependency/recovery roots (`node_modules`, `.next`, `.git`, `.context`, `coverage`); do not skip a nested directory merely for sharing a generated-directory name inside an application root. Pin exclusions with reasons. A current-source discovery census must reconcile all 20 modules/96 runtime exports/13 erased types, and a temporary-filesystem mutation must find an added action in a nested directory, alternate supported source extension, and `src/app`. Comments, strings outside directive prologues, and erased types create no action.

Every module directive runtime export is keyed by `(repository path, export name)`. No missing, duplicate, stale registration, missing evidence path, or missing reason passes. Inline directives must also be discovered. Current inline count is zero: initially fail closed with file/function/line diagnostics for **all inline actions** until a reviewed explicit registration and supported identity shape is added. This deliberate finite admission avoids inventing stable identities for anonymous closures. A fixture must show both named and anonymous nested inline directives cannot disappear. Merely unsupported syntax cannot become a public exception.

Initially support the actual async non-generator exported function declaration shape, plus immutable const async function/arrow bindings and local immutable alias exports only if tested with explicit lexical resolution. Fail closed on export-star, external re-exports, namespace/import-equals exports, mutable let/var exports, anonymous/default exports without supported stable identity, non-async/non-function runtime values, decorators/unsupported parse shapes, and sync/async generators. Explicit fixtures cover `export *`, `export { h as action }`, default, import-equals and let/var. A local named alias may be deliberately refused instead of supported; its refusal must be tested. Type-only exports are ignored without hiding adjacent runtime exports.

Each protected row pins the **exact set** of registered owner module/export/member identities called by that action or its actually invoked local function chain. Reuse AIO-1208’s approved lexical rules: imports/comments/strings/type references, shadowed imports, wrong canonical modules, merely declared helpers, uncalled closures, and every generator count for nothing. Async helper calls must be actually awaited/returned where their guard is asynchronous; a fire-and-forget promise does not establish completion before the protected effect. Traverse only explicitly invoked ordinary local helpers with cycle protection. `linkMemberSlack` genuinely delegates to the exported ordinary `linkMemberIdentity`; preserve that shape. Imported opaque action wrappers need their own registered owner and executing denial evidence, not a substring exemption.

Canonical owner identity is finite syntax: current root `@/` alias or an extensionless relative path to the registered sole `.ts` module. Wrong bare-package, `/index`, explicit alternate extensions, unrelated export or shadowing cannot satisfy a guard. Record the current owner-file/alias census and fail on drift in the pinned alias/owner files; do not claim arbitrary package/import resolution. Pure authority predicates (role/admin, content writer, note/project visibility) are co-guards requiring current session/member identity. Preserve expected exact sets when a tenant-admin guard is replaced by weaker identity-only access.

This gate pins **invocation identities**, not arbitrary control-flow dominance, argument correctness, verdict handling, or owner semantics. Small syntactic dead-code pruning may be reused; it must be documented precisely. Executing tests establish refusal/ordering for the actual boundaries and target binding. No green AST run should claim branch-complete authorization. Tests must kill real in-memory full-policy mutants: new unregistered export/directive, removed guard call, guard downgraded to session-only, import/comment/unused helper, spare guarded export, shadow/wrong module, unawaited async guard, generator helper/export, and stale protocol/evidence. An admitted ordinary awaited helper control prevents a reject-everything analyzer from passing.

## Targeted runtime correction A: legacy approval team ownership

Current `decideApproval` resolves a team admin but reads `governed_actions` by approval ID alone and calls `resolveApproval` without team identity. `lib/actions/index.ts:ResolveApprovalInput` has no team ID. The resolver reads `approval_requests` by ID, actions by approval reference, writes the approval and actions by ID, audits under the approval row’s team, and invokes the action handler with that row’s team. `finish` also writes by action ID alone. `postgres/schema.sql` gives approval/action/member independent global UUID foreign keys; there is no composite tenant constraint or unique action-per-approval constraint. The stale RLS comment does not provide enforcement.

Constructed scenario: session member is active unrestricted administrator of A; pending legacy approval/action belongs to B; invoke `decideApproval(A.slug, B.approvalId, approved|denied)`. The desired result is `{ok:false,error:"approval not found"}`, B approval/action rows and audit ledger unchanged, zero sandbox/handler dispatch and zero revalidation. The base action/resolver currently has no predicate connecting the authorized A context to B’s IDs. Required pre-fix tests must demonstrate the mismatch, not only a mocked resolver argument.

Make `teamId` a **required** resolver input supplied from `ctx.teamId`. Scope the action’s governed routing lookup to that team and keep foreign governed approvals non-disclosing; governed core already receives team context and must never fall through into legacy execution. Resolver ownership reads and all approval/action writes—including shared handler completion—must use the authoritative team. Resolve errors and ambiguous multiple linked actions fail closed before decision writes/audit/dispatch. A linked action’s tenant must match its approval tenant; read only minimal identifiers to check an inconsistent foreign link before loading execution payload. A genuinely orphaned legacy approval remains decidable without inventing an action. No unscoped lookup of private params may be used to discover ownership.

Retain pending→approved/denied and action pending→running→succeeded/failed, denied, not_found and already_decided outcomes. Claim a decision with an atomic team/id/**pending** conditional update and returned affected row; a lost claim cannot audit or dispatch. The winning claimant’s terminal decision is not undone by an independent request. Handler execution remains outside a held DB transaction; do not hold locks over an external sandbox or provider call. Existing handler failure is recorded as failed and is not automatically retried by this patch. A crash/uncertain delivery after the durable approval claim remains operator-visible through existing approval/action states; no automatic replay, invented exactly-once external-delivery guarantee, new worker or migration. Document this residual legacy recovery limit rather than concealing it.

All statement errors affecting ownership or decision claiming are fatal/refusing, not interpreted as “no action” or success. Audit on a refused foreign/absent/lost-claim request must not record a successful decision. Existing application `GovernedError` mapping stays intact. Update the action so refused outcomes do not revalidate; preserve approved/denied UI messages. Require absent, foreign, already-decided, ambiguous/fault, inconsistent-link, same-team approve/deny, governed-no-legacy and two-request claim tests. Independent requests after admin/session revocation refuse through the current guard; this task does not add linearizable revocation across an already admitted external operation.

## Targeted runtime correction B: People target and resource ownership

Current local `gate` resolves the team, calls `currentMember`, then `canEditMemberContext(me, suppliedMemberId)` without proving the target belongs to that team. A role-admin shortcut accepts a foreign team’s member. `setMemberProfile`/`setMemberAvatar` upsert on global `member_id`; profile schema has separate team and member foreign keys. Time-off/new goal inserts likewise accept unrelated tuple values. For deletes, `removeTimeOff` and `removeMemberGoal` constrain only team/id. `setMemberGoal` updates a supplied ID by team/id and sets `member_id`; imported dedup resolves `(team, source, external_id)` across members. The partial unique goal index is intentionally team-wide.

Constructed scenarios requiring pre-fix observable RED: member Alice authorizes the supplied Alice ID but supplies Bob’s same-team time-off/goal ID; deletion removes Bob’s row. An explicit Bob goal ID or imported source/external-ID collision reassigns Bob’s goal to Alice. Administrator A supplies foreign member B to profile/avatar or new time-off/goal; the global FK/upsert permits cross-team association or overwrite. Tests must seed actual distinct members/teams and inspect durable rows/audits, not rely on reading source or asserting a writer was called.

The People gate must resolve **the existing target member by `(resolvedTeamId, targetMemberId)`** and fail with the existing `not allowed` shape when absent/foreign, before private writer operations. Preserve current self editing and admin-other **same-team** editing, including lead-self behavior; a lead/member cannot edit a teammate merely by presenting their own member ID. Keep self API-key issue/revoke bound to the authenticated member and existing ownership checks.

Pass an explicit browser member-scope constraint through the existing profile single writer, separate from audit actor identity. For time-off/goal delete, the atomic statement predicate is `(team_id, member_id, id)` and must return/check a matched row before successful audit/result. For an explicit goal update, match `(team_id, member_id, goal_id)` and do not reassign `member_id`. For imported dedup, detect the existing team-wide key’s owner and refuse a different member’s match; never reinterpret it as “no match” and insert into a unique collision, nor silently move it. Scope the final update as well as the read so a changed owner between them cannot be overwritten. A concurrent unique insert or ownership change must refuse/retry only by re-reading the scoped ownership; no blind fallback or reassignment. Zero-row writes are refusal, not successful audit.

Keep the team-wide import unique index, idempotent same-member imports, manual non-dedup behavior, profile partial-field preservation, validation, avatars and trusted system import APIs compatible. One finite option is an optional `memberScope` in existing writer options, required by all six browser profile/time-off/goal/avatar actions; unscoped trusted system callers retain their documented import behavior. The implementation must choose and document this internal API without weakening browser guarantees. Target-member lookup belongs to the action authority gate; writer predicates bind mutable child resources. Browser profile/avatar writes also must not overwrite an existing profile row with a contradictory tenant; refuse malformed legacy tuples, do not silently repair/reclassify them. Use transaction-bound adapter/raw SQL only if necessary to express a conditional upsert; keep it in the profile single writer and verify same-connection rollback/fault behavior. Normal API paths do not move a member between tenant identities; member deletion races reject through the FK, not write to a new member.

Delete/missing/foreign/peer resource IDs return the same `not allowed` result without leaking the peer’s content or creating a success audit. Fail infrastructure errors through the existing generic action failure path; do not turn a failed ownership lookup into an admitted empty result. Successful mutations alone revalidate. Real Postgres tests cover every foreign insert/upsert, explicit ID update/delete, imported dedup collision, and owner-change barrier plus admitted self/admin-other and same-member import controls. Preserve the single-writer tests and `getMemberAvatar` read behavior.

## Ownership, recovery and compatibility map

| Transition | Canonical owner / data | Other caller or consumer | Evidence and recovery |
| --- | --- | --- | --- |
| Session→active team member→admin | auth guard + posture resolver; members/current group membership | all admin action exports; gateway guard | executing owner refusal/admission tests; no raw legacy tier fallback or new membership writer |
| Legacy pending approval→decision→handler | `lib/actions/index.ts`; approval_requests/actions/audit | sole dashboard approvals action; action request producer | team-bound atomic pending claim; lost claim zero dispatch; external crash is uncertain existing durable state, no new replay |
| Governed approval decision | governed transactional owner | same dashboard routing action; pending PR governed consumers | retain team input and no legacy dispatch; do not change owned governed consumers |
| Profile/time-off/goal edits | `lib/identity/profile.ts`; existing three tables | six People actions; trusted direct writer tests | current member + same-team target; child write owner predicates, matched-row evidence; refused write creates no success audit |
| Imported goal identity | existing `(team,source,external_id)` partial unique index | currently People action plus direct tests; future trusted importer | same-member browser convergence; peer collision refusal; unscoped trusted import contract retained, no schema rewrite |
| Owned action/content membership behavior | PR714/733/734/735/738/739 owners | new census/denial tests only | record current semantics; hold implementation if a test exposes a new owned-path defect |

Architectural root-cause check is triggered by authority/ownership and possible external handler dispatch. The shared cause of the two targeted classes is accepting resource identity independently of authenticated context. Correct it in the canonical owners and their caller contract, not with page-only checks. These are separate durable state machines; there is no shared queue or need for a general authorization service. No migration, data backfill, automatic classification or historical cleanup. Any preexisting contradictory profile/action tenant tuple remains unchanged and refused.

## Acceptance criteria

- **AC-01 — Complete discovery.** Executed inventory reconciles current 20/96/13/0 census; filesystem mutations discover alternate-root/extension/nested module actions and inline directive forms; every unsupported action shape fails closed. Comments/non-prologue strings/types do not fabricate actions.
- **AC-02 — Complete policy rows.** Every runtime export has exactly one protected/protocol registration with guard owner, refusal, protected effects and actual executing evidence; stale, duplicate or missing entries/reasons/evidence paths fail. All 96 rows below must be reconciled before acceptance; counts are not a bypass allowlist.
- **AC-03 — Genuine invocation.** Full-policy mutants for removed/downgraded guard, comments/import/unused helper, spare guarded export, lexical shadow, wrong owner/export, unawaited async invocation, generator and stale exception fail; ordinary awaited local/delegated helper controls pass. Exact guard sets preserve co-guard requirements. Run existing AIO-1208 regressions if its helper changes. Browser action arguments cannot select a trusted-system writer mode or override the server-created member-scope option.
- **AC-04 — Actual boundary denial.** Valid-input direct execution of each 95 protected exports refuses missing identity/admin/member authority before that row’s protected effect, including secret/provider/model calls, writes/audit-success/revalidation/after callbacks. Existing tests count only when they execute the action and assert the relevant refusal/effect; a helper-only or source-read test is insufficient. Representative admitted controls for each distinct guard family prevent vacuity.
- **AC-05 — Guard owners and policy compatibility.** Real session/active-same-team/member/posture owner tests discriminate absent/foreign/disabled member, role, and current membership-derived admin posture in both stale legacy-tier directions; permitted members/admins pass. Preserve People self/admin-other rules, project-member creation, task/decision content writer/project checks, meeting/social content gates and owned-path hold.
- **AC-06 — Account protocol.** Sign-out clears only current browser auth and redirects without needing identity; stale/missing cookie is harmless. Welcome uses own identity and only-if-unset password writer; change password uses own identity plus current-password verification. Missing identity/invalid old password/already-set account refuse with zero credential change; admitted credential controls work. No active tenant membership requirement is added.
- **AC-07 — Approval team binding RED→GREEN.** Two real teams, authenticated administrator A, B legacy approval/action: approved and denied requests refuse indistinguishably from absent, all B rows/audit unchanged, no handler/sandbox/revalidation. The regression fails on unchanged base for the intended durable-state/dispatch observation; same-team approve/deny pass after correction.
- **AC-08 — Approval state/fault boundary.** Every resolver read/write/completion is team-bound; governed never dispatches legacy; inconsistent foreign/ambiguous link and ownership/claim DB fault refuse before decision/audit/dispatch. Atomic pending claim permits one decision/handler for competing requests; replay remains already-decided. Handler failure/uncertain post-claim state is recorded honestly without new automatic replay.
- **AC-09 — People tenant target RED→GREEN.** Admin A cannot profile/avatar-upsert, add time-off or new goal for member B in another team; absent/foreign uses not-allowed, no row/audit/revalidation. Same-team self and admin-other controls, partial profile update and avatar validation remain compatible. Reproduce actual base acceptance/mutation before fix.
- **AC-10 — People child owner RED→GREEN.** Supplying self target with peer time-off/goal ID, explicit peer goal update, or peer imported dedup key cannot remove, alter or reassign peer content. Atomic team/member/resource filters, zero-row and owner-change races refuse without success audit. Admitted own rows, admin legitimate peer target, same-member imports and trusted import compatibility pass.
- **AC-11 — Ownership and rollout.** No production edits to recorded owned paths or schema/membership writers without a verified owner decision. No migration/backfill, production credentials/queries/member mutations or live external provider calls. Repeat ownership/base census before publication; release note accurately states foreign/peer ID calls now refuse and uncertain legacy delivery remains operator-managed.
- **AC-12 — Falsification and evidence.** Named base runtime RED results, in-memory and filesystem mutant outcomes, caller/owner census, stable source hashes and test commands/results are saved durably with actual run snapshot. Do not launder delayed reconstruction as a prebuild execution. Reviewer independently reads code before author matrix. All pending or skipped evidence remains labelled.
- **AC-13 — Validation.** Scoped unit/checker/action tests, required real-PG target/fault/concurrency and existing affected PG tests pass; `npm run typecheck`, lint, docs checks and `npm run build` pass with actual commands/results. Run full unit coverage with existing assertions/thresholds and report default timeout failures honestly if worker-limited retry is needed. Distinguish direct action execution from Next action-wire proof. No broad datamechanics or 96-action wire claim unless actually run.
- **AC-14 — Required reviews and attachment.** Independent subscription Opus 5.5 spec/code reviews and fresh Astra permissioning design/final reviews resolve confirmed in-scope failures; HIGH/blocker requires independent per-finding skepticism per workflow. Exact accepted full Markdown/hash is attached/read back from AIO-1217 before implementation. Publication uses the earned review line and staging target; ticket stays In Progress until required main integration policy is satisfied.

## Verification matrix and implementation sequence

| AC | Planned named evidence | Current status |
| --- | --- | --- |
| 01–03 | new `test/guards/server-action-auth.test.ts`; filesystem/full-registry mutants, owner/alias census; existing `test/guards/api-route-auth.test.ts` if shared primitive touched | source census only; tests NOT RUN |
| 04 | new executing action-family tests under `test/actions/`; all 95 denied valid fixtures and protected-effect spies; reusable `test/attribution-drilldown-action-authz.test.ts`, `test/admin-sync-context-actions.test.ts` only for proven named cases | existing test source inspected, NOT RUN |
| 05 | new focused auth-owner tests / existing real-PG membership-derived admin cases; task/update, meeting/content regressions | source owner chains inspected, NOT RUN |
| 06 | new account/welcome action tests; existing `test/datamechanics/change-password.datamechanics.test.ts` plus explicit unset-password identity controls | source protocol inspected, NOT RUN |
| 07–10 | new `test/datamechanics/server-action-target-binding.datamechanics.test.ts`; existing `lib/actions/actions.test.ts`, `test/datamechanics/member-profile.datamechanics.test.ts`; staged pre-fix RED before runtime edits | source counterexample paths identified, runtime NOT VERIFIED |
| 11 | recorded PR/worktree ownership + exact staged/unstaged diff; schema unchanged; release note | initial ownership read, final repeat pending |
| 12 | durable inventory/matrix/commands/results/hashes; fresh reviewer snapshot | preliminary artifacts only |
| 13 | scoped unit, PG affected selection, full coverage, typecheck/lint/docs/build | NOT RUN for AIO-1217 |
| 14 | actual Opus/Astra review outputs, adjudication, readiness, accepted Linear readback/hash | PENDING; no implementation admission |

1. Freeze the source-grounded v1 and obtain independent design reviews/readiness. Resolve ownership/finite scope and attach exact accepted spec to Linear. Checkpoint only authorized task doc after required prepush review; no implementation before this gate.
2. Before runtime changes, create observable two-team/peer-resource tests and run on unchanged base. Save real RED observation and same-team admitted baseline. If an intended defect does not reproduce, investigate and revise the claim before fixing. Implement discovery/policy mutants without weakening acceptance.
3. Sole admitted subscription Opus 5.5 builder corrects only own-path target contracts, then direct denial/effect cases and owner tests. Record any necessary internal signature changes and preserve trusted system protocols. Hold owned paths. Stop for material spec/policy flaw rather than expanding silently.
4. Run affected unit/PG and complete validation. Produce 96-row evidence census with actual test names/assertions/results; no existing filename alone is proof. Reviews receive exact diff, full changed/untracked files, caller/schema/owner context and all qualifications.
5. Independent code/Astra reviews; resolve findings, final exact snapshot checks, normal checkpoint/push hooks and staging PR attestation. No merge/deploy without the user’s authorization for that next action.

## Build with Claude Opus 5.5, high

The implementation is security-sensitive because a missed tenant/resource predicate can dispatch a handler or overwrite another member’s content. Use exact subscription-authenticated `claude-opus-5-5` with high effort, verified by coordinator preflight and actual result metadata. No Anthropic API key billing. One implementation writer at a time; do not recursively invoke this workflow, delegate, push, publish, merge or deploy from the builder. Sol 6.1 retains specification/routine adjudication; fresh Astra high reviews permissioning independently. Preserve durable scoped checkpoints, actual quota admission/stop policy, review-beforepush, and source-fingerprint check records.

## Compatibility, release and rollback

No schema changes or replay migration. Release notes explain that foreign approval/member IDs and peer-resource ID substitution now refuse, while legitimate same-team admin/self operations and public own-account protocol remain. The development gate is not a new runtime role policy. Existing action export names/result shapes remain compatible except malicious/mistargeted zero-row operations no longer report success. Trusted system imported goal convergence retains existing team-wide key semantics.

Rollback is a scoped code rollback against the recorded staging base; no data reclassification or audit deletion. Reverting runtime fixes reopens the documented authorization paths and requires an explicit security decision, not an automatic response to a test/tool failure. A build/checker-only discovery rollback cannot be represented as continued inventory enforcement. Existing durable approval/action failures/uncertainty remain visible; never automatically replay a possibly executed external handler. Keep accepted spec and RED/evidence/reviews in durable recovery storage.

## Bounded open decisions for design review

No routine user preference is required. Fresh reviewers must challenge the conditional browser profile-write implementation and legacy claim/handler boundary against actual adapter semantics before acceptance. If a sanctioned conditional upsert cannot preserve foreign/malformed-row refusal in the existing single writer without migration, surface that concrete feasibility issue instead of weakening target binding. Separately, `createMeetingTodosAction` accepts client-supplied extracted rows after team membership; its source-content/row identity contract is a **read-only audit observation**, not yet a demonstrated disclosure or an authorized third rewrite. Existing scan visibility and deliberate task creation semantics must be inspected before any follow-up ownership decision. New defects in held PR-owned paths are reported with observable counterexample and owner decision before code.

## Action classification census

The following is the complete baseline runtime export inventory. Codes map to owner chains below, never guard spelling alone. Refusal text is the authorization refusal; validation/team/record absence may refuse earlier without protected effects. Effects are the operations whose denial tests must observe. Existing test references are candidates, not assertions of executed/passing coverage. Every row requires actual named evidence in the implementation matrix.

| Code | Exact owner / co-predicate | Expected refusal and execution evidence owner |
| --- | --- | --- |
| ADM | `lib/auth/guard:requireTeamAdmin` → `lib/integrations/read:resolveIntegrationsAdmin` → active session/member + posture + `lib/auth/admin-access:canAccessAdmin` | admins only (availability returns []); new action-family executing tests plus owner runtime/PG denial/admission |
| MEM | `lib/auth/guard:currentMember` → session/active same-team/posture | not a member of this team; new executing boundary cases |
| SELF | `lib/auth/session:getSessionUser` | not signed in; account/welcome executing tests, password PG controls |
| PEOPLE | local invoked `gate` → currentMember + `lib/identity/context:canEditMemberContext`, plus proposed same-team target lookup | not allowed; People action/target real-PG tests; no new posture rule |
| TEAM | MEM plus inline tier=team or `lib/meetings/notes:canSeeMeetingNotes` | team-tier membership required; action tests and existing meeting PG candidates |
| WRITER | MEM + `lib/access/enforce:canWriteStructuredRow` through called local helper where present | absent task/decision refusal; existing task-update PG plus new denial controls |
| PROJECT | MEM + `lib/access/enforce:canSeeProjectRow` | project not found; direct action execution tests |
| LEAD | MEM + existing inline role admin/lead, and codebase tier=team where present | admins and leads only / team leads or admins only; action executing role/co-predicate tests |
| NOTE | TEAM + `lib/meetings/notes:getMeetingNote` content oracle | meeting note not found; no key/model/provider/write before denial |
| CHAIN | ADM + called local actorChainGate → `lib/access/enforce:visibleItemIds` + `lib/social/store:actorSeesChain` | visibility resolution failed / not found for this team; actor-scoped chain tests |
| GATEWAY | `lib/auth/session:getSessionUser` + `lib/gateway/admin-persistence:authorizeGatewayAdmin` | admins only, feature-off approval not found, GatewayAdminError code; existing AIO-1208 action consumer tests |
| OUT | `lib/auth/session:signOut` then `next/navigation:redirect` | deliberate public own-cookie protocol; no tenant/data/provider effects |

### `app/t/[team]/meetings/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `uploadMeetingNoteAction` (55) | TEAM | `resolveAnsweringKeys`, `extractFromTranscript`, `findDuplicateMeeting`, `mergeIntoMeetingNote`, `createMeetingNote`, `extractAndStoreActionItems`; authorized team/target context | existing enfb3-meetings/meeting-tasks-push PG candidates + new all-five boundary cases |
| `importPushedMeetingsAction` (164) | MEM + lib/auth/admin-access:canAccessAdmin | `resolveAnsweringKeys`, `backfillMeetingNotesFromItems`; authorized team/target context | existing enfb3-meetings/meeting-tasks-push PG candidates + new all-five boundary cases |
| `extractMeetingActionItemsAction` (205) | NOTE | `getMeetingNote`, `resolveAnsweringKeys`, `extractAndStoreActionItems`; authorized team/target context | existing enfb3-meetings/meeting-tasks-push PG candidates + new all-five boundary cases |
| `regenerateMeetingSummaryAction` (287) | NOTE | `getMeetingNote`, `resolveAnsweringKeys`, `extractFromTranscript`, `updateMeetingSummary`; authorized team/target context | existing enfb3-meetings/meeting-tasks-push PG candidates + new all-five boundary cases |
| `pushMeetingTasksAction` (353) | NOTE | `getMeetingNote`, `resolvePrimaryProvider`, `projectRows`; authorized team/target context | existing enfb3-meetings/meeting-tasks-push PG candidates + new all-five boundary cases |

### `app/t/[team]/people/[handle]/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `saveProfile` (49) | PEOPLE | `setMemberProfile`; same-team target; conditional global-member profile upsert must refuse contradictory tenant | new People direct action + real-PG ownership cases |
| `addMemberTimeOff` (67) | PEOPLE | `addTimeOff`; authorized team/target context | new People direct action + real-PG ownership cases |
| `deleteMemberTimeOff` (85) | PEOPLE | `removeTimeOff`; matched team/member/resource delete before successful audit | new People direct action + real-PG ownership cases |
| `saveMemberGoal` (103) | PEOPLE | `setMemberGoal`; scoped explicit-ID update/import dedup/new insert; no browser owner reassignment | new People direct action + real-PG ownership cases |
| `deleteMemberGoal` (121) | PEOPLE | `removeMemberGoal`; matched team/member/resource delete before successful audit | new People direct action + real-PG ownership cases |
| `saveAvatar` (144) | PEOPLE | `setMemberAvatar`; same-team target; conditional profile upsert; avatar validation retained | new People direct action + real-PG ownership cases |
| `issueMyApiKey` (175) | MEM (called selfGate) | `issueApiKey`; authorized team/target context | new self-key denial/admitted controls |
| `revokeMyApiKey` (189) | MEM (called selfGate) | `revokeOwnApiKey`; authorized team/target context | new self-key denial/admitted controls |

### `app/t/[team]/codebases/[slug]/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `recordFindingDecision` (15) | LEAD (tier=team) | `getCodebaseIdentity`, `decideCodebaseFinding`, `audit`; authorized team/target context | new direct finding action role denial/admitted control |

### `app/t/[team]/social/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `discoverNow` (41) | ADM + lib/access/enforce:visibleItemIds | `discoverOpportunities`; ctx.teamId/actor chain where listed | new social boundary/co-guard cases; admitted chain controls |
| `discoverFromArcsNow` (62) | ADM + lib/graph/partition-read:resolveArcScope | `resolveAnsweringKeys`, `discoverOpportunitiesFromArcs`; ctx.teamId/actor chain where listed | new social boundary/co-guard cases; admitted chain controls |
| `planNow` (91) | CHAIN | `planOpportunity`; ctx.teamId/actor chain where listed | new social boundary/co-guard cases; admitted chain controls |
| `generateDrafts` (109) | CHAIN | `generatePlanDrafts`; ctx.teamId/actor chain where listed | new social boundary/co-guard cases; admitted chain controls |
| `setAutonomyLevel` (130) | ADM | `setAutonomy`; ctx.teamId/actor chain where listed | new social boundary/co-guard cases; admitted chain controls |
| `submitApproval` (146) | CHAIN | `submitForApproval`; ctx.teamId/actor chain where listed | new social boundary/co-guard cases; admitted chain controls |
| `decideContentApproval` (164) | CHAIN | `decideApproval`; ctx.teamId/actor chain where listed | new social boundary/co-guard cases; admitted chain controls |
| `connectTypefully` (192) | ADM | `saveTypefully`; ctx.teamId/actor chain where listed | new social boundary/co-guard cases; admitted chain controls |
| `setDryRun` (208) | ADM | `setPublishDryRun`; ctx.teamId/actor chain where listed | new social boundary/co-guard cases; admitted chain controls |
| `scheduleVariantAction` (221) | CHAIN | `scheduleVariant`; ctx.teamId/actor chain where listed | new social boundary/co-guard cases; admitted chain controls |
| `cancelPublicationAction` (248) | CHAIN | `cancelScheduledPublication`; ctx.teamId/actor chain where listed | new social boundary/co-guard cases; admitted chain controls |
| `refreshAnalytics` (270) | ADM | `runCollectAnalytics` counts-only; existing ENFB-4 chain exemption, ADM still required | new social boundary/co-guard cases; admitted chain controls |
| `generateImage` (283) | CHAIN | `generateVariantImage`; ctx.teamId/actor chain where listed | new social boundary/co-guard cases; admitted chain controls |

### `app/auth/welcome/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `setInitialPassword` (12) | SELF | `setPasswordIfUnset` | new welcome action + conditional credential PG |

### `app/t/[team]/admin/pm-sync/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `projectBoardAction` (24) | ADM | `projectAllTasks`, `recordProjectionRun`, `audit`; authorized team/target context | new module-family action denial/admission |
| `reconcileDivergenceAction` (87) | ADM | `reconcileProviderState`, `audit`; authorized team/target context | new module-family action denial/admission |

### `app/t/[team]/admin/approvals/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `decideApproval` (22) | ADM | `governedActions.decide` or team-bound `resolveApproval`; `createE2BSandbox`; no legacy dispatch for governed | new approval action + real-PG binding/state/fault tests |
| `decideManagedGatewayApproval` (75) | GATEWAY | `decideGatewayApproval`; authorized team/target context | existing AIO-1208 dashboard-conversation-auth action proof + gateway PG |

### `app/t/[team]/admin/agents/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `mintAgentTokenAction` (46) | ADM | `visibleProjectRows`, `mintAgentToken`; authorized team/target context | new module-family action denial/admission |
| `revokeAgentTokenAction` (108) | ADM | `revokeAgentToken`; authorized team/target context | new module-family action denial/admission |

### `app/t/[team]/admin/integrations/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `saveIntegration` (90) | ADM | `rejectPrivateSlackChannels`, `upsertIntegration`, `setIntegrationSecret`; authorized team/target context | new module-family action denial/admission |
| `toggleIntegration` (129) | ADM | `setIntegrationStatus`; authorized team/target context | new module-family action denial/admission |
| `rotateSecret` (145) | ADM | `setIntegrationSecret`; authorized team/target context | new module-family action denial/admission |
| `syncSlackNow` (229) | ADM | `runNowThenReconcile`, `runSlackIngestion`; authorized team/target context | new module-family action denial/admission |
| `syncPlaneNow` (248) | ADM | `runNowThenReconcile`, `runPlaneIngestion`; authorized team/target context | new module-family action denial/admission |
| `syncLinearNow` (264) | ADM | `runNowThenReconcile`, `runLinearIngestion`; authorized team/target context | new module-family action denial/admission |
| `syncGithubNow` (280) | ADM | `runNowThenReconcile`, `runGithubIngestion`; authorized team/target context | new module-family action denial/admission |
| `addGithubRepo` (302) | ADM | `linkGithubRepo`; authorized team/target context | new module-family action denial/admission |
| `removeGithubRepo` (326) | ADM | `unlinkGithubRepo`; authorized team/target context | new module-family action denial/admission |
| `connectGithubToken` (347) | ADM | `validateGithubToken`, `ensureGithubIntegration`, `setIntegrationSecret`; authorized team/target context | new module-family action denial/admission |
| `checkGithubAccess` (371) | ADM | `githubReposAndToken`, `checkRepoAccess`; authorized team/target context | new module-family action denial/admission |
| `estimateGithubImportAction` (392) | ADM | `githubReposAndToken`, `estimateGithubImport`, `getGraphEfficiency`, `countPreviouslyImportedTasks`; authorized team/target context | new module-family action denial/admission |
| `saveOpenrouter` (459) | ADM | `validateOpenrouterKey`, `saveOpenrouterSettings`; authorized team/target context | new module-family action denial/admission |
| `projectToGraphNow` (487) | ADM | `readStagingRuntimeState`, `runGraphProjection`, `recordIngestRun`; authorized team/target context | new module-family action denial/admission |
| `saveProvisioningSettings` (541) | ADM | `saveProvisioningSettings_`; authorized team/target context | new module-family action denial/admission |
| `saveProviderModel` (571) | ADM | `saveProviderModel_`; authorized team/target context | new module-family action denial/admission |
| `setAnsweringProvider` (595) | ADM | `teams` config update by ctx.teamId; `audit`; authorized team/target context | new module-family action denial/admission |
| `setAnsweringModel` (626) | ADM | `teams` config update by ctx.teamId; `saveProviderModel_`, `audit`; authorized team/target context | new module-family action denial/admission |
| `setExtractionModel` (707) | ADM | `teams` config update by ctx.teamId; `audit`; authorized team/target context | new module-family action denial/admission |
| `setExtractionSmallModel` (766) | ADM | `teams` config update by ctx.teamId; `audit`; authorized team/target context | new module-family action denial/admission |
| `setReasoningModel` (872) | ADM | `teams` config update by ctx.teamId; `audit`; authorized team/target context | new module-family action denial/admission |
| `setEmbeddingModel` (913) | ADM | `teams` config update by ctx.teamId; `audit`; authorized team/target context | new module-family action denial/admission |
| `removeIntegration` (962) | ADM | `deleteIntegration`; authorized team/target context | new module-family action denial/admission |
| `setMeetingTaskStatus` (986) | ADM | `setMeetingTaskStatusDb`, `audit`; authorized team/target context | new module-family action denial/admission |
| `setPrimaryPmProvider` (1014) | ADM | `teams` config update by ctx.teamId; `audit`; authorized team/target context | new module-family action denial/admission |

### `app/t/[team]/admin/members/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `linkMemberGithub` (29) | ADM | `linkGithub`, `after`, `reconcileAttribution`; authorized team/target context; PR714 runtime held | new module-family action denial/admission |
| `linkMemberIdentity` (61) | ADM | `setMemberIdentity`, `after`, `reconcileAttribution`; authorized team/target context; PR714 runtime held | new module-family action denial/admission |
| `linkMemberSlack` (91) | ADM via actually invoked linkMemberIdentity | `linkMemberIdentity`; authorized team/target context; PR714 runtime held | new module-family action denial/admission |
| `unlinkMemberIdentity` (101) | ADM | `removeMemberIdentity`, `after`, `reconcileAttribution`; authorized team/target context; PR714 runtime held | new module-family action denial/admission |
| `addMemberEmail` (131) | ADM | `addAuthorAlias`, `after`, `reconcileAttribution`; authorized team/target context; PR714 runtime held | new module-family action denial/admission |
| `reattributeIdentitiesNow` (160) | ADM | `reattributeItems`, `bustTeamLearningCaches`; authorized team/target context; PR714 runtime held | new module-family action denial/admission |
| `resetMemberPassword` (188) | ADM | `adminSetPassword`, `audit`; authorized team/target context; PR714 runtime held | new module-family action denial/admission |
| `setMemberRole` (229) | ADM | `updateMemberRole`, `syncMemberActor`; authorized team/target context; PR714 runtime held | new module-family action denial/admission |
| `setMemberManager` (276) | ADM | `updateMemberManager`, `syncMemberActor`; authorized team/target context; PR714 runtime held | new module-family action denial/admission |
| `removeMember` (305) | ADM | `deleteMember`, `syncMemberActor`; authorized team/target context; PR714 runtime held | new module-family action denial/admission |
| `retryProvisioning` (349) | ADM | `runProvisioning`; authorized team/target context; PR714 runtime held | new module-family action denial/admission |
| `removeMemberEmail` (384) | ADM | `removeAuthorAlias`, `after`, `reconcileAttribution`; authorized team/target context; PR714 runtime held | new module-family action denial/admission |

### `app/t/[team]/admin/brand/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `saveBrand` (11) | ADM | `saveBrandProfile`; authorized team/target context | new module-family action denial/admission |
| `addAsset` (27) | ADM | `addBrandAsset`; authorized team/target context | new module-family action denial/admission |
| `removeAsset` (43) | ADM | `removeBrandAsset`; authorized team/target context | new module-family action denial/admission |

### `app/t/[team]/admin/access/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `runContextBackfillAction` (13) | ADM | `backfillTeamContext`; authorized team/target context | new module-family action denial/admission |

### `app/t/[team]/admin/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `inviteMember` (61) | ADM | `createMember`, `issueMemberInvite`, `resolveTeamUrl`, `rollbackMemberCreation`, `syncMemberActor`; authorized team/target context | new module-family action denial/admission |
| `getProvisioningAvailabilityAction` (203) | ADM | `getProvisioningAvailability`; authorized team/target context | new module-family action denial/admission |
| `issueApiKey` (211) | ADM | `issueApiKeyPrimitive`; authorized team/target context | new module-family action denial/admission |
| `revokeApiKey` (230) | ADM | `revokeApiKeyPrimitive`; authorized team/target context | new module-family action denial/admission |

### `app/t/[team]/admin/policies/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `savePolicy` (11) | ADM | `updatePolicy`, `createPolicy`; authorized team/target context | new module-family action denial/admission |
| `togglePolicy` (25) | ADM | `setPolicyEnabled`; authorized team/target context | new module-family action denial/admission |
| `removePolicy` (37) | ADM | `deletePolicy`; authorized team/target context | new module-family action denial/admission |

### `app/t/[team]/admin/attribution/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `previewAttributionCorrectionAction` (28) | ADM | `buildCorrectionContext`, `resolveAnsweringKeys`, `parseCorrectionPlan`, `previewCorrection`; authorized team/target context | attribution-drilldown existing two action denials + new remaining cases |
| `getMemberItemsAction` (69) | ADM | `getMemberItems`; authorized team/target context | attribution-drilldown existing two action denials + new remaining cases |
| `previewCorrectionPlanAction` (91) | ADM | `previewCorrection`; authorized team/target context | attribution-drilldown existing two action denials + new remaining cases |
| `applyAttributionCorrectionAction` (107) | ADM | `applyAttributionCorrection`, `after`, `bustTeamLearningCaches`; authorized team/target context | attribution-drilldown existing two action denials + new remaining cases |

### `app/actions/tasks.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `moveTaskAction` (52) | WRITER | `tasks` team-bound update after row-writer predicate; `after` → `projectTaskByIdAfterWrite`; authorized team/target context | task-update PG candidate + new all-three action denial controls |
| `createTaskAction` (85) | PROJECT | `tasks` team-bound insert after project visibility; `after` → `projectTaskByIdAfterWrite`; authorized team/target context | task-update PG candidate + new all-three action denial controls |
| `updateTaskAction` (152) | WRITER | `tasks` team-bound update after row-writer predicate; `after` → `projectTaskByIdAfterWrite`; authorized team/target context | task-update PG candidate + new all-three action denial controls |

### `app/actions/meeting-todos.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `scanMeetingTodosAction` (64) | TEAM + lib/access/enforce:visibleItemIds | `scanMeetingTodosForTeam`; authorized team/target context | new two exported-action cases; separate source-binding audit observation |
| `createMeetingTodosAction` (121) | TEAM + existing membership-only create boundary | `createMeetingTodoTasks`, `projectAllTasks`, `recordProjectionRun`; authorized team/target context | new two exported-action cases; separate source-binding audit observation |

### `app/actions/decisions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `createDecisionAction` (31) | LEAD + PROJECT | `decisions` team-bound insert after role + project visibility; owned runtime held; authorized team/target context | new executing current behavior cases; no governed rewrite |
| `setDecisionValidityAction` (87) | LEAD + WRITER | `decisions` team-bound update after role + row writer; owned runtime held; authorized team/target context | new executing current behavior cases; no governed rewrite |

### `app/actions/projects.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `createProjectAction` (20) | MEM | `ensureProjectGraphPointer`, `grantProjectToCreator`; authorized team/target context | existing system-project-grant PG candidates + new action denial |

### `app/actions/account.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `changeMyPassword` (14) | SELF | `changePassword` | new own-account action tests + change-password PG |
| `signOutAction` (30) | OUT | own-cookie `signOut`; `redirect("/login")`; no tenant/data/provider write | new own-account action tests + change-password PG |

