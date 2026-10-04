---
eval_tier: deterministic
spec_gate: block
safety: true
type: issue-spec
status: ACCEPTED
---

# AIO-1208 — enumerate and verify App Router route-file authentication contracts

Version: final (accepted v3 architecture and acceptance IDs, with finite final-review build obligations). Independent Opus round 3 and focused Astra v3 passed; Sol adjudicated their remaining implementation clarifications without an architecture revision. Ticket: https://linear.app/je4light/issue/AIO-1208/every-team-brain-api-route-has-a-proven-auth-guard-enforced-by-a-build . Brain key/trailer: AIO-1208. Ticket In Progress was verified by the coordinator. Implementation has not begun.

Reviewed base: staging `dc72e5bce4c37ec379e1f7777043f7577ce56932`; checkout `.context/aio1208-worktree`; intended branch `codex/aio-1208-route-auth-inventory`; PR target staging.

## Outcome and rederived problem

A new App Router route-file handler, or an existing handler losing an expected guard, must fail the existing `npm test` CI gate with its exact path and method. Every route method must have an explicit per-method classification and either actually invoke its expected set of registered authentication/authorization entry points, through a bounded supported wrapper when appropriate, or have a method-specific documented public protocol exception. Merely mentioning or importing a guard is insufficient. Public login/callback/readiness endpoints remain usable through their existing protocols.

`proxy.ts` excludes `/api/` and protects only `/t/` pages. There is no Postgres RLS backstop. Auth belongs to each handler or its called owner. The ticket's 61-file/49-visible/12-unverified scan is historical. Current source has **63 `app/**/route.ts` files and 72 explicitly exported HTTP handlers**, including `/auth/confirm` and the newly hardened `/auth/dev-login`. This is the baseline, not a future hardcoded ceiling. Six handlers have deliberate public protocol contracts; the other 66 are protected. Initial regexp enumeration assisted discovery but is not accepted proof of guard execution.

The twelve routes named by the ticket are classified below; “unverified” did not mean unguarded. Actual inspection found all existing named routes have a credential protocol or guard. It also found a browser-admin policy discrepancy that this slice explicitly corrects: `lib/gateway/admin-persistence.ts:authorizeGatewayAdmin` reads `members.tier` directly, while current admin authority requires deliberate `everyone` membership. This is observable when an active admin has legacy `tier='team'` but no everyone membership: the gateway helper admits a caller that current dashboard admin gates refuse. The reverse stale record rejects an otherwise-authorized admin.

The shared admin policy motivating the new bounded decision is `docs/design/pret4-tier-wall-teardown.md` §1d: `role === 'admin' && posture === 'team'`, with posture from everyone membership. `lib/access/posture.ts` says the PRET-6 legacy window is retired and the builtin row alone decides. `lib/integrations/read.ts:resolveIntegrationsAdmin` and `lib/auth/guard.ts:currentMember` consume that resolver. `test/fixtures/contract/gateway-approval-v1.10.json` names admin/external/ineligible outcomes, without reserving raw legacy tier as a gateway exception. Existing `test/datamechanics/gateway-approval.datamechanics.test.ts` changes raw tier in its authorization matrix and does not test stale-tier/membership disagreement. That fixture must be corrected to express the current authority source.

## Twelve-route audit

All paths below end in route.ts.

| Ticket path | Methods | Current authority / classification | Required observable proof |
|---|---|---|---|
| `app/auth/confirm` | GET | Public magic-link redemption; `redeemMagicToken` must return a valid single-use token before `signSession` | Invalid/expired/replayed token sets no session; valid token retains first-login redirect |
| `app/api/auth/login` | POST | Public password entry; `loginWithPassword` before signing, rate limited | Wrong/unknown credentials yield same 401 and no session; valid password succeeds |
| `app/api/auth/slack/callback` | GET | Public OAuth callback; `consumeSlackOAuthState` verifies signed, single-use member/team binding before provider exchange and writes | Invalid/expired/replayed state causes no secret write/provider exchange; successful state stores for bound owner |
| `app/api/v1/actions/[action_id]` | GET | Protected wrapper `governedActionHttp.status` authenticates with `authenticateApiKey` before service read | Authentication failure cannot call governed status service |
| `app/api/dashboard/conversations/[id]` | GET, PATCH, DELETE | `resolveChatOwner` in each method; owner-scoped store read/rename/archive | Unauthenticated/not-member refusal before store operation, owner pair retained on success |
| `app/api/dashboard/conversations/[id]/run` | GET | `resolveChatOwner`, then owner-scoped `latestRun` | No owner → 403 before run read; successful read retains owner pair |
| `app/api/internal/executor-gateway/v1/admin/[teamSlug]/policies` | GET, POST | `gatewayAdminContext`, then `isResponse` early refusal before persistence | Enabled anonymous/member/lead/restricted/inactive caller cannot list/create |
| `.../policies/[policyId]` | PATCH, DELETE | Same shared admin guard | Refusal before update/delete |
| `.../approvals` | GET | Same shared admin guard | Refusal before approval enumeration |
| `.../approvals/[approvalId]/decision` | POST | Same shared admin guard | Refusal before decision |
| `.../service-identities/[serviceIdentityId]/credentials` | GET, POST | Same shared admin guard | Refusal before credential enumeration/rotation |
| `.../service-identities/[serviceIdentityId]/credentials/[credentialId]/revoke` | POST | Same shared admin guard | Refusal before revocation |

The abbreviated paths retain the exact `app/api/internal/executor-gateway/v1/admin/[teamSlug]` prefix. The six files cover **nine admin operations**, not six.

## Bounded implementation

Add a test-owned inventory/checker under `test/guards/`: new file: `test/guards/api-route-auth.test.ts`. New file `test/guards/helpers/api-route-auth.ts` is appropriate if necessary for fixture/mutation testing; this is development-only code and is not a new runtime authorization layer. Use the installed TypeScript compiler API, already a dev dependency, to parse actual syntax. Do not build a general control-flow/security theorem or add a parser dependency.

The checker walks the actual app filesystem, including untracked source files, and discovers all route-file extensions Next currently accepts: route.ts, route.tsx, route.js and route.jsx. Installed Next route matcher (`node_modules/next/dist/server/lib/find-page-file.js:createValidFileMatcher`) uses configured pageExtensions; installed pageExtensions docs list these four defaults, and current next.config.ts does not customize them. This repository currently uses only route.ts: fail with path diagnostics on any discovered non-ts route instead of ignoring it. Also fail if pages/api, src/pages/api or src/app appears, or if pageExtensions is customized without updating this discovery contract. This keeps the guarantee explicit for this repository rather than silently ignoring an alternate routing tree. Discovery includes non-API /auth routes. Resolve every explicit exported HTTP method among GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS. Support current function exports and straightforward exported const function/arrow handlers. Aliases, reexports, overloads or other unsupported export shapes must fail with a useful diagnostic rather than silently vanish; bounded support can be added if a real current route requires it. Required failing fixtures explicitly include export-star and named re-export alias (`export * from ...` and `export { h as GET } from ...`) so unsupported method exports cannot evade inventory. Next's automatically generated HEAD/OPTIONS are not explicit source exports and are not additional route records. Refuse parse errors and HTTP-named exports that cannot be classified. Assert nonempty discovered inventory.

Maintain an explicit expected guard-symbol set for each protected `(path, method)`; discovery and classification keys must match exactly, so every new handler requires review of a new registry row. Each protected handler must have genuine call expressions to exactly its approved entry-point set in the handler's executed function body. The registry identifies **module export identity**, not just a spelling: resolve named import aliases and the current destructured dynamic import of canAccessAdmin; recognize approved member calls such as `governedActionHttp.status` only on the import from its exact owner module. Shadowed/redeclared local identifiers must not satisfy import identity. Do not descend into a nested function/arrow just because it exists; an unused nested helper containing authentication does not authenticate the surrounding handler. Follow explicitly called local functions for the current `resolveAdminTeam` pattern, with cycle protection; after its real guard call is removed, the local wrapper is no longer satisfactory. No comments, strings, type references, import-only symbols, unrelated methods or unused top-level helper definitions count. A file guarded in GET but unguarded in POST must fail for POST.

Registered entries are the currently used owners, plus `canAccessAdmin` (`lib/auth/admin-access`) as a required authorization co-invocation for the two routes below: `authenticateApiKey`/`authenticateAgentToken` (`lib/api/auth`); `getSessionUser` (`lib/auth/session`); `currentMember` (`lib/auth/guard`); `resolveChatOwner` (`lib/chat/session`); `gatewayAdminContext` (`lib/gateway/admin-http`); `authenticateGatewayRequest` (`lib/gateway/http`) and `authorizeGraphProxy` (`lib/llm/graph-proxy`); `governedActionHttp.submit`/`.status` (`lib/actions/governed/http`); `stagingBuildMetadataResponse` (`lib/staging/build-metadata`). The local `resolveAdminTeam` in dashboard/access/inspect is traced to both getSessionUser and canAccessAdmin, with module identity preserved, rather than globally registered by name. Expected sets are specified by the final inventory table with these precise per-method refinements: dashboard/access/inspect GET and POST require {getSessionUser,canAccessAdmin}; dashboard/social/media/[id] GET requires {currentMember,canAccessAdmin}; v1/items POST requires {authenticateApiKey}, GET requires {authenticateApiKey,authenticateAgentToken}; v1/query POST and v1/evidence/search POST each require {authenticateApiKey,authenticateAgentToken}. All other protected methods require exactly the named entry in their current inventory row; credential-branch wording denotes both symbols. Local wrapper name resolveAdminTeam itself is not a registered authority. canAccessAdmin alone is never sufficient authentication. Do not accept `rateLimit`, `gatewayDisabled`, mere response serializers or `safeNextPath` as an authentication guard.

Wrapper registration is an explicit trust decision, coupled to tests of its actual denial behavior. Maintain reason/owner/evidence for each wrapper; fail stale registration/evidence paths and unused registrations so bypass entries cannot accumulate. A registered wrapper's unused import inside a route still fails. Guard absence is diagnosed per method, e.g. `app/api/.../route.ts POST: no registered authentication invocation`.

**Bounded guarantee:** this static check pins the expected registered invocation set in each actual handler/called local helper, not that every possible branch dominates all data access or that a helper can never become permissive. Runtime denial tests below substantiate refusal and ordering on the priority routes and wrapper owners. Do not claim the inventory replaces content authorization, revocation enforcement or peer identification. In particular, the seven getSessionUser route files (brain/arcs, brain/arcs/recompute, brain/events, brain/facts, dashboard/query, dashboard/team-work, dashboard/timeline) still perform inline active same-team membership resolution beyond the registered session call; this scanner does not prove that inline predicate or all its branches. A branch such as `if (false) authenticateApiKey(...)` should be rejected when syntactically obvious; arbitrary path feasibility is outside this checker. This limitation belongs in the durable documentation.

### Public protocol exceptions

Use exact path **and method** entries with nonempty reason, authority/protocol description and existing/new test evidence paths. No directory-wide exceptions, wildcard methods or generic “internal” exemption. Require every exception's file and method still exist; newly exported methods at that path require separate classification. Detect duplicate/conflicting entries, stale/nonexistent evidence paths, and empty reasons.

Initial exception set (all one method):

| Path/method | Public-by-design reason and limits | Evidence |
|---|---|---|
| `app/api/auth/login/route.ts POST` | Obtains a session by proving password; cannot require a preexisting session | `test/http/auth.http.test.ts`, `test/datamechanics/login.datamechanics.test.ts` |
| `app/api/auth/request-magic-link/route.ts POST` | Pre-login delivery request; uniform response, rate limited, never sets session | `test/request-magic-link-route.test.ts`, `test/http/auth.http.test.ts` |
| `app/auth/confirm/route.ts GET` | Browser redeems emailed single-use token before session exists | `test/http/auth.http.test.ts`, `test/datamechanics/login.datamechanics.test.ts` |
| `app/api/auth/slack/callback/route.ts GET` | OAuth browser redirect cannot carry member API bearer; signed consumed state supplies identity | `test/slack-oauth-state.test.ts`, `test/datamechanics/slack-oauth.datamechanics.test.ts` |
| `app/api/health/route.ts GET` | Platform readiness is public; only `{ok,commit}` without token; detailed staging evidence remains separately authenticated | `test/staging-health.test.ts` |
| `app/auth/dev-login/route.ts GET` | Deliberate local-development login; production hard-off, exact opt-in and local authority checks, no credential in this protocol | `test/dev-login-route.test.ts`, `test/datamechanics/dev-login.datamechanics.test.ts`, `test/http/dev-login.dev-http.test.ts`, `test/http/dev-login-build-cli.ts` |

The metadata route is NOT public; its `stagingBuildMetadataResponse` validates an independent service token before returning metadata. AIO-1210 already implemented dev-login restrictions; preserve them and their current tests/carriers. Public exceptions do not declare verifier-free success safe: tests of credential/state rejection continue to run. `healthResponse` detail gating and protocol verifiers should have direct route/wrapper tests where existing evidence misses invocation coverage; do not duplicate already-substantive real-PG tests merely to change filenames.


### Registered authority evidence table (required build obligation)

Evidence means executing the named owner at its normal dependency seam and asserting a real denial or preserved protocol outcome. A mocked verdict in a handler test alone does not prove its owner. Existing lower-layer tests may be paired with a focused wrapper test rather than duplicated. New file: test/auth-wrapper-evidence.test.ts provides the missing owner composition proofs below. The acceptance matrix must map each table row to actual test names/results; unresolved evidence blocks AC-13 completion. These obligations clarify existing AC-04/06/07/08/13, without adding a broader full-route or Server Action audit.

| Registered symbol | Authority owner | Required denial evidence/test path |
|---|---|---|
| authenticateApiKey | lib/api/auth.ts | Existing test/api-auth-team-header.test.ts rejects wrong team; test/http/auth.http.test.ts rejects invalid key. Add actual-owner missing/invalid/revoked/inactive-owner refusal as necessary in new test/auth-wrapper-evidence.test.ts; preserve admitted control, do not mock authenticateApiKey itself. |
| authenticateAgentToken | lib/api/auth.ts → lib/access/agent-tokens.ts | Existing test/datamechanics/access-agent-tokens.datamechanics.test.ts proves revoked/expired/bad-secret/ineligible verification; test/http/agent-tokens.http.test.ts proves invalid bearer401. New test/auth-wrapper-evidence.test.ts executes actual authenticateAgentToken for verification refusal and team mismatch before principal return, with a valid admitted control. |
| getSessionUser | lib/auth/session.ts → lib/auth/pg-session.ts | New test/auth-wrapper-evidence.test.ts executes actual cookie-reading wrapper and real session verification: no cookie, invalid/tampered/expired cookie returns null; valid synthetic session admits. Membership is not part of this identity wrapper. |
| currentMember | lib/auth/guard.ts | New test/auth-wrapper-evidence.test.ts executes actual helper at session/server DB seam: missing session, absent/disabled membership or membership solely in another team returns null; same-team active member succeeds with shared posture, without a mocked currentMember verdict. |
| canAccessAdmin (co-guard only) | lib/auth/admin-access.ts | Existing test/admin-access.test.ts checks role/posture denials and admitted admin. Inspector/media expected co-call mutants remain AC-03; this predicate alone does not prove session identity. |
| resolveChatOwner | lib/chat/session.ts | New test/auth-wrapper-evidence.test.ts actual helper: no session, inactive/disabled membership, and foreign-team-only member refuse; active same-team owner pair succeeds. AC-06's route seam tests separately prove no store/run dispatch. |
| gatewayAdminContext | lib/gateway/admin-http.ts → authorizeGatewayAdmin | AC-08/09/10 tests: actual wrapper no session401, helper denial404/422/403 and substrate failure generic500; no downstream privilege on refusal; approved context control. Evidence can be in new test/gateway/gateway-admin-consumers.test.ts and existing realPG gateway approval test. |
| authenticateGatewayRequest | lib/gateway/http.ts → service credential verifier | Existing enabled gateway wire test rejects invalid credential401. New test/auth-wrapper-evidence.test.ts executes actual wrapper with verifier failure at its credential seam, version mismatch409 and admitted correctly versioned service; no secret/service principal returns on refusal. Lower credential verifier remains exercised by existing gateway-wrong-key realPG tests. |
| authorizeGraphProxy | lib/llm/graph-proxy.ts | Existing test/graph-llm-proxy.test.ts already executes real predicate and rejects absent, weak, wrong/malformed secrets, with correct-secret control. Do not substitute source-string guard for this evidence. |
| governedActionHttp.submit / status | lib/actions/governed/http.ts | Extend test/actions/governed-http-body.test.ts per AC-07: real owner authenticator returns null/error and no submit/status service dispatch; admitted control. |
| stagingBuildMetadataResponse | lib/staging/build-metadata.ts | New file: test/staging-build-metadata.test.ts per AC-04 tests absent/wrong service token401, no sensitive metadata, and admitted valid token+commit control. |

Prebuild full-file tier census verified only the browser helper's typed tier/select/check and the preserved policy subject input/serialization occurrences; no additional members.tier record consumer appears later in admin-persistence. Re-run the actual full-file census before modifying that helper and retain evidence. A new record consumer outside these enumerated paths returns to specification/adjudication; never re-add the broad exemption silently.

Program docs/design/retire-permissive-model.md §8 names delegated-token semantics (unchanged, always attenuated, tier-independent) and does not name browser gateway administration. The PRET-4 amendment is sufficient for this new human/session boundary; program §8 need not be redefined. Source search in test/guards for pgClient importers or transaction call-site registries found no such restriction requiring a new importer allowlist. Preserve ordinary guard tests; revisit only an actual subsequent failure.

### Gateway admin correction

Change the signature to `authorizeGatewayAdmin(teamSlug: string, authUserId: string, db: TransactionCapableDbClient = pgClient())`. The optional third parameter is a server-only composition/test capability, never a route or action input. All production callers keep two arguments and the actual default uses the existing sanctioned PgClient factory. A test can supply `new PgClient({decorateSessionExecutor})` through that parameter. Use `db.transaction`, so the injected factory owns all three bound reads; do not call pgClient().transaction inside the function while ignoring the supplied capability.

Within `authorizeGatewayAdmin`, retain team lookup and same-team member lookup, active-member refusal and existing status/error shape. Remove raw tier as authority. Use the supplied/default sanctioned `db.transaction(async session => ...)` factory instead of this helper's raw `withTransaction` callback. Keep existing team/member SQL through `session.executeSql`; resolve shared posture through `resolveViewerPosture(session.db, teamId, memberId)`, then use shared `canAccessAdmin`. Both public session capabilities are defined in lib/db/types.ts. This makes all three reads use the same managed connection without manually constructing a bound PgClient (the factory owns that construction), opening a second transaction, querying the process pool during the callback, or copying Everyone SQL. Await the resolver and never retain session capabilities beyond the callback. Other gateway persistence functions retain their own transactions unchanged. Both old and new transactions use ordinary BEGIN/READ COMMITTED; this is not a repeatable-snapshot claim.

Preserve order/errors: unknown team or member → existing 404; inactive → existing 422 before any posture read; then non-team posture → existing 422 `gateway_scope_not_found`; team-posture member/lead → existing 403 `gateway_forbidden`; active same-team admin with team posture → same context. A posture substrate error throws through `gatewayAdminContext` to fixed 500 `gateway_internal`, never legacy-tier fallback or default success. `getSessionUser` absence remains 401. Gateway disabled state remains the same inert 404 before auth/parsing. PRET-4 §3.3 also explicitly grants a broader historical file-level exclusion: “the token/gateway layer (`lib/access/agent-tokens.ts` mint/verify, `lib/gateway/persistence.ts:988`, `lib/gateway/admin-persistence.ts`, `lib/gateway/policy.ts`, `gateway_executions.tier_snapshot` — delegated-token semantics, program §8 out of scope, UNTOUCHED). Everything else is a guard violation (§4 AC4/AC5).” Do not claim that exclusion already distinguished this browser-admin helper or that a prior slice implemented this correction. AIO-1208 makes the NEW bounded policy amendment: browser/admin-session authority in authorizeGatewayAdmin follows shared role+membership posture; persisted token/execution/policy subject-tier semantics remain excluded and unchanged. Add an explicit dated AIO-1208 amendment adjacent to PRET-4 §3.3 explaining this narrowed exclusion and update its sanctioned-record-consumer list accordingly. After correction this module has no remaining members.tier record read: the query currently selecting id/role/tier/status and row.tier check belong solely to authorizeGatewayAdmin and lose tier. Remaining tier occurrences are policy subject-selector input (`input.subject.tier`, cols.tier), `policies.subject_tier` metadata selection, and create/update subject_tier persistence; none reads members.tier. `test/guards/tier-no-access-reads.test.ts` currently allowlists the whole module as “gateway policy persistence — program §8”. Remove that now-unneeded members.tier allowlist entry and document the narrowed reason in PRET-4. The existing guard must remain green, with its non-vacuous raw gateway lease fixture untouched. Its current raw-SQL regex requires qualified m.tier/members.tier and cannot detect the old unqualified select tier::text shape. Do not claim removal of its exemption catches reintroduction of that browser query: AC-09 and AC-12 are the actual behavior regression pins. Extending that regex is optional and not required by this slice. Do not add a fresh raw-members-tier exemption; real-PG stale-tier arms also catch reintroduction of the old browser authority. No change to gateway service-token authorization, action-policy subject selector tiers, admin request schemas, credential serialization, transaction mutation owners, or resource team scoping.

Authority is resolved per request; committed membership removal is reflected by the next request. Existing requests remain snapshot-authorized; this slice does not promise cancellation or make authorization and later mutations one transaction. No new cache. Test database errors with an existing seam or instrumented bound executor, without production env/secrets. No production member/token mutation is part of this build.


### Direct consumers of the changed gateway authority

Source search over app/lib/scripts found exactly three production call sites for authorizeGatewayAdmin: lib/gateway/admin-http.ts:gatewayAdminContext (all nine admin route methods); app/t/[team]/admin/approvals/page.tsx:ApprovalsAdminPage (managed queue branch, itself preceded by requireTeamAdmin); app/t/[team]/admin/approvals/actions.ts:decideManagedGatewayApproval (session then helper, before decideGatewayApproval). No policies Server Action calls this helper. Other callers are the existing real-PG test only. Re-run this search before publication; unexpected callers require bounded specification/test correction, not silent scope expansion.

The two non-route consumers change behavior through the shared helper and are explicitly covered in this slice despite general Server Actions inventory being deferred. Add focused unit tests calling the actual managed decision action with valid IDs and enabled flag: helper422 refusal returns its existing error and invokes no decideGatewayApproval/revalidatePath; admitted context dispatches with authenticated IDs. Add a focused actual approvals-page test that imports and executes its TSX module with admin gate admitted: managed-helper refusal yields no managed queue/panel/list call while unrelated pending/recent queues retain current behavior; approved helper context dispatches the managed list. These tests may mock session and authority verdict to prove consumer control flow; actual authority is established by AC-09 real PG and AC-12 wire. Source-text inspection is not the AC-14 page outcome test. Execute the page and inspect its returned/rendered managed-panel outcome and operation spies. A .test.ts file can import the TSX page; if a .test.tsx carrier is actually needed, minimally include **/*.test.tsx alongside the existing **/*.test.ts in vitest.config.ts. A minimal JSX transform setting is permitted only when demonstrated necessary for executing this existing page; preserve existing test collection and do not weaken assertions. No new action exports, UI behavior design or page source refactor is required unless implementation reveals a concrete existing bypass. New file: test/gateway/gateway-admin-consumers.test.ts may hold these cases.

### Base-run corrections and preserved credential policy

Run the real method inventory against the unchanged base before corrections. Its exact-set report is evidence: reconcile any unanticipated actual invocation with source/policy and record a spec correction before proceeding. Never relax expected-set equality to a subset/superset or drop an acceptance requirement merely to make the base green. Current source AST inspection independently verified items POST {authenticateApiKey}, items GET/query POST/evidence POST {authenticateApiKey,authenticateAgentToken}; no canAccessAdmin is present in those handlers. Ensure the final review packet includes their full method source, not only an inventory summary.

The all-disabled password refusal is existing normative behavior, not a speculative policy improvement: lib/auth/pg-login.ts:emailHasMember selects status <> disabled; loginWithPassword returns null when none, before password verification. Existing test/datamechanics/login.datamechanics.test.ts already asserts a disabled member with correct password returns null. Add the route-level no-cookie arm using a unique email whose only membership is disabled, preventing unrelated fixture memberships from falsifying its premise. If that arm fails, diagnose fixture/data leakage or a genuine existing protocol defect and resolve within the reviewed policy; do not mark it it.fails or silently defer required refusal. A material discovered policy conflict returns to specification review. Valid magic-token identity issuance despite all-disabled memberships is an existing asymmetry, named in the durable document; token expiry/replay refusal and protected membership checks remain independently required. No new identity prohibition is chosen.

The scanner excludes page endpoints, framework-generated metadata endpoints (such as robots/sitemap/icon routes), and Server Actions except the above shared-helper consumer tests. State these exclusions in the durable architecture note; say coverage of explicitly authored App Router route-file handlers, not every HTTP endpoint.

## Tests, verification matrix and falsification

Write observable failing tests before the correction. Before green, record the expected failing assertions against the unchanged base in a durable evidence file. Static fixture tests exercise the real checker, not a second implementation. Mutation tests take an in-memory path-to-source map and transform copies of real source read from disk. Execute the actual checker on that map. Never mutate product files on disk; an interrupted run must not leave a weakened guard available for checkpointing. Besides fixture mutants, real-source mutants must remove authenticateApiKey from a representative v1 handler, gatewayAdminContext from one admin method, getSessionUser from local resolveAdminTeam, canAccessAdmin from inspector/media, and authenticateAgentToken from each dual-credential handler; every mutant must fail naming the affected method(s), while unchanged copies pass.

| ID | Requirement and observable expected behavior | Required test/evidence lane |
|---|---|---|
| AC-01 | Every current App Router route file and exported HTTP method is classified; baseline is 63/72; discovery includes /auth and untracked source. Non-ts Next route files and alternate routing trees fail rather than disappear; future guarded additions also require explicit registry classification | `test/guards/api-route-auth.test.ts`, actual repo inventory + positive synthetic handler |
| AC-02 | New unguarded route or new unguarded POST on a guarded GET file fails, naming exact path/method | Checker fixture tests, including new guarded method lacking registry row; existing unit CI `npm test` |
| AC-03 | Removing a real guard call fails even if import/comment/string/unused top-level or nested helper retains its name; a same-spelled local function does not count; supported named import alias really called passes; removed authorization co-guard or delegated branch guard fails the exact expected set | Adversarial checker fixtures and real-source in-memory mutants; no disk mutation; record actual checker result |
| AC-04 | Called `resolveAdminTeam` is followed to its real session guard; removing that inner guard fails both GET and POST. `governedActionHttp.status`/submit and metadata wrapper require actual approved calls, not imports. The metadata owner must return401 for absent/wrong token and valid token+commit success, so registration is not a substitute for protocol proof | Local/wrapper checker fixtures against real-source-shaped cases; new file: `test/staging-build-metadata.test.ts` for substantive owner protocol test |
| AC-05 | Public exceptions require exact file/method, reason and existing evidence; stale file/method, new method, empty reason, duplicate entry and stale evidence fail | Checker fixtures and actual exception inventory |
| AC-06 | Named dashboard conversation GET/PATCH/DELETE and run GET refuse without a resolved owner before calling store/run operations; authorized calls keep authenticated owner pair | Meaningful direct-handler unit tests with owner resolver seam plus actual resolveChatOwner wrapper absent/inactive/foreign-team denial and admitted control in new file: `test/auth-wrapper-evidence.test.ts`; valid payload/UUID so parser errors cannot substitute for refusal |
| AC-07 | Governed action status and submit wrappers refuse invalid/missing API authentication before invoking status/submit service | Extend `test/actions/governed-http-body.test.ts` or focused unit handler/wrapper tests; existing contracts remain |
| AC-08 | All nine enabled gateway admin methods return guard refusal unchanged, and invoke no privileged persistence on 401/403/404/422/500; disabled routes retain inert 404 | Parameterized actual-handler unit tests: gatewayEnabled seam on, gate refusal, spies for all nine operation owners; include positive approved dispatch so unconditional refusal cannot pass |
| AC-09 | Shared gateway authority follows actual everyone membership: legacyteam/noeveryone active admin refuses422; legacyexternal/witheveryone active admin succeeds. Member/lead with everyone refuse403, without everyone refuse422 (precedence). Inactive admin with everyone refuses422 before posture read; foreign-team everyone membership cannot grant local posture; foreign/unknown remain404 | Extend `test/datamechanics/gateway-approval.datamechanics.test.ts` with real PG fixtures; first stalelegacyteam arm must fail before fix |
| AC-10 | Next request after committed everyone removal refuses; injected factory observes teams→members→group_members on one connection (inactive has no posture read); bound posture failure produces generic500/no dispatch and cannot fall back to legacy tier or unbound client | Real-PG authority test for committed removal; real-PG or focused injected transaction-session executor: fail only bound group_members query and make unbound pool path a test failure; gatewayAdminContext returns generic500 with no privileged dispatch |
| AC-11 | Login/confirm/Slack/health/dev-login exceptions preserve their actual credential/protocol boundaries and success control cases, no leaked session/secret on credential refusal. Slack callback tamper/expiry/replay explicitly makes zero provider fetch and zero secret write calls. Magic confirm expired/replayed tokens set no cookie. Password login where all email memberships are disabled returns401/no cookie. Public health no-token returns exact {ok,commit}; wrong-token returns401 exact {ok:false}, never detailed state | Existing `auth.http`, login/Slack real-PG, magic request/unit state, health and AIO1210 dev-login tests; add only actual gaps such as confirm replay no-cookie if not already covered |
| AC-12 | Enabled gateway wire verifies all nine admin methods reject anonymous valid path requests401 before malformed-body parsing; disabled carrier still404; named dashboard/action guard routes return their documented anonymous refusal | Extend `test/http/gateway-approval-enabled.http.test.ts`; focused new/existing HTTP route-auth test for conversation/action methods; plus full-chain wire GET policies: real stalelegacyteam/noeveryone admin session refuses422, enrolled active admin returns200; role/posture real-PG matrix retained |
| AC-13 | Correct unit/integration CI lanes execute new tests; lint/typecheck/docs and existing tier-consumer guard pass with narrowed PRET-4 exemption; registry failure is build-failing, not silently skipped | `npm test`, `npm run lint`, `npm run typecheck`, `npm run check:docs`; focused `test:datamechanics`; HTTP normal and enabled gateway carriers; build for HTTP artifact |
| AC-14 (new in v3) | Known non-route consumers of changed helper are covered: managed approval action refuses without decision/revalidation dispatch; approvals page omits managed queue on refusal; both have admitted controls using authenticated helper context | New file: `test/gateway/gateway-admin-consumers.test.ts`, actual action/page module invocation with scoped verdict/session/DB seams; actual authority proved by AC-09/12 |

Implementation acceptance matrix must add actual implementation paths, test names and pass/fail/unverified evidence for each ID. No criterion is satisfied merely by a test file existing. Tests of parser failures or feature-disabled 404 alone cannot prove gateway authentication. Runtime tests must substantiate registered wrapper owners (especially real resolveChatOwner session/active/same-team behavior), not only mock a wrapper into refusal. The explicit wrapper evidence table below is an AC-04/06/07/08/13 build obligation; registry paths alone do not satisfy it. Wire tests use generated fixture identities, local DB and synthetic credentials only; use existing HTTP setup, never live model/provider calls or production transcripts. Match carrier conditions explicitly: enabled gateway run uses `npm run test:http:gateway-approval` (or current supported equivalent), because default tests can skip enabled cases. Existing `.github/workflows/ci.yml` already runs `npm run test:http:gateway-approval` sequentially after ordinary HTTP, so no CI amendment is expected; verify new test is selected by that carrier. A unit test for the scanner is sufficient to gate future discovery; a full live request across all 66 protected methods is not required for this bounded ticket.

## Ownership, rollout, recovery and scope

Source of truth: actual route exports determine inventory; named auth modules determine credential authority; explicit membership determines admin posture; exception reasons are checked-in test policy. No route list inferred from ARCHITECTURE or ticket counts. Inventory never prints credentials, DB rows, headers or session material. Diagnostics contain paths/methods/registered symbols only. Route content is parsed as source, not executed by the scanner.

New/changed files: test/guards checker + api-route-auth test; focused handler unit tests as necessary; `lib/gateway/admin-persistence.ts`; gateway real-PG authorization fixture/tests; enabled HTTP carrier and focused route-auth wire tests; new file: `docs/design/aio1208-route-auth-inventory.md`; concise `docs/ARCHITECTURE.md` auth inventory/admin-posture note; `docs/design/pret4-tier-wall-teardown.md` §3.3 amendment and sanctioned-consumer list; `test/guards/tier-no-access-reads.test.ts` remove now-unused module exemption; minimal CI wiring only if needed. Actual registry may live in the test helper rather than a redundant external manifest. No dependencies, schema, SQL migration, data backfill, route wire redesign or middleware auth consolidation. Audit enabled HTTP admin seeding, scripts/e2e.sh and scripts/seed-demo.ts for deliberate everyone enrollment; seed-demo already calls writeInviteDefaultMembership and e2e uses that seed. Update only relevant deficient fixtures, not these scripts without evidence of a missing prerequisite. No RLS, conversation changes, token write expansion, bootstrap convergence/materialization work, or changes to separately owned PR739/738 behavior. Migration-number reservation is unnecessary because no migration is proposed.

Read installed Next 16.3 docs (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`) before any route changes: HTTP exports are method handlers, dynamic params remain Promise values, GET defaults dynamic; preserve runtime, disabled response and no-store policy. The spec author read the identical installed route guide in both the previous and fresh staging checkout; builder must read its fresh checkout's installed docs too. Do not export test helpers from route files; tests use existing library seams.

Sequence: (1) freeze/reconcile inventory and record twelve-route audit; (2) implement checker/manifest and adversarial fixtures, show base failing stale-posture case; (3) narrowly correct gateway guard and adjust legacy-tier-only fixtures; (4) complete priority runtime and wire denial coverage; (5) run appropriate checks and fill matrix; (6) obtain required independent Opus and Astra review on stable snapshot; (7) publish feature PR to staging under workflow. Permissioning/authorization change triggers Astra design and final code checkpoint. The new policy amendment superseding only the browser-helper portion of the old file exemption is explicit; no product choice remains unresolved in this draft; independent reviewers must challenge the authority-source inference and scanner limitations before acceptance.

Rollout has no schema step and is compatible with stored data. A gateway admin with everyone membership but stale legacyexternal is now admitted to browser administration while gateway subject_tier selectors retain their existing external evaluation; the two semantics are deliberately distinct. An admin lacking everyone membership loses gateway administration per the AIO-1208 amendment; deliberate membership enrollment restores eligibility, not raw tier edits. Conversely an enrolled admin is no longer blocked by stale legacyexternal. Release notes state this bounded authorization correction; do not silently repair production memberships. Errors remain fixed/non-sensitive. Normal schema replay/mirror lanes may run as repository required but are not claimed to verify this change.

Rollback: reverting scanner/tests removes the preventive CI gate; reverting only the helper restores the browser legacy-tier authorization behavior superseded by the AIO-1208 amendment and must not be called security-safe. Prefer a forward fix if policy verification regresses; if emergency rollback is authorized, separately disable gateway through its existing feature flag until reviewed guard is restored. Rollback does not revoke credentials or change memberships. Feature flags/deployment mutations are outside this build authorization. Preserve durable checkpoints and reviewed spec/matrix/review identities per repository workflow; coordinator alone commits/pushes/opens PR.


## Build-with

Build-with: Opus 5.5, high effort, through subscription-authenticated Claude CLI under the selected Astra Spec Claude Build workflow. The route-method inventory is bounded but the gateway authority correction changes a high-privilege permission boundary; required independent Opus and Astra checkpoints remain.

## Explicit exclusions and authentication protocols

This guarantees coverage of every App Router route-file handler in this repository, not every possible HTTP endpoint. Server Actions are separate public POST endpoints; their general inventory remains outside this ticket. The two known non-route consumers of the changed helper receive the bounded integration coverage in AC-14. A read-only TypeScript directive scan of app/lib/components/scripts found **20 use-server directives in 20 source files**, all module-level action files. Include their explicit paths in the durable document (the implementation can rederive the same list). No inline directive was found.

Current Server Action files (excluded from this guarantee):

- `app/actions/account.ts`
- `app/actions/decisions.ts`
- `app/actions/meeting-todos.ts`
- `app/actions/projects.ts`
- `app/actions/tasks.ts`
- `app/auth/welcome/actions.ts`
- `app/t/[team]/admin/access/actions.ts`
- `app/t/[team]/admin/actions.ts`
- `app/t/[team]/admin/agents/actions.ts`
- `app/t/[team]/admin/approvals/actions.ts`
- `app/t/[team]/admin/attribution/actions.ts`
- `app/t/[team]/admin/brand/actions.ts`
- `app/t/[team]/admin/integrations/actions.ts`
- `app/t/[team]/admin/members/actions.ts`
- `app/t/[team]/admin/pm-sync/actions.ts`
- `app/t/[team]/admin/policies/actions.ts`
- `app/t/[team]/codebases/[slug]/actions.ts`
- `app/t/[team]/meetings/actions.ts`
- `app/t/[team]/people/[handle]/actions.ts`
- `app/t/[team]/social/actions.ts`
 Preserve that exclusion in docs/ARCHITECTURE and the PR; do not imply general action coverage. Follow-up [AIO-1217 — Prove authentication and authorization guards for Team Brain Server Actions](https://linear.app/je4light/issue/AIO-1217/prove-authentication-and-authorization-guards-for-team-brain-server) is verified High priority / Backlog with a native related relation to AIO-1208. The current AIO-1208 slice tests the two known non-route consumers of its changed helper as specified below; it does not undertake that general action inventory.

Do not adopt a new auth identity policy while filling protocol tests. loginWithPassword already refuses when the email has no non-disabled membership; a single-team/all-disabled fixture therefore gets no cookie. redeemMagicToken intentionally verifies an email credential and can create an auth identity despite a disabled team membership: linkMemberByEmail excludes disabled rows, and protected team helpers reject inactive membership. Do not newly forbid the identity cookie for a still-valid magic token because the ticket does not choose that behavior and a person can belong to other teams. Test token expiry/replay/no-cookie and verify disabled rows remain disabled and receive no protected team/admin access if extending this journey.

The bound-query failure test must be sensitive to using the wrong connection: use the optional injected TransactionCapableDbClient with PgClient decorateSessionExecutor. Observe bound SQL against teams, then members, then group_members in that order; inactive member produces zero group_members statements. Fail only the bound group_members read and assert it was exercised; an unbound client that bypasses that fault must make the test fail. Include generic500/no-dispatch proof through gatewayAdminContext. Separately mock resolveViewerPosture to reject in an actual helper/HTTP-wrapper unit test if needed for easy error response assertions; mere resolver-call assertions are insufficient.

## Itemized acceptance criteria

- **AC-01:** Every current App Router route file and exported HTTP method is classified; baseline is 63/72; discovery includes /auth and untracked source. Non-ts Next route files and alternate routing trees fail rather than disappear; future guarded additions also require explicit registry classification.
- **AC-02:** New unguarded route or new unguarded POST on a guarded GET file fails, naming exact path/method.
- **AC-03:** Removing a real guard call fails even if import/comment/string/unused top-level or nested helper retains its name; a same-spelled local function does not count; supported named import alias really called passes; removed authorization co-guard or delegated branch guard fails the exact expected set.
- **AC-04:** Called `resolveAdminTeam` is followed to its real session guard; removing that inner guard fails both GET and POST. `governedActionHttp.status`/submit and metadata wrapper require actual approved calls, not imports. The metadata owner must return401 for absent/wrong token and valid token+commit success, so registration is not a substitute for protocol proof.
- **AC-05:** Public exceptions require exact file/method, reason and existing evidence; stale file/method, new method, empty reason, duplicate entry and stale evidence fail.
- **AC-06:** Named dashboard conversation GET/PATCH/DELETE and run GET refuse without a resolved owner before calling store/run operations; authorized calls keep authenticated owner pair.
- **AC-07:** Governed action status and submit wrappers refuse invalid/missing API authentication before invoking status/submit service.
- **AC-08:** All nine enabled gateway admin methods return guard refusal unchanged, and invoke no privileged persistence on 401/403/404/422/500; disabled routes retain inert 404.
- **AC-09:** Shared gateway authority follows actual everyone membership: legacyteam/noeveryone active admin refuses422; legacyexternal/witheveryone active admin succeeds. Member/lead with everyone refuse403, without everyone refuse422 (precedence). Inactive admin with everyone refuses422 before posture read; foreign-team everyone membership cannot grant local posture; foreign/unknown remain404.
- **AC-10:** Next request after committed everyone removal refuses; injected factory observes teams→members→group_members on one connection (inactive has no posture read); bound posture failure produces generic500/no dispatch and cannot fall back to legacy tier or unbound client.
- **AC-11:** Login/confirm/Slack/health/dev-login exceptions preserve their actual credential/protocol boundaries and success control cases, no leaked session/secret on credential refusal. Slack callback tamper/expiry/replay explicitly makes zero provider fetch and zero secret write calls. Magic confirm expired/replayed tokens set no cookie. Password login where all email memberships are disabled returns401/no cookie. Public health no-token returns exact {ok,commit}; wrong-token returns401 exact {ok:false}, never detailed state.
- **AC-12:** Enabled gateway wire verifies all nine admin methods reject anonymous valid path requests401 before malformed-body parsing; disabled carrier still404; named dashboard/action guard routes return their documented anonymous refusal.
- **AC-13:** Correct unit/integration CI lanes execute new tests; lint/typecheck/docs and existing tier-consumer guard pass with narrowed PRET-4 exemption; registry failure is build-failing, not silently skipped.

- **AC-14 (new in v3):** Test actual managed approval action and approvals-page consumers of the changed helper for refusal/no privileged dispatch and admitted controls as defined in the direct-consumer section.

## Full current route/method audit inventory

The following audit is source-derived; maintain future coverage from discovery rather than hardcoding these counts. Guards named here describe actual calls/owner wrappers inspected in the draft, and do not claim a preexisting checker had proven them.

| Path | Explicit methods | Current guard/protocol |
|---|---|---|
| `app/api/auth/login/route.ts` | POST | Public password protocol |
| `app/api/auth/request-magic-link/route.ts` | POST | Public email delivery request |
| `app/api/auth/slack/callback/route.ts` | GET | Public signed single-use OAuth state |
| `app/api/auth/slack/start/route.ts` | GET | authenticateApiKey |
| `app/api/auth/slack/status/route.ts` | GET | authenticateApiKey |
| `app/api/brain/arcs/recompute/route.ts` | POST | getSessionUser + active same-team member resolution |
| `app/api/brain/arcs/route.ts` | POST | getSessionUser + active same-team member resolution |
| `app/api/brain/events/route.ts` | GET | getSessionUser + active same-team member resolution |
| `app/api/brain/facts/route.ts` | GET | getSessionUser + active same-team member resolution |
| `app/api/dashboard/access/inspect/route.ts` | GET, POST | called local resolveAdminTeam → getSessionUser + canAccessAdmin |
| `app/api/dashboard/conversations/[id]/route.ts` | GET, PATCH, DELETE | resolveChatOwner |
| `app/api/dashboard/conversations/[id]/run/route.ts` | GET | resolveChatOwner |
| `app/api/dashboard/conversations/route.ts` | GET | resolveChatOwner |
| `app/api/dashboard/query/route.ts` | POST | getSessionUser + active same-team member resolution |
| `app/api/dashboard/social/media/[id]/route.ts` | GET | currentMember + canAccessAdmin |
| `app/api/dashboard/team-work/route.ts` | GET | getSessionUser + active same-team member resolution |
| `app/api/dashboard/timeline/route.ts` | GET | getSessionUser + active same-team member resolution |
| `app/api/health/route.ts` | GET | Public readiness; authenticated detail |
| `app/api/internal/executor-gateway/v1/admin/[teamSlug]/approvals/[approvalId]/decision/route.ts` | POST | gatewayAdminContext (9 total admin operations) |
| `app/api/internal/executor-gateway/v1/admin/[teamSlug]/approvals/route.ts` | GET | gatewayAdminContext (9 total admin operations) |
| `app/api/internal/executor-gateway/v1/admin/[teamSlug]/policies/[policyId]/route.ts` | PATCH, DELETE | gatewayAdminContext (9 total admin operations) |
| `app/api/internal/executor-gateway/v1/admin/[teamSlug]/policies/route.ts` | GET, POST | gatewayAdminContext (9 total admin operations) |
| `app/api/internal/executor-gateway/v1/admin/[teamSlug]/service-identities/[serviceIdentityId]/credentials/[credentialId]/revoke/route.ts` | POST | gatewayAdminContext (9 total admin operations) |
| `app/api/internal/executor-gateway/v1/admin/[teamSlug]/service-identities/[serviceIdentityId]/credentials/route.ts` | GET, POST | gatewayAdminContext (9 total admin operations) |
| `app/api/internal/executor-gateway/v1/authorize-and-redeem/route.ts` | POST | authenticateGatewayRequest |
| `app/api/internal/executor-gateway/v1/executions/[executionId]/resume-claim/route.ts` | POST | authenticateGatewayRequest |
| `app/api/internal/executor-gateway/v1/record-outcome/route.ts` | POST | authenticateGatewayRequest |
| `app/api/internal/executor-gateway/v1/resolve-lease/route.ts` | POST | authenticateGatewayRequest |
| `app/api/internal/llm/v1/chat/completions/route.ts` | POST | authorizeGraphProxy |
| `app/api/internal/llm/v1/embeddings/route.ts` | POST | authorizeGraphProxy |
| `app/api/internal/staging-build-metadata/route.ts` | GET | stagingBuildMetadataResponse → service-token check |
| `app/api/v1/actions/[action_id]/route.ts` | GET | governedActionHttp.status → authenticateApiKey |
| `app/api/v1/actions/route.ts` | POST | authenticateApiKey |
| `app/api/v1/actions/submit/route.ts` | POST | governedActionHttp.submit → authenticateApiKey |
| `app/api/v1/attribution/route.ts` | GET | authenticateApiKey |
| `app/api/v1/codebases/[slug]/debt-intake-events/route.ts` | POST | authenticateApiKey |
| `app/api/v1/codebases/route.ts` | POST | authenticateApiKey |
| `app/api/v1/company-graph/route.ts` | GET | authenticateApiKey |
| `app/api/v1/conversations/[id]/route.ts` | GET | authenticateApiKey |
| `app/api/v1/conversations/route.ts` | GET | authenticateApiKey |
| `app/api/v1/costs/route.ts` | POST | authenticateApiKey |
| `app/api/v1/decisions/route.ts` | GET | authenticateApiKey |
| `app/api/v1/evidence/search/route.ts` | POST | authenticateApiKey / authenticateAgentToken credential branches |
| `app/api/v1/graph-query/route.ts` | POST | authenticateApiKey |
| `app/api/v1/identities/resolve/route.ts` | GET | authenticateApiKey |
| `app/api/v1/integrations/route.ts` | GET | authenticateApiKey |
| `app/api/v1/items/[id]/route.ts` | GET | authenticateApiKey |
| `app/api/v1/items/route.ts` | POST, GET | authenticateApiKey / authenticateAgentToken credential branches |
| `app/api/v1/me/route.ts` | GET | authenticateApiKey |
| `app/api/v1/me/slack-token/route.ts` | GET, POST, DELETE | authenticateApiKey |
| `app/api/v1/members/invite/route.ts` | POST | authenticateApiKey |
| `app/api/v1/members/route.ts` | GET | authenticateApiKey |
| `app/api/v1/metrics/route.ts` | POST | authenticateApiKey |
| `app/api/v1/okf-bundle/route.ts` | GET | authenticateApiKey |
| `app/api/v1/pm-sync/health/route.ts` | GET | authenticateApiKey |
| `app/api/v1/projects/route.ts` | GET | authenticateApiKey |
| `app/api/v1/query/route.ts` | POST | authenticateApiKey / authenticateAgentToken credential branches |
| `app/api/v1/subscriptions/route.ts` | POST | authenticateApiKey |
| `app/api/v1/tasks/route.ts` | GET | authenticateApiKey |
| `app/api/v1/timeline/route.ts` | GET | authenticateApiKey |
| `app/api/v1/work-events/route.ts` | POST | authenticateApiKey |
| `app/auth/confirm/route.ts` | GET | Public single-use magic token |
| `app/auth/dev-login/route.ts` | GET | Public local opt-in protocol; production hard-off |
