# AIO-1217 — complete successor v11, round 2: bounded CI contracts

Status: **UNACCEPTED PROPOSAL; NOT READY; NO BUILDER ADMISSION.** Sole specification author: fresh `gpt-6-astra`, MEDIUM. This document is neither a review nor an attestation. It specifies a bounded CI repair while preserving the complete accepted application contract. Its existence cannot accept its own requirements or attest their implementation.

## 1. Authority, scope, hierarchy and exact snapshot

The sole current write is completion of this retained v11 file. Accepted v9 and unaccepted v10 remain byte-for-byte unchanged. No implementation, tests, scanner, CDC sweep, network operation, Linear write, Git write or worker dispatch belongs to this author stage. The parent owns hash computation, one-file-delta verification and any subsequently qualified documentation checkpoint.

The frozen v11 input manifest incorporates the entire v10 author manifest: 43 fixed inputs, 325 lexical candidate identities and 678 app/lib/scripts source identities, plus 28 round-2 inputs. These are exact evidence identities, not a semantic safety census. `W` means the supplied task worktree and `H` its durable sibling handoff. Evidence names below are relative references within those frozen packets; no private scanner report or private model stream is a source.

Original v11-author launch HEAD was `9753e94d86e8eaf2164976d6edd5222fdf8ea7c5`, adding only unaccepted v10 above remote `813f61c395fef73c236de9804598f40ab497bbce`. Recovery starts from verified clean local HEAD `f757d7582d001e08fd94056f3a6fc43178337d27`, whose sole additional task change is the retained partial v11 (SHA-256 `8342ce7d538364929ba540f4eb05b919aed2a7cf14334d006767e775f92dceba`, 397800 bytes, 2074 lines). The prior author thread `01a110d6-109b-73e3-9363-3d641e779a9d` ended `turn.failed` on a provider usage limit, was reaped and emitted no completion marker; that run remains incomplete. This recovery continues its valid draft, not a new predecessor-based rewrite. The sanitized interruption and local-checkpoint records establish lifecycle/scope only. Recorded remote remains `813f61c395fef73c236de9804598f40ab497bbce`, staging remains `c5e832c2ff179ee5c99f95966fba1ed9ce77ae3e`, and PR 744 remains draft in the preserved readback; recovery performs no network readback. No unit/scanner/CDC result attests `9753e94...`, the partial-v11 checkpoint or final v11 bytes. All supplied executed results labelled `813f61c...` remain evidence of that snapshot only.

The remote checkpoint deadline `2026-10-06T09:36:31.465516Z` is overdue and unreset. A readback of the older remote does not reset it. This author grants no push authorization, cadence reset or attestation. The parent must preserve that debt until a qualifying remotely verified checkpoint under normal controls actually exists.

Accepted v9: SHA-256 `0a19ddf87f9247d960cd5ed0247e14962963df3f99ae3c4b1a1546cd4342985f`, 203946 bytes; native attachment `bba1ee93-a5e2-4a09-8289-528b6aa0e46c`. Unaccepted v10: SHA-256 `4570e5cbb3b1b008697d5e49c0787cf169aec695f3682c40431c91bdbff1133e`, 187114 bytes. V10 is historical proposal evidence, never an accepted permission expansion.

Precedence for this successor is: current explicit task constraints; the fresh Astra HIGH decision `NARROW_EXISTING_GUARD_CONTRACT_ADMISSIBLE` for Contract A; this complete v11 proposal for the stated B/C amendments and renewed gates, subject to independent acceptance; accepted v9 for every unchanged application requirement; source and executed receipts for current facts; older proposals/reviews as qualified historical evidence. The fresh scope decision materially supersedes the earlier Astra material-revision decision's expanded Contract A. It does not invalidate the H1/H2 counterexamples against v10 or accept Contracts B/C. The full normative finite contract and its controls are reproduced below, and every §6 amendment is reproduced as a traceability table in Appendix D.

Appendix A reproduces the complete v9 text, including its complete Appendix, without abbreviation. That is exact content incorporation, not a summary that loses F4. V11's expressly enumerated supersessions take precedence over affected historical future-version references, the false CDC universal envelope and the new CI contract; no other v9 requirement is weakened. Historical status words inside reproduced predecessor evidence do not become current v11 status. There remain exactly AC-01 through AC-14.

**Reference namespaces.** Unqualified section references outside incorporated quotations mean v11 §§1–10 and its Appendices A–E. Inside the exact v9 body in Appendix A, references retain v9's namespace; its nested immutable v6 body retains v6's namespace and original path context. Inside the reproduced Astra decision in §4 and Appendix D, numbered decision sections refer to that named decision; the left column of Appendix D refers to preserved v10. Thus v10 §§10–12 and Appendix B.3 are predecessor references, not missing v11 sections. Historical source line numbers identify the frozen artifact, not this expanded document. The nineteen `Criterion N` headings are Appendix E's documentation-edit keys. No scanner occurrence ordinal is introduced. Closing v11 §8 contains dispositions/ACs, §9 implementation and verification, and §10 remaining gates.

## 2. Preserved outcome, data ownership, invariants and exclusions

The application goal remains fail-closed authorization at the actual executing Server Action boundary, with identity-derived tenant/actor context, stable refusal conventions, honest client-ID binding and protected effects behind the correct guard. Complete discovery, action registration, runtime denials, paired REDs, production owner semantics, caller/wire compatibility and the complete F4 approval state machine remain required exactly as reproduced in Appendix A. This section is an orientation, not a substitute for that operational contract.

F4 keeps team/id/expected-state-bound transitions and completions, checked returned errors and affected rows, pending-only atomic claim, consistent forward/reverse/terminal links, producer readiness and deliberate competing-request outcomes. Governed execution never falls back into legacy dispatch. Post-claim preparation or deny failure retains the human decision with no dispatch. Completion persistence failure after handler execution is uncertain completion, not permission to write a second failure, claim success, replay, compensate or promise exactly-once external effects. Sanitized fixed errors and allowlisted phase/actionId/actual-dispatch fields remain the only new fault diagnostics. No payload/SQL/driver-error disclosure is allowed. Pure sandbox-factory construction is distinct from sandbox allocation/run. Existing route-500 behavior and lack of client retry/idempotency guarantees remain explicit.

The six table-specific write owners are unchanged: `groups`, `group_members`, `project_groups` belong to `lib/access/groups.ts`; `agent_tokens` to `lib/access/agent-tokens.ts`; `project_context_units` to `lib/projects/context/units.ts`; `project_context_memberships` to `lib/projects/context/memberships.ts`. This finite development detector does not supply transaction isolation or runtime authorization. Owning one table does not confer ownership of another. Neither fixture status nor a green lexical check creates authority.

This slice changes only future development checks, reviewed value-free reconciliation metadata and the specified documentation claims. It changes no application route, identity, runtime guard, access oracle, token policy, membership policy, SQL owner, database schema, CDC production algorithm/config, document inclusion or production data. No UI, Server Action transport, live provider, concurrency or revocation guarantee follows from these CI changes. Runtime work still owed under v9 remains separately blocked until its own evidence and ownership gates are met.

## 3. Current evidence and qualification ledger

The original Opus v10 review has substantive 2 HIGH, 8 MEDIUM and 6 LOW findings but is formally unqualified: its lifecycle recorded a historical read denial. Exit zero did not make success true. The denied workflow inspection and original attestation cannot be retroactively repaired. The fresh coverage follow-up inspected the missing workflow coverage; it repairs that coverage only. Fresh independent H1 and H2 skeptics each concluded FINDING STANDS. The three-stage repair batch completed with workers reaped and input postverification, zero new denial, no push allowance and no clock reset. The separate Astra HIGH scope decision supplies a narrower policy, not a clean v10 review.

All prior inspection qualifications persist. The Astra scope reviewer read a finite source set, inspected schema only in relevant ranges and by targeted searches, and did not semantically inspect all 325/678 files. Its census/index digest inspection was partly sampled. Referenced execution logs were not independently read. The original review, repair and skeptics remain limited to their declared supplied source/evidence scopes; none ran the absent production, scanner, CDC, live-provider or wire checks, and none converts a generic helper into a proved SQL closure. Full byte/hash verification by this author is distinct from exhaustive semantic interpretation. The frozen closures were read for identity and relevant source was reinspected; no whole-source semantic proof is claimed. The exact originating inspection ledgers and NOT VERIFIED statements remain controlling qualifications, not erased by incorporation.

The bounded `813f61c...` diagnostic observed selected current CDC unit checks at 52 pass / 2 fail versus staging 54 pass; current direct document inventory 158 and eligible append corpus 91 documents / 1820 samples versus staging 155 direct and 88 / 1760. The old sweep's exit zero did not gate the legacy envelope or every tail-locality report. These are historical measurements, not v11 baseline values. The accepted v9 quiet-66 witness remains CDC 2 / legacy 0 / gap 2. The present CI/Codacy failures, affected-review qualifications and diagnostic scope remain unresolved; none is relabelled green by changing the specification.

AIO-1230 was created exactly once, routed as a child of AIO-1217, assigned to Chetan in Backlog, and read back successfully. The requested description was 4060 bytes and the stored description 4059: 16 line-leading list hyphens became asterisks and the final LF was removed; all other bytes agree and the installed `verify-desc` normalization accepted the content. This is routine serialization normalization, not a need to recreate or mutate the issue. The earlier diagnostic's pending-normalization state is superseded by that verified result. No private stored description or private URL is reproduced. Routing is not owner agreement, accepted deferral, implementation admission or safety certification.

## 4. Contract A — exact narrow existing guard

The following reproduced §§4–5 of the fresh Astra HIGH scope decision are the normative detector and production-entry control requirements for v11. They replace v10 §§4.1–4.5 in full. Any reference to a successor in that text means this proposed v11; any requirement described as future remains unimplemented. The evidence channel boundaries are intentional: only the coarse channel is comment-masked. No generalized SQL interpreter or expanded source closure is implicit.

**4. Complete normative Contract-A contract**

The successor must specify the following finite contract.

**Protected tables and ownership**

| Table | Sole application writer |
|---|---|
| `groups`, `group_members`, `project_groups` | `lib/access/groups.ts` |
| `agent_tokens` | `lib/access/agent-tokens.ts` |
| `project_context_units` | `lib/projects/context/units.ts` |
| `project_context_memberships` | `lib/projects/context/memberships.ts` |

Ownership is a table-specific permission within this detector. A groups owner gains no token/substrate authority. Replace the current early whole-file owner skip with table-specific comparisons. This is a bounded enforcement correction to the existing map, not permission for new runtime edits or generic provenance analysis.

**Inventory and entry point**

- Recursively inspect the existing `app`, `lib`, `scripts` roots for `.ts`, `.tsx`, `.mjs`; inspect `postgres/**/*.sql` for the existing SQL guard.
- Do not silently import v10’s eight-extension expansion or call the 678-file index the narrow scanner’s semantic coverage.
- Include owners, read-exempt files and script fixtures. No test-name exclusion.
- Missing roots, unreadable files, path escapes, ambiguous paths, unsupported filesystem entries and symlinks must produce an inventory failure rather than an empty successful scan.
- The implementation exercised by the existing production guard test and CI must be the implementation exercised by mutation controls. A helper-only demonstration is insufficient.

**Evidence channels**

1. **Static `.from(...)` detection:** preserve the current exact quoted-table matching and write-verb window on original source bytes. Preserve all six tables and `insert`, `upsert`, `update`, `delete`. Describe its 200-character boundary honestly; it is not receiver/dataflow proof.
2. **Coarse fallback:** preserve the existing quoted-name-plus-write-verb test for `group_members`, `project_groups`, `agent_tokens` and both substrate tables. Continue excluding ambiguous `groups` from this fallback.
3. **Only the coarse fallback receives comment-masked input.** Use the existing locked TypeScript parser with the appropriate source kind. Identify actual syntactic JS/TS comments, including comments inside template expressions. Replace their non-line-ending characters with position-preserving whitespace.
4. Preserve every non-comment byte: ordinary strings, template quasis, interpolation expressions, tagged templates, regex literals and executable SQL evidence. Do not print/re-emit an AST and accidentally normalize literals.
5. Parse failure or uncertain comment boundaries fail closed. Do not fall back to regex stripping.
6. **Raw substrate detection:** retain the existing case-insensitive `INSERT INTO`, `UPDATE`, `DELETE FROM`, optional `public.` matching for both substrate tables on original source. Preserve ordinary-string, indented-template and tagged-template evidence.
7. **PostgreSQL-file detection:** retain the existing DML protection for `groups`, `group_members`, `project_groups`, `agent_tokens`, `project_context_memberships`. Adding `project_context_units` to that SQL-file set is deferred expansion, not an existing guarantee.

This deliberately preserves conservative lexical behavior. It does not promise that every inert SQL example becomes green. A comment containing recognizable raw substrate SQL can still trigger the unchanged raw channel.

**Existing exceptions and authority**

Retain only the four existing **coarse-channel** read exceptions:

- `memberships.ts:project_groups`
- `memberships.ts:project_context_units`
- `enforce.ts:project_context_memberships`
- `enforce.ts:project_context_units`

They never suppress static-chain or raw-SQL detection. Bind their eligibility to the reviewed source identities in this packet; changed bytes require renewed review rather than automatic grandfathering.

Retain the existing `fake-supabase.ts` raw-substrate exception only for its frozen reviewed artifact. It is a compatibility exception for the inspected in-memory SQL recognizer, not database-write authority. Changed bytes invalidate that eligibility. No new path, filename pattern or fixture class inherits it.

Do not add authority records for the five edge writes under Path N. They remain outside the JavaScript raw-edge detector’s coverage and have **no newly adjudicated exemption**.

**Frozen materializer**

- Only the complete reviewed `materialize_builtin_membership_once()` definition from the manifest’s `postgres/schema.sql` may receive the historical body exception.
- Bind the exception to the exact path and frozen definition bytes, including signature and body. The successor must include the reference span/bytes or an identity-bound fixture copied from that artifact; the implementation must not approve whatever definition it discovers at runtime.
- A changed, missing, duplicate or relocated definition fails. A matching function name alone is insufficient.
- Mask only that verified definition body for the existing outside-body SQL scan. Scan preceding/following text and every other function and migration normally.
- Preserve the migration’s executable call, permissive-fleet refusal ordering and call-before-column-drop ordering. Comment text cannot substitute for the call.
- Preserve the sole-definition check across `postgres`.
- A small dollar-tag extraction example may remain a boundary test; it must not count as production authorization for a different body.

These are finite frozen-definition and required-call controls. They do **not** establish whole-repository closure over indirect SQL function invocations, SQL loaders or `.rpc`.

**Fail-closed and stale behavior**

Recognized unauthorized writes, inventory/parser errors, missing required controls and stale exception/materializer identities fail. Expected owner writes, token caller wiring and oracle restrictions remain non-vacuous.

There is no new abstract `Unknown` domain. Targets and SQL effects outside the named lexical channels are **not verified**, rather than resolved safe. Examples include computed identifiers, cross-module target construction and raw edge SQL in JavaScript.

No application owner, reader, seed/proof script, schema or migration change is authorized by this guard contract. Future evidence must identify its actual source snapshot; existing results do not attest a changed successor or implementation.

**5. Mandatory production-entry controls and identities**

Every control must traverse the same inventory, parsing, exception and violation-reporting path used by CI. Isolated fixtures or filesystem overlays must preserve repository-relative paths. Capture actual fixture bytes, hashes, mutation coordinates, entry command, result and diagnostic. Never execute injected database code.

| Control | Required result |
|---|---|
| Unmodified frozen `enforce.ts`, including original comments and crypto `.update` | Pass Contract A |
| Line/block/JSDoc table-name comments plus crypto `.update` | Pass coarse channel |
| Comment containing `.update` plus executable quoted table name | Comment does not supply the coarse write verb |
| Same quoted table name moved from comment into executable ordinary string, paired with `.from(table).insert(...)` | Fail outside owner |
| Equivalent executable backtick literal | Fail outside owner |
| Comment delimiters inside strings, regex literals, template quasis and tagged SQL | Preserved, never stripped as comments |
| Syntactic comment inside `${...}` | Only that comment is masked |
| Static writes to each of six protected tables, each mutation verb | Fail outside its owner |
| Variable-table writes using the five coarse-protected quoted names | Fail outside owner |
| Unauthorized static/raw-substrate injection into each read-exempt file | Fail; exemptions cannot suppress those channels |
| Existing owner writes | Pass; removing their expected write evidence fails non-vacuity |
| Cross-protected-table write injected into an owner file | Fail |
| Raw substrate DML in ordinary strings, indented templates and tagged templates; unqualified and `public.` forms | Fail outside owner |
| Read-only substrate SQL without another matching write signal | Pass |
| Unmodified fake recognizer | Pass its narrowly preserved exception |
| Changed fake recognizer containing an injected real mutation | Fail; stale identity cannot preserve exception |
| Removed mint/revoke/admin wiring | Fail |
| Oracle `.from("items")` or `items.member_id` mutation | Fail |
| Frozen materializer and required migration call | Pass |
| Added DML before/after materializer, inside another function or in a migration | Fail |
| Changed/duplicate/relocated materializer; missing/comment-only/reordered migration call | Fail |
| Missing/unreadable root, syntax error, path/identity failure | Fail |

Include controls demonstrating that removing the coarse channel, stripping all strings or bypassing an owner file causes the control suite to fail. A generic nonzero process exit is insufficient: expected violation categories must distinguish mutation detection from unrelated fixture/parser failures.

The frozen source identities are the manifest identities—not newly computed here. Particularly consequential baselines are:

| Artifact | Manifest SHA-256 |
|---|---|
| Existing guard | `4eb66ef4ba7b2b9cebb859a5eb7113b62edcf2e738d578aa720beddf49bc8806` |
| `enforce.ts` | `751eaa06bfb55a9991a7cd5004e588827a029e3631ae303fed844f2916dea27b` |
| `provenance-sql.ts` | `b01c0884764cf74f49ff529777d5ac0a84a8d50e409851ae0e1f94bd3e39edbf` |
| `memberships.ts` | `42561052cf4c153a1ec227e74d2374958a24218e64c2cc7daf1b1b58c1bd8224` |
| `fake-supabase.ts` | `8f1f69743f8a42ec98b14c9cee75e5d66d31438a6c6f82679267698e5fc7f062` |
| `postgres/schema.sql` | `23c79fcdce11c7dd1171c06d79b9ab3ad80d745a5c7879c3f90837e2490b5eca` |
| Required materializer migration | `7f25361556b438cc3d227e92ba2acfffc2e1d380b6be11ae93b19196d26184b6` |
| Staging-pair fixture | `02f3b2b3ae2e6cf85421b44b55f1663aa0a093df7e6abf676068f2b6e8f2109f` |
| Debt-intake proof | `d7c8c305fc51d1fff85b055096f2123cb11bf2efa79398356f12b1a3c57ae057` |

The owner, token-caller and action-caller fixtures must likewise use their exact manifest identities. Newly created control artifacts need parent-computed identities before their results receive credit.


### 4.1 Consequences, residuals and the two HIGH findings

Unmodified `lib/access/enforce.ts`, including cryptographic `.update`, must pass the actual guard entry path. Its syntactic comments cease supplying coarse quoted-table evidence (and comments cannot supply a coarse write verb either); executable strings and `.update` remain intact. No string erasure, file exemption, generic SQL-fragment safety assertion or whole-owner bypass may explain the pass. The parser must distinguish comment syntax within template expressions from delimiter text in executable string/quasi/regex/tagged-template content. Preserve source positions and line endings; parser uncertainty or failure is a categorized fatal error, never an empty masked file. Use the already locked TypeScript 5.9.3 parser; no dependency/package change is authorized.

The retained static quoted `.from`/write-verb 200-character channel is lexical, not dataflow. Retained raw-substrate SQL detection is lexical, not an SQL semantic theorem. The finite roots/extensions, six-table ownership, four exact coarse-only read exemptions, exact fake recognizer, oracle/token/wiring/non-vacuity and frozen materializer/required-call rules above must each survive through the real entry point. Tests that only call the masker do not qualify. A positive control must assert the intended violation category and relevant path/channel; a parse/setup failure is not a successful detection. Negative controls must establish successful inventory and parsing before asserting no violation.

The five actual raw edge writes remain uncovered residuals without an authority waiver:

| Source | Executable targets and context | V11 disposition |
|---|---|---|
| `scripts/debt-intake-migration-proof.mjs` lines 87–88 in frozen source | Inserts/upserts `groups` (including `is_builtin=true`) and `group_members`; local Docker/random scratch database construction is context, not an owner-policy exemption. | Two real writes outside sole owner; existing raw channel does not detect these edge tables. AIO-1230 routed; NOT VERIFIED owner agreement or accepted deferral. |
| `scripts/staging-ops/staging-pair-fixture.mjs` lines 86, 88, 90 | Inserts `groups`, `group_members`, `project_groups` through supplied pg access; builtin context can use `PROD_DATABASE_URL`, so fixture naming does not establish isolation. | Three real writes outside sole owner; existing guard coverage is absent. Same routed child and unresolved authority limits. |

H1 remains valid against v10: its expansion demanded detection/refusal of those real writes while forbidding the source edits or authority decision needed for a passing tree. V11 withdraws that expanded obligation, retains the real residuals and proves only the admitted existing detector. It does not solve or authorize the writes. H2 remains valid against v10: the six `runSql` sites at frozen `enforce.ts` lines 339, 352, 389, 409, 422, 456 depend on runtime parameter placeholders and nested provenance fragments not covered by v10's finite-string proof rules. V11 withdraws that general abstraction requirement. Passing unchanged enforcement under the finite detector supplies no generic SQL safety certificate.

Deferred and uncredited: generalized `runSql`/`executeSql`/`.rpc`, pg-client/receiver identity, generic helpers and callers, SQL-fragment transfer, dynamic identifiers, function invocation side effects, arbitrary SQL loaders, extra roots (`components`, instrumentation and others) and extra extensions. Unsupported forms beyond the existing finite channels are not newly certified safe. Parser failure in the retained syntactic task still fails closed. The frozen materializer definition and required executable call remain enforced even though general function-call closure is deferred. AIO-1230 creation is the verified separate routing required by AC-11; owner disposition remains a distinct unresolved fact.

### 4.2 Exact frozen materializer reference

The authorized definition is the complete `postgres/schema.sql` lines **2987–3083 inclusive**, from `create or replace function materialize_builtin_membership_once()` through `end $$;`, including its terminating LF. In the frozen 177596-byte schema (SHA-256 `23c79fcdce11c7dd1171c06d79b9ab3ad80d745a5c7879c3f90837e2490b5eca`) that is the zero-based UTF-8 byte interval **[166106, 171748)**: **5642 bytes**, SHA-256 **`488dae3c5d9ad62105a69909ae8eb5027a61ee100d05e8521735672b473e37f7`**. These are source-identity measurements only, not an executed guard or SQL result. Copy this exact span into the allowed guard implementation as its frozen reference; no additional committed fixture path is authorized. Validate signature and complete definition against that reference before masking only its body. A current-source extraction must never become its own approval. Definition absence, change, duplication or relocation fails; scan all outside bytes and other SQL normally.

The required migration is exactly `postgres/migrations/20260818210000_pret6_retire_access_enforcement.sql`, **1924 bytes**, SHA-256 `7f25361556b438cc3d227e92ba2acfffc2e1d380b6be11ae93b19196d26184b6`. Preserve the actual executable `perform materialize_builtin_membership_once();` after the permissive-fleet refusal and before `alter table teams drop column access_enforcement;`, plus the sole-definition check. Its original full source is the reference, not a name-only or comment-only match. Future production-entry controls still must prove each required failure category; these frozen identities earn no such execution credit.

## 5. Contract B — pinned Linux scanner and exact occurrence reconciliation

### 5.1 Preservation and evidence identity

Preserve every original committed archive, test and specification byte. No evidence encoding, relocation, deletion, broad directory/test/archive allowlist, `.gitleaksignore`, baseline suppression, inline allow marker, rule weakening, `|| true` or unconditional `continue-on-error` is authorized. `.gitleaks.toml` remains SHA-256 `79a28348f99acf97a60274feaa31fa7fc72edd118f5d87623a697c4f17b7aec3`, 1660 bytes, extending the pinned default rules with its existing configuration only. All original scanning remains active. A reconciled reviewed finding is still a finding, never a claim of a zero-finding archive.

Use gitleaks **8.18.4**, official Linux x64 release archive `gitleaks_8.18.4_linux_x64.tar.gz`, downloaded from the versioned official GitHub release URL. Its SHA-256 must be exactly `ba6dbb656933921c775ee5a2d1c13a91046e7952e9d919f9bac4cec61d628e7d` before extraction. Official checksum-file SHA-256: `6f2a2620b5a3e8595a5480d25504040299eaf2189ad30cc1adcbd0ff5dcc4aa0`; tagged default config: `b94aad1d0f105e4d7cb230872461705a4b04a7743c656836144ae6853cb33e1b` (79554 bytes); selected two-rule evidence: `9e9e9cbc6c73086ff3b1f01981bb76ee2daff3a66deaf33decb84433e4d3c487` (20802 bytes). The primary help explicitly supports `--ignore-gitleaks-allow` and `--gitleaks-ignore-path`. No unsupported platform binary or flag is promised.

Future `.github/workflows/ci.yml` job `secret-scan` runs on `ubuntu-24.04`, verifies Linux/x86_64, checks out the exact candidate, and provisions Node 20 using the repository's pinned setup-node action convention. Under a fresh non-symlink `$RUNNER_TEMP/aio1217-gitleaks` directory OUTSIDE the scanned checkout, download the exact versioned archive using failure-on-HTTP-error behavior; verify the hardcoded archive checksum; inspect archive entries against traversal/link entries; extract only the regular `gitleaks` executable to `bin/gitleaks`; verify version 8.18.4 and compute its full binary SHA-256. Record and compare that extracted-binary identity with an independently reviewed provisioning receipt. A verified archive identity is supplied; the extracted executable digest/receipt is still a parent-owned pre-builder fact, not an invented value here. Failed download/checksum/version/platform/extraction/identity check stops before scanning.

Create outside the root a regular empty ignore file and private report/log directory (mode 0700, files 0600). Pin their paths; refuse symlinks and reuse by another run. The wrapper owns its spawn arguments, does not invoke a shell, and strips inherited `GITLEAKS_CONFIG`, `GITLEAKS_CONFIG_TOML`, ignore/baseline/config overrides and other scanner-changing environment overrides. Never read a repository-provided ignore file. The exact scanner invocation, with absolute resolved controlled values, is:

```text
<outside-root>/bin/gitleaks detect --no-git --source <exact-checkout-root> --config <exact-checkout-root>/.gitleaks.toml --redact=100 --no-banner --exit-code 1 --report-format json --report-path <outside-root>/private/report.json --ignore-gitleaks-allow --gitleaks-ignore-path <outside-root>/empty.ignore
```

There is no `--baseline-path`, rule-selection restriction, maximum-target-size bypass, follow-symlinks switch or alternate config. The parent must verify exact no-history completion and supported flag behavior with the actual pinned Linux binary before readiness. Console output is a value-free wrapper receipt; scanner stdout/stderr and report stay private outside the root and are neither uploaded as public artifacts nor printed. Redaction is defense in depth, not authority to expose the raw report. Dispose of private disposable outputs after retained sanitized evidence is safely preserved.

MEDIUM-4 is addressed by separation: ordinary `npm test` runs pure descriptor/reconciliation and parser controls without downloading or requiring gitleaks. The actual binary controls live in `scripts/aio1217-gitleaks-controls.mjs`, explicitly invoked only by provisioned `secret-scan` before the real checkout scan. A `*.test.ts` file must not implicitly require a locally installed scanner. The Linux job runs `node scripts/aio1217-gitleaks-controls.mjs --binary <outside-root>/bin/gitleaks --config <exact-root>/.gitleaks.toml --work-root <outside-root>/controls` and then `node scripts/reconcile-aio1217-gitleaks.mjs --root <exact-root> --binary <outside-root>/bin/gitleaks --work-root <outside-root>/scan`. The wrapper resolves its ledger/index at the exact allowed repository paths. All commands are future implementation interfaces, not executed author evidence.

### 5.2 Versioned public schema and safe coordinates

The committed `scanner-exceptions.v1.json` uses `schemaVersion: 1`, fixed scanner identity (version, release archive SHA-256, reviewed binary SHA-256, config SHA-256, `scanMode: "no-git"`), `occurrences`, and `classificationGroups`. No timestamps/person/commit metadata, private paths, raw `Match`/`Secret`, fingerprints or hashes of matched values belong in this ledger. Its descriptor is exactly:

```text
{ path, artifactSha256, artifactBytes, ruleId,
  startLine, endLine, startColumn, endColumn }
```

Path is canonical repository-relative POSIX spelling, SHA is the complete referenced regular artifact's 64 lowercase hexadecimal SHA-256, bytes is its exact byte size, ruleId is the actual pinned rule identifier, and coordinates are the scanner's full safe coordinates. They are positive safe integers, ordered consistently (end line not before start; same-line end column not before start), within the referenced artifact's scanner coordinate domain. Do not silently reinterpret columns as UTF-16 offsets; validate the pinned scanner's byte/column convention using ASCII, multiline and non-ASCII controls. Scanner coordinate validation is a remaining actual-control gate. Identity includes all descriptor fields and top-level scanner/config/binary binding. Categories and review dispositions are metadata, never descriptor identity.

An absolute scanner `File` is acceptable only after proving containment under the EXACT scanned root, resolving the target to a regular artifact, and proving every path component is non-symlink. Then emit only its relative POSIX path. Reject unknown roots, drive/root aliases, NUL, `..`, escapes, symlinks, nonregular files and duplicate normalized aliases. A relative scanner path must undergo the same root-containment/regular-artifact checks, not just string prefix removal. Do not normalize a path from another checkout merely because its suffix matches. Snapshot artifact bytes before reconciliation and recheck identities afterwards to reject races/stale reads. The parent safely verifies these rules without publishing private absolute paths.

Strict schema parsing rejects duplicate JSON keys, unknown fields, null/NaN/unsafe integers, noncanonical hex, malformed coordinate/rule/path values and identity mismatch. Deterministic ordering is code-point order of path, ruleId, numeric startLine/endLine/startColumn/endColumn, artifactSha256, artifactBytes; no locale-dependent sort and **no ordinal**. Sort order never determines category association. `occurrences` entries contain the descriptor, `classificationAssociation` (`EXACT` or `GROUP_AMBIGUOUS`), a reviewed disposition enum (`APPROVED_NONCREDENTIAL_OCCURRENCE` or `REJECTED`), and for exact singleton association only the reviewed category. An ambiguous member carries no individual category. Approval comments, if present, are fixed value-free rationale codes, not free-form private content. Every accepted occurrence or entire ambiguous descriptor group requires explicit independent review; a scan never authors approvals.

Each group is keyed by `(path, startLine, ruleId)` and binds the finite SET of full descriptors at that base key through exact descriptor references, a count, `categoryCounts` multiset, `perOccurrenceAssociation`, and a reviewed group disposition. Referencing a descriptor means its complete safe tuple, not an invented ordinal. Group counts must equal actual referenced members; no missing/repeated reference or inconsistent singleton category is permitted. Reviewer approval of an ambiguous group means approval of the explicitly enumerated descriptor set and the aggregate classification, not knowledge of a per-coordinate category association. Reconciliation must reject ambiguous DESCRIPTORS; legitimate `GROUP_AMBIGUOUS` category metadata does not make the already-distinct descriptors ambiguous.

### 5.3 Proven projection, ambiguity and one-for-one reconciliation

Only `resume-ci-v11-gitleaks-occurrence-projection-v2.sanitized.json` supplies coordinate evidence (SHA-256 `8546ecafb5155a8600e26928f542f4d35ea4151243aa2ee87cc26b919fc3833a`, 971860 bytes). It proves 1669 local records, 1668 tracked, 13 tracked artifacts, 1668 distinct full-coordinate tuples, zero collisions and no ordinal/private values. The one ignored local scratch record has no public path or coordinates and is NOT a committed exception. Projection from a stored report at the later local snapshot is not a new scanner execution of `9753e94...`.

The first projection is rejected history: equal counts and base-key multisets did not justify zipped input-order association; 1634 alignments disagreed. It supplies no coordinate/category credit. V2 proves exactly 771 singleton base-key associations and 146 duplicate base-key groups containing 897 occurrences. Those 897 individual category associations remain **GROUP_AMBIGUOUS**. Never reconstruct them by input order, sorting, occurrence number, category distribution or invented ordinal.

Safe tracked aggregate categories are exactly 767 source-file SHA maps, one SHA substring, two spec/checkpoint SHAs, 877 synthetic UUIDs, two UUID substrings, 18 synthetic encrypted integration snapshots and one tracked synthetic fault label. The second fault label belongs to the excluded scratch record. These counts are retained as reviewed aggregate evidence and do not override group ambiguity. The finite no-actual-credential classification is not a general theorem about archives, future edits, UUIDs, encrypted payloads or SHA-looking strings. The parent/reviewer must independently confirm value-free provenance and dispositions for the exact approved artifact set; the author does not invent private-value proof.

The wrapper reads the actual pinned scanner report privately, validates its schema, converts only safe descriptor fields, and computes complete artifact identities. Reconcile actual and reviewed descriptor SETS by an exact bijection, with each occurrence consumed once. Equality of totals is insufficient. Fail closed on unmatched/additional/missing entries, duplicate input records, collisions, ambiguous descriptor resolution, stale/wrong artifacts, wrong rules, malformed/truncated JSON, scanner launch/config/report/completion errors, suppression-channel evidence, ledger/index integrity failure or metadata findings. Expected 1668 is a frozen snapshot fact, not a permanent count allowance: new v10/v11/metadata findings would require independent review and an explicitly admitted successor ledger, never an automatic approval update.

Exit zero is accepted only with a well-formed completed zero-finding report AND an empty expected finding set for that particular control root; it cannot erase expected archive findings. Exit one is potentially the configured findings exit only when a valid complete report and independent successful scanner-completion receipt exist; a scanner error that also returns one must fail. Every other exit/signal/error fails. Controls must demonstrate launch failure, bad config, truncated report and findings status are distinguishable. Safe public output reports reconciled counts and status/categories, not raw findings or secrets.

### 5.4 Archive integrity, new metadata and controls

Keep all 148 exact-byte archive entries, five public-receipt substitutions and 33 task-branch source-reference semantics. Stored public receipt bytes are not the original private evidence bytes; source references identify task-branch source rather than pretending those files are archived copies. Preserve README, original `artifact-index.json`, original `publication-manifest.json` and all existing artifacts unchanged. The new `scanner-index.v1.json` is a noncyclic integrity supplement: `schemaVersion:1`, full SHA/size of the new ledger, the two existing indexes and README, scanner identity, and the exact original archive identity relationships. It neither rewrites an old hash nor hashes itself. A separate parent receipt pins the index bytes and reviewer-approved snapshot. Both old archive validation and new ledger validation must pass. Any untracked scratch entry must be rejected from committed approval metadata.

The new ledger/index/guard metadata itself must produce **zero raw scanner findings before reconciliation**. It cannot approve its own hashes or recursively add self-exceptions. If metadata layout triggers a rule, fail and independently review a genuinely value-free schema/layout correction; no encoding of original evidence, scanner allowlisting or circular suppression. Public redaction continues to forbid private matched values, fingerprints, report paths, private absolute paths, credentials and person/commit metadata in the ledger. Public archive receipts retain their existing safe meanings.

Pure tests cover malformed schemas, every tuple field, dup/collision, reorder invariance, artifact change, exact path normalization, symlinks/escapes, stale config/binary, group ambiguity, singleton association, extra/missing findings, metadata self-findings and index corruption. Actual Linux controls construct disposable roots outside the checkout and generate synthetic rule-triggering values privately at runtime, never commit or print them. Exercise both relevant pinned rules (`generic-api-key`, `sentry-access-token`) in ordinary source, archive-like files and files with an otherwise-approved occurrence; adding a new occurrence in an approved file must fail. Exercise an unchanged approved finite finding set that passes, a removed finding that fails missing, inline `gitleaks:allow` that cannot suppress, a supplied `.gitleaksignore` that cannot suppress, attempted baseline/config override that is refused, symlink/escape/unknown-root rejection, actual malformed scanner outcomes and zero-finding metadata. Negative controls fail only for the expected category; unrelated scanner setup failure cannot satisfy them. Primary flag evidence resolves MEDIUM-5's flag uncertainty, while actual pinned behavior remains a required pre-builder verification gate.

## 6. Contract C — unchanged CDC, structural live gate and frozen specimen budgets

### 6.1 Immutable algorithm, corpus and metric

No production edit to `lib/graph/cdc.ts`, `lib/graph/project.ts`, chunk parameters or config is authorized. Keep `cdc1`, UTF-16 boundary coordinates, target 2500 / min 1250 / max 4000 / cap 80 and config `cdc1-2500-1250-4000-80`. Keep direct nonrecursive `.md` discovery in repository root, `docs`, `docs/design`, with the existing >=15000 UTF-16-unit eligibility, and all intended documents, including accepted v9, unaccepted v10, complete v11 and both edited CDC design documents. No editing, relocating or excluding documents to improve the measured outcome. Inventory all candidates and record eligibility even for short documents; reject missing roots, unreadable/nonregular/symlink/duplicate paths. Assert eligible documents >5 and nonzero samples; exact counts belong to each measured snapshot, not this proposal.

The production cost metric is SET-MEMBERSHIP churn: `after.filter(chunk => !new Set(before).has(chunk)).length`. It counts admitted AFTER-array entries absent from the prior content set, not distinct new contents and not indexwise differences. Hash-based measurement must cross-check exact chunk strings in this pure corpus. Positional churn is separately labelled diagnostic evidence; never substitute it for costs. UTF-8 hashes/byte sizes identify artifacts; `.length`, slicing and append lengths use UTF-16 code units. Deterministic reexecution must match arrays, boundaries and all measured fields exactly.

### 6.2 Structural gate and whitespace qualification

For admitted chunk arrays C0,C1 and common equal-content prefix length L, enforce set churn <= max(0, |C1|-L). Tail locality uses UNCAPPED boundary arrays: a boundary whose starting search window is strictly more than `max` before the original end must not move on append. Preserve the one-code-unit surrogate qualification at exactly max. Let LB be their common boundary prefix and derive divergence depth from the old boundary suffix; enforce `depth <= 1 + floor((max-1)/min)`, which is 4 at the fixed defaults, not the observed 2. Report the observed maximum as an observation only. Validate the size envelope independently: nonfinal chunks respect min and max with the exact +1 surrogate adjustment; terminal chunk rules and cap truncation follow unchanged cdc1. Verify admitted arrays against uncapped boundaries and content reconstruction, so mismatched coordinate systems fail.

For a NONBLANK base and append length A, enforce the independently derived absolute ceiling `4 + ceil(A/1250)` in addition to the admitted-array bound and tail locality. A whitespace-only base produces an empty admitted array even though boundary geometry exists; when a nonblank append activates it, preexisting whitespace can become admitted content. For that transition apply the admitted-array bound, size/identity/determinism controls and explicitly qualified boundary diagnostics; do NOT apply the nonblank ceiling as a universal rule. Preserve the 20000-space plus `x` witness yielding six chunks, and refuse any rule that asserts a one-chunk or unconditional nonblank bound there. This qualification is not a blanket whitespace exemption from all validation.

### 6.3 Exact regression fixture schema and function identities

The versioned committed fixture `test/fixtures/cdc-append-regression.v1.json` is nonproduction data, outside the document corpus, independently admitted. It has exactly these top-level fields: `schemaVersion:1`, `metric:"admitted-set-membership-v1"`, `config`, `algorithmBindings`, `recipeDefinitions`, `corpusInventory`, `specimens`, `admissions`. Reject unknown/duplicate keys. Config contains algorithm/min/target/max/cap/unit. Inventory records every candidate `{path,sha256,bytes,utf16Length,eligible}` sorted by canonical POSIX path. A specimen key is the full tuple `(document path, document SHA-256, document bytes, document UTF-16 length, recipe ID, append SHA-256, append UTF-16 length, algorithm-binding-set SHA-256, config)`; path alone or a document title is insufficient.

Each specimen records nonnegative safe integer `beforeAdmitted`, `afterAdmitted`, `commonChunkPrefix`, `commonBoundaryPrefix`, `divergenceDepth`, `cdcChurn`, `legacyProductionChurn`, `legacySweepChurn`, signed integer `gap`, `positionalChurn`, boolean `blankBase`, structural result fields and reviewed ceilings `maxCdcChurn`, `maxGap`. Gap is CDC minus legacy set churn; both legacy implementations must agree exactly on chunk arrays and churn before using either. Ceilings equal the independently admitted measurement, not a guessed padding factor. Review disposition is `ADMITTED` or `REJECTED`, with a value-free decision reference bound by a separate parent review receipt to exact candidate bytes. No per-specimen self-approval or runtime `accept-current` mode. Metadata may identify reviewed artifact hashes; no source content or private corpus text is required.

Function-level bindings are mandatory, not just whole-file hashes. A binding is `{path,symbol,syntaxKind,sourceStart,sourceEnd,sha256,bytes,dependencies}` over the exact UTF-8 bytes of a TypeScript-parser-selected complete declaration (start/end are source UTF-16 offsets; hash bytes are explicit UTF-8). Record parser version 5.9.3, reject duplicate/missing symbols and source span ambiguity, and include exact constant/initializer declarations and transitive boundary-affecting dependencies. Whole-file hashes remain provenance diagnostics, not a reason an unrelated edit silently changes the algorithm identity.

CDC bindings include `chunkCdc`, `cdcBoundaries`, `normalizeParams`, `masksFor`, `avoidSurrogateSplit`, `isHighSurrogate`, `isLowSurrogate`, `splitmix32`, `gear`, `GEAR_SEED`, the single destructuring/IIFE declaration initializing both `GEAR_LO` and `GEAR_HI` and its dependencies, defaults/config arithmetic and any directly used boundary-affecting declaration. The discovery must verify this closure against actual pinned source rather than treat this list as permission to omit a renamed dependency. Bind BOTH `chunkContentLegacy` in `lib/graph/project.ts` and `legacyChunks` in `scripts/cdc-churn-sweep.mjs`, plus effective target/cap and blank-input handling dependencies. The latter is an inlined implementation, not proof of the former. The independent measurement harness extracts/evaluates the actual pure production legacy declaration with explicit constant bindings (no DB/provider initialization), and cross-checks it against actual sweep legacy on every specimen and blank/cap/surrogate edge control. A hand-retyped copy cannot satisfy the production cross-check. Any extraction/dependency ambiguity blocks measurement.

The producer computes these function identities; no function digest or final v11 budget is fabricated here. Frozen whole-file source identities remain in Appendix C, including CDC `0ad3b17c954bfbe0bbfadf7483dbe58c99fe596eac672111dd319bc79895f8b5`, project `06774065ffd60f1fdfa11eb9154102dc799e8ccab1bb6273d52cdb480362ec8c`, sweep `8b89658c873da66224d18a5d033888fb906c49b05249321cb79664fc91176bbc`, and unit `4ae834ec40f229d6f1e2b329401871a31529820e880902f4fad33980a5de7fa9`. These source hashes do not stand in for the outstanding function-level receipt.

### 6.3.1 Closed schema, identity encoding and continuing admission

The following closes the field names/types implied by §6.3; it is schema notation, not measured fixture content. `UInt` is a nonnegative safe integer, `Int` a signed safe integer, `Hash` exactly 64 lowercase hexadecimal characters, and `Path` a canonical regular non-symlink repository-relative POSIX path. Every object rejects unknown/duplicate keys; every array has the ordering and uniqueness rules below. No optional free-form measurement fields are allowed.

```text
Config = { algorithm: "cdc1", min: 1250, target: 2500, max: 4000,
           cap: 80, unit: "UTF-16" }
BindingRef = { path: Path, symbol: string }
Binding = { path: Path, symbol: string, syntaxKind: string,
            sourceStart: UInt, sourceEnd: UInt, sha256: Hash, bytes: UInt,
            dependencies: BindingRef[] }
AlgorithmBindings = { parserVersion: "5.9.3", cdc: Binding[],
                      legacyProduction: Binding[], legacySweep: Binding[],
                      sha256: Hash }
Recipe = { id: string, family: string, length: UInt, definitionVersion: 1,
           generatorBinding: Binding[], appendSha256: Hash }
InventoryEntry = { path: Path, sha256: Hash, bytes: UInt,
                   utf16Length: UInt, eligible: boolean }
SpecimenKey = { path: Path, documentSha256: Hash, documentBytes: UInt,
                documentUtf16Length: UInt, recipeId: string,
                appendSha256: Hash, appendUtf16Length: UInt,
                algorithmBindingSetSha256: Hash, config: Config }
Structural = { admittedArrayBound: UInt, admittedArrayPass: boolean,
               tailLocalityPass: boolean, sizeEnvelopePass: boolean,
               depthCeiling: 4, depthPass: boolean,
               nonblankCeiling: UInt | null, nonblankCeilingPass: boolean | null,
               whitespaceTransition: boolean, admittedBoundaryAgreementPass: boolean,
               deterministic: boolean, legacyArraysEqual: boolean }
Specimen = { key: SpecimenKey, beforeAdmitted: UInt, afterAdmitted: UInt,
             commonChunkPrefix: UInt, commonBoundaryPrefix: UInt,
             divergenceDepth: UInt, cdcChurn: UInt,
             legacyProductionChurn: UInt, legacySweepChurn: UInt,
             gap: Int, positionalChurn: UInt, blankBase: boolean,
             structural: Structural, maxCdcChurn: UInt, maxGap: Int }
Admission = { key: SpecimenKey, disposition: "ADMITTED" | "REJECTED",
              decisionRef: Hash, predecessor: SpecimenKey | null }
Fixture = { schemaVersion: 1, metric: "admitted-set-membership-v1",
            config: Config, algorithmBindings: AlgorithmBindings,
            recipeDefinitions: Recipe[], corpusInventory: InventoryEntry[],
            specimens: Specimen[], admissions: Admission[] }
```

A measured candidate has `admissions: []`; its measured `maxCdcChurn`/`maxGap` are proposed ceilings only, not approvals. A committed admitted fixture requires exactly one `ADMITTED` entry per specimen and no rejected/unreferenced entry. `decisionRef` identifies the independent value-free review artifact whose external parent receipt binds the complete candidate and resulting admitted bytes. Keep prior fixtures and rejection/removal decisions in the durable parent record; never satisfy a missing current specimen by retaining a stale admission. For a genuinely new document, predecessor is null; changed document/recipe/config keys name their preceding reviewed key. Removed documents require a separate reviewed inventory-removal receipt before a smaller current fixture is admissible. Ordinary CI cannot perform admission.

`sourceStart`/`sourceEnd` are zero-based, half-open UTF-16 offsets locating a complete declaration; select its first syntactic token through declaration end, preserving internal comments/literals and excluding leading trivia. A destructuring declaration is one complete binding (`symbol: "GEAR_LO,GEAR_HI"`), with both exported names resolved to it. Dependencies are unique `(path,symbol)` references sorted by path then symbol, and must resolve in the corresponding transitive binding set. Literal generators use their complete enclosing declaration/expression and necessary constants; they cannot be represented by an empty dependency assertion in place of actual source identity.

For deterministic hashing use UTF-8 compact JSON with object keys recursively sorted by Unicode code-point order, no extra whitespace or final LF, and arrays ordered as specified. The algorithm-binding-set digest hashes `{parserVersion,cdc,legacyProduction,legacySweep}` after projecting each Binding to `{path,symbol,syntaxKind,sha256,bytes,dependencies}` and sorting by path then symbol. Exclude location offsets and the digest itself from that digest: a comment inserted elsewhere in a large source file cannot change the function identity. Re-extract every binding to verify its declaration bytes; changed offsets alone are refreshed as location provenance through independent review, never treated as changed behavior or permission to increase a budget. Recipe generator identities use the same projection and exact dependency-byte validation. Recipe family is the ID prefix before `/`; `length` and generated append length must equal the ID suffix. A source declaration changed internally requires renewed identity/admission even if output appears unchanged.

For every specimen validate inventory/key/config/recipe/hash equality, `gap = cdcChurn - legacyProductionChurn`, both legacy values and arrays equal, and `admittedArrayBound = max(0, afterAdmitted-commonChunkPrefix)`. Blank-base qualification is derived from actual `trim()` behavior, not chosen metadata. Only a blank base allows both nonblank-ceiling fields to be null; all other applicable pass fields must be true for admission. Preserve tail-locality and boundary checks for blank inputs under §6.2's qualification; null is not a general structural bypass. Signed gap/ceiling values may be negative. Sort admissions exactly as specimens; references use complete keys, never ordinals. Reject impossible prefix/count/coordinate relationships, mismatched derived values or non-deterministic measurements.

After merge, any maintainer proposing a corpus change takes the producer role and a separate reviewer takes the independent admission role, using the same frozen harness, exact-byte candidate, reproduction and durable receipts. These roles do not depend on this chat being present. The implementation author may propose measurements but cannot approve them, remove difficult specimens or use an update flag to admit a regression. A new counterexample returns to reviewed policy adjudication; it does not automatically raise a ceiling. All initial final-v11 measurements, binding/recipe digests and admissions remain outstanding.

### 6.4 Complete live-specimen recipe IDs and exact recipe definitions

Recipe schema is `{id,family,length,definitionVersion,generatorBinding,appendSha256}`. Generator binding uses the same exact function/dependency identity form. All recipes append at the original document end without separator unless the recipe itself includes one. No platform newline normalization. The recipe definitions below identify exact existing generators, not fresh approximate prose. Parent measurement must prove generated UTF-16 length and SHA per recipe; any mismatch is fatal.

`unit-prose-v1/N`: frozen unit-test `doc(N,77)` with its complete WORDS array, LCG arithmetic and slicing unchanged. `unit-quiet-v1/N`: exactly `"a".repeat(N)`. N ranges over exactly 1,66,700,1249,2500,9000. `scenario-sentence-v1/66`: exact literal ` a new closing paragraph appended at the very end of the document.` including the leading space and final period; its actual length is checked against the recipe ID, not assumed from its label.

`sweep-prose-v1/N`: frozen sweep `filler(N,"z")`; begin with empty string, append tokens `${tag}${i} lorem ipsum dolor sit amet consectetur ${i*7919} ` with i starting zero until length >=N, then slice(0,N). `sweep-quiet-v1/N`: exactly `"a".repeat(N)`. N ranges over exactly 1,66,700,1249,1251,2500,5000,9000,20000,60000.

`comparison-prose-a-v1/N`: same exact filler(N,"z"); `comparison-prose-b-v1/N`: `filler(N+512,"q").replace(/lorem/g,"dolorem").slice(0,N)` (replacement BEFORE final slice); `comparison-quiet-v1/N`: exactly `"a".repeat(N)`, each N exactly 66,2500,9000. `comparison-sentence-v1/66` is the exact scenario sentence. Separate IDs retain the original consumer-role obligations even when append bytes coincide; no duplicate specimen key is permitted. The finite 43-ID expansion follows; no unlisted variable recipe is silently admitted.

- `unit-prose-v1/1`
- `unit-prose-v1/66`
- `unit-prose-v1/700`
- `unit-prose-v1/1249`
- `unit-prose-v1/2500`
- `unit-prose-v1/9000`
- `unit-quiet-v1/1`
- `unit-quiet-v1/66`
- `unit-quiet-v1/700`
- `unit-quiet-v1/1249`
- `unit-quiet-v1/2500`
- `unit-quiet-v1/9000`
- `scenario-sentence-v1/66`
- `sweep-prose-v1/1`
- `sweep-prose-v1/66`
- `sweep-prose-v1/700`
- `sweep-prose-v1/1249`
- `sweep-prose-v1/1251`
- `sweep-prose-v1/2500`
- `sweep-prose-v1/5000`
- `sweep-prose-v1/9000`
- `sweep-prose-v1/20000`
- `sweep-prose-v1/60000`
- `sweep-quiet-v1/1`
- `sweep-quiet-v1/66`
- `sweep-quiet-v1/700`
- `sweep-quiet-v1/1249`
- `sweep-quiet-v1/1251`
- `sweep-quiet-v1/2500`
- `sweep-quiet-v1/5000`
- `sweep-quiet-v1/9000`
- `sweep-quiet-v1/20000`
- `sweep-quiet-v1/60000`
- `comparison-prose-a-v1/66`
- `comparison-prose-a-v1/2500`
- `comparison-prose-a-v1/9000`
- `comparison-prose-b-v1/66`
- `comparison-prose-b-v1/2500`
- `comparison-prose-b-v1/9000`
- `comparison-quiet-v1/66`
- `comparison-quiet-v1/2500`
- `comparison-quiet-v1/9000`
- `comparison-sentence-v1/66`

All eligible live documents are measured against all 43 listed recipes in the shared baseline producer/validator; unit and sweep retain their original subsets and required reports, and CI validates the complete fixture. This adds explicit finite regression coverage without changing production or excluding documents. The parent must review this expanded measurement inventory before readiness; no previously published sample total is presented as execution of it.

Keep the 300-document finite comparison: seeds 1..300, `filler(2000+(seed*911)%80000, "s"+seed+"-")`, appends `filler(N,"t"+seed+"-")` at N=1,66,700,1249,2500,9000,40000. Keep 400-document / 8400-sample structural controls: seeds 1..400, `filler(2000+(seed*911)%80000,"g"+seed+"-")`, each N=1,66,700,1249,2500,9000,40000 with `filler(N,"h"+seed+"-")`, `a` repeated N and spaces repeated N. These synthetic suites are separate from the live fixture's 43-ID Cartesian product and must retain their pinned original generator source and control coverage. Their empirical legacy comparison does not become a universal theorem.

Retain CAPPED (including shared admitted prefix reaching cap and exactly-at-cap contrast), MERGE (actual disappearing boundary), DUPLICATE (set strictly below positional bound), verbatim-duplicate equality, WHITESPACE, GROWTH (content and length variation), determinism, fixed boundary sequence, minimum-content guarantee, cap-prefix stability, insertion/deletion and unchanged in-place controls. Existing test fixtures and exact generators remain the authoritative bytes; do not simplify a fixture while replacing the false live envelope. Preserve unit append lengths `1,66,700,1249,2500,9000` and sweep lengths `1,66,700,1249,1251,2500,5000,9000,20000,60000`. Preserve v9 quiet-66 exactly CDC 2 / legacy 0 / gap 2. No universal `+2` replaces the falsified universal `+1`.

### 6.5 Admission, deterministic validation and outstanding baseline

For an unchanged full specimen key, actual CDC churn may not exceed reviewed `maxCdcChurn`, and actual CDC-minus-legacy gap may not exceed reviewed `maxGap`. Structural gates must also pass. An increased legacy result cannot hide a CDC regression: both exact legacy implementations must agree and match their reviewed measurement for the unchanged key. A lower result is reported as an improvement but does not rewrite the baseline automatically. Any algorithm/config identity change is a new independently admitted version, not permission to discard old specimens. V11 grants no such production change.

Sort inventory by path; recipes by ID; specimens by path, document SHA, recipe ID, append SHA and binding hash using code-point comparison. Exact expected set equality is required. Missing/extra/stale/malformed/duplicate entries, omitted eligible documents, unexpected ineligibility, absent prior specimen or changed recipe/generator fails. New/changed document bytes require a candidate measurement and explicit independent admission with predecessor linkage; a removed document requires separately reviewed removal disposition, not silent disappearance. Frozen reviewed v9/v10/v11 bytes cannot be edited as a shortcut. Review of changed CDC documentation occurs after the exact bounded replacements are applied; all resulting new specimens must be admitted before final code review/publication.

**Outstanding BEFORE readiness and builder admission:** parent-generated, independently reviewed exact-final-v11 measurement artifact, function/dependency identities, all append hashes, both-legacy cross-check and all specimen ceilings. Neither the older aggregate sweep nor the v2 scanner projection supplies these. The parent must produce and independently review a read-only measurement harness in durable handoff storage, with exact source hash and deterministic extraction/generator controls; this author's scope does not authorize its creation or execution. Required future interface:

```text
node --import tsx <durable-handoff>/cdc-v11-measure.mts --root <exact-worktree> --spec docs/design/aio1217-server-action-auth-v11-ci-contract.md --mode measure --output <durable-handoff>/cdc-v11-candidate.json
```

Use the pinned repository dependencies and Node 20; bind tool source, runtime/dependency identity, exact full corpus and exact v11 hash/size in a separate sanitized producer receipt. The candidate JSON follows the fixture schema but has no ADMITTED decisions. Producer and independent reviewer are different workers; the author and future builder cannot approve their own baseline. The reviewer checks every specimen key/ceiling, exact recipe generators, structural outcomes, function closure, both-legacy equivalence and retained witnesses. An independent reproduction must agree before admission. This gate is expressly outstanding, not an invitation to invent final numbers or let the builder pick convenient budgets.

After accepted policy, the sole builder implements the shared validator and encodes only admitted measurements. Its implementation must reproduce the already-reviewed candidate through the actual unit/sweep paths. Subsequent allowed design-document edits generate new exact-byte specimens through the same parent producer/reviewer workflow before completion; no baseline-update flag is accepted by CI. A tool mismatch, unknown symbol, invalid source extraction or new counterexample returns to review. No parser, budget or specimen failure is converted to warning.

## 7. Exact future CDC documentation replacement instructions

These instructions authorize no present write to either design document. Future edits are limited to the anchored spans below; each anchor must match the frozen source exactly once or the builder stops for reviewed re-anchoring. Keep historical measured figures with their original corpus/commit/exclusion labels; replace only current/general claims. Do not change `cdc-boundary-overlap.md` or runtime to make this text easier to satisfy.

For `cdc-append-churn.md` §0f, replace the entire body between `### 0f. The two assertions guarding this row today` and the next `## 1.` with this normative body, retaining the heading:

> The predecessor short-append assertion `cdcChurn <= legacyChurn + 1` and its 300-document empirical comparison were historical finite checks, not a universal guarantee. The accepted AIO-1217 v9 quiet-66 specimen falsifies that assertion on the later live corpus: CDC 2, legacy 0, gap 2. Do not replace it with universal +2. Current acceptance combines the structural admitted-array/tail-locality/depth/size gates and independently reviewed frozen per-specimen CDC-churn and CDC-minus-legacy budgets defined by AIO-1217 v11. Budgets cover short and long listed recipes and exact document bytes; a new or changed specimen requires independent admission. The nonblank ceiling is 4 + ceil(A/1250) at the fixed defaults; whitespace activation is separately qualified. The original 300-document comparison remains a finite regression control, with its original measurements labelled historically.

For §2b, replace its entire body between `### 2b.` and `### 2c.` with:

> Let C0 and C1 be the admitted before/after chunk arrays and L their common equal-content prefix. Set-membership churn is at most |C1| - L; this is a bound, not an equality, because content already present elsewhere costs nothing. Independently enforce tail locality using uncapped boundaries, the size envelope and derived divergence depth 1 + floor((max-1)/min), equal to 4 under the unchanged defaults. For nonblank bases also enforce 4 + ceil(A/1250). A whitespace-only base may activate previously unadmitted whitespace on a nonblank append, so use its admitted-array bound and qualified structural controls rather than that nonblank ceiling. These structural bounds can be loose: reviewed exact-byte per-specimen ceilings on CDC churn and CDC-minus-legacy gap supply the second required gate for both short and long listed append recipes. Neither gate certifies a universal legacy +1 or +2 envelope. Retain separate set/positional diagnostics and the strict-vs-equality duplicate controls.

For §2d, replace its entire body up to the next heading with:

> Remove the falsified live `cdcChurn <= legacyChurn + 1` assertion. Require both the structural live-corpus gate and independently reviewed frozen per-specimen CDC and gap budgets, keyed by exact document, append recipe and function/config identities. Do not assert universal +2. Preserve insertion/deletion comparisons and all independent in-place controls unchanged. New or changed specimens cannot disappear or approve their own baseline; missing, stale, extra, duplicate or malformed baseline data fails. V9 quiet-66 remains 2/0/2, not a new permissible bound for other specimens.

For §3, replace each of its nineteen bullets exactly as specified in Appendix E's old-text-to-new-text table, preserving nineteen criteria and their order. That table is the exhaustive disposition; no bullet may be silently dropped. The supplementary exact spans below settle the introduction, §4 and §5; they replace the former open-ended instruction to alter related sentences. Other historical measurements retain their original labels and scopes.

**Preservation within the three full-body replacements:** before replacing §§0f, 2b and 2d, retain each original body verbatim immediately after its new normative body in a block labelled “Historical predecessor text — superseded acceptance rules, original finite measurements only.” This explicitly preserves old witnesses, numbers and the reasons for the prior comparison without making their universal/deferral language current. The new body controls; the old block cannot supply acceptance. Heading boundaries for those operations are the exact source heading pairs below (start heading retained, next heading excluded):

| Source start heading | Next heading / exclusive endpoint |
|---|---|
| `### 0f. The two assertions guarding this row today` | `## 1. The claims that cannot hold` |
| `### 2b. The test asserts the bound per document — and an ABSOLUTE ceiling that cannot self-adjust` | `### 2c. Four checked-in fixtures, because the live corpus cannot guarantee any of these branches` |
| `### 2d. The false comparison is REPLACED, not deleted` | `### 2e. The sweep script` |

**Introduction disposition:** retain the entire historical command/exclusion account from `**Every number below comes from one run of**` through the paragraph ending `rather than a fix.` unchanged, prefixed by: “Historical measurement scope only. The exclusions below apply to the original published figures, not current acceptance. AIO-1217 v11 acceptance includes both design documents and every eligible specification, with exact-byte independent specimen admission.” This is a historical qualification, not permission to exclude documents in CI.

**§4 exact old bullet:**

> - **Gating the long-append legacy envelope.** The synthetic maximum (+2 here, higher under other
>   generators) is a lower bound, and this file does not gate on lower bounds — the short-append regime is
>   where the envelope is measured on both populations.

Replace that whole bullet with:

- **Universal long-append theorem remains deferred.** Independently reviewed exact-byte finite specimen budgets for both short and long listed recipes are required now. They do not claim a universal maximum gap or turn a synthetic maximum into a theorem.

**§5 exact old paragraph:**

> Wrong if any document exceeds the absolute ceiling of `(1 + ⌊(max − 1)/min⌋) + ⌈A/min⌉`, which would mean
> the structural window in §0d is not what `cdcBoundaries` does.

Replace that paragraph with:

> Wrong if a nonblank-base document exceeds `(1 + floor((max-1)/min)) + ceil(A/min)`, or an applicable structural gate fails. Whitespace-to-nonblank activation instead uses the admitted-array bound and qualified boundary checks. Independently, an unchanged exact specimen exceeding either reviewed CDC churn or gap budget fails, and a new/changed specimen lacking independent admission fails. Neither structural success nor a universal legacy +1/+2 assertion can replace these budgets.


In `content-defined-chunking.md`, replace the exact acceptance row `| append at end | 1 of 20 (for a SHORT append — see below) | **conditional — see below** |` with:

`| append at end | Historical 66-character legacy example: 1 of 20; current per-specimen legacy measured exactly | Set churn <= admitted after length minus common chunk prefix; zero when shared prefix reaches cap. Tail locality, derived depth/size and nonblank 4 + ceil(A/1250) gates apply; whitespace activation qualified. Both CDC and gap must stay within independently reviewed exact-byte specimen budgets; content and length affect growth. |`

Replace the paragraph beginning `**The trade, both directions measured.**` through the paragraph immediately before `**And in prod, after:**` with:

> The historical corpus and 300-document comparison measured a short-append gap no greater than one, but that does not hold universally on later live documents. Accepted AIO-1217 v9 quiet-66 yields CDC 2, legacy 0, gap 2. No universal +2 is claimed. Current append acceptance uses both structural bounds and independently reviewed per-specimen CDC/gap budgets for exact document and append bytes, including long appends. The insertion benefit remains measured separately. The summary table's legacy one-chunk claim stays scoped to its original 66-character append; a 2501-character legacy append can churn two. These validation amendments do not change cdc1 or exclude documents.

Preserve the replaced trade paragraphs verbatim after the replacement in a block labelled “Historical predecessor trade measurements — not current acceptance”; keep their original finite-corpus attribution. Retain the exact historical legacy summary row and its 66-character qualifier, unrelated in-place/insertion/deletion claims, runtime/config/lazy-rollout/content-safety contracts and their historical limitations. The future documentation review must compare all anchored replacements and all nineteen criteria, not grep only for `+ 1`.


## Appendix A. Complete immutable accepted v9 text

BEGIN EXACT V9 CONTENT. The following bytes are incorporated as predecessor requirements subject only to the explicit v11 supersessions; original status/version references remain historical.

# AIO-1217 — Proposed v9: Server Action authority and F4-E4 retrospective evidence amendment

Status: **PROPOSED v9, F4-E4 author revision round 1 of at most 3; affected fresh independent specification review, fresh Astra permissioning/design-readiness and complete exact Linear attachment/readback pending. F4-dependent PM reconciliation acceptance remains BLOCKED.** This is a material process/evidence amendment, not a runtime change or an acceptance report. No verified authoring timestamp is asserted. The inherited v8 label `2026-10-06` is an unverified document label, not an actual UTC authoring date. No execution is dated or credited by this document.

Ticket: AIO-1217. Target for subsequently authorized publication: `staging`. Preserved base: `c5e832c2ff179ee5c99f95966fba1ed9ce77ae3e`; exact preserved reference runtime commit: `ceb184db9991dc9c6bb5ba3cb3b249cf6c480834`; exact candidate: `cd0387e8f6315199f0497d64a4f2134ca02f6ad4`. The immutable reference-to-candidate patch has SHA-256 `944d741dd2c3a537dff4f3abf4e4b00c295f3c0dfd96e4b7b68905a7fb3a3006` (manifest: 82,494 bytes, five changed files). This revision author verified the patch hash and all 15 input hashes pinned by `author-manifest.json` with read-only `sha256sum`; this is not fresh Git/worktree, runtime-loading or execution attestation.

Historical v7 authoring snapshot: `730eb34e75fe92f6e1262f6b60cf502c7600d2c4`; correction reference checkpoint: `87763351abc3d65ad56cb0f5064478e5d143eb55`. These remain historical provenance. This successor is based on exact proposed v8 SHA-256 `82c3b9ff8d828f4fd68ac1c1c20ef4b6fca9f81377359f17f269fb434fbbcef0` and accepts only M1/M2/M3 from the controlling copied Opus review SHA-256 `04499928573a249faf6e06d14ad82b2eee4d2d79f39996dae243fb7257065dff`, verdict `SPEC_REVIEW_REQUIRES_REVISION`. Those finding IDs belong to this review, not the historical v7 H1/H2/M1–M3 dispositions, which remain closed. The sole changed historical acceptance route remains F4-E4 chronology; no runtime design or other historical gate is relaxed.

**M3 dating conflict — UNRESOLVED.** The controlling review reports v8 and its author manifest labelled `2026-10-06`, with the old change map calling that an actual authoring date. It also reports the author-read CURRENT stamped `2026-10-05T22:38:49Z` with launch pending, while the frozen CURRENT supplied here (SHA-256 `3602f269ca3c91644c37579ea899cd882479b79c3beec7c7961f51acc7bbe115`) is stamped `2026-10-05T22:52:18.180309Z` and already cites v8 and the failed first review. The prior author event stream lacks timestamps and its status supplies only a 342.9-second duration, according to the controlling review. These records do not establish which date/stamp is wrong, whether timezone interpretation explains it, or whether CURRENT was not advanced. The parent must reconcile the original host launch/terminal capture, timezones and CURRENT update history before any externally dated assertion of authoring or chronology; retain the evidence and actual UTC start/end timestamps, or a corroborated explanation of a stale CURRENT stamp. This author does not resolve that conflict or invent timestamps. The execution timestamp and retrospective-label requirements in §§7–9 remain mandatory.

## 1. Authority, revision boundary and retained v6/v7 contract

The accepted v6 baseline is the immutable `inputs/10-aio1217-server-action-auth.md`, SHA-256 `be9788fb508518ec22cdaf7a3433419c3c7040a0595ff50f37a67cd6d108cdec`. The immutable accepted v7 baseline is `inputs/11-aio1217-server-action-auth-v7.md`, SHA-256 `326704ba3b1d6c5a91976b0e148bd6936fb2ca3d3942a4ad30aa2562b4662ee8`. Both are under `review-public-support/f4-e4-e6-package-repair/` in the AIO-1217 handoff. Neither accepted file is edited. The complete v6 Markdown is reproduced verbatim in Appendix A so this successor contains every retained normative requirement, inventory, stable AC-01–AC-14 identifier, ownership restriction, compatibility decision, deferral and evidence qualification. Sections 2–8 restate the complete v7 F4 contract with the narrow E4 amendment in §7 and terminology clarification in §8; §9 reconciles admission and acceptance. The appendix's historical status and sequencing statements keep their original scope. Only the F4-specific retrospective alternative expressly defined here modifies the incorporated E4 process; no other v6 or v7 chronology is waived, and no historical evidence is recertified.

**Accepted-status provenance and verification remain required:** the CURRENT historically pinned by v8, SHA-256 `f926ab0ae59f9c67588da6417f0e37a92a02a42433efaf5e033202f5d88731ef`, reportedly records acceptance of both exact baseline hashes and a complete Linear readback at `2026-10-05T21:20:38.644877Z`, rendered SHA-256 `fa17678bd795a64c207e42443c52f2b9a9c66e6bc7144cb046eb60e08020c9ac`. The v8 author reported verifying that file hash, not the external records; this revision author verified only the supplied successor CURRENT hash identified in the M3 paragraph. Historical PROPOSED headings are deliberately preserved. The coordinator must retain/verify the exact-hash external independent review, fresh Astra design/readiness and complete attachment/readback records and their identities in the durable handoff; a filename or checkpoint is not acceptance. Missing or mismatched evidence leaves the gate pending. Earlier accepted v6/v7 records cannot admit this material v9 amendment.

**Complete Linear contract:** after the ordered reviews and readiness in §9, attach the **complete exact immutable v6 Markdown plus the complete exact reviewed v9 Markdown** as clearly identified full-text documents to AIO-1217. Preserve unrelated ticket content and immutable v6/v7 history. Read back both complete bodies and verify each against its exact local body and SHA-256; record attachment/readback identities and the reviewed v9 hash. A repo link, hash, excerpt, summary or v9-only attachment is insufficient. The v6 appendix makes v9 standalone but does not remove the separate exact v6 attachment/readback obligation. This gate is future work and has not occurred here.

Historical runtime-decision provenance retained from v7: sanitized `f4-v7-astra-decision-evidence.md`, SHA-256 `888f30e658c9d2b52ae8ef807d8c6cdffaddc567c99f50dbbfda577fa9c576e5`, records `f4-pm-reconcile-astra-decision.final.md`, SHA-256 `735e99e2a1dd447b828b66e4eae7fb9bfe004b85f2768a9bf9d2df4256563ebe`, under `f4-v7-astra-spec-author-scope.md`. These inherited references are not newly hashed inputs or completed gates in this authoring run.

The controlling amendment decision is immutable `f4-e4-astra-adjudication.final.md`, SHA-256 `722041efbe3df6838dcda82cb919b3b0e5d41e712e97667a525d138de4336d89`, terminal `REQUIRES_SPEC_REVISION`. Its status and parent-capture hashes are respectively `c07ae19a48c19e7691aff44bede4b19d86ad1f6591551dd70ce2ef0af21b69fe` and `44b311e228024679d39b661d47b7504c7671f496f6e022661251cb9680830456`. The obstacle is the missed original execution chronology, not tests being committed with the fix. A later run can compare exact preserved runtime but cannot establish that RED preceded implementation. This qualification must remain in evidence, acceptance and release records even if the revised E4 alternative is later earned.

In this document, **must**, **required**, and gate tables describe proposed normative v9 requirements. Sections headed **Snapshot facts**, the reference defect in §2, historical “currently”/“future” language retained below and Appendix A describe their original snapshots; they do not claim a new source census or that the pinned candidate is absent. CURRENT records a candidate and bounded earlier results; this document independently credits none of them. The source-only E6 review `f4-e6-opus-census-review.final.md`, SHA-256 `2b8491f39b1244804c49b2aa60bfa57c85054a8ce0eaaec89da40fbdc175f1fa`, establishes no rendered UI, Server Action wire/serialization/cache behavior or complete E6. Its candidate census does not prove the required pre-edit census occurred. Stale committed NOT RUN/no-mutant prose remains unearned; correcting it requires focused reruns under the existing gates.

No application checks, tests, native evidence, mutations, new caller census, reviews, attachment or publication occurred during this authoring task. M1/M2/E5 results, source inspection, TODOs and a reconstructed run alone cannot earn E4. This authoring terminal earns no E4 execution, E6/UI/wire, full-task, PR, merge or deployment credit.

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
7. For an adapter supporting `fetchSeenStates` (Linear on this snapshot), resolved no-link reconciliation returns before provider fetch. Resolved linked reconciliation reads provider states, updates changed `provider_seen_status` bookkeeping and its timestamp, surfaces divergences, and does not write brain task fields or the provider board. An unchanged rerun performs no link updates but the action still audits and revalidates. This action creates no ingest run.
8. **Plane lacks `fetchSeenStates` on this snapshot.** With a usable Plane integration, the owner returns exactly `{ provider: "plane", seenUpdated: 0, divergences: [], reason: "plane has no inbound reconcile support" }` before any link scan or provider request. The existing action drops `reason`, audits, revalidates and returns exactly `{ ok: true, provider: "plane", seenUpdated: 0, divergences: [] }`. This unsupported-adapter outcome is distinct from F4's unavailable integration. It remains unchanged, with no `notRunReason` marker; it does not prove a Plane board was checked.

The native action fixture currently defines Linear changed/unchanged controls and selected real ADM denials. Its explicit TODOs exclude F4, Plane, no-link and no-primary branches, wider caller proof, and executed mutants. The association fixture exercises real posture with a substituted reconciliation owner; the action unit fixture likewise uses lower-owner seams. The owner divergence fixture is not action-level proof. Their presence and assertions are useful context, not passing v7 evidence.

## 3. F4 decision and exact observable outcomes

After ADM admission and the existing same-team resolution prerequisites, a configured named **Linear or Plane** primary whose enabled usable integration cannot be resolved because it is **missing, disabled or secret-less** must return exactly:

```ts
{ ok: false, error: "primary PM integration is unavailable" }
```

The public result must omit `provider`, `seenUpdated`, `divergences`, `reason` and the internal marker. Do not include those keys with `undefined`, extra diagnostics, provider names or secret/configuration data. The error string and two-key object are part of the contract.

| Condition | Required public outcome | Required ordering/effects |
| --- | --- | --- |
| ADM refuses | Existing exact `{ ok: false, error: "admins only" }` | Stop after only the guard prerequisite reads preceding the discriminated refusal arm in F4-E3; no service client, reconciliation resolution, link/provider work, audit, revalidation or run creation |
| Existing resolver returns `provider: null` | Existing `{ ok: false, error: result.reason ?? "no primary PM provider configured" }` | Preserve refusal and reason behavior; no link/provider/audit/revalidation/run effects |
| Named Linear/Plane primary has no usable integration | Exact F4 failure above | Resolve only after ADM; stop before link scan, provider request, audit, revalidation or run creation |
| Usable Plane integration, unsupported inbound adapter (with or without eligible links) | Existing exact `{ ok: true, provider: "plane", seenUpdated: 0, divergences: [] }`; internal reason as §2, no marker | After same-team resolution, return from owner before link scan/provider request; no link/task/provider/configuration/run mutation; preserve existing action audit then revalidation |
| Resolved supported adapter (Linear), no eligible links | Existing `{ ok: true, provider, seenUpdated: 0, divergences: [] }` | Preserve bounded link scan, no provider request or link update, then existing audit and revalidation |
| Resolved supported adapter (Linear), changed provider states | Existing success fields and divergence rows | Preserve same-team/provider scan, provider reads and changed-link bookkeeping, then audit, revalidation, return |
| Resolved supported adapter (Linear), unchanged board | Existing success, `seenUpdated: 0`, current divergences | Provider reads still occur for eligible links; no link update; preserve audit and revalidation |

“No primary” means a null resolution result, not merely an unset configuration field. The sole-enabled fallback is retained. Legitimate zero-work/zero-update successes must not be converted into errors by testing `seenUpdated`, an empty divergence list or an empty link set. “Zero effect” on an admitted no-link or unchanged reconciliation means zero reconciliation mutation, **not** absence of its established success audit/revalidation.

The same audit/revalidation qualification applies to the preserved unsupported Plane outcome. F4 does not add Plane inbound support or change its public unsupported outcome. Plane admitted inbound no-link/changed/unchanged controls are not required or claimable on this snapshot: a later Astra support decision, renewed scope/review/readiness and exact attachment/readback must precede any such implementation or requirement. The six Linear/Plane unavailable-integration refusal cells remain mandatory because they stop before adapter capability selection.

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

For Linear, execute resolved no-link, changed-state and unchanged-board controls through the actual action/native owners. Check exact public and internal successful shapes, absence of the marker, same-team/provider bindings, no foreign rows/secret exposure, expected read-only provider requests, changed-link-only bookkeeping, divergence contents, and the exact audit-then-revalidation sequence. Compare timestamps and durable rows on unchanged reruns; preserve the legitimate new audit row. Brain task fields, provider board, integrations/configuration and run history remain unchanged.

For Plane, execute a usable-integration **unsupported-adapter compatibility control**, both with eligible seeded links and without them. Require the exact internal reason-bearing result and exact public success DTO in §2, absent marker, same-team resolution, zero link scan/update and zero provider requests, followed by the existing audit and revalidation. Compare complete durable rows across a repeated invocation: only the established success audit row is added per call; links/timestamps, tasks, integrations/configuration and run history remain unchanged. Do not stub in `fetchSeenStates` to manufacture Plane inbound admission. No Plane inbound no-link scan, changed-state bookkeeping or unchanged-board-read proof is required unless a later Astra decision changes support under the gates in §3.

Exercise null-provider refusal for no usable candidates and ambiguous unconfigured primaries, with exact existing reason mapping and no success effects. Exercise unset-primary/sole-enabled Linear as a compatible admitted control and sole-enabled Plane as the preserved unsupported-adapter outcome. An unset field is not sufficient evidence of refusal. Linear controls must demonstrate that the fixture can reach real provider reads and expected effects; a universally refusing fixture cannot pass. Plane's compatibility control must not be labelled successful inbound reconciliation evidence.

### F4-E3 — Each ADM conjunct and tenant confinement

Keep the action's exact `admins only` denial. Establish every check preceding the particular refusal arm and valid enabled feature inputs, then separately discriminate missing/invalid session, unknown team, missing or foreign membership, inactive membership, non-admin role (member and lead), and restricted membership-derived posture. Assert the guard's allowed reads and no subsequent service-client acquisition/resolution, provider/link work, audit/revalidation/run effects or durable changes. A helper-only predicate assertion is insufficient: the action must honor the verdict.

Retain admitted active same-team admin controls, two-team binding and both stale legacy-tier directions: legacy `team` without builtin Everyone membership refuses; legacy `external` with valid builtin Everyone membership admits. Removing/restoring the relevant association must affect a fresh invocation. Existing owner/association evidence can support individual semantics only with exact case/snapshot attribution; substituted owner cases do not establish native F4 behavior. Preserve current guard-fault outcomes without broadening exception policy. No new task-level viewer-policy or concurrent revocation guarantee is inferred.

## 6. Caller and DTO compatibility gate

**Snapshot caller facts:** `reconcile-button.tsx` imports the action and `ReconcileResultDto`, stores the returned value, renders success on `result.ok`, and otherwise renders “Reconcile failed” with `result.error`. A named primary does not disable the button merely because its integration is unavailable. The proposed failure fits the existing failure branch by source inspection; this is not executed UI proof or a complete caller census.

**Before any runtime edit**, census the actual production and test consumers of `reconcileProviderState`, `ReconcileResult`, `reconcileDivergenceAction` and `ReconcileResultDto` on the pre-edit snapshot. Include re-exports, wrappers and serialization/exact-object consumers; record paths, identities, existing outcomes and proposed compatibility decisions in the durable handoff. The decision and manifest do not certify caller counts. Resolve material new impact through Astra scope/readiness adjudication and renewed affected review/attachment before editing; do not discover the authorized impact only after implementation. **Recheck that census against the exact candidate before code/final review and publication**, record drift and caller evidence, and repeat affected checks after integration or later changes. Wider required runtime changes beyond the two owners require renewed Astra scope adjudication, never silent expansion.

Required checks:

- Keep `ReconcileResultDto` compatible; introduce no mandatory field and leak no internal marker/reason. Successful action objects remain exactly `{ ok: true, provider, seenUpdated, divergences }`; existing ADM/no-primary failures retain their existing shapes. F4 is the one intended public behavior change.
- Preserve existing exact-object expectations in `test/actions/aio1217-admin-operations-auth.test.ts` and `test/datamechanics/aio1217-admin-guard-association.datamechanics.test.ts`; their successful substituted results have no marker and must still work. Preserve native successful owner/action expectations and `reconcile-divergence.datamechanics.test.ts` outcomes. Do not loosen assertions broadly to accommodate an optional field.
- Check internal exact-object consumers: the named unavailable owner result intentionally gains one property; null-provider and successful owner objects do not. Test key presence as well as values so an everywhere-present `undefined` field cannot masquerade as absence.
- Verify the UI caller renders the exact F4 message in its failure branch and preserves successful controls. No UI rewrite is proposed. Type checking and source inspection alone do not prove rendered behavior; record the actual caller evidence used and its limits.

## 7. Regression, mutations and verification records

### F4-E4 — Actual reference RED → candidate GREEN, with explicit chronology

**E4 process alternative.** Ordinarily, run the new native refusal assertions against the exact unchanged reference implementation before runtime correction, retain actual RED outcomes and admitted baselines, investigate a non-reproducing defect before editing, then execute the same cases against the bounded implementation. For this already-preserved F4 candidate, this amended contract also permits a **transparently dated retrospective comparison against the exact preserved reference runtime** identified in §1, after §9's renewed review/readiness and exact attachment/readback gates. Label every such result “retrospective reference-runtime RED” or “retrospective candidate GREEN,” with the actual execution timestamps. The original before-correction RED chronology was missed; the alternative does not cure, backdate or establish that chronology. Do not call a retrospective comparison historical pre-fix execution or prebuild execution. Preserve v6 AC-12 verbatim: “Do not launder delayed reconstruction as a prebuild execution.” This exception is specific to F4-E4; it waives no other runtime, caller-census, ownership, review or sequencing obligation.

**Investigation gate.** If any claimed reference RED does not reproduce the intended false success and its effects, stop that E4 acceptance claim, disclose the observed result, and investigate provenance, loading and fixture premises before any further proposed correction or acceptance. A failure to reproduce after implementation is not permission to edit preserved runtime, inject a defect, weaken assertions or rewrite chronology. Material runtime or scope findings return to Astra adjudication and renewed affected review/readiness/attachment. Setup failures, import failures, timeouts, a missing-marker assertion or an unexplained nonzero exit are not discriminating reference RED.

**Exact runtime and same cases.** Newly authored tests may overlay preserved runtime; the tests need not have existed in the historical reference commit. Same-commit test/fix provenance neither disqualifies the assertions nor proves execution order. Execute the actual action through real session/guard, resolver, integration owner, reconciliation owner and native Postgres. The preserved patch has two production owners and three test files. A disclosed isolated candidate copy with both production owners restored byte-for-byte from the exact preserved reference commit may reproduce that reference runtime, provided the complete provenance demonstrates that every other loaded production dependency is the declared unchanged runtime. Never label a composite tree a pristine checkout. Do not use a marker-removal mutant as a substitute for the preserved reference. “Same cases” means unchanged assertions, fixture logic, invocation paths and controls between reference and candidate; fresh synthetic IDs/timestamps are allowed only with equivalent independently verified stored premises. No changed expectations, selected easier cells or weakened assertions between runs.

**Required execution record, for either chronology route.** Retain reference/candidate commit identities and source-tree identity; hashes of every actually loaded runtime artifact, test and harness/observation artifact; a complete overlay/substitution manifest with paths, origin commits, before/after hashes and exact substitutions or explicit none; dependency/lockfile/toolchain identities; sanitized effective configuration and database/adapter/schema identities and fixture/reset provenance. Record module resolution and cache isolation sufficient to exclude stale candidate code from the reference execution. For every run/case retain the exact command, working directory, actual start/end timestamps with timezone, exit result, reached assertions/invocations, and sanitized raw results/traces/readbacks. Hash the retained evidence artifacts and link them to the exact run. Do not include credentials or private provider data. Distinguish parent-reported results from directly captured observations; commit names and equal test bytes alone do not prove execution or completeness.

**Six discriminating reference observations.** Execute and record separately Linear × missing, disabled, secret-less and Plane × missing, disabled, secret-less. Each cell must reach admitted active same-team unrestricted role-admin authority and real same-team resolution, then actually show the named provider public success `{ ok: true, provider, seenUpdated: 0, divergences: [] }`, a durable `team.reconcile_divergence` audit insertion and recorded revalidation of the established path, with absent link scan/writes and absent provider requests. Capture the actual reason-bearing unmarked owner result and public keys without manufacturing a verdict. The audit insertion is an observed defect effect, so reference pre/post audit rows must show it rather than claim all reference rows unchanged. Record exact trace order and distinguish the recording revalidation seam from live Next cache/transport behavior.

**Corresponding exact-candidate observations.** Execute the same six cases against the exact candidate and require exactly `{ ok: false, error: "primary PM integration is unavailable" }`, only the two public keys, internal `notRunReason: "integration_unavailable"` provenance and the F4-E1 trace boundary after allowed prerequisites. Prove no link scan/write, provider read/write, audit invocation/insertion, revalidation or run creation; retain full relevant durable pre/post rows and actual repeated invocations as F4-E1 requires. Show every intended cell was reached and evaluated. A GREEN exit or marker alone cannot establish those obligations.

**Real premises, durable comparisons and non-vacuous controls.** Record the real session premise and read back actual stored membership/posture, team configuration and integration conditions, including missing/disabled/secret-less distinctions, from real rows. Seed eligible tasks/links, an enabled usable same-provider integration in the other team and an enabled usable alternate-provider integration in the acting team; read back their conditions and verify they do not rescue the configured primary. Use synthetic credentials and recording synthetic provider transport. Pass-through observation must preserve real arguments, execution and results; never replace the guard, resolver or reconciliation result with an F4 answer. Compare complete relevant rows for both teams—links and timestamps, tasks, integrations, configuration, audits and runs—before/after each invocation, naming the reference audit defect, legitimate admitted audit/bookkeeping differences, and candidate refusal invariance separately. Permitted same-team prerequisite reads/decryption remain permitted; zero database activity is not the required boundary. Foreign-team secrets must not be read/decrypted. Do not reinterpret decryption, database or provider faults as unavailable-integration premises.

Retain and execute the F4-E2/E3 controls: Linear no-link, changed-state and unchanged-board; both usable Plane unsupported-adapter compatibility cases with/without eligible links; null-provider refusal for no candidate and ambiguity; sole-enabled fallback for Linear and Plane; every ADM conjunct refusal/admission specified in F4-E3, stale legacy-tier directions and tenant bindings. Execute all these controls, including the admitted non-vacuous baselines, on both the exact preserved reference runtime and the exact candidate with identical test and harness bytes; the reference record must show the controls alongside all six failing reference cells, with actual run/case identities and observations, not candidate-only or inferred controls. Supported admitted controls must reach actual provider reads and expected effects to disprove universal refusal. Plane unsupported compatibility neither adds nor proves inbound support. All preserved public/internal shapes, ordering, repeated invocation and durable comparison obligations remain unchanged.

**Invocation reachability and repeats.** The supplied fixture's `reach()` captures one invocation and then asserts. An assertion failure there prevents any subsequent repeat in that path. Evidence may credit only the invocation and observations actually captured; it must mark later assertions/repeats not reached and may not infer them from test source or unchanged bytes. Capture enough sanitized observations before an expected assertion failure to establish the discriminating reference outcome without bypassing the actual action. Any additional repeated-reference observation must have its own actual execution record. All required candidate refusal repetitions and repeated admitted controls must really execute. A failed first invocation cannot be claimed as two invocations.

**Acceptance boundary.** Original compliant evidence, if verifiable, retains its actual chronology; retrospective evidence retains the disclosed sequencing gap permanently. Neither source inspection, TODOs, M1/M2/E5 results, unchanged test bytes, nor a reconstructed run by itself earns E4. Only the reviewed/admitted alternative plus the complete discriminating comparison record may support a subsequent E4 determination under §9. Executable E5 mutants remain a separate obligation. This proposal performs neither comparison nor acceptance.

### F4-E5 — Isolated-copy executable mutations

Mutate isolated copies of the exact candidate and invoke the actual imported mutated code. Keep original runtime files intact during falsification. Required mutants omit the owner's marker, ignore its verdict in the action (restoring current false success), and allow audit and/or revalidation before returning the failure. Include an overbroad marker/refusal mutant on legitimate no-link or unchanged success. The refusal/trace/durable-state assertions must kill the corresponding mutants for the intended behavioral reason. Also retain affected v6 ignored-ADM and tenant-binding falsification obligations; F4 does not replace them.

A compile/import failure, fixture setup failure, skipped test or mutation never reached is not a kill. Record candidate identity, precise isolated mutation, actual command/exit result, reached branch and discriminating assertion, with unmodified controls passing. Merely retaining a guard identifier in an AST registry does not prove its verdict is obeyed or a late refusal stops effects.

### F4-E6 — Validation and durable evidence

Run scoped marker/action/caller tests, all required native F4 and admitted cases, the existing native reconciliation action and owner suites, affected admin unit/association suites, and regressions invalidated by the two-file runtime diff. Retain v6 AC-13 validation obligations including typecheck, lint, docs checks, build and required unit coverage; report actual commands, environment/seams, results, timeouts, skips and limitations. Do not infer full datamechanics or Server Action wire coverage from selected direct-export tests.

Store sanitized durable evidence with exact source snapshot/hashes, case names, real database premises, prerequisite/effect traces, precise DTO keys, before/after durable comparisons, repetition results, non-rescue and admitted controls, caller census and mutation outcomes. Preserve task checkpoints and remote backups under the agreed workflow when that work is authorized. No credentials/private provider data belong in artifacts. Synthetic provider responses prove bounded local behavior, not provider service semantics, live authorization, pagination, Next transport security, cache invalidation or general outage handling.

## 8. F4 compatibility, release and rollback obligations

Before publication, record F4's compatibility disposition and release wording alongside the candidate evidence. Name the intended behavior change: a configured Linear or Plane primary with a missing, disabled or secret-less integration previously returned apparent success and emitted a success audit/revalidation; it must now return exactly `{ ok: false, error: "primary PM integration is unavailable" }` before either effect. The UI displays this through its existing failure branch. Record actual caller/rendered evidence, not just type compatibility. The optional internal marker is additive only on that named-unavailable owner result and is never a public field; reconcile all exact-object consumers through the pre-edit census and candidate recheck.

Release notes must preserve and distinguish null-provider refusal, sole-enabled fallback, Linear's legitimate no-link/unchanged successes and normal changed-link bookkeeping, and Plane's existing unsupported-adapter success/audit/revalidation outcome. Explicitly disclose that usable Plane integrations still lack inbound reconciliation on this snapshot; F4 does not certify a Plane board read or fix that residual. Preserve the accepted v6 release qualifications and deferred siblings. No schema, migration, backfill, secret/configuration rewrite, run creation or historical audit cleanup is part of F4. Future release-note preparation is an obligation, not permission to edit another file during this correction or to release production.

**Residual R1 — Plane unsupported reconciliation reports success.** With a usable Plane integration, the owner returns its unsupported reason before any link scan or provider request, but `reconcileDivergenceAction` drops that reason and emits the existing success DTO, success audit and revalidation (§2/§3). This misleading outcome remains an unresolved finding, not an endorsed claim that the board was checked. The F4-E2 compatibility control proves preservation of that outcome only; it cannot prove Plane inbound reconciliation or absence of board divergence. **Accountable follow-up intake owner: the continuing AIO-1217 coordinator/hardening workstream; status: PENDING separate intake.** No existing verified follow-up ticket or implementation owner is established by the canonical inputs. The coordinator must carry this finding into separate intake and verify ownership, active-worktree/PR overlap and integration order before assigning correction; a separate specification and its review/readiness gates must precede any runtime change. Release wording must disclose the remaining misleading success/audit/revalidation and unsupported inbound capability, even after F4 passes.

**Residual R2 — `projectBoardAction` configuration false success.** Separately, for a team with a project and a configured named Linear or Plane primary whose integration is missing, disabled or secret-less, `projectAllTasks` returns the named provider, empty reports and a reason before task loading or provider projection. With that configuration unchanged across the project loop, `projectBoardAction` retains the non-null provider, passes `reason: undefined` to `recordProjectionRun`, bypasses its `!provider && reason` failure check, audits, revalidates and returns `{ ok: true, provider, counts: {}, reports: [] }`. This is a source-derived observation, not an executed reproducer or proof of the persisted run result. **Accountable follow-up intake owner: the continuing AIO-1217 coordinator/hardening workstream; status: PENDING separate intake, distinct from R1.** No existing verified follow-up ticket or implementation owner is established by the canonical inputs. The coordinator must separately verify ownership, active-worktree/PR overlap, affected callers and integration order and obtain a separate specification with review/readiness before correction. Release wording must disclose that F4 corrects unavailable-integration refusal only for reconciliation; projection can still report apparent success under this configuration, and its action/run call does not prove a board projection occurred.

Neither residual belongs in F4 runtime work or reopens AIO-1225–1228. These dispositions record future intake responsibility without claiming that intake, ownership verification, reproduction or correction has occurred. They do not waive the future exact-hash v6 accepted-status proof or complete exact v6-plus-v9 Linear attachment/readback gates in §1/§9.

Record a scoped rollback plan against the actual candidate and recorded staging base, covering the two F4 runtime owners together and their dependent evidence. Optional typing alone does not make a mixed owner/action deployment correct: an old owner without the marker leaves a new action unable to detect F4, and an old action ignores a new owner's marker. Review and publish the owner/consumer pair as one candidate. A rollback restores the false-success/audit/revalidation defect and therefore requires an explicit authorized security/compatibility decision; it is not an automatic response to a test or tool failure. Preserve unrelated v6 fixes and earned evidence; make no data reclassification, audit deletion, task/provider replay or compensating run. Retain exact accepted documents, reference-runtime RED with its actual execution dates and explicit original-or-retrospective chronology, candidate results, reviews and recoverable checkpoints. Reverting or partially rolling back F4 reopens dependent PM acceptance and invalidates affected candidate attestations until fresh verification and review; it cannot retain a GREEN claim. Merge, deployment and release remain separately authorized operations.

In retained evidence and release wording, “pre-fix RED” may describe the runtime version only when accompanied by its actual execution date and an explicit original-before-correction or retrospective classification. For this alternative, use “retrospective reference-runtime RED.” Never let “pre-fix” imply the missed original before-correction/prebuild chronology was met. Preserve the original sequencing gap and v6 AC-12's anti-laundering rule in every dependent acceptance record, even after a successful retrospective comparison. This terminology clarification changes no rollback, release, caller or runtime obligation above.

## 9. Acceptance mapping and ordered admission gates

Stable v6 IDs remain intact. F4 still extends the PM-reconciliation portion of AC-04 (actual action refusal/non-effects), AC-05 (ADM and caller compatibility), AC-11 (bounded ownership), AC-12 (RED and mutation evidence), AC-13 (affected validation), and AC-14 (fresh review/readiness/attachment). This amendment changes only F4-E4's process/evidence acceptance under AC-12 and the consequential AC-14 admission and dependent PM acceptance mapping. AC-04/05/11/13 outcomes, E1–E3/E5/E6, AC-06 and every other independent requirement are unchanged. Historical evidence is neither erased nor converted into new passes.

| Affected acceptance item | Revised evidence rule | Unchanged limit |
| --- | --- | --- |
| AC-12, F4-E4 only | Original compliant RED-before-correction record or the §7 transparently dated exact-preserved-runtime retrospective comparison, with all six discriminating reference observations, exact candidate observations, complete provenance, premises, controls and actually reached repetitions | Missed original chronology remains disclosed; v6 anti-laundering rule and unrelated RED chronology remain; M1/M2/E5 and reconstruction alone are insufficient |
| AC-14, material amendment admission | Ordered independent subscription `claude-opus-5-5` HIGH spec review → fresh Astra permissioning/design-readiness → complete exact v6 plus reviewed v9 Linear attachment/readback, each hash verified | Authoring/adjudication do not satisfy any review, readiness or attachment gate; no API-key billing or automatic model substitution |
| Dependent PM acceptance | Only after revised-spec admission and all retained runtime, E1–E6, caller, compatibility and exact-candidate review requirements are earned may acceptance be considered; an accepted retrospective E4 record keeps its chronology qualification | E4 alone is not PM/full-task acceptance; no E6/UI/wire, final review, PR, merge or deployment credit transfers from this amendment |

**Explicit reviewer/model gate and order:** first obtain fresh independent subscription-authenticated **`claude-opus-5-5` HIGH specification review** of exact proposed v9 and the complete v6/v9 contract. Resolve confirmed findings, then obtain a separate **fresh-context Astra permissioning design review and readiness disposition** for that exact reviewed material. Only after both pass may the coordinator perform complete exact v6-plus-v9 Linear attachment/readback with verified hashes. The prior Astra F4/E4 adjudications and this authoring task are not permissioning/design review. Record the existing user-authorized subscription Opus override of older Fable reviewer defaults, actual reviewer model/effort/identity, subscription authentication/capacity admission and exact reviewed snapshot. The override permits neither API billing nor bypassing capacity/stop controls, automatic reviewer substitution or waiver of Astra. If authorization or required reviewer identity is unverifiable, hold the gate. Use independent per-HIGH/blocker skepticism under the agreed workflow; repeat affected review on material revision.

After implementation/evidence, require independent subscription Opus 5.5 HIGH code review and separate fresh-context Astra HIGH final review on the exact candidate, including affected callers, native outcomes and executable mutants. Retain the outstanding blind Sol HIGH final-review role recorded by CURRENT and all whole-task final review requirements; this F4 amendment substitutes for none of them. No review is earned here.

| Gate | Completion requirement | Status of this proposal |
| --- | --- | --- |
| Baseline accepted-status evidence | Retain/verify exact-hash external acceptance/review/readiness and complete attachment/readback records in §1; historical PROPOSED headings do not establish or negate external acceptance | Reported in pinned CURRENT; no fresh external verification here |
| Independent specification review | Verified authorized subscription override and fresh independent `claude-opus-5-5` HIGH review of exact v9 and complete v6/v9 contract; resolve findings | PENDING |
| Fresh design permissioning/readiness | After independent spec review, separate fresh-context Astra permissioning design review, including the narrow E4 alternative and all retained holds; explicit readiness disposition | PENDING |
| Exact attachment | After both preceding gates pass, attach complete exact v6 and reviewed v9 Markdown, preserve unrelated content and immutable accepted history; read back both complete bodies and verify local equality and hashes | PENDING |
| Runtime admission | All preceding gates before any further runtime writer; verified sole owner, pre-edit census/compatibility decisions, recoverable checkpoint and workflow capacity/authentication requirements | No new runtime authorization; existing candidate is preserved, not retrospectively admitted by this document |
| Runtime correctness | Only the two bounded production changes; exact F4 failure before forbidden effects; preserved no-primary/admitted/ADM contracts | Candidate reported by pinned CURRENT; not implemented or newly verified here |
| F4-E4 comparison | After amended-spec admission, earn either the original compliant record or §7 retrospective reference/candidate comparison with all required provenance and observations; retain chronology qualification | UNEARNED |
| Evidence/compatibility | F4-E1–E6, exact caller/DTO checks and candidate census recheck; Linear inbound versus Plane unsupported controls; honest pending/skipped items and actual rendered caller evidence | Not completed here; E6 source-only census remains qualified/incomplete |
| Code/final review | Independent subscription Opus 5.5 HIGH code and fresh-context Astra HIGH final reviews of exact candidate/callers/native outcomes/mutants; retained blind Sol HIGH and whole-task review roles; resolve confirmed in-scope blockers | PENDING |
| Publication compatibility | Candidate census recheck, release wording with chronology and residual qualifications, paired-owner rollback in §8, retained v6 publication holds | PENDING; no publication authorization |
| Dependent PM acceptance | All runtime, evidence, compatibility and review gates complete after revised-spec admission; recorded retrospective qualification if used; unresolved pre-edit caller census or runtime-admission gaps keep this BLOCKED until an explicit Astra disposition | BLOCKED; no acceptance claim |

**Common ordered admission:** verify/retain exact baseline acceptance records and reviewer override → freeze v9 → independent subscription `claude-opus-5-5` HIGH specification review → separate fresh Astra permissioning/design-readiness → attach and completely read back **both full exact immutable v6 and full exact reviewed v9 Markdown bodies**, verifying each hash. Only then can the revised E4 route be used for dependent acceptance work. These gates are not performed by authoring.

**Original prospective execution route:** after common admission and verified owner/pre-edit caller census/compatibility decisions, perform pre-runtime RED and investigate non-reproduction before editing → bounded sole-writer implementation → same-case candidate GREEN, native/caller compatibility evidence, isolated-copy mutants and validation → exact-candidate caller census recheck and independent code/fresh Astra final reviews plus retained whole-task reviews → publication compatibility/release/rollback gate. This remains the normal sequence for work that has not already been corrected.

**F4 retrospective route for the preserved candidate:** disclose that original pre-runtime RED → implementation chronology was missed; preserve the exact reference and existing candidate identities rather than claiming a new prebuild event. After common admission, verify evidence ownership, isolation/provenance and unchanged preserved production runtime → execute and record the transparently dated reference-runtime comparison, including all F4-E2/E3 controls and admitted non-vacuous baselines alongside all six failing reference cells → execute the same cases and all those controls against the exact candidate with identical test and harness bytes, required actual candidate refusal repeats and repeated admitted controls on both runtimes, subject to the actual-reach limitations in §7 → resolve E4's complete evidence record and retain its chronology qualification → complete retained E1–E3/E5/E6, caller/rendered evidence, isolated-copy mutations and validation → exact-candidate census recheck and independent code/fresh Astra final reviews plus retained whole-task reviews → publication compatibility/release/rollback gate. The already-existing implementation stays explicitly earlier in this history; do not backdate runs or re-label reconstruction as original execution. Any later candidate/runtime change invalidates affected evidence and requires the corresponding renewed admission/verification.

The pre-edit caller census requirement in §6 is unchanged. It may be performed earlier as read-only readiness work but must not be postponed until after runtime edits. The retrospective E4 alternative does not establish or excuse an absent historical pre-edit census: record that separate gap and return any material impact/permissioning issue to Astra. Any unresolved pre-edit caller census or runtime-admission gap keeps dependent PM acceptance BLOCKED until an explicit Astra disposition identifies the gap, supporting evidence and its acceptance consequence. This document grants no such disposition, retrospective runtime admission or waiver; the sole changed historical acceptance route is E4 chronology. Neither the candidate's existence nor retrospective E4 evidence makes any runtime, evidence, compatibility, review, caller, mutation or validation gate optional. All E1–E3/E5/E6, caller/UI, residual, role and final-review gates remain in force. The source-only candidate census cannot stand in for the pre-edit census. Material new impact or a material revision after review/attachment requires renewed affected review/readiness and complete exact v6-plus-revised-spec attachment/readback before dependent runtime work or acceptance. Earlier v6/v7/v8 reviews and attachment do not attest v9.

No runtime writer is authorized by this file. This bounded authoring task permits only support-document writes and pinned-input inspection/hash verification; no source/test/runtime change, checks, workers/reviewers, browser, network, Linear or nested Codex execution occurred. No PR, merge, deployment, release, ticket completion or full-task acceptance follows. Subsequent authorized publication targets `staging`; merging and deployment require their own authorization. Held PR714/shared changes and whole-task/visibility-error obligations remain untouched and unreleasable until their own gates pass.

## Bounded amendment handoff

The support-only proposal and its change map await parent verification of the author terminal, then affected fresh independent subscription Opus HIGH specification review; this task dispatches no reviewer. All 15 input hashes pinned by the author manifest and the exact candidate patch hash matched before authoring. The author modifies no canonical accepted document or implementation-worktree file. E4 execution, E6/UI/action-wire, full-task/final reviews, PR, merge, deployment, Astra readiness and Linear attachment/readback remain unearned. The M3 date conflict remains unresolved for parent host-capture reconciliation before any externally dated assertion. Follow §9's review → fresh Astra readiness → exact two-document attachment/readback order before considering dependent acceptance.

### M1 narrow reading of preserved Appendix A qualifiers

Appendix A remains byte-for-byte immutable v6. Every inherited “applicable” below has only its named operation/case meaning, never discretion to omit a gate for the preserved F4 candidate. The following locations use immutable v8 line numbers to identify the unchanged appendix text exactly:

| Original v8 location and qualifier | Required narrow meaning retained in v9 |
| --- | --- |
| 248, documented refusal conjunctions; 451, documented conjunction and omitted/widened/wrong-principal mutants; 468, finite conjuncts and mutants; 557, finite conjunct list and each denial | Every conjunction enumerated for that action's authority codes and every well-typed mutation of its named consumer contract; all named rows and controls remain required. Explicit deferred desired protections remain deferred, never passed. |
| 264, ownership before the edit | The particular held production path being edited; every such edit requires its verified ownership/integration gate. |
| 303, arc mutant; 305, executing tests; 315, typed cases | Arc wider/stale/wrong-principal group substitution; each of the 15 named connection tests for the changed argument/verdict; the three named meeting actions' well-typed wrong-viewer/ignored-null cases. The existing exclusion of ill-typed missing positional arguments does not excuse executing mutants. |
| 326, operation for that export | That export's named plan/approval/schedule/cancel/generation dispatch/model/output/revalidation effects, after its specified authorized prerequisites. |
| 363, assertion failure | The behavioral refusal/consumer-zero/revalidation or genuine-empty-control assertion corresponding to each named propagation/continuation/empty-as-error mutation; never a setup/import failure. |
| 385, confirmed transitions | The selected approval or denial state transition in the existing approval state machine, proved by returned-row/durable readback and dispatch evidence. |
| 412, approvalRequestId | The identifier of the approval request when that fault phase has an associated approval request; no invented ID or broader log payload. |
| 609–620, exact-scope connection cases | The exact named export-to-consumer connections in the finite 15-connection table, with each row's authority conjunction and admitted controls still mandatory; no invented connection or exemption from a listed one. |

These interpretations preserve the existing case-specific semantics and all original obligations. No unresolved prerequisite, missing evidence or historical sequencing gap may be classified away through these words.

## Appendix A — Complete immutable accepted v6 Markdown

The following is the complete unchanged byte content of accepted v6, SHA-256 `be9788fb508518ec22cdaf7a3433419c3c7040a0595ff50f37a67cd6d108cdec`, delimited by the two HTML comments. Its historical PROPOSED/status entries and relative paths retain their original document/worktree context. All its requirements remain normative subject only to the explicit F4-specific additions and E4 process alternative above. The original separately hashed v6 file remains the exact attachment source.

<!-- BEGIN IMMUTABLE V6 BODY -->
# AIO-1217 — Server Action authority inventory and target binding

Status: PROPOSED v6 material revision; acceptance pending the gates below. Revision author: GPT-6 Astra, medium reasoning. Prior v5-final author: GPT-6.1 Sol, high reasoning. Original design base: `c5e832c2ff179ee5c99f95966fba1ed9ce77ae3e` (`staging`, after PR 741). Target: `staging`. Ticket: [AIO-1217](https://linear.app/je4light/issue/AIO-1217/prove-authentication-and-authorization-guards-for-team-brain-server), verified In Progress / High. Stable acceptance IDs below survive revision. This document becomes ACCEPTED only after independent subscription Claude Opus 5.5 specification review, fresh Astra permissioning design review, readiness, and exact full-text Linear attachment/readback. The user’s current model instructions override older model names in the workflow.

## Revision record — v6 all visibility resolver error refusal

Revision checkpoint: `b99d8c0ba837f1f353723b322983e4bf9b94742f`; accepted pre-revision specification SHA-256: `66a052cf886b12266925d8136cc427c84584475f6588d4867a3be2a1ebc21ae2`. The authoritative trigger is fresh Astra HIGH adjudication at worktree-relative `../aio1217-handoff/astra-scope-lookup-error-adjudication.final.md`: all four resolver read failures already require refusal, but three oracle failures lose their provenance before `visibleItemIds`, allowing empty consumer execution/revalidation. Content isolation does not satisfy that contract.

This material revision preserves the refusal outcome and authorizes one bounded shared materializer/error-propagation correction, subject to verified PR714 ownership/integration. It supersedes the tests-only scope premise; it does not reopen registry, People, approvals or deferred AIO-1225–1228 outcomes. AC-04/05/11–14 are affected; AC-06 and all inventory counts remain unchanged. Historical evidence/status entries below retain their original snapshot scope, not v6 acceptance; prior registry/People/approvals evidence is neither erased nor recertified here.

Before resuming any AIO-1217 implementation: complete affected independent subscription **Opus 5.5 HIGH specification review**, fresh Astra permissioning design review and readiness, then attach the **full exact revised accepted Markdown** to AIO-1217 preserving unrelated ticket content and verify full readback/hash. Attachment does not wait for the PR714 decision. After these admission gates, independent unrelated task work/evidence may continue; verified PR714 ownership/integration gates only the `lib/access/enforce.ts` edit. While that decision is unresolved, the six oracle-leg action cases remain **BLOCKED/FAIL, never PASS or DEFERRED**, and publication is held. Record the owner, branch/checkpoint, agreement, dependent callers, integration order and outcome in the durable handoff at worktree-relative `../aio1217-handoff/`; this operational decision does not alter the attached spec or its hash. The only valid outcomes are: AIO-1217 carries the bounded edit with verified owner agreement; reuse an accepted landed PR714 correction after rebase and rerun affected evidence; or return to Astra for revised scope, renewed review/readiness and exact attachment/readback before dependent implementation. Prior attachment/reviews do not cover this revision. The independent v6 Opus review completed successfully (exit 0, no denials) with **READINESS: BLOCKED** on B1/B2; this text addresses its findings but claims no completed rereview/readiness, attachment, implementation, tests or acceptance. After admission, the sole implementation writer remains subscription Opus 5.5 HIGH; the coordinator runs validation.

## Problem and intended behavior

Server Actions are independently callable POST boundaries. A page, layout, hidden button, action ID encryption, or a comment does not establish authority. AIO-1208’s route-file inventory deliberately excludes them. At this base an AST inventory of 1,617 repository source files finds **20 module-level directive files, 96 exported runtime actions, 13 erased type/interface exports, and zero inline/nested action directives**. Ninety-five runtime actions require identity or tenant authority; `signOutAction` is an intentional own-cookie protocol exception. These counts describe current source, not 96 proven vulnerabilities.

The change records every action and its exact current authority chain, adds a development-only regression gate for real invocation, and pins the applicable documented refusal conjunctions with executing action/owner tests. This is not a certification of complete content protection across all 96 actions: the independent meeting-todo create/export gap is explicitly deferred to AIO-1225 and the adjacent admin-key target-binding gap to AIO-1226 below. Admin identity/alias target binding (AIO-1227) and attribution drill-down viewer-policy reconciliation (AIO-1228) are also expressly deferred; their current authority invocation evidence cannot certify the missing desired protections. It also corrects two source-derived target-binding classes on unowned paths: a team A administrator can currently send team B’s legacy approval ID into a resolver with no caller-team input; and People actions authorize a supplied member ID while their writers can modify a different member’s resource or accept a foreign-team member ID. Runtime regressions must reproduce these paths on the unchanged base before implementation; no runtime reproducer has been executed during specification authoring.

Preserve current active-member, membership-derived admin, content visibility, self-account, and deliberate public protocol behavior. In particular, People editing retains `canEditMemberContext`’s self-or-admin rule; this task does not add an Everyone/team-posture prerequisite to that editor or reinterpret leads/external members. The existing context editor is a source-specific self-or-role-admin rule (lib/identity/context.ts:70–77 and test/identity-can-edit-context.test.ts), distinct from canAccessAdmin’s /admin and Social role-plus-posture rule. Active external-posture administrators retain same-team admin-other editing; target status/kind is not an additional eligibility predicate. Projects remain creatable by current active members. Existing task/decision writer and project visibility predicates remain necessary. Registered pure predicates never authenticate on their own.

## Installed framework and source authority

Read before proposing this design: installed Next **16.3.0** `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-server.md`, `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, and `node_modules/next/dist/docs/01-app/02-guides/authentication.md`. Module directive prologues expose exported async Server Functions; inline function directive prologues are another declaration form, including nested closures. Untrusted serialized arguments/FormData cannot supply the authenticated identity or establish ownership. POST/origin checks and closure encryption supplement application authorization. Client-side sequential dispatch does not serialize independent requests. Our discovery is conservative source inventory, not proof that every source is bundled or reachable over the wire.

The Postgres target has no RLS authorization backstop (`lib/db/types.ts`, `docs/ARCHITECTURE.md`). `currentMember` in `lib/auth/guard.ts` binds the session’s auth-user to an **active** member in the requested team and resolves current viewer posture through `resolveViewerPosture`. `requireTeamAdmin` delegates to `lib/integrations/read.ts:resolveIntegrationsAdmin`: team slug, active same-team member, `role=admin`, and unrestricted membership-derived posture. `canAccessAdmin` alone is a co-predicate, not identity. `getSessionUser` identifies an auth account; account password setup/change intentionally does not require a currently active tenant membership. `authorizeGatewayAdmin` now uses the AIO-1208 same-connection membership-derived guard; delegated gateway token semantics remain unchanged.

## Ownership and scope

Actual PR/worktree ownership records were read before selecting changes. PRs **733/734/735 against main** own `app/actions/decisions.ts` and governed decision/note consumers. PR **714 draft against staging** owns `app/t/[team]/admin/members/actions.ts`, `lib/access/enforce.ts`, and related identity/password/admin services. PRs **738/739 against staging** own membership materialization/bootstrap behavior. The active stagingmark5 worktree overlaps `lib/access/groups.ts`. Hold production edits to these areas. Inventory registration, source inspection and executing regression tests can cover their current behavior without becoming a parallel implementation. A newly demonstrated defect there requires an explicit recorded owner/integration decision before code; this task must not copy pending PR fixes.

The original checker/tests and target-binding runtime corrections use unowned paths: approvals action, `lib/actions/index.ts`, People actions, `lib/identity/profile.ts`. No new schema/migration or membership writer is planned. Recheck ownership before implementation and publication. Read-only census shows `resolveApproval` has **one** production caller (the approvals action) and five existing unit call sites across four resolver test cases; profile mutations have only the People production action caller and existing direct data-mechanics tests. `getMemberAvatar` is a reader and remains compatible. The profile single-writer boundary remains in its existing owner file. The sole additional runtime permission is at `lib/access/enforce.ts` item-scope materialization/error propagation, a held/shared PR714 path. Before the `enforce.ts` edit, verify one owner and agreement with PR714 and record owner, branch/checkpoint, dependent callers, integration order and permitted outcome in `../aio1217-handoff/`, without changing the attached spec hash; an unacknowledged coordination message is not agreement. Follow the revision record's three outcomes: agreed AIO-1217 edit, accepted landed PR714 correction reused after rebase, or return to Astra for revised scope. Unresolved ownership holds this edit and publication, with the six oracle-leg cases BLOCKED/FAIL; after review/readiness and exact Linear attachment/readback, independent unrelated task evidence may continue. This is not a membership writer or general access-policy redesign.

Deps: PR 741 / AIO-1208 is already merged into staging and included in base c5e832c2ff179ee5c99f95966fba1ed9ce77ae3e. No further pending slice was required for the original target-binding corrections; the v6 order is review/readiness → exact Linear attachment/readback → implementation resumption, with verified PR714 ownership/integration additionally required before the `enforce.ts` edit. For reuse, the accepted PR714 correction must land before rebase, followed by affected evidence and review before publication; for an AIO-1217 edit, owner agreement and the recorded integration order must precede that edit. Production edits to the recorded owned paths remain held; recheck ownership before the applicable edit. AIO-1225, AIO-1226, AIO-1227 and AIO-1228 are deferred sibling follow-ups, not prerequisites or implemented protections.

Increment: one PR against staging for the finite Server Action inventory/tests and the two selected target-binding runtime families plus the bounded v6 shared error-propagation correction. Separate sibling specifications own meeting-todo source/write/export authority (AIO-1225), administrator-issued API-key target binding (AIO-1226), identity/alias member targets (AIO-1227), and attribution item viewer policy (AIO-1228).

Expected implementation paths: new file to create: `test/guards/server-action-auth.test.ts`; new file to create: `test/guards/helpers/server-action-auth.ts`; new distinctly named aio1217-*.test.ts action denial fixture files to create under `test/actions/` (split by current module families; existing governed-action fixtures are not replaced); new file to create: `test/datamechanics/server-action-target-binding.datamechanics.test.ts`; new file to create: `test/datamechanics/server-action-scope-connections.datamechanics.test.ts`; existing `test/guards/entry-surface-graph.ts` and its `test/guards/context-hook-callsites.test.ts` for a narrowly reusable pure directive predicate or agreement regression; the four targeted runtime files above plus the ownership-gated `lib/access/enforce.ts` correction, and `docs/ARCHITECTURE.md` for precise discovery/proof bounds. Existing `lib/actions/actions.test.ts`, `lib/ingest/fake-supabase.ts`, `test/datamechanics/member-context.datamechanics.test.ts` and `test/datamechanics/member-profile.datamechanics.test.ts` may be updated for required internal inputs and compatible import controls. The existing AIO-1208 helper may expose a small shared **development-only** invocation primitive if that avoids a second analyzer; preserve all its existing cases (including parameterized regressions) and route policy intact. Do not move runtime auth into a test helper, build a general CFG/import evaluator, or rewrite action families to fit checker convenience.

## Finite discovery and invocation gate

Discover filesystem source, including untracked files, rather than only a regex over known action filenames. Parse TS/TSX/JS/JSX/MTS/CTS/MJS/CJS source across the repository, explicitly including `app`, `src`, `pages`, `components`, and `lib`. An executable directive in another first-party source root is an unsupported/unclassified action location until reviewed, not silently ignored. The root is the current task repository root supplied explicitly to discovery; never scan parent worktrees/ancestor .context directories. Do not enter the pinned repository-root non-product roots (`node_modules`, `.next`, `.git`, `.context`, `coverage`, `out`, `build`, `.yarn`, `.vercel`, `.pnp` and root-generated `.pnp.*` files, `.aios`, `supabase`, `tmp`, `.staging-pair-artifacts`, `.staging-ops-reaper-checks`): respectively dependency/framework/Git/recovery/test-output/build-output/tool-state/local-stack/customer-scratch/operational-evidence exclusions. Current root .gitignore supports its declared generated/dependency exclusions; .context is instead a task-recovery policy backed by actual common .git/info/exclude line7 (git check-ignore -v .context/example-evidence.json), not by .gitignore. These are evidence for pinned exclusions, not authority to exclude every ignored or untracked first-party file. Match pinned excluded root/path names before symlink classification or parsing, so even a symlinked root node_modules is skipped without visiting its target (current task node_modules is physical, not a symlink). The additional pinned nested non-product policy excludes ingestion/.venv, ingestion/.pytest_cache and __pycache__ directories strictly below ingestion, as supported by ingestion/.gitignore; no app/src nested node_modules/.next or arbitrary ignored first-party directory is excluded. Never parse a malformed supported-extension file inside those pinned dependency trees. Other nested third-party trees require an explicit reasoned exclusion revision; unsupported/unparseable first-party source fails with a path diagnostic, never an automatic ignore. Root-relative paths must not escape the root. After name exclusion, skip .env* and other unsupported non-source files without reading content or probing their symlink target. Diagnose nonexcluded symlink directories and supported-source-file symlinks; do not follow them outside the root or fail solely on an unrelated non-source file link; do not skip a nested directory merely for sharing a generated-directory name inside an application root. Pin exclusions with reasons and fail deliberate exclusion/config drift. Shape fixtures containing executable directives live in source strings/in-memory inputs or independent temporary fixture roots passed explicitly to the scanner; no checked-in direct directive fixture silently enters or is broadly exempted from the production census. Temporary-root tests must discriminate skipped symlinked root node_modules, diagnosed app/x directory/source symlink, malformed ingestion/.venv/**/x.js intentionally skipped, and nested app/node_modules/action.ts still discovered. A current-source discovery census must reconcile all 20 modules/96 runtime exports/13 erased types, and a temporary-filesystem mutation must find an added action in a nested directory, alternate supported source extension, and `src/app`. Comments, strings outside directive prologues, and erased types create no action.

Every module directive runtime export is keyed by `(repository path, export name)`. No missing, duplicate, stale registration, missing evidence path, or missing reason passes. Inline directives must also be discovered. Current inline count is zero: initially fail closed with file/function/line diagnostics for **all inline actions** until a reviewed explicit registration and supported identity shape is added. This deliberate finite admission avoids inventing stable identities for anonymous closures. Pin the exact directive semantics of existing test/guards/entry-surface-graph.ts:949–999: scan StringLiteral ExpressionStatements at any position in the contiguous directive prologue, including use strict before use server; stop at the first other statement. Comments may precede prologue statements, but templates, arbitrary/non-prologue strings and expression-bodied arrows are not directive prologues. Enumerate every block-bodied function declaration, function expression, arrow function, class/object method, constructor, get accessor and set accessor, including named/anonymous/nested and generator bodies; unsupported/sync/non-Next-admitted shapes are still discovered then refused, not hidden. Bodiless signatures/type nodes cannot carry a directive. One positive/negative fixture per body-bearing form plus module/multiple-prologue cases and agreement with the existing detector over that corpus is required. Reuse its pure predicate via a narrow dev-only export/extraction or compare existing lib-surface classification without changing its authorization policy; do not invent a second incompatible prologue detector. Merely unsupported syntax cannot become a public exception.

Initially support the actual async non-generator exported function declaration shape, plus immutable const async function/arrow bindings and local immutable alias exports only if tested with explicit lexical resolution. Fail closed on export-star, external re-exports, namespace/import-equals exports, mutable let/var exports, anonymous/default exports without supported stable identity, non-async/non-function runtime values, decorators/unsupported parse shapes, and sync/async generators. Explicit fixtures cover `export *`, `export { h as action }`, default, import-equals and let/var. A local named alias may be deliberately refused instead of supported; its refusal must be tested. Type-only exports are ignored without hiding adjacent runtime exports.

Each protected row pins the **exact set** of registered owner module/export/member identities called by that action or its actually invoked local function chain. Reuse AIO-1208’s approved lexical rules: imports/comments/strings/type references, shadowed imports, wrong canonical modules, merely declared helpers, uncalled closures, and every generator count for nothing. For asynchronous guards admit only direct await, returning the promise, or direct array-literal elements of a directly awaited unshadowed standard Promise.all. Pin the actual two visibleProjectRows calls in mintAgentTokenAction as an admitted full-policy control, and reject non-awaited array/combinator and shadowed Promise controls. This is finite syntax, not arbitrary array/promise data flow. Async helper calls must be completed in those admitted forms; a fire-and-forget promise does not establish completion before the protected effect. Traverse only explicitly invoked ordinary local helpers with cycle protection. `linkMemberSlack` genuinely delegates to the exported ordinary `linkMemberIdentity`; preserve that shape. Imported opaque action wrappers need their own registered owner and executing denial evidence, not a substring exemption.

Each registration declares completion mode sync or async, verified against the exact owner declaration before invocation credit. The finite supported owner shape is the current canonical exported ordinary function declaration (or explicitly supported/tested immutable local binding), with async modifier required for async mode; the three current sync co-predicates have no async modifier and an explicit boolean return annotation. Unsupported/ambiguous owner declarations or stale mode fail closed. This is a source-declaration pin, not inference over arbitrary promise-returning bodies. A sync predicate is legitimately not awaited; sync→async mutation with a stale registration must fail before its calls can count. Called local helpers additionally derive their mode from their actual declaration and obey completion requirements at each call edge.

| Existing registered owner declaration | Completion mode |
| --- | --- |
| lib/auth/guard.ts currentMember / requireTeamAdmin | async |
| lib/auth/session.ts getSessionUser / signOut (own-cookie protocol) | async |
| lib/gateway/admin-persistence.ts authorizeGatewayAdmin | async |
| lib/access/enforce.ts canWriteStructuredRow / canSeeProjectRow / visibleItemIds / visibleProjectRows | async |
| lib/meetings/notes.ts getMeetingNote | async |
| lib/social/store.ts actorSeesChain | async |
| lib/graph/partition-read.ts resolveArcScope | async |
| lib/identity/context.ts canEditMemberContext | sync, boolean |
| lib/meetings/notes.ts canSeeMeetingNotes | sync, boolean |
| lib/auth/admin-access.ts canAccessAdmin | sync, boolean |

Inline role/posture co-checks have no imported owner declaration: record them as inline structural requirements plus executing verdict tests, not fake sync functions. Owner cases still prove actual semantics. Static named imports/aliases and the actual const object-destructure form const { exportedName: localName } = await import('canonical literal module') are admitted with the same canonical module/export identity. Each credited element must be a plain identifier/property rename without default/rest/spread/nested binding; mutable let/var or nonliteral/unawaited import forms fail credit. Do not weaken the existing route analyzer to admit new syntax. Controls cover renamed dynamic imports and unawaited sync calls; mutants cover dropped await on requireAdmin, stale owner sync→async, default/rest/mutable dynamic binding, nonawaited collections and shadowed Promise. The completion-aware rule belongs to this Server Action checker. AIO-1208 route registrations/credit policy remain unchanged; share only narrow lexical/import/directive primitives and rerun existing route regressions if their helper is touched.

Canonical owner identity is finite syntax: current root `@/` alias or an extensionless relative path to the registered sole TypeScript module (extensionless canonical owner points to its reviewed .ts file). Wrong bare-package, `/index`, explicit alternate extensions, unrelated export or shadowing cannot satisfy a guard. Record the current owner-file/alias census and fail on drift in the pinned alias/owner files; do not claim arbitrary package/import resolution. Pure authority predicates (role/admin, content writer, note/project visibility) are co-guards requiring current session/member identity. Preserve expected exact sets when a tenant-admin guard is replaced by weaker identity-only access.

This gate pins **invocation identities**, not arbitrary control-flow dominance, argument correctness, verdict handling, or owner semantics. Small syntactic dead-code pruning may be reused; it must be documented precisely. Executing tests establish refusal/ordering for the actual boundaries and target binding. No green AST run should claim branch-complete authorization. Tests must kill real in-memory full-policy mutants: new unregistered export/directive, removed guard call, guard downgraded to session-only, import/comment/unused helper, spare guarded export, shadow/wrong module, unawaited async guard, generator helper/export, and stale protocol/evidence. An admitted ordinary awaited helper control prevents a reject-everything analyzer from passing.

## Finite scope connections and refusal boundaries

A registered resolver invocation and its error refusal do not prove that the returned scope constrains downstream work. The current actions forward the scopes described below, but the adjudicated candidate loses oracle-error provenance before two actions infer successful empty scope. V6 adds the bounded shared correction below alongside the existing executing connection proof; it does not allege a current omitted scope argument. The independent HIGH skeptic confirmed a source-derived mutant: removing only the meeting scan action’s visibleItemIds option retains every authority call/error branch but allows the trusted scanner’s optional scope to become team-wide. No runtime reproduction was executed during design. Social item discovery differs: missing visibleItemIds already fails closed, so omission must be detected by its admitted visible-content control, not asserted to leak. Arc discovery takes a required groups argument; replacement with a wider/stale/wrong-principal group set is its applicable mutant.

The finite list is **15 scope connections across 14 distinct exported actions** (generateDrafts has two). It does not imply generic interprocedural data-flow analysis. For each row execute the actual export with valid enabled input and preceding authority admitted; assert server-authenticated team/member identity, successful empty and partial scope where meaningful, excluded data/effects, and a nonempty admitted control. Couple exact action-to-consumer argument/verdict assertions to executing consumer confinement evidence with the same fixture scope, or run the real consumer through the action. A mocked consumer alone cannot certify private-read confinement. Recording graph/provider/model boundaries are permitted; never call live services. Retaining a resolver call/error branch while omitting/discarding/widening its scope or substituting another principal must fail the applicable executing tests. Do not require an ill-typed missing positional-argument mutant or call a fail-closed no-op a leak. Counts/source-read tests alone are insufficient.

| Exported action / connection | Server authority → consumer | Required finite observable proof |
| --- | --- | --- |
| scanMeetingTodosAction | visibleItemIds(team.id, auth.memberId) → scanMeetingTodosForTeam options.visibleItemIds | Actual action against real PG visible/restricted transcript fixtures: candidates, scanned count and returned source content exclude restricted rows; genuine successful empty scope invokes the scanner and yields none; visible control yields candidate. Each of the four resolver faults must instead produce the exact refusal and zero consumer/effects below. Omitted option, widened IDs and wrong-principal resolution mutants fail. Existing direct enfb2 scanner tests alone do not prove this connection. |
| discoverNow | visibleItemIds(ctx.teamId, ctx.memberId) → discoverOpportunities options.visibleItemIds plus actor.memberId | Exact item set/actor reaches real discovery’s item predicate; loaded candidate bodies and persisted/returned opportunity title, summary and evidence exclude restricted sentinel content. This discovery is deterministic scoring, with no model call; a zero model-call spy alone proves nothing. Missing option remains fail-closed and breaks nonempty admitted control; widened/wrong-principal mutants break confinement. Each of the four resolver faults must produce the exact refusal and zero consumer/effects below; genuine successful empty scope still invokes discovery and retains successful revalidation. Existing direct enfb4 discovery coverage alone is not action wiring proof. |
| discoverFromArcsNow | resolveArcScope(ctx.teamId, validated teamSlug argument, ctx.memberId, team tier) → discoverOpportunitiesFromArcs groups plus actor.memberId → getFusedArcs | Exact returned group list reaches actual discovery and fused-arc partition selection; record graph read group/model input and resulting opportunity evidence, with empty/partial/admitted controls. Wrong-principal or broader/stale substituted groups fail. Stubbed injected arcs alone do not prove production partition selection. |
| planNow, generateDrafts, submitApproval, decideContentApproval, scheduleVariantAction, cancelPublicationAction, generateImage (seven connections) | actorChainGate → visibleItemIds(ctx.teamId, ctx.memberId) → actorSeesChain(team, reference, exact set) → honored boolean verdict | Actual action uses the authenticated actor’s set at the chain oracle; execute real team-bound publication/variant/plan/opportunity lookup and every-evidence visibility predicate with partial/empty/nonempty sets. Wrong actor/set or ignored denied verdict must not admit its downstream plan/approval/schedule/cancel/generation effect. Shared owner cases can establish chain semantics, but each export must prove its actual connection and honored verdict. |
| generateDrafts (second connection) | second visibleItemIds(ctx.teamId, ctx.memberId) → generatePlanDrafts options.actorVisibleItemIds → generateVariantText evidence checks | First chain check admits; a deterministic second narrower/empty scope must still confine draft evidence before model input/status writes. Exact second set reaches consumer; omit/widen/wrong-principal mutants fail. This pins the existing second check without promising linearizable visibility after final admission. |
| mintAgentTokenAction (projects mode) | visibleProjectRows(ctx.teamId, admin ctx.memberId) AND visibleProjectRows(ctx.teamId, request launcher memberId) → normalized requested project subset → mintAgentToken | Both actual principals’ sets and existing `VisibleProjectRows.error` arms are independently honored; token target team/member and normalized requested scope match server-validated request. Foreign/wrong-principal or widened selected-set mutants fail. Empty/partial selected scopes use valid contract cases; all-reachable intentionally performs no enumeration and preserves existing live authority semantics. |
| extractMeetingActionItemsAction, regenerateMeetingSummaryAction, pushMeetingTasksAction (three connections) | getMeetingNote(team.id, noteId, viewer memberId=me.id and tier=me.tier) → canSeeItem for source → admitted content/effects | Actual action and real note owner distinguish actor-visible/restricted notes before private body/attendee/task data or model/provider effects. Wrong viewer and ignored null verdict mutants fail applicable typed cases. getMeetingNote requires viewer: removing that positional argument is ill-typed, not required as an executing omission mutant. Extraction’s second fresh getMeetingNote uses the same actor; pin the repeated check. Admitted controls reach the appropriate extraction/summary/eligible-task provider recording seam. |

The 96-row inventory’s effect lists identify operations to observe; they are not universal zero-call lists for every later denial. Each executing case records **which conjunction denied, permitted earlier prerequisites, and forbidden subsequent effects**. Valid input and earlier admission avoid vacuous validation/feature-off denial. Preserve existing ordering; no new key-resolution ordering or graph-arming policy is introduced here.

| Refusal case | Permitted prerequisite work | Forbidden subsequent effects / required observation |
| --- | --- | --- |
| Missing identity/member/admin, or role/posture denial | Existing identity/team/member/posture resolution; the three row-derived-team actions below additionally permit their exact minimal pre-identity metadata lookup, not downstream content/key resolution | That action’s secret resolution, content owner, provider/model/discovery/mutation/success audit, revalidation and after callbacks remain uncalled. Current permission-owner read behavior is not rewritten. |
| Row-derived-team actions before identity: moveTaskAction, updateTaskAction, setDecisionValidityAction | Current task metadata team_id (update additionally project_id/row_key) or decision team_id by supplied ID establishes which team to authenticate; no title/body read | Missing ID retains task/decision-not-found; existing row without authority retains not-a-member/admins-and-leads-only. This metadata lookup and existence distinction are reachable even with no session at all and are deliberately retained; no uniform absence claim. After identity/content refusal no mutation, parent validation, provider/projection/after callback; app/actions/decisions.ts remains held. |
| Meeting scan/item discovery visibility lookup error: `members`, `group_members`, `project_groups`, or `project_context_memberships` resolver read | Valid input and admitted identity/posture; same-team resolver reads, with the fault occurring after authentication admission | Exact `{ok:false,error:"visibility resolution failed"}`; zero scanner/discovery invocation, private source load, model call, opportunity write and cache revalidation; durable rows unchanged. No empty-success or widening fallback. |
| Arc discovery scope refusal/fault after admin/feature admission | Existing internal resolveAnsweringKeys may read/decrypt this authorized team’s provider settings/config before resolveArcScope. Values stay internal and are not returned/logged in fixtures. The scope owner may perform its existing same-team oracle-visible-project arming/readiness operations before a later readiness/debt/recency fault. | No discoverOpportunitiesFromArcs/getFusedArcs, external provider/model call, social opportunity/content mutation, success audit or cache revalidation. Assert ordering with recording seams and distinct early versus late scope faults. A member-enforcement/oracle fault before project selection performs zero arming; a later fault may retain only existing bounded graph arming/readiness effects. Never assert zero total database writes for that late fault. |
| NOTE content denial (null/lookup fault) | getMeetingNote’s initial team/note row read includes title/summary as well as source/identity/time metadata, followed by canSeeItem visibility resolution; these authorized internal prerequisites are the current guard itself | Initial title/summary must not be returned or fed to model/provider/cache on refusal. No later private transcript body/attendee/eligible-task expansion after denied visibility, key/provider resolution, model/extraction/summary writes, projection, success audit or revalidation. getMeetingNote being called is required, not a failed zero-effect assertion. |
| Social CHAIN content denial or second draft-scope denial | Admin admission and team-bound chain/visibility prerequisite reads; for second draft check the earlier chain check has admitted | No subsequent plan/approval/schedule/cancel/generation dispatch/model/output writes or revalidation; only the applicable operation for that export is asserted. |
| Selected agent-project scope denial | Admin admission and normalized request validation; both visibility lookups as existing Promise.all requires. Launcher eligibility lookup is in mintAgentToken, after these selected-scope checks | No token issuance/revocation/mutation-success audit or cache revalidation; each principal/error arm is discriminating. Here “lookup error” means only the existing `VisibleProjectRows.error` arm. Its `writerRule → visibleProjects` legacy-wrapper oracle-leg narrowing remains fail-closed and is not certified as refusal by v6; no correction to that path is authorized. |
| Later validation/eligibility denial after NOTE admission | Existing admitted note content and provider-selection prerequisites if current push path reaches them before task eligibility | No outbound projectRows/provider request or successful projection/write/revalidation for no eligible tasks. Do not claim provider selection never occurred after note admission. |

Source authority for these distinctions includes lib/graph/partition-read.ts:51–135 and lib/graph/arming.ts:27–165: arm-on-read is prescribed, restricted to selected oracle-visible initiative projects; readyPartitions may latch readiness. lib/query/answering.ts:43–82 and lib/integrations/manage.ts:314–341 perform internal configuration/secret resolution, not an outbound call. lib/meetings/notes.ts:426–442 establishes note visibility before expanding private note content. Tests pin these boundaries; only the ownership-gated v6 shared materializer correction may edit the held path. The desired meeting-todo create/export protections remain DEFERRED AIO-1225. Scope-owner PG and actual-export connections live in the new file to create: `test/datamechanics/server-action-scope-connections.datamechanics.test.ts`; focused unit action wiring fixtures are new files to create under `test/actions/`. The arc path executes real discoverOpportunitiesFromArcs/getFusedArcs, recording readArcCache partition key g:<group> and lower graph/model/warmer calls; injected arcs alone are insufficient. getFusedArcs returns empty arcs/warmScheduled=0 for [] before reads (arc-fusion.ts:92–99); pin it and a nonempty cached-partition admitted control. These are synthetic real-PG/recording-seam tests, not live graph/model tests.

### Bounded shared correction: preserve resolver failure provenance

Membership/grant rows remain authoritative. Canonical ownership is **`lib/access/oracle.ts:visibleProjectsWithError` (project visibility) → `lib/access/enforce.ts:visibleItemIds` (item materialization and error propagation) → existing actions (consumer/revalidation admission)**. The error-aware oracle already returns `error:true` for `members`, `group_members` and `project_groups` read failures. The legacy `visibleProjects` serving wrapper discards that flag; materialization then short-circuits as successful empty. The fourth leg, `project_context_memberships`, already reports a materializer error. The shared defect is loss of failure provenance, not demonstrated private disclosure.

Authorize one correction at the shared item-scope materialization/error-propagation boundary: carry the existing error-aware oracle result through `visibleItemIds`, returning empty IDs with error on any of those failures so the existing action refusal branches stop execution. Preserve successful visibility predicates/attenuation and legitimate empty results without error. Do not globally change the legacy `visibleProjects` serving API, infer failure from emptiness, duplicate/diagnose the lookup in actions, or separately patch either action. No new retry, job, compensation or linearizable-revocation guarantee: downstream work never starts on refusal; a later request resolves current authority afresh.

#### Production caller census and compatibility decision

The independent review identifies **ten production call sites** of `visibleItemIds` (the shared chain site serves seven exports). These compatibility decisions are part of v6, not deferred until after attachment. “Oracle fault” here means the `members`, `group_members`, and `project_groups` resolver legs; `project_context_memberships` already propagates its error. Only the affected outcomes listed here are authorized by the shared correction; no caller runtime rewrite or general API error contract is added. Successful empty/partial/nonempty behavior remains compatible.

| Production call site (reviewed source line) | Oracle-fault behavior before → required after | Compatibility decision and required evidence |
| --- | --- | --- |
| `app/actions/meeting-todos.ts:84` — `scanMeetingTodosAction` | Empty scanner execution → `visibility resolution failed` before scanner | Intended change; all four fault legs through the actual export refuse with zero consumer/effects/revalidation. |
| `app/t/[team]/social/actions.ts:47` — `discoverNow` | Empty discovery execution/revalidation → `visibility resolution failed` before discovery | Intended change; all four fault legs through the actual export refuse with zero consumer/effects/revalidation. |
| `app/t/[team]/social/actions.ts:33` — `actorChainGate`, seven exports | `not found for team` → `visibility resolution failed`; zero downstream effects in both | Intended refusal-text change; one oracle-leg fault through a real chain-gated export plus shared-owner coverage pins propagation and zero effects; retain all seven existing connection/verdict obligations. |
| `app/t/[team]/social/actions.ts:119` — `generateDrafts` second scope | `generatePlanDrafts` executes then throws its own evidence check (`lib/social/generate.ts:238–243`) → consumer never executes, action returns `visibility resolution failed` | Intended earlier refusal/error-text change; one oracle-leg fault at the second resolver invocation through the real export plus shared-owner coverage; no generation/model/output writes/revalidation. |
| `app/api/v1/evidence/search/route.ts:49–50` — member-key branch | 200-empty → 500 `enforcement check failed` | Intended change; actual member-key route regression with resolver fault and fault-free admitted control. Delegated agent-token residual is disclosed separately. |
| `lib/meetings/notes.ts:361–362`, via `lib/meetings/loaders.ts:26–28` — meetings list | Successful empty → thrown error reaching the error boundary | Intended change; real notes/loader path regression with resolver fault and fault-free admitted control, asserting rejection rather than successful empty rendering. |
| `app/t/[team]/social/page.tsx:57–58` — Social page | Successful empty → thrown error reaching the error boundary | Intended change; page-path regression with resolver fault and fault-free admitted control, asserting rejection rather than successful empty rendering. |
| `app/api/dashboard/social/media/[id]/route.ts:36–37` | 404 → 404 | Unchanged; bounded caller check pins existing 404 on oracle fault. |
| `app/t/[team]/people/[handle]/page.tsx:99–101` | Explicit empty → explicit empty | Unchanged; bounded caller check pins swallowed error/empty behavior. |
| `lib/access/inspect.ts:189` | Error flag ignored → error flag ignored | Unchanged; bounded caller check pins ignored flag/empty item result, not a new refusal. |

For each changed non-action surface, a named oracle-leg regression must execute its real caller branch through the shared materializer; shared-owner coverage supplies the three-leg propagation matrix without multiplying every caller by every fault. Record all ten caller decisions and their named evidence. The evidence-search delegated branch remains `delegatedVisibleItemIds → effectiveVisibleProjects → visibleProjects` (`lib/access/oracle.ts:142–152`): the same oracle fault still yields 200-empty for an agent token while the member-key branch now yields 500. Preserve and record a discriminating delegated control as a disclosed legacy-wrapper residual; correcting it is outside v6. Do not promise uniform evidence-search or other API behavior beyond these call sites.

Second-draft fault arming must count `visibleItemIds` invocations: first execute a real successful `actorChainGate`, including its real chain/evidence visibility check, then arm one oracle-leg fault specifically inside the **second** invocation. A first SELECT per client/table fault would hit the chain gate and cannot satisfy this case. Record first-call admission, second-call fault activation and zero `generatePlanDrafts` calls; pair with a fault-free admitted draft control. This bounded one-leg actual-export case plus shared-owner coverage does not claim an eight-case draft matrix.

Keep registered invocation identities/completion modes unchanged; this correction needs no AC-02/03 registration expansion. Recheck caller drift before the shared edit/publication against this decided census; material new impact returns to Astra. The PR714 gate in the revision record applies only to the shared edit, with publication held while unresolved.

Required executable evidence in `test/datamechanics/server-action-scope-connections.datamechanics.test.ts`: **both actual exports × each of the four resolver fault legs** (eight cases), valid enabled input with identity/posture already admitted. Prove each fault fired at the resolver read, not an earlier authentication read, and surfaced through the real adapter/materializer. Assert exact refusal, recording boundaries with zero scanner/discovery calls, zero private source loads/opportunity writes/cache revalidation and unchanged durable rows. Pair with fault-free nonempty admission and partial-scope confinement for both exports. Preserve S2/D2 item-membership-empty admitted controls, and add a distinct genuine **oracle-zero-project, no-error** control for each actual export: a genuinely grantless actor returns zero projects without error at the oracle (the existing `oracle.ts:85` or `:106` path), reaching `projectIds.size === 0` before item-membership lookup. Moving item memberships while retaining a project grant does not meet this obligation. Both controls invoke the consumer successfully with zero results; discovery still revalidates. Assert the no-error result and short-circuit, so a mutant that converts an empty project set into error fails. No-error emptiness is not refusal.

Use the executing source/test-substitution convention used for the People and response mutants: load a test-time source substitution of the shared materializer or action, execute the real fault/control cases against it, and require the applicable assertion failure. Discarded/ignored error propagation, consumer continuation despite error, and zero-project emptiness converted to error must be killed alongside the accepted omission/widening/wrong-principal mutants. These are executable substitutions, not AST registry mutations (invocation identities do not change), and `enforce.ts` mutants are test-time substitutions, not on-disk edits to the held production path. Content-isolation-only output is explicitly insufficient. The adjudicated S4/D4 evidence excludes refusal, consumer-zero and revalidation assertions; its exit-zero result proves only its actual assertions, not these eight cases or all 15 connections. Capture named pre-correction failure and post-correction evidence against their exact snapshots: the expected pre-correction RED set is exactly six oracle-leg action cases (two exports × three oracle legs); the two `project_context_memberships` cases are already green and must remain green. Do not relabel old results. Synthetic executor rejection converted by the real adapter is acceptable when labelled as such, not native-driver-outage proof.

## Targeted runtime correction A: legacy approval team ownership

Current `decideApproval` resolves a team admin but reads `governed_actions` by approval ID alone and calls `resolveApproval` without team identity. `lib/actions/index.ts:ResolveApprovalInput` has no team ID. The resolver reads `approval_requests` by ID, actions by approval reference, writes the approval and actions by ID, audits under the approval row’s team, and invokes the action handler with that row’s team. `finish` also writes by action ID alone. `postgres/schema.sql` gives approval/action/member independent global UUID foreign keys; there is no composite tenant constraint or unique action-per-approval constraint. The stale RLS comment does not provide enforcement.

Constructed scenario: session member is active unrestricted administrator of A; pending legacy approval/action belongs to B; invoke `decideApproval(A.slug, B.approvalId, approved|denied)`. The desired result is `{ok:false,error:"approval not found"}`, B approval/action rows and audit ledger unchanged, zero sandbox/handler dispatch and zero revalidation. The base action/resolver currently has no predicate connecting the authorized A context to B’s IDs. Required pre-fix tests must demonstrate the mismatch, not only a mocked resolver argument. After administrator admission validate approvalRequestId with the existing isUuid helper before database/sandbox operations; malformed IDs return fixed invalid request. Foreign governed approvals must also return exactly approval not found before governedActions.decide, matching absent/foreign legacy without audit/revalidation; same-team GovernedError mapping remains. governed/errors.ts maps not_found to Action or destination not found, so relying on its foreign-routing catch would retain an unwanted existence distinction.

Make `teamId` a **required** resolver input supplied from `ctx.teamId`. `governed_actions` has **no team_id column**; tenant ownership is `governed_action_identities.team_id`. Routing and legacy exclusion must use that identity join (as `lib/actions/governed/index.ts:549–553` does), or an equivalent bounded minimal identity lookup chain through the supported adapter. Do not invent `.eq("team_id", ...)` on governed_actions or assume an unregistered adapter embed exists. First establish the approval’s authorized tenant; detect governed ownership by minimal ID/identity fields and verify its identity tenant before routing. A governed identity team differing from the authoritative approval team returns approval not found; an owned approval marker with a missing owner row or a different governed action ID returns could not decide. Neither case authorizes legacy fallback. Existing governed core receives team context and remains the canonical owner; no governed consumer rewrite.

Resolver ownership reads and all approval/action writes—including shared handler completion—must use the authoritative team. A linked action’s tenant must match its approval tenant; inspect only minimal identifiers until that match is established, then load execution payload under the team predicate. Resolve errors and ambiguous multiple linked actions fail closed before writes/audit/dispatch. This adapter’s `.maybeSingle()` returns the first row even when multiple rows exist (`lib/db/pg/query-builder.ts:378–383`); inspect list cardinality explicitly, e.g. at least two minimal identifiers, for nonunique legacy approval links. Global approval UUID primary key and governed approval_request_id uniqueness do not make legacy actions.approval_request_id unique. No unscoped private params lookup may discover ownership.

**Producer readiness and standalone approvals.** `runAction:87–105` inserts a pending approval with `context.action_id` before linking the existing action. The pending queue can expose it during that gap. A reverse-link miss is not orphanhood. A present action_id requires valid same-team forward identity, reverse link to this approval, and action status **pending_approval** before deciding. Present invalid/mismatched action_id is malformed intent; a producer not yet linked refuses with named `approval not ready` result (retry can succeed only if the producer resumes), leaving approval/action/audit unchanged and dispatch zero. After the producer resumes, a new decision can proceed. A running/terminal linked action is a permanent inconsistent-state refusal, not promised retryable. If the producer dies after approval insertion and never finishes the reverse link, the pending approval/requested action can remain stranded indefinitely; this task documents that operator-managed residual instead of claiming a liveness repair. A genuine standalone approval is non-governed, has no action_id metadata **and no reverse-linked action**; it remains a decision-only operation without dispatch. There are zero current production standalone producers: runAction always supplies context.action_id and the governed producer always supplies context.governed_action_id. Compatibility tests seed genuine standalone rows directly; retaining this arm is not a claim of a current browser/API producer. A present context.governed_action_id is governed intent, even if its governed row is absent: malformed marker, missing owner row or a marker naming a different governed ID returns could not decide, never legacy standalone; an owner identity belonging to a different approval team returns approval not found. One reverse-linked action on an old metadata-free record still requires all tenant/state checks. Multiple or contradictory forward/reverse links refuse. Do not infer orphanhood/readiness from timestamps.

**Named refusal outcomes, distinct from faults.** Extend the internal ResolveApprovalOutcome.status union with malformed_links, ambiguous_links and not_ready, alongside existing not_found/already_decided/approved/denied. Return these outcomes for malformed/contradictory owner markers or links, ambiguous cardinality, and unready producer/running/terminal states respectively; the dashboard maps malformed_links/ambiguous_links to could not decide and not_ready to approval not ready. These successful lookup results are not persistence exceptions and emit no legacy_action_persistence_fault event. Absent/foreign remains not_found; an owned nonpending approval or lost pending claim remains already_decided, also without a fault event. Actual database returned errors/throws are LegacyActionPersistenceFault; post-claim prepare/deny/completion zero-row writes and checked shared runAction transition zero rows are faults because the required confirmed transition did not occur. Ordinary absent ownership/readiness and a lost claim must never be logged as a driver failure.

**Claim, preparation and durable completion.** Retain approval pending→approved/denied and action pending_approval→running→succeeded/failed, or denied, with not_found/already_decided outcomes. Claim the approval with an atomic team/id/**pending** conditional update and exactly one returned affected row. Lost claims cannot audit/dispatch. The winning human decision is durable and is not undone/replayed by a competing request. After that claim, check the linked action prepare/deny update’s returned error and exactly one returned row using `(team_id,action_id,approval_request_id,status=pending_approval)`. Dispatch only after running preparation is confirmed. A prepare/deny fault or zero-row state mismatch returns an infrastructure refusal, retains the durable approval decision and may retain the previous action state, with no handler dispatch or completion-success audit. This is a documented known-not-dispatched preparation failure, not an external handler failure. No producer transaction redesign or transaction-capability retrofit is required; never hold a transaction over sandbox/provider execution.

Capture handler outcome separately from result persistence: missing handler, returned failure and throw are known failed outcomes; a successful handler is a succeeded outcome. The handler catch must not include the terminal write. Persist completion under `(team_id,action_id,status=running)` with returned-error and matched-row checking, then emit/return the confirmed terminal status. A terminal persistence error/zero row after execution is a distinct uncertain-completion infrastructure failure: do not relabel a known successful handler as failed, attempt a second failed completion, emit action.succeeded/action.failed for an unconfirmed terminal transition, return normal success, revalidate, or replay the handler. A write may have committed before an envelope/connection fault; do not infer otherwise without readback. Preserve existing durable states and operator-managed recovery; no new enum/migration/worker or external exactly-once guarantee.

`runAction` shares `executeHandler`/`finish` with the resolver. Its sole production consumer is `app/api/v1/actions/route.ts:39`; the resolver’s sole production consumer is this dashboard action. Check runAction’s requested→denied, requested→pending_approval linkage and requested→running transitions before normal return/dispatch, bind shared completion to its authoritative team, and test compatible existing route error mapping (catch→500). An approval insertion followed by failed producer-link update does not become a truthful pending-approval success response. Do not silently expand beyond these selected state transitions. Five existing resolver call sites across four resolver test cases, and seven direct-run unit call sites must be reconciled; caller counts are source census, not passing test claims.

All ownership/claim/preparation/denial/completion errors are explicit failures, not empty success. Existing `GovernedError` mapping stays intact; action generic failure shape remains usable for infrastructure/uncertain completion. Refused outcomes do not revalidate; normal approved/denied messages require confirmed applicable transitions. Existing `audit` is **best effort** (`lib/api/audit.ts:24–51`), not an implicit required transactional-audit retrofit: returned-row/durable readback and exact dispatch counts are canonical evidence. No successful decision audit on foreign/absent/lost-claim refusal; a durable claim’s approval event may remain even when subsequent preparation fails. Never emit a confirmed terminal action event before its state is confirmed.

**Finite decision table.** API/result labels below map to the existing action result shape; infrastructure/uncertain failures use could not decide, never normal success. Every omitted write is also no success audit/revalidation. The phrase zero sandbox means zero SandboxRunner.run/E2B allocation/loader/provider execution; createE2BSandbox is a pure factory and may already be constructed before the resolver lookup. Readback/returned rows, not best-effort audit presence, establish confirmed state.

| Authoritative same-team tuple / event | Decision result | Durable change, dispatch, audit and revalidation |
| --- | --- | --- |
| Absent/foreign approval, including governed identity tenant mismatch | approval not found | none; neither resolver/governed dispatch, sandbox, audit nor revalidation |
| Malformed UUID after admin admission | invalid request | no database/sandbox/mutation/revalidation |
| Owned legacy approval nonpending (approved/denied/expired), or claim loses pending CAS | already decided by someone else | no new claim/dispatch/audit/revalidation; client may refresh independently |
| Malformed/ambiguous/contradictory forward or reverse ownership | could not decide | none; no private payload or dispatch |
| Pending + valid forward action requested but reverse link absent/not yet pending_approval | approval not ready for approve AND deny | untouched; zero dispatch/audit/revalidation; transient only if producer resumes, otherwise stranded operator signature |
| Pending + linked running/terminal action | approval not ready (permanent inconsistent-state refusal) | untouched; no claim/replay/revalidation |
| Pending genuine standalone, no forward/reverse/governed owner AND no governed_action_id marker | confirmed approved/denied | atomic pending claim only, approval audit best effort, no action dispatch; revalidate after confirmed decision |
| Pending + one consistent same-team linked pending_approval action | approved or denied after checked transitions | atomic approval claim; checked pending_approval→running or denied; approved dispatch once only after running confirmed; normal confirmed result/audit and revalidation |
| Claim won, prepare/deny error or zero matched rows | could not decide; known not dispatched | claim remains approved/denied; previous action may remain; best-effort durable decision audit may remain, no handler/terminal audit/revalidation |
| Handler succeeds/fails/throws/is missing + checked running→terminal matched row | confirmed action succeeded/failed | normal terminal event/result only after confirmation; no second handler invocation |
| Handler executed then terminal persistence errors/returns zero | could not decide; uncertain completion | never fabricate failed outcome/second failed write/terminal-success audit/replay/revalidation; operator examines actual standing rows |
| runAction requested→deny/pending_approval/running check fails | existing HTTP500 internal envelope | no false settled response; no handler without confirmed running; pending approval may remain after failed producer link |

Decision precedence: admin admission and UUID validation; authoritative approval tenant/absence; minimal governed ownership/intent validation and same-team canonical routing; then owned nonpending legacy status before legacy forward/reverse readiness. Thus malformed legacy links on an already-decided owned legacy approval do not trigger dispatch or private payload lookup, but a dangling governed marker never becomes standalone. Pending legacy links then undergo the full identity/cardinality/readiness checks before CAS. Test each precedence collision explicitly.

PgClient.transaction could make fileApprovalRequest plus link atomic, but it changes this legacy producer’s generic DbClient/test adapter contract and its selected fault semantics. The chosen finite fix checks transitions and refuses unsafe readiness, explicitly retaining the stranded tuple; it does not retrofit producer transactions/cancellation or claim compensation. Do not add requested→denied cancellation as an unreviewed competing-producer protocol. The operator signature is approval.pending with context.action_id pointing to an action.requested lacking the matching reverse link; it does not distinguish a paused producer from a dead one by timestamps. No automatic repair/replay is authorized. A transaction must never surround external handler execution.

Existing lib/ingest/fake-supabase.ts does not currently return matched update/delete rows even after select(), and lacks limit(). If retained for the existing action unit cases, add only truthful matched-row RETURNING and bounded limit support plus discriminating tests; otherwise move those cases to real PG and record the decision. It proves neither PostgreSQL constraints, concurrency nor atomicity. Required real-PG fault/cardinality/claim tests remain; do not relax returned-row checks to accommodate the fake.

**New persistence-fault error contract.** Confine this addition to lib/actions/index.ts and its existing dashboard wrapper. Every newly checked resolver/runAction database ownership/CAS/preparation/denial/link/running/terminal error, and the checked transition zero-row faults specified above, uses a typed internal LegacyActionPersistenceFault with the exact fixed message **action persistence unavailable**; no driver message, SQL, params, handler output, key or private payload is interpolated into it. Existing approval action maps it to could not decide; unchanged v1 route maps that safe message through its existing500 internal error envelope. Do not edit the route implementation or sanitize unrelated preexisting exceptions as a new global API project. Existing initial-insert/handler/other error behavior is not certified globally sanitized by this task.

At the owner’s fault point emit one allowlisted server event through console.error("[legacy_action_persistence_fault]", structuredAllowlistedFields). This prefixed event is the named recording test seam; it carries phase (approval_ownership/action_ownership/approval_claim/action_prepare/action_deny/request_deny/request_approval_link/request_running/action_finish), authenticated teamId, actionId when established (otherwise null), approvalRequestId when applicable, and dispatch=not_started|attempted. Terminal event may additionally carry only a known outcome enum succeeded|returned_failure|threw|missing_handler, never output/error text. Dispatch tracks actual handler invocation: a missing handler is not_started even if a terminal write fails. This log provides an operator correlation ID/phase, not a client wire identifier or new durable audit requirement. Capture no raw cause in this event or response. The no-PG-sentinel assertion covers the new prefixed event payload and HTTP response body only; existing query-builder driver console.error messages are explicitly excluded and are not globally rewritten. Recording log assertions and actual unchanged route-handler tests must discriminate fixed body message/no injected PG sentinel, pre-dispatch fault zero handler calls, post-dispatch fault exactly one call plus actionId/phase/dispatch event and no false terminal response/replay.

The legacy POST route has no idempotency key and drops the actionId on500. Server-side never-replay means this invocation does not rerun its handler; a client’s fresh POST retry can create another action and re-execute after uncertain completion. Explicitly retain/disclose that client-retry residual. Do not blindly retry500; operator reconciles the phase/actionId and actual standing rows first. No new idempotency key/status endpoint/response field/automatic cancellation or owned route runtime rewrite is authorized. This contract does not promise exactly-once external delivery.

Required tests: absent/foreign/already-decided; cardinality and malformed/inconsistent forward/reverse links; governed-no-legacy; genuine standalone approve/deny; same-team approve/deny; deterministic producer pause after approval insert for both decisions, unchanged early refusal, producer resumption and later consistent decision; running/terminal not-ready; two competing claims; real-PG returned-envelope/zero-row prepare, denial and terminal faults; handler success/returned failure/throw/missing-handler; exact dispatch/audit/response/revalidation/durable-state assertions through resolver **and shared runAction**. Independent requests with absent/expired/invalid session, or revoked active membership/role/current admin posture, refuse through existing guard. Sessions are stateless JWTs: browser sign-out deletes only the current cookie, and does not revoke a copied valid unexpired JWT; test these distinct cases rather than claim server-side JWT revocation; no linearizable revocation guarantee is added to an already admitted external operation. The original requester’s role/tier is not re-derived when legacy approval resumes (current principal is stored actor, role member, tier team); preserving that legacy policy behavior is an explicit non-goal, not a claim of requester-revocation protection. Current human decider authority is still rechecked. No test has run at design stage.

## Targeted runtime correction B: People target and resource ownership

Current local `gate` resolves the team, calls `currentMember`, then `canEditMemberContext(me, suppliedMemberId)` without proving the target belongs to that team. A role-admin shortcut accepts a foreign team’s member. `setMemberProfile`/`setMemberAvatar` upsert on global `member_id`; profile schema has separate team and member foreign keys. Time-off/new goal inserts likewise accept unrelated tuple values. For deletes, `removeTimeOff` and `removeMemberGoal` constrain only team/id. `setMemberGoal` updates a supplied ID by team/id and sets `member_id`; imported dedup resolves `(team, source, external_id)` across members. The partial unique goal index is intentionally team-wide.

Constructed scenarios requiring pre-fix observable RED: member Alice authorizes the supplied Alice ID but supplies Bob’s same-team time-off/goal ID; deletion removes Bob’s row. An explicit Bob goal ID or imported source/external-ID collision reassigns Bob’s goal to Alice. Administrator A supplies foreign member B to profile/avatar or new time-off/goal; the global FK/upsert permits cross-team association or overwrite. Tests must seed actual distinct members/teams and inspect durable rows/audits, not rely on reading source or asserting a writer was called.

The People gate must resolve **the existing target member by `(resolvedTeamId, targetMemberId)`** and fail with the existing `not allowed` shape when absent/foreign, before private writer operations. The target lookup has no status/kind filter: invited/disabled/nonhuman same-team targets retain current admin editing; actor activity remains enforced by currentMember. Preserve current self editing and admin-other **same-team** editing, including lead-self behavior; a lead/member cannot edit a teammate merely by presenting their own member ID. Keep self API-key issue/revoke bound to the authenticated member and existing ownership checks.

Pin writer scope as an explicit contract in the existing profile single writer, separate from audit actor identity. removeTimeOff/removeMemberGoal require positional target memberId; no omitted target/untyped caller may mutate. setMemberGoal requires a discriminated scope: browser_member with the server-authorized target, or explicit system_import for trusted non-browser import callers. No omitted/default mode selects system behavior; GoalInput cannot choose or override it. Profile/avatar/add-time-off already receive mandatory memberId, and bind that exact target/tuple as specified below rather than rely on an optional browser flag. For time-off/goal delete, the atomic statement predicate is `(team_id, member_id, id)` and must return/check a matched row before successful audit/result. For a browser_member explicit goal update, match `(team_id, member_id, goal_id)` and do not reassign `member_id`. For imported dedup, detect the existing team-wide key’s owner and refuse a different member’s match; never reinterpret it as “no match” and insert into a unique collision, nor silently move it. Scope the final update as well as the read so a changed owner between them cannot be overwritten. A concurrent unique insert or ownership change must refuse/retry only by re-reading the scoped ownership; no blind fallback or reassignment. Zero-row writes are refusal, not successful audit.

Keep the team-wide import unique index, idempotent same-member imports, manual non-dedup behavior, profile partial-field preservation, validation, avatars and trusted system import APIs compatible. Trusted system imported-goal callers explicitly choose system_import, preserving documented team-wide import convergence/reassignment; its explicit id selects an existing goal by team/id and may deliberately reassign its member_id to the supplied memberId, just as its team-wide imported dedup match may. Both trusted paths still check the team-bound matched row/errors and preserve validation; wrong-team/absent explicit id cannot fabricate success. This arm authenticates nobody and remains unavailable to browser input. There are zero current production system_import callers: only the People action and direct PG tests call the primitive. Ordinary manual goals in member-context.datamechanics.test.ts:53/84 and member-profile.datamechanics.test.ts:100/101/135/138/141 select browser_member for the seeded member; the two Jira source/externalId convergence calls at member-profile:104/111 choose system_import. Delete tests add the seeded target member to the required argument. Add explicit same-team trusted id-reassignment/dedup controls, runtime omitted-mode throw/no-row-change, and actual browser substitution mutant; browser actions always construct browser_member internally. Update direct caller tests explicitly. An omitted required goal mode or browser substitution with trusted mode must fail executing action/owner regressions without mutation; compile-time failure alone is not evidence. Admitted writer return types remain compatible (goal id / void), using a dedicated typed ProfileScopeRefusal with a fixed code for denied ownership. All six action wrappers map that class to {ok:false,error:"not allowed"}; existing validation errors retain their messages and real infrastructure errors use the current fail path. The existing cross-team writer delete test’s silent no-op becomes explicit scope refusal with untouched row/no audit—this behavior change is deliberate, not only a signature change. Target-member lookup belongs to the action authority gate; writer predicates bind mutable child resources. Browser profile/avatar writes also must not overwrite an existing profile row with a contradictory tenant; refuse malformed legacy tuples, do not silently repair/reclassify them. Use a supported builder-only profile/avatar mechanism: update by (team_id,member_id) with checked returned row; if absent, insert. A unique insert race triggers a scoped reread and checked scoped update only for the same tenant/member; contradictory existing tenant refuses. Use existing lib/ids.ts:isUniqueViolation on the adapter error message (no SQLSTATE code is exposed) only for an insert unique-conflict branch. Permit at most two conflict retries: exhaustion with no same-tenant matched row is ProfileScopeRefusal; nonunique error, failed reread/update, or another infrastructure fault remains infrastructure. Never convert a genuine lookup fault into absence; no unconditional upsert, tenant reassociation or global executor fallback. The SQL builder’s existing upsert cannot express a conflict WHERE and currently writes team_id from EXCLUDED, so it is not the scoped mechanism. This finite update/insert design adds no transaction capability or query-builder feature; real-PG zero-row/error/unique-race tests prove the predicates. Any alternate raw conditional upsert requires a recorded reviewed implementation decision, through the passed client’s same-connection transaction session inside profile.ts, not an escape to a global executor. Normal API paths do not move a member between tenant identities; member deletion races reject through the FK, not write to a new member.

Explicit goal updates colliding with the team-wide import unique key refuse as ProfileScopeRefusal; insert races only follow the bounded scoped reread contract, never blind reassignment. Delete/missing/foreign/peer resource IDs and contradictory legacy profile tuples return the same `not allowed` result without leaking the peer’s content or creating a success audit. Fail infrastructure errors through the existing generic action failure path; do not turn a failed ownership lookup into an admitted empty result. Successful mutations alone revalidate. Real Postgres tests cover every foreign insert/upsert, explicit ID update/delete, imported dedup collision, and owner-change barrier plus admitted self/admin-other and same-member import controls. Preserve the single-writer tests and `getMemberAvatar` read behavior.

## Ownership, recovery and compatibility map

| Transition | Canonical owner / data | Other caller or consumer | Evidence and recovery |
| --- | --- | --- | --- |
| Session→active team member→admin | auth guard + posture resolver; members/current group membership | all admin action exports; gateway guard | executing owner refusal/admission tests; no raw legacy tier fallback or new membership writer |
| Legacy requested/pending approval→decision→handler | `lib/actions/index.ts`; approval_requests/actions/audit | dashboard approvals action; runAction → v1 actions route | context.action_id readiness; team/state-bound claim + checked prepare/completion; preparation failure retains claim without dispatch; uncertain completion has no false terminal status/replay |
| Governed approval decision | governed transactional owner | same dashboard routing action; pending PR governed consumers | retain team input and no legacy dispatch; do not change owned governed consumers |
| Profile/time-off/goal edits | `lib/identity/profile.ts`; existing three tables | six People actions; trusted direct writer tests | current member + same-team target; child write owner predicates, matched-row evidence; refused write creates no success audit |
| Imported goal identity | existing `(team,source,external_id)` partial unique index | currently People action plus direct tests; future trusted importer | same-member browser convergence; peer collision refusal; unscoped trusted import contract retained, no schema rewrite |
| Resolver result→item scope→consumer admission | oracle → shared materializer → actions as specified above; membership/grant rows authoritative | all ten call sites in Production caller census and compatibility decision, including member evidence search, meetings list, Social page and three unchanged callers; `enforce.ts` held by PR714 | verified owner/branch/checkpoint/outcome/integration order in durable handoff before shared edit; four-leg action refusal, named caller regressions and admitted controls; later request resolves fresh authority, no compensation/replay |
| Owned action/content membership behavior | PR714/733/734/735/738/739 owners | new census/denial tests only | record current semantics; hold implementation absent verified owner/integration decision, including the bounded v6 correction |

Architectural root-cause check is triggered by authority/ownership and possible external handler dispatch. The shared cause of the two targeted classes is accepting resource identity independently of authenticated context. Correct it in the canonical owners and their caller contract, not with page-only checks. These are separate durable state machines; there is no shared queue or need for a general authorization service. No migration, data backfill, automatic classification or historical cleanup. Any preexisting contradictory profile/action tenant tuple remains unchanged and refused.

## Acceptance criteria

- **AC-01 — Complete discovery.** Executed inventory reconciles current 20/96/13/0 census; filesystem mutations discover alternate-root/extension/nested module actions and inline directive forms; every unsupported action shape fails closed. Comments/non-prologue strings/types do not fabricate actions.
- **AC-02 — Complete policy rows.** Every runtime export has exactly one protected/protocol registration with guard owner, refusal, protected effects, stated client-ID binding classification/limits and actual executing evidence; stale, duplicate or missing entries/reasons/evidence paths fail. All 96 rows below must be reconciled before acceptance; counts are not a bypass allowlist.
- **AC-03 — Genuine invocation.** Full-policy mutants for removed/downgraded guard, comments/import/unused helper, spare guarded export, lexical shadow, wrong owner/export, unawaited async invocation, generator and stale exception fail; ordinary awaited local/delegated helper, sync predicate and renamed dynamic-import/directly awaited literal Promise.all controls pass; stale owner completion mode fails; unawaited/shadowed combinator controls fail. Exact guard sets preserve co-guard requirements. Run existing AIO-1208 regressions if its helper changes. Browser action arguments cannot select trusted system_import or omit/override server-created browser_member/mandatory member target. Executing omission/trusted-arm-substitution mutants must fail.
- **AC-04 — Actual boundary denial.** Valid-input direct execution of each 95 protected exports refuses missing identity/admin/member authority before that row’s protected effect, including secret/provider/model calls, writes/audit-success/revalidation/after callbacks. For later conjunctions use the case-specific permitted prerequisite versus forbidden subsequent-effect contract above; guard-owner reads and authorized scope arming are not blanket forbidden effects. Existing tests count only when they execute the action and assert the relevant refusal/effect; a helper-only or source-read test is insufficient. For each action’s applicable documented conjunction, earlier checks admit and valid feature-enabled input reaches its refusal arm: role, posture, content, target and selected scope plus lookup error. Registered call retained but denied verdict ignored, and removed inline role/posture mutants must fail executing tests. Shared-owner cases may establish primitive semantics; the action must separately honor the verdict. Representative admitted controls for each distinct guard family prevent vacuity. For both actual `scanMeetingTodosAction` and `discoverNow`, execute all four resolver faults (`members`, `group_members`, `project_groups`, `project_context_memberships`) after identity/posture admission: exact `{ok:false,error:"visibility resolution failed"}`, zero scanner/discovery/private source load/opportunity write/cache revalidation and unchanged durable rows. Fault-free nonempty/partial controls, item-membership-empty controls and distinct genuine oracle-zero-project/no-error controls for each export must pass with successful consumer execution (including discovery revalidation); discarded-error/consumer-continuation and empty-projects-as-error executable substitution mutants must fail. Execute all 15 scope connections above across 14 exports: successful empty/partial/exact actor scopes must constrain consumers and outputs, with nonempty controls and applicable omitted/widened/wrong-principal mutants; real-PG action-to-scanner proof and recording graph/model/provider consumer evidence are required. createMeetingTodosAction proves its current membership/posture refusal only; the absent desired content gate is explicitly DEFERRED AIO-1225, not PASS. Administrator issueApiKey proves its existing admin conjunction only; its missing desired same-team member-target denial is DEFERRED AIO-1226, not PASS. Identity/alias target denials and attribution drill-down viewer-scope policy are likewise DEFERRED AIO-1227/1228; prove only their recorded existing admin conjunctions.
- **AC-05 — Guard owners and policy compatibility.** Real session/active-same-team/member/posture owner tests discriminate absent/foreign/disabled member, role, and current membership-derived admin posture in both stale legacy-tier directions; permitted members/admins pass. Preserve People self/admin-other rules, project-member creation, task/decision content writer/project checks, existing meeting/social content gates, selected-project mint admin AND launcher visibility and existing `VisibleProjectRows.error` arms only (oracle-leg narrowing through the legacy wrapper remains fail-closed, not v6-certified refusal; explicit all-reachable mode remains non-enumerating), and owned-path hold subject only to the verified v6 ownership decision. Preserve the legacy `visibleProjects` API and genuine-empty admission; propagate existing oracle failures at the shared materializer, with the ten-call-site compatibility decision and evidence in Production caller census and compatibility decision. Pin the chain gate's changed `visibility resolution failed` text with zero effects, second-draft refusal before consumer on an invocation-two fault after real chain admission, member-key evidence search 500 `enforcement check failed`, and meetings-list/Social-page error-boundary outcomes instead of successful empty. Pin unchanged dashboard-media 404, People explicit empty and inspect ignored-flag behavior. Disclose/pin delegated agent-token 200-empty as a legacy-wrapper residual, not a correction or uniform API guarantee. Preserve the existing per-refusal ordering/prerequisite boundaries, including authorized internal keys and bounded read-side graph arming before late scope faults. No complete content-protection claim for the deferred meeting-todo create/export path or complete key-target binding claim for the deferred administrator-issued credential path.
- **AC-06 — Account protocol.** Sign-out clears only current browser auth and redirects without needing identity; stale/missing cookie is harmless. Welcome uses own identity and only-if-unset password writer; change password uses own identity plus current-password verification. Missing identity/invalid old password/already-set account refuse with zero credential change; admitted credential controls work. No active tenant membership requirement is added.
- **AC-07 — Approval team binding RED→GREEN.** Two real teams, authenticated administrator A, B legacy approval/action: approved and denied requests refuse indistinguishably from absent, all B rows/audit unchanged, no handler/sandbox/revalidation. The regression fails on unchanged base for the intended durable-state/dispatch observation; same-team approve/deny pass after correction. Foreign governed identity links return the identical absent shape before routing, zero governed/legacy/sandbox/audit/revalidation; same-team governed compatibility remains.
- **AC-08 — Approval state/fault boundary.** Every resolver/shared runAction transition/completion is team/id/expected-state bound with checked returned errors and affected rows; governed tenant is identity-derived and never dispatches legacy. Explicit cardinality, context.action_id producer readiness, genuine standalone and inconsistent foreign/forward/reverse/running/terminal cases refuse correctly. Atomic pending claim permits one decision; post-claim prepare/deny failure retains claim with zero dispatch. Real-PG faults/zero rows pin prepare/deny/finish and shared runAction, with success/returned-failure/throw/missing-handler controls. Completion persistence failure is separate from handler failure: no false terminal response/audit, failed rewrite or replay. Producer barrier/resumption and two competing requests keep deliberate outcomes consistent. Governed-intent/terminal-link precedence is pinned; zero sandbox means run/allocation, not pure factory. New faults use fixed sanitized message plus allowlisted phase/actionId/actual dispatch log, with unchanged route500 tests and no client retry/idempotency guarantee.
- **AC-09 — People tenant target RED→GREEN.** Admin A cannot profile/avatar-upsert, add time-off or new goal for member B in another team; absent/foreign uses not-allowed, no row/audit/revalidation. B profile row team_id and content remain unchanged (base upsert can re-home it). Same-team self and admin-other—including retained target status/kind and actor editor posture—controls, partial profile update and avatar validation remain compatible. Reproduce actual base acceptance/mutation before fix.
- **AC-10 — People child owner RED→GREEN.** Supplying self target with peer time-off/goal ID, explicit peer goal update, or peer imported dedup key cannot remove, alter or reassign peer content. Atomic team/member/resource filters, zero-row and owner-change races refuse without success audit. Admitted own rows, admin legitimate peer target, same-member imports and trusted system_import explicit-ID reassignment and dedup compatibility pass; runtime omitted mode throws without mutation and browser substitution mutant fails.
- **AC-11 — Ownership and rollout.** No production edits to recorded owned paths or schema/membership writers without a verified owner decision. The v6 `enforce.ts` correction requires verified PR714 owner, branch/checkpoint, dependent callers, permitted outcome and integration order recorded in `../aio1217-handoff/` before that edit, without altering the attached spec hash; unresolved ownership leaves the six oracle-leg cases BLOCKED/FAIL and holds publication while independent unrelated evidence may continue after review/readiness and attachment/readback; no separate action patches or membership/access-policy redesign. No migration/backfill, production credentials/queries/member mutations or live external provider calls. Repeat ownership/base census before publication; verified AIO-1225 owner-backed deferral covers both meeting-todo overwrite and whole-project export and qualifies inventory claims; verified Medium Backlog AIO-1226 separately owns admin-issued key target binding, High Backlog AIO-1227 owns identity/alias targets under held PR714 integration, and Medium Backlog AIO-1228 owns attribution viewer-policy reconciliation. Desired deferred boundaries are never PASS. Release note states foreign/peer ID calls now refuse, prepare/uncertain legacy delivery remains operator-managed, and deferred content protections are not fixed. It also names the intended chain refusal-text/second-draft early-refusal changes, member evidence-search 500, meetings-list/Social-page error boundaries, unchanged three caller outcomes and delegated-token residual from the ten-call-site census.
- **AC-12 — Falsification and evidence.** Named base runtime RED results, in-memory and filesystem mutant outcomes, caller/owner census, stable source hashes and test commands/results are saved durably with actual run snapshot. Do not launder delayed reconstruction as a prebuild execution. Reviewer independently reads code before author matrix. All pending or skipped evidence remains labelled. Record both-export × four-leg fault/adapter activation, exact response, consumer/effect counts, durable-row comparisons, nonempty/partial/item-membership-empty and separate oracle-zero-project/no-error controls, and executable source/test-substitution propagation/continuation/empty-as-error mutant outcomes. Pre-correction RED is exactly the six oracle-leg action cases; the two `project_context_memberships` cases are already green before correction and remain green afterwards. AST registry mutations cannot stand in for executing these propagation mutants. Content isolation or S4/D4 exit-zero alone cannot establish refusal; preserve prior registry/People/approvals evidence at its original snapshot without inflating 15-connection coverage.
- **AC-13 — Validation.** Scoped unit/checker/action tests, required real-PG target/fault/concurrency and existing affected PG tests pass; `npm run typecheck`, lint, docs checks and `npm run build` pass with actual commands/results. Run full unit coverage with existing assertions/thresholds and report default timeout failures honestly if worker-limited retry is needed. Distinguish direct action execution from Next action-wire proof. No broad datamechanics or 96-action wire claim unless actually run. Validate all eight resolver-fault cases and admitted controls through actual exports/real adapter, plus the ten-call-site caller evidence: chain text/zero effects, second-draft invocation-two fault after real chain admission (one oracle-leg actual-export case plus shared-owner coverage), and named regressions with fault-free controls for member evidence-search 500, meetings-list error boundary and Social-page error boundary. Verify the three unchanged caller outcomes and delegated agent-token residual; no general API guarantee. Include separate oracle-zero-project/no-error controls for each target export. Distinguish synthetic executor rejection from native-driver outage. Existing unaffected evidence remains valid only for its recorded snapshot; rerun checks invalidated by the correction.
- **AC-14 — Required reviews and attachment.** Independent subscription Opus 5.5 spec/code reviews and fresh Astra permissioning design/final reviews resolve confirmed in-scope failures; HIGH/blocker requires independent per-finding skepticism per workflow. For this material revision, affected independent subscription Opus 5.5 HIGH spec review, fresh Astra permissioning design review and readiness must complete, followed by full exact accepted Markdown attachment in AIO-1217 and complete readback/hash, before any implementation resumes. Verified PR714 ownership/integration additionally gates only the `enforce.ts` edit; record owner/branch/checkpoint/outcome in the durable handoff without altering the attached spec hash. Only the three outcomes in the revision record are valid. While unresolved, the six oracle-leg action cases are BLOCKED/FAIL, never PASS/DEFERRED, and publication is held; independent unrelated evidence may continue after the review/readiness and attachment gates. Earlier reviews/attachment do not attest v6. Subsequent code review and fresh Astra HIGH final review must cover the shared correction, affected callers and executable refusal evidence. Publication uses the earned review line and staging target; ticket stays In Progress until its merge/squash commit is verified contained in remote main under the current workflow Stage 7. A staging merge alone is explicitly insufficient; this lifecycle does not change the staging feature base or PR target.

## Verification matrix and implementation sequence

| AC | Planned named evidence | Current status |
| --- | --- | --- |
| 01–03 | new file to create: `test/guards/server-action-auth.test.ts`; filesystem/full-registry mutants, owner/alias census; existing `test/guards/api-route-auth.test.ts` if shared primitive touched | source census only; tests NOT RUN |
| 04 | new file to create: `test/datamechanics/server-action-scope-connections.datamechanics.test.ts`; new action-family fixture files to create under `test/actions/`; all 95 denied valid fixtures, finite applicable-conjunct prerequisite/forbidden-effect spies, all 15 action-to-scope-consumer connections with applicable omission/widening/wrong-principal mutants, and ignored-verdict/inline-check mutants; reusable `test/attribution-drilldown-action-authz.test.ts`, `test/admin-sync-context-actions.test.ts` only for proven named cases | existing test source inspected, NOT RUN |
| 05 | new focused auth-owner tests / existing real-PG membership-derived admin cases; task/update, meeting/content and selected-scope conjunct regressions; AIO-1225 desired content denial DEFERRED | source owner chains inspected, NOT RUN |
| 06 | new account/welcome action tests; existing `test/datamechanics/change-password.datamechanics.test.ts` plus explicit unset-password identity controls | source protocol inspected, NOT RUN |
| 07–10 | new file to create: `test/datamechanics/server-action-target-binding.datamechanics.test.ts`; existing `lib/actions/actions.test.ts`, `test/datamechanics/member-profile.datamechanics.test.ts`; staged pre-fix RED before runtime edits | source counterexample paths validated; new prep/completion/readiness obligations; runtime NOT VERIFIED |
| 11 | recorded ownership/diff, schema unchanged, release note, verified related AIO-1225/1227 High Backlog and AIO-1226/1228 Medium Backlog + explicit qualified action rows | initial ownership and follow-up verified; repeat pending; AIO-1225/1226/1227/1228 desired boundary tests DEFERRED |
| 12 | durable inventory/matrix/commands/results/hashes; fresh reviewer snapshot | preliminary artifacts only |
| 13 | scoped unit, PG affected selection, full coverage, typecheck/lint/docs/build | NOT RUN for AIO-1217 |
| 14 | actual Opus/Astra review outputs, independent per-HIGH skepticism, adjudication/readiness, accepted Linear readback/hash | v1/v2 Astra required corrections; independent per-HIGH skeptics STANDING, Astra v3 and targeted v4 design PASS for their snapshots; Opus v4 source review required finite corrections and had one support-manifest denial (not a completed gate); Opus v5 PASS design feasibility/correctness with one manifest-only MEDIUM and four finite LOW wording pins, denied0; focused Astra v5 PASS with49 checked source hashes/full diff for snapshot7fb52b. This final text applies only those pins; expanded normative support-manifest verification, deterministic readiness and exact accepted attachment/readback remain PENDING; no implementation admission |
| 04/05/11–14 (v6) | both exports × four resolver faults, nonempty/partial/genuine-empty controls, propagation/continuation mutants; shared caller census and PR714 owner/integration; affected review/readiness and full exact Linear readback/hash | PENDING; authoritative adjudication found noncompliance; independent Opus v6 review completed exit 0/no denials with READINESS: BLOCKED on B1/B2. This revision addresses those findings; rereview/readiness, exact attachment/readback and implementation/evidence remain uncompleted. Unresolved PR714 ownership leaves six oracle-leg action cases BLOCKED/FAIL and publication held |

1. Freeze v6 and complete the affected subscription Opus 5.5 HIGH spec review, fresh Astra permissioning design review and readiness; historical v5 review evidence remains scoped to v5. Attach the full exact accepted spec to Linear and verify complete readback/hash before any AIO-1217 implementation resumes. Attachment does not wait for PR714. Record the later verified owner/branch/checkpoint/outcome and integration order in `../aio1217-handoff/`, not the attached spec. Checkpoint only authorized task doc after required prepush review. Independent unrelated evidence may then continue; unresolved PR714 ownership holds the `enforce.ts` edit and publication, and the six oracle-leg action cases remain BLOCKED/FAIL.
2. Before runtime changes, create observable two-team/peer-resource tests and run on unchanged base. Save real RED observation and same-team admitted baseline. If an intended defect does not reproduce, investigate and revise the claim before fixing. Implement discovery/policy mutants without weakening acceptance.
3. Sole admitted subscription Opus 5.5 HIGH builder corrects the own-path target contracts and, only after the v6 gates, the bounded shared materializer provenance defect, then direct denial/effect cases and owner tests. Record any necessary internal signature changes and preserve trusted system protocols. Hold all other owned-path edits and hold the shared correction until verified ownership/integration. The only outcomes are AIO-1217 edit with owner agreement, reuse of an accepted landed PR714 correction after rebase and affected revalidation, or return to Astra for revised scope and renewed review/readiness/attachment. Stop for material spec/policy flaw rather than expanding silently.
4. Run affected unit/PG and complete validation. Produce 96-row evidence census with actual test names/assertions/results; no existing filename alone is proof. Reviews receive exact diff, full changed/untracked files, caller/schema/owner context and all qualifications.
5. Independent code/Astra reviews; resolve findings, final exact snapshot checks, normal checkpoint/push hooks and staging PR attestation. No merge/deploy without the user’s authorization for that next action.

## Build with Claude Opus 5.5, high

The implementation is security-sensitive because a missed tenant/resource predicate can dispatch a handler or overwrite another member’s content. Use exact subscription-authenticated `claude-opus-5-5` with high effort, verified by coordinator preflight and actual result metadata. No Anthropic API key billing. One implementation writer at a time; do not recursively invoke this workflow, delegate, push, publish, merge or deploy from the builder. Astra owns this material revision/adjudication; fresh Astra high reviews permissioning independently. Preserve durable scoped checkpoints, actual quota admission/stop policy, review-beforepush, and source-fingerprint check records.

## Compatibility, release and rollback

No schema changes or replay migration. A profile already re-homed to another tenant before this fix remains contradictory and its rightful member’s save may permanently refuse until a separately authorized operator repair; this task neither auto-repairs nor promises recovery for that row. Release notes explain that foreign approval/member IDs and peer-resource ID substitution now refuse, while legitimate same-team admin/self operations and public own-account protocol remain. The development gate is not a new runtime role policy. Existing action export names/result shapes remain compatible except malicious/mistargeted zero-row operations no longer report success and resolver faults now reach the required visibility-error refusal instead of empty consumer success; genuine-empty success/revalidation remains compatible. This does not limit v6 impact to action results: the ten-call-site census also authorizes member-key evidence-search 200-empty → 500 `enforcement check failed`, and meetings-list/Social-page successful empty → error boundary. Release evidence must name those three regressions, the chain gate's `not found for team` → `visibility resolution failed` with zero effects, and second-draft refusal before `generatePlanDrafts` instead of its later evidence-check error. Dashboard-media 404, People explicit empty and inspect ignored error flag remain unchanged. Delegated agent-token evidence search still uses the legacy wrapper and returns 200-empty on the same oracle fault; disclose this residual without correcting it or claiming a uniform API contract. Record per-caller fault/admitted evidence as required by the census. Trusted system imported goal convergence retains existing team-wide key semantics.

The external normative action endpoint contract is in aios-workspace/docs/brain-api.md (reviewed actual /Users/chetan/Dropbox/Code/aios/aios-workspace/docs/brain-api.md section1729–1789, SHA256 5edcbc83aac718b565f400ec974acf1854e32d5195c2da1ea48e18294fdc087b). No workspace client currently calls this legacy endpoint. Normal confirmed response statuses remain succeeded200, pending_approval202, denied403 and handler-failed422. The existing route catches infrastructure exceptions as500 internal. Newly checked transition/terminal faults now use that existing500 envelope instead of false normal settled responses; completion may be uncertain and requires inspection, never automatic handler replay inside the current invocation. A fresh client retry can create/re-execute a second legacy action because no idempotency exists; the new sanitized phase/actionId server event supports reconciliation, without returning a new wire field. This is an intentional failure-behavior correction, not a new wire result/version or external contract edit. The external endpoint's normal error list omits500; independent review must assess this explicit fault qualification, not assume the contract was already read or amended. Test actual route fault mapping and normal admitted statuses.

Bounded read-only diagnostic examples (operator/synthetic authorization only; this task runs no production query) identify tenant contradictions and producer-readiness candidates without private payloads. They are not repair scripts or proof a producer is dead; no timestamps classify a record:

```sql
select p.member_id, p.team_id as profile_team, m.team_id as member_team
from member_profiles p join members m on m.id = p.member_id
where (p.team_id = $1 or m.team_id = $1) and p.team_id <> m.team_id limit 100;

select p.id as approval_id, p.status as approval_status, a.id as action_id,
       a.team_id as action_team, a.status as action_status, a.approval_request_id
from approval_requests p left join actions a on a.id::text = p.context->>'action_id'
where p.team_id = $1 and p.status = 'pending' and p.context->>'action_id' is not null
  and (a.id is null or a.team_id <> p.team_id or a.status = 'requested'
       or a.approval_request_id is distinct from p.id)
limit 100;

select p.id as approval_id, p.status as decision_status, a.id as action_id,
       a.status as action_status, a.approval_request_id
from approval_requests p join actions a on a.approval_request_id = p.id
where p.team_id = $1 and a.team_id = $1 and p.status in ('approved','denied')
  and a.status = 'pending_approval' limit 100;

select id as action_id, approval_request_id, status
from actions where team_id = $1 and status = 'running' limit 100;
```

The decided-approval/pending_approval-action tuple identifies a possible post-claim prepare/deny fault; running identifies possible active/uncertain completion, not proof execution is dead. Use allowlisted phase/actionId logs and actual state to reconcile; these signatures authorize no forced finish/replay and distinguish no state by elapsed time.

Rollback is a scoped code rollback against the recorded staging base; no data reclassification or audit deletion. Reverting runtime fixes reopens the documented authorization paths and requires an explicit security decision, not an automatic response to a test/tool failure. A build/checker-only discovery rollback cannot be represented as continued inventory enforcement. Existing durable approval/action failures/uncertainty remain visible; never automatically replay a possibly executed external handler. Keep accepted spec and RED/evidence/reviews in durable recovery storage.

## Bounded open decisions for design review

No routine user preference is required. Fresh reviewers must challenge conditional browser profile writes, checked legacy claim/preparation/completion and producer readiness before acceptance. If conditional upsert cannot preserve foreign/malformed-row refusal in the existing single writer without migration, surface the concrete feasibility issue instead of weakening target binding. New defects in held PR-owned paths require observable counterexample and owner decision before code.

**Explicit deferred HIGH content boundary — [AIO-1225](https://linear.app/je4light/issue/AIO-1225/bind-meeting-todo-writes-and-pm-projection-to-member-authority), verified High / Backlog, natively related to AIO-1217.** `createMeetingTodosAction` accepts client rowKey, sourceItemId, audience and replacement content after active membership/team-posture admission. A caller with a known restricted task rowKey (including retained knowledge after revocation) can supply it with replacement source/content; `createMeetingTodoTasks` upserts by team/project/client rowKey without source/task writer authority. This is same-team overwrite/provenance rebinding; arbitrary guessing or cross-tenant overwrite is not asserted. Independently, one legitimate visible todo with projectToLinear=true invokes `projectAllTasks`, which loads the entire meetings project without acting-member visibility and can send another restricted transcript task’s title/body to the primary PM provider. No hidden ID/key knowledge is needed for that batch. This scenario requires configured usable provider and a hidden row needing initial/changed projection; missing configuration or unchanged fingerprint is an availability/idempotence condition, not a content guard. It does not establish that the caller can read the provider issue or that a live deployment actually exported content.

Fresh Astra and independent per-HIGH source skeptics found no downstream content-authority guard in `app/actions/meeting-todos.ts`, `lib/meetings/extract-todos.ts`, or `lib/pm-sync/project.ts`. Neither counterexample has been reproduced with real Postgres/provider-boundary fixtures. AIO-1225 owns **both** tests-first source/task write binding and whole-project export correction, with visible/restricted fixtures and recording provider stub, no live provider. Intake/next-slice owner is this continuing hardening coordinator/workstream; no other human assignee or production branch transfer is asserted. No exact overlapping owner was found in the recorded snapshots for its three paths; recheck at that ticket’s implementation. A dedicated future codex/ branch is planned, not created.

This task retains its two selected target-binding runtime families plus the bounded v6 resolver-provenance correction; the latter does not change this deferral. For createMeetingTodosAction its inventory/denial claim is **current membership/posture invocation and refusal only**, with this unresolved content-write/export gap recorded. AC-04/05 do not certify that action’s complete intended resource/content authority. A missing desired no-overwrite/no-hidden-export denial must be labelled DEFERRED AIO-1225, never PASS or fixed. Required fresh design review must accept this qualified scope disposition before specification acceptance. Expanding this task to guarantee all content-policy boundaries would conflict with the disposition and requires an explicit accepted scope/review revision, not an expansion of the bounded v6 correction.

**Separate optional API-key target boundary — [AIO-1226](https://linear.app/je4light/issue/AIO-1226/prove-same-team-target-binding-for-admin-issued-api-keys), verified Medium / Backlog, natively related to AIO-1217.** Administrator issueApiKey passes client memberId to lib/admin/keys.ts without a same-team member lookup; api_keys has independent team/member foreign keys, and authenticateApiKey joins the referenced member while retaining the key team. This source-derived inconsistent credential tuple has not been reproduced at runtime and does not establish access to the foreign team’s content. Existing CLI issuance resolves a same-team email target and self-service uses its authenticated member; both require compatibility review in the follow-up. No exact overlap for app/t/[team]/admin/actions.ts, lib/admin/keys.ts or lib/api/auth.ts was found in current ownership snapshots; recheck all callers/owners before that separate implementation. Continuing hardening coordinator/workstream owns intake; no human reassignment or branch transfer is asserted. Future separate codex/ branch is planned, not created. AIO-1217 proves this action’s existing admin refusal/admission only; missing desired same-team key-target refusal remains DEFERRED AIO-1226, never PASS or fixed. This remains outside the selected runtime corrections.

**Additional target/viewer dispositions.** [AIO-1227](https://linear.app/je4light/issue/AIO-1227/prove-same-team-member-targets-for-admin-identity-and-alias-mapping) is verified High / Backlog and related to AIO-1217 and AIO-1170. linkMemberIdentity/linkMemberSlack→setMemberIdentity accepts independent team/member tuple; schema member_identities has independent FKs. addMemberEmail→addAuthorAlias similarly inserts/remaps member_emails/contribution attribution; linkMemberGithub’s member update is team/id scoped but unchecked zero rows precede the same alias writer. These are source-derived missing target predicates, not executed cross-team exploits. PR714/AIO1170 owns the overlapping member action/identity paths; continuing workstream owns intake only, no owner agreement, branch transfer or parallel production edit asserted. Hold implementation until verified coordination/integration and new source-grounded spec. Desired foreign-target denial is DEFERRED, never PASS here.

[AIO-1228](https://linear.app/je4light/issue/AIO-1228/decide-and-prove-actor-visibility-for-admin-attribution-item-drill) is verified Medium / Backlog and related to AIO-1217. getMemberItemsAction→lib/attribution/health.getMemberItems returns body-head-derived titles/path/frontmatter by team and attributed member without acting-viewer oracle. Its source documents an all-tier admin-health read, while ENFB2/4 content→membership applies to admins. AIO-1217 preserves that current privileged contract and proves its admin conjunction only; desired viewer confinement is DEFERRED, not silently certified as an exception or fixed. The follow-up must settle normative policy then prove actual-export sentinel confinement; adjacent preview/apply content flows require read-only audit, not assumed defects. Coordinator owns intake and future owner/overlap selection; no live disclosure reproduced or implementation branch/owner transfer asserted.

Client-ID statuses below qualify the inventory. Registration proves specified authority invocation/refusal, not every descendant target/content predicate. Existing bound classifications are source contracts awaiting executing evidence; selected corrections need RED→GREEN. Any client ID not certified by the named predicates must remain explicitly “not certified beyond registered conjunctions” in its evidence row, never acquire a generic target PASS or silently add a new runtime family. The builder records exact fields/owner references with each actual test; a newly demonstrated missing predicate gets scope/owner adjudication before code.

| Action / supplied ID class | Source classification within AIO-1217 |
| --- | --- |
| decideApproval approvalRequestId | Selected correction: authoritative approval/governed identity tenant plus legacy forward/reverse/state contracts; foreign governed/legacy absent response pinned. |
| Six People context mutations memberId/child IDs/import key | Selected correction: target existing same-team row, required scoped resource statements and explicit browser goal mode; target status/kind retained. |
| issueApiKey memberId | Missing same-team target: DEFERRED AIO-1226; current admin conjunction only. |
| linkMemberIdentity/linkMemberSlack/linkMemberGithub/addMemberEmail memberId and force remap | Missing complete same-team target: DEFERRED AIO-1227 on held integration paths; current admin conjunction only. |
| mintAgentTokenAction launcher/represented member/project IDs | Bound by mintAgentToken→getMember(team_id,id)/isPrincipal, including all-reachable; selected projects additionally check both actor/launcher visibility. The action itself does not perform launcher lookup before those checks. No suspected foreign launcher gap established. |
| recordFindingDecision findingId/ownerMemberId | Bound by decideCodebaseFinding RPC→schema decide_codebase_finding: same-team/codebase finding and active same-team owner before update. No suspected foreign owner gap established; no codebase policy rewrite. |
| getMemberItemsAction attributed memberId/filter | Existing team-bound item selector, not a target write; actor content scope not applied. Current privileged admin contract preserved, viewer-policy proof DEFERRED AIO-1228. |
| Task/decision resource/project IDs | Existing actual canWriteStructuredRow/canSeeProjectRow conjunctions and same-team/project parent constraints where present; minimal pre-identity metadata/existence distinction retained. Held decision path untouched. |
| NOTE note/task IDs and meeting scan source IDs | Existing actor source oracle plus same-note/meeting-project requested-task eligibility; scanner returned set must reach private read. createMeetingTodosAction client rowKey/sourceItemId/audience and whole-project export remain DEFERRED AIO-1225. |
| Social opportunity/plan/variant/publication IDs | Team-bound actual chain oracle and every-evidence set plus specified second draft scope; no broader descendant identity claim beyond those predicates. |
| Other inventory supplied IDs/filters/config values | Record only current guard-derived team and named owner predicates; descendant target binding not certified beyond registered conjunctions. These rows still require valid-input actual admin/member denial and admitted controls, not a blanket desired target/content guarantee. No unknown field may be labelled “bound” from an import/call count. |

## Action classification census

The following is the complete baseline runtime export inventory. Codes map to owner chains below, never guard spelling alone. Refusal text is the authorization refusal; validation/team/record absence may refuse earlier without protected effects. Effects are the operations whose denial tests must observe, interpreted per the case-specific prerequisite/forbidden-effect table above. Existing test references are candidates, not assertions of executed/passing coverage. Every row requires actual named evidence in the implementation matrix, including exact supplied-ID fields and the client-ID table’s bound/selected/deferred/not-certified classification; baseline line numbers are informational, never registry keys. Other held PRs need not land first: after an actual base/owner integration, this task coordinator and active implementer refresh affected row/export/owner evidence and rerun relevant checks/review, rather than enforce stale sets or copy pending implementations. Every row expands its codes into a finite applicable-conjunct list: ADM = session, active same-team membership, admin role and current unrestricted posture; MEM = session/active same-team (posture is resolved but external is not universally denied); PEOPLE adds same-team target and self-or-admin, with scoped child predicates for resource actions; TEAM adds the actual team-posture write predicate; LEAD adds its role arm and codebase team posture; WRITER/PROJECT/NOTE/CHAIN add their named content predicate and lookup-error refusal; SCOPE adds both selected-project principals; SELF adds own-account/current-password or only-if-unset protocol condition. Test each applicable denial while preceding checks admit, including negative verdict honored and error failure. Future conditions are not invented from code names; explicit all-reachable and counts-only existing exceptions retain their stated reasons. createMeetingTodosAction’s missing desired content conjunction is a separately tracked gap, not registered as already enforced.

| Code | Exact owner / co-predicate | Expected refusal and execution evidence owner |
| --- | --- | --- |
| ADM | `lib/auth/guard:requireTeamAdmin` → `lib/integrations/read:resolveIntegrationsAdmin` → active session/member + posture + `lib/auth/admin-access:canAccessAdmin` | admins only (availability returns []); new action-family executing tests plus owner runtime/PG denial/admission |
| MEM | `lib/auth/guard:currentMember` → session/active same-team/posture | not a member of this team (selfGate uses not signed in); new executing boundary cases |
| SELF | `lib/auth/session:getSessionUser` | not signed in; account/welcome executing tests, password PG controls |
| PEOPLE | local invoked `gate` → currentMember + `lib/identity/context:canEditMemberContext`, plus proposed same-team target lookup | not allowed; People action/target real-PG tests; no new posture rule |
| TEAM | MEM plus inline tier=team or `lib/meetings/notes:canSeeMeetingNotes` | team-tier membership required; action tests and existing meeting PG candidates |
| WRITER | MEM + `lib/access/enforce:canWriteStructuredRow` through called local helper where present | absent task/decision refusal; existing task-update PG plus new denial controls |
| PROJECT | MEM + `lib/access/enforce:canSeeProjectRow` | project not found; direct action execution tests |
| LEAD | MEM + existing inline role admin/lead, and codebase tier=team where present | admins and leads only / team leads or admins only; action executing role/co-predicate tests |
| NOTE | TEAM + `lib/meetings/notes:getMeetingNote` content oracle | meeting note not found; guard metadata/visibility prerequisite reads allowed, no later key/model/provider/private expansion/write before content denial |
| CHAIN | ADM + called local actorChainGate → `lib/access/enforce:visibleItemIds` + `lib/social/store:actorSeesChain` | visibility resolution failed / not found for team; actor-scoped chain tests |
| GATEWAY | `lib/auth/session:getSessionUser` + `lib/gateway/admin-persistence:authorizeGatewayAdmin` | admins only, feature-off approval not found, GatewayAdminError code; existing AIO-1208 action consumer tests |
| SCOPE | ADM + conditional `lib/access/enforce:visibleProjectRows` for admin AND launcher | separately deny each principal visibility and each existing `VisibleProjectRows.error` arm in projects mode; “lookup error” means only that arm. Oracle-leg narrowing through `writerRule → visibleProjects` remains fail-closed and is not certified as refusal by v6; all-reachable intentionally skips enumeration |
| OUT | `lib/auth/session:signOut` then `next/navigation:redirect` | deliberate public own-cookie protocol; no tenant/data/provider effects |

### `app/t/[team]/meetings/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `uploadMeetingNoteAction` (55) | TEAM | `resolveAnsweringKeys`, `extractFromTranscript`, `findDuplicateMeeting`, `mergeIntoMeetingNote`, `createMeetingNote`, `extractAndStoreActionItems`; guard team; target limits in client-ID table | existing enfb3-meetings/meeting-tasks-push PG candidates + new independent-conjunct and actual viewer-to-note connection cases |
| `importPushedMeetingsAction` (164) | MEM + lib/auth/admin-access:canAccessAdmin (admin access required) | `resolveAnsweringKeys`, `backfillMeetingNotesFromItems`; guard team; target limits in client-ID table | existing enfb3-meetings/meeting-tasks-push PG candidates + new independent-conjunct and actual viewer-to-note connection cases |
| `extractMeetingActionItemsAction` (205) | NOTE | guard-prerequisite `getMeetingNote`; then `resolveAnsweringKeys`, `extractAndStoreActionItems`; guard team; target limits in client-ID table | existing enfb3-meetings/meeting-tasks-push PG candidates + new independent-conjunct and actual viewer-to-note connection cases |
| `regenerateMeetingSummaryAction` (287) | NOTE | guard-prerequisite `getMeetingNote`; then `resolveAnsweringKeys`, `extractFromTranscript`, `updateMeetingSummary`; guard team; target limits in client-ID table | existing enfb3-meetings/meeting-tasks-push PG candidates + new independent-conjunct and actual viewer-to-note connection cases |
| `pushMeetingTasksAction` (353) | NOTE | guard-prerequisite `getMeetingNote`; then `resolvePrimaryProvider`, eligible-task status/raw_status write when override supplied, `projectRows`; guard team; target limits in client-ID table | existing enfb3-meetings/meeting-tasks-push PG candidates + new independent-conjunct and actual viewer-to-note connection cases |

### `app/t/[team]/people/[handle]/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `saveProfile` (49) | PEOPLE | `setMemberProfile`; same-team target; conditional global-member profile upsert must refuse contradictory tenant | new People direct action + real-PG ownership cases |
| `addMemberTimeOff` (67) | PEOPLE | `addTimeOff`; guard team; target limits in client-ID table | new People direct action + real-PG ownership cases |
| `deleteMemberTimeOff` (85) | PEOPLE | `removeTimeOff`; matched team/member/resource delete before successful audit | new People direct action + real-PG ownership cases |
| `saveMemberGoal` (103) | PEOPLE | `setMemberGoal`; scoped explicit-ID update/import dedup/new insert; no browser owner reassignment | new People direct action + real-PG ownership cases |
| `deleteMemberGoal` (121) | PEOPLE | `removeMemberGoal`; matched team/member/resource delete before successful audit | new People direct action + real-PG ownership cases |
| `saveAvatar` (144) | PEOPLE | `setMemberAvatar`; same-team target; conditional profile upsert; avatar validation retained | new People direct action + real-PG ownership cases |
| `issueMyApiKey` (175) | MEM (called selfGate) | `issueApiKey`; guard team; target limits in client-ID table | new self-key denial/admitted controls |
| `revokeMyApiKey` (189) | MEM (called selfGate) | `revokeOwnApiKey`; guard team; target limits in client-ID table | new self-key denial/admitted controls |

### `app/t/[team]/codebases/[slug]/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `recordFindingDecision` (15) | LEAD (tier=team) | `getCodebaseIdentity`, `decideCodebaseFinding`, `audit`; guard team; target limits in client-ID table | new direct finding action role denial/admitted control |

### `app/t/[team]/social/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `discoverNow` (41) | ADM + lib/access/enforce:visibleItemIds | `discoverOpportunities`; all-four-error refusal before consumer/revalidation; ctx.teamId/member chain only as classified | actual-export four-leg refusal/effect evidence, exact/partial/nonempty and genuine-empty admitted controls including revalidation; discarded-error/continuation mutants |
| `discoverFromArcsNow` (62) | ADM + lib/graph/partition-read:resolveArcScope | authorized prerequisite `resolveAnsweringKeys`/scope-owner arming; then scoped `discoverOpportunitiesFromArcs`; ctx.teamId/member/groups | new social boundary/co-guard and applicable exact-scope connection cases; admitted controls |
| `planNow` (91) | CHAIN | `planOpportunity`; ctx.teamId/member chain only as classified | new social boundary/co-guard and applicable exact-scope connection cases; admitted controls |
| `generateDrafts` (109) | CHAIN + second lib/access/enforce:visibleItemIds | `generatePlanDrafts`; ctx.teamId/member chain only as classified | new social boundary/co-guard and applicable exact-scope connection cases; admitted controls |
| `setAutonomyLevel` (130) | ADM | `setAutonomy`; ctx.teamId/member chain only as classified | new social boundary/co-guard and applicable exact-scope connection cases; admitted controls |
| `submitApproval` (146) | CHAIN | `submitForApproval`; ctx.teamId/member chain only as classified | new social boundary/co-guard and applicable exact-scope connection cases; admitted controls |
| `decideContentApproval` (164) | CHAIN | `decideApproval`; ctx.teamId/member chain only as classified | new social boundary/co-guard and applicable exact-scope connection cases; admitted controls |
| `connectTypefully` (192) | ADM | `saveTypefully`; ctx.teamId/member chain only as classified | new social boundary/co-guard and applicable exact-scope connection cases; admitted controls |
| `setDryRun` (208) | ADM | `setPublishDryRun`; ctx.teamId/member chain only as classified | new social boundary/co-guard and applicable exact-scope connection cases; admitted controls |
| `scheduleVariantAction` (221) | CHAIN | `scheduleVariant`; ctx.teamId/member chain only as classified | new social boundary/co-guard and applicable exact-scope connection cases; admitted controls |
| `cancelPublicationAction` (248) | CHAIN | `cancelScheduledPublication`; ctx.teamId/member chain only as classified | new social boundary/co-guard and applicable exact-scope connection cases; admitted controls |
| `refreshAnalytics` (270) | ADM | `runCollectAnalytics` counts-only; existing ENFB-4 chain exemption, ADM still required | new social boundary/co-guard and applicable exact-scope connection cases; admitted controls |
| `generateImage` (283) | CHAIN | `generateVariantImage`; ctx.teamId/member chain only as classified | new social boundary/co-guard and applicable exact-scope connection cases; admitted controls |

### `app/auth/welcome/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `setInitialPassword` (12) | SELF | `setPasswordIfUnset` | new welcome action + conditional credential PG |

### `app/t/[team]/admin/pm-sync/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `projectBoardAction` (24) | ADM | `projectAllTasks`, `recordProjectionRun`, `audit`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `reconcileDivergenceAction` (87) | ADM | `reconcileProviderState`, `audit`; guard team; target limits in client-ID table | new module-family action denial/admission |

### `app/t/[team]/admin/approvals/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `decideApproval` (22) | ADM | `governedActions.decide` or team-bound `resolveApproval`; `createE2BSandbox`; no legacy dispatch for governed | new approval action + real-PG binding/state/fault tests |
| `decideManagedGatewayApproval` (75) | GATEWAY | `decideGatewayApproval`; guard team; target limits in client-ID table | existing AIO-1208 dashboard-conversation-auth action proof + gateway PG |

### `app/t/[team]/admin/agents/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `mintAgentTokenAction` (46) | SCOPE | `mintAgentToken` only after admin + normalized request + conditional admin/launcher project visibility | new mint action cases: exact admin AND launcher scope connection, each visibility/existing `VisibleProjectRows.error` arm only, all-reachable control; oracle-leg narrowing is not v6 refusal certification |
| `revokeAgentTokenAction` (108) | ADM | `revokeAgentToken`; guard team; target limits in client-ID table | new module-family action denial/admission |

### `app/t/[team]/admin/integrations/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `saveIntegration` (90) | ADM | `rejectPrivateSlackChannels`, `upsertIntegration`, `setIntegrationSecret`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `toggleIntegration` (129) | ADM | `setIntegrationStatus`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `rotateSecret` (145) | ADM | `setIntegrationSecret`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `syncSlackNow` (229) | ADM | `runNowThenReconcile`, `runSlackIngestion`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `syncPlaneNow` (248) | ADM | `runNowThenReconcile`, `runPlaneIngestion`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `syncLinearNow` (264) | ADM | `runNowThenReconcile`, `runLinearIngestion`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `syncGithubNow` (280) | ADM | `runNowThenReconcile`, `runGithubIngestion`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `addGithubRepo` (302) | ADM | `linkGithubRepo`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `removeGithubRepo` (326) | ADM | `unlinkGithubRepo`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `connectGithubToken` (347) | ADM | `validateGithubToken`, `ensureGithubIntegration`, `setIntegrationSecret`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `checkGithubAccess` (371) | ADM | `githubReposAndToken`, `checkRepoAccess`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `estimateGithubImportAction` (392) | ADM | `githubReposAndToken`, `estimateGithubImport`, `getGraphEfficiency`, `countPreviouslyImportedTasks`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `saveOpenrouter` (459) | ADM | `validateOpenrouterKey`, `saveOpenrouterSettings`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `projectToGraphNow` (487) | ADM | `readStagingRuntimeState`, `runGraphProjection`, `recordIngestRun`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `saveProvisioningSettings` (541) | ADM | `saveProvisioningSettings_`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `saveProviderModel` (571) | ADM | `saveProviderModel_`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `setAnsweringProvider` (595) | ADM | `teams` config update by ctx.teamId; `audit`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `setAnsweringModel` (626) | ADM | `teams` config update by ctx.teamId; `saveProviderModel_`, `audit`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `setExtractionModel` (707) | ADM | `teams` config update by ctx.teamId; `audit`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `setExtractionSmallModel` (766) | ADM | `teams` config update by ctx.teamId; `audit`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `setReasoningModel` (872) | ADM | `teams` config update by ctx.teamId; `audit`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `setEmbeddingModel` (913) | ADM | `teams` config update by ctx.teamId; `audit`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `removeIntegration` (962) | ADM | `deleteIntegration`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `setMeetingTaskStatus` (986) | ADM | `setMeetingTaskStatusDb`, `audit`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `setPrimaryPmProvider` (1014) | ADM | `teams` config update by ctx.teamId; `audit`; guard team; target limits in client-ID table | new module-family action denial/admission |

### `app/t/[team]/admin/members/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `linkMemberGithub` (29) | ADM; member target DEFERRED AIO-1227 | `linkGithub`, `after`, `reconcileAttribution`; guard team; target limits in client-ID table; PR714 runtime held | new module-family action denial/admission |
| `linkMemberIdentity` (61) | ADM; member target DEFERRED AIO-1227 | `setMemberIdentity`, `after`, `reconcileAttribution`; guard team; target limits in client-ID table; PR714 runtime held | new module-family action denial/admission |
| `linkMemberSlack` (91) | ADM via actually invoked linkMemberIdentity; target DEFERRED AIO-1227 | `linkMemberIdentity`; guard team; target limits in client-ID table; PR714 runtime held | new module-family action denial/admission |
| `unlinkMemberIdentity` (101) | ADM | `removeMemberIdentity`, `after`, `reconcileAttribution`; guard team; target limits in client-ID table; PR714 runtime held | new module-family action denial/admission |
| `addMemberEmail` (131) | ADM; member target DEFERRED AIO-1227 | `addAuthorAlias`, `after`, `reconcileAttribution`; guard team; target limits in client-ID table; PR714 runtime held | new module-family action denial/admission |
| `reattributeIdentitiesNow` (160) | ADM | `reattributeItems`, `bustTeamLearningCaches`; guard team; target limits in client-ID table; PR714 runtime held | new module-family action denial/admission |
| `resetMemberPassword` (188) | ADM | `adminSetPassword`, `audit`; guard team; target limits in client-ID table; PR714 runtime held | new module-family action denial/admission |
| `setMemberRole` (229) | ADM | `updateMemberRole`, `syncMemberActor`; guard team; target limits in client-ID table; PR714 runtime held | new module-family action denial/admission |
| `setMemberManager` (276) | ADM | `updateMemberManager`, `syncMemberActor`; guard team; target limits in client-ID table; PR714 runtime held | new module-family action denial/admission |
| `removeMember` (305) | ADM | `deleteMember`, `syncMemberActor`; guard team; target limits in client-ID table; PR714 runtime held | new module-family action denial/admission |
| `retryProvisioning` (349) | ADM | `runProvisioning`; guard team; target limits in client-ID table; PR714 runtime held | new module-family action denial/admission |
| `removeMemberEmail` (384) | ADM | `removeAuthorAlias`, `after`, `reconcileAttribution`; guard team; target limits in client-ID table; PR714 runtime held | new module-family action denial/admission |

### `app/t/[team]/admin/brand/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `saveBrand` (11) | ADM | `saveBrandProfile`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `addAsset` (27) | ADM | `addBrandAsset`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `removeAsset` (43) | ADM | `removeBrandAsset`; guard team; target limits in client-ID table | new module-family action denial/admission |

### `app/t/[team]/admin/access/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `runContextBackfillAction` (13) | ADM | `backfillTeamContext`; guard team; target limits in client-ID table | new module-family action denial/admission |

### `app/t/[team]/admin/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `inviteMember` (61) | ADM | `createMember`, `issueMemberInvite`, `resolveTeamUrl`, `rollbackMemberCreation`, `syncMemberActor`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `getProvisioningAvailabilityAction` (203) | ADM | `getProvisioningAvailability`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `issueApiKey` (211) | ADM; key member-target binding DEFERRED AIO-1226 | `issueApiKeyPrimitive`; admin team admission only, missing desired same-team target lookup recorded | new admin denial/admission; desired foreign-target refusal DEFERRED, NOT PASS |
| `revokeApiKey` (230) | ADM | `revokeApiKeyPrimitive`; guard team; target limits in client-ID table | new module-family action denial/admission |

### `app/t/[team]/admin/policies/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `savePolicy` (11) | ADM | `updatePolicy`, `createPolicy`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `togglePolicy` (25) | ADM | `setPolicyEnabled`; guard team; target limits in client-ID table | new module-family action denial/admission |
| `removePolicy` (37) | ADM | `deletePolicy`; guard team; target limits in client-ID table | new module-family action denial/admission |

### `app/t/[team]/admin/attribution/actions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `previewAttributionCorrectionAction` (28) | ADM | `buildCorrectionContext`, `resolveAnsweringKeys`, `parseCorrectionPlan`, `previewCorrection`; guard team; target limits in client-ID table | attribution-drilldown existing two action denials + new remaining cases |
| `getMemberItemsAction` (69) | ADM; viewer content policy DEFERRED AIO-1228 | `getMemberItems` existing privileged team-wide admin read, no actor oracle; not certified viewer scope | attribution-drilldown current admin denial/admission only; desired viewer denial DEFERRED, NOT PASS |
| `previewCorrectionPlanAction` (91) | ADM | `previewCorrection`; guard team; target limits in client-ID table | attribution-drilldown existing two action denials + new remaining cases |
| `applyAttributionCorrectionAction` (107) | ADM | `applyAttributionCorrection`, `after`, `bustTeamLearningCaches`; guard team; target limits in client-ID table | attribution-drilldown existing two action denials + new remaining cases |

### `app/actions/tasks.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `moveTaskAction` (52) | WRITER | `tasks` team-bound update after row-writer predicate; `after` → `projectTaskByIdAfterWrite`; guard team; target limits in client-ID table | task-update PG candidate + new all-three action denial controls |
| `createTaskAction` (85) | PROJECT | `tasks` team-bound insert after project visibility; `after` → `projectTaskByIdAfterWrite`; guard team; target limits in client-ID table | task-update PG candidate + new all-three action denial controls |
| `updateTaskAction` (152) | WRITER | `tasks` team-bound update after row-writer predicate; `after` → `projectTaskByIdAfterWrite`; guard team; target limits in client-ID table | task-update PG candidate + new all-three action denial controls |

### `app/actions/meeting-todos.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `scanMeetingTodosAction` (64) | TEAM + lib/access/enforce:visibleItemIds | oracle-bounded `scanMeetingTodosForTeam` private source rows; all-four-error refusal before consumer | actual-action real-PG visible/restricted scan, exact/partial/nonempty/genuine-empty scope, four-leg refusal/effects, omission/widening/wrong-principal and discarded-error/continuation mutants plus independent member/posture cases |
| `createMeetingTodosAction` (121) | TEAM only; unresolved content authority DEFERRED AIO-1225 | supplied-row `createMeetingTodoTasks` overwrite and whole-project `projectAllTasks` lack actor content binding; known source gap | membership/posture denial only; desired resource/no-hidden-export denial DEFERRED, NOT PASS |

### `app/actions/decisions.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `createDecisionAction` (31) | LEAD + PROJECT | `decisions` team-bound insert after role + project visibility; owned runtime held; guard team; target limits in client-ID table | new executing current behavior cases; no governed rewrite |
| `setDecisionValidityAction` (87) | LEAD + WRITER | `decisions` team-bound update after role + row writer; owned runtime held; guard team; target limits in client-ID table | new executing current behavior cases; no governed rewrite |

### `app/actions/projects.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `createProjectAction` (20) | MEM | `projects` insert, `ensureProjectGraphPointer`, `grantProjectToCreator`; guard team; target limits in client-ID table | existing system-project-grant PG candidates + new action denial |

### `app/actions/account.ts`

| Export (base line) | Guard / protocol | Protected effects and target context | Evidence group |
| --- | --- | --- | --- |
| `changeMyPassword` (14) | SELF | `changePassword` | new own-account action tests + change-password PG |
| `signOutAction` (30) | OUT | own-cookie `signOut`; `redirect("/login")`; no tenant/data/provider write | new own-account action tests + change-password PG |
<!-- END IMMUTABLE V6 BODY -->

END EXACT V9 CONTENT.

## Appendix B. Frozen lexical census and separately sourced corrections

The original 325 candidates are a lexical matcher result. They are not a completed semantic census. The original 311/14 disposition split is proposal-era classification, not safety coverage. Match counts, names and coordinates remain historical; no supplemental source is retroactively added to the candidate set. Every original candidate identity follows, with its observed matcher families, rather than a new semantic-safe label.

Frozen matcher definitions and occurrence counts:

```json
{
  "matcherFamilies": [
    {
      "name": "builderFrom",
      "source": "\\.from\\s*\\(",
      "flags": "g"
    },
    {
      "name": "builderMutationMethod",
      "source": "\\.(?:insert|upsert|update|delete)\\s*\\(",
      "flags": "g"
    },
    {
      "name": "computedMutationMethod",
      "source": "\\[\\s*[\"'`](?:insert|upsert|update|delete)[\"'`]\\s*\\]\\s*\\(",
      "flags": "g"
    },
    {
      "name": "queryOrExecuteSink",
      "source": "\\.(?:query|execute|unsafe)\\s*\\(",
      "flags": "g"
    },
    {
      "name": "sqlTemplateTag",
      "source": "\\b(?:sql|query)\\s*`",
      "flags": "g"
    },
    {
      "name": "rawSqlDmlToken",
      "source": "\\b(?:INSERT\\s+INTO|UPDATE\\s+[\"'`A-Za-z_]|DELETE\\s+FROM|UPSERT\\s+INTO)\\b",
      "flags": "gi"
    },
    {
      "name": "databaseLibraryImport",
      "source": "\\b(?:from\\s*[\"'](?:pg|postgres|@supabase|drizzle|kysely)|require\\s*\\(\\s*[\"'](?:pg|postgres|@supabase|drizzle|kysely))",
      "flags": "g"
    },
    {
      "name": "genericFromTarget",
      "source": "\\.from\\s*\\(\\s*[A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)?",
      "flags": "g"
    },
    {
      "name": "tableLikeHelperParameter",
      "source": "\\b(?:function\\s+[A-Za-z_$][\\w$]*\\s*\\([^)]*\\b(?:table|relation|target)[A-Za-z0-9_$]*\\b|(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*=\\s*(?:async\\s*)?\\([^)]*\\b(?:table|relation|target)[A-Za-z0-9_$]*\\b)",
      "flags": "gi"
    }
  ],
  "familyOccurrenceCounts": {
    "builderFrom": 983,
    "builderMutationMethod": 404,
    "computedMutationMethod": 0,
    "queryOrExecuteSink": 263,
    "sqlTemplateTag": 35,
    "rawSqlDmlToken": 97,
    "databaseLibraryImport": 22,
    "genericFromTarget": 123,
    "tableLikeHelperParameter": 37
  }
}
```

| Historical candidate | SHA-256 | Bytes | Lexical family: lines (not semantic disposition) |
|---|---|---:|---|
| `app/actions/decisions.ts` | `f28b752a85aae0ee519e4e41abae58ceab199cb973ec98013275ed233e0eb09a` | 4717 | builderFrom: 54,93,111; builderMutationMethod: 55,112 |
| `app/actions/meeting-todos.ts` | `853c294c4b94a68b332c1dc09f26488f2af4f6bd5509853aefe1bc1ee30ed581` | 5691 | builderFrom: 50,95,104 |
| `app/actions/projects.ts` | `0830fc98f1a547b27e9322997d668311bfab8865f8fda0e54d6ee9685c668ccb` | 5767 | builderFrom: 38,48; builderMutationMethod: 39 |
| `app/actions/tasks.ts` | `4a561b345b9bb027ce86aec33692982b734da614008841cde036bdf75db8b46e` | 10096 | builderFrom: 59,70,109,158,184,196,215; builderMutationMethod: 77,110,215 |
| `app/api/auth/slack/callback/route.ts` | `f4534257c30c16ee36dd226b48598d01e4ac951738e095dd00e5947af8fb5eaa` | 5442 | builderFrom: 113 |
| `app/api/auth/slack/start/route.ts` | `d0c1f7fc85781b9a37ce8f3855a9aa1ba4653c14e2e6fe5f23917436e1661553` | 2466 | builderFrom: 54; builderMutationMethod: 54 |
| `app/api/brain/arcs/recompute/route.ts` | `4b08bfa869e9919e5a670ed11facbce9732057400d67ed07b6e2821559bd43e5` | 9949 | builderFrom: 56,59 |
| `app/api/brain/arcs/route.ts` | `46ac9a036c1f0ff71a7c143bb016b75af1ba61f5eb8047c058d39161b44906fb` | 8080 | builderFrom: 40,43 |
| `app/api/brain/events/route.ts` | `0ac2b3ddd0af0026c3dc0a681a86b2ffeacc427ba4b8d4258c5b6c4f78de115f` | 5722 | builderFrom: 28,31,69 |
| `app/api/brain/facts/route.ts` | `cb2319630b04b2620b39e05202551226ac3eabd4b7c8e5dd79e36737e8704c09` | 5650 | builderFrom: 30,33,69 |
| `app/api/dashboard/access/inspect/route.ts` | `0e81190daa7f7e6cae0a38222ce299f61835fb875d3f4c67f728d2ffec608ac0` | 4601 | builderFrom: 33,36,54 |
| `app/api/dashboard/conversations/route.ts` | `c36f183bac532456ba5d90515effba9c0cce06de542f38198623a2499cde7e97` | 2033 | sqlTemplateTag: 15 |
| `app/api/dashboard/query/route.ts` | `fdff591f446a1d789fe9a4733f09ea26c2f72cf5f4ef19f16c129b2e712de1ed` | 15685 | builderFrom: 108,115,128,182,190; sqlTemplateTag: 174 |
| `app/api/dashboard/social/media/[id]/route.ts` | `c21c0c9d74ddcdedea5fe8016c3c55a6a2f897c8bdbdd1ba5a7d94b7d71c181d` | 2135 | builderFrom: 23,42 |
| `app/api/dashboard/team-work/route.ts` | `be90bf0b08073952594ce3124c72a960fe4407bd2af382978bf14504d4a9e141` | 2495 | builderFrom: 28,31 |
| `app/api/dashboard/timeline/route.ts` | `20dca7c3c5beb96bd46ff9963ed4a5516cdd9132384cd878d86ca0a7837e3bc2` | 3947 | builderFrom: 40,43 |
| `app/api/internal/executor-gateway/v1/authorize-and-redeem/route.ts` | `8ed4d1cee20bcf4b51a3e63b148650cf65fd2cdc4d0222220b0dffb32eca0d10` | 5044 | builderFrom: 119; genericFromTarget: 119 |
| `app/api/v1/company-graph/route.ts` | `7cd56a6cab731902a18d26bb06669e6527d865b4fc1f077c55ffeffcb01ba47d` | 4996 | builderFrom: 56,61 |
| `app/api/v1/graph-query/route.ts` | `c9c3cab3f82fbe2a12716fabc08534a33833f309e6838dbc88105a990fcc8329` | 4509 | builderFrom: 52,72; sqlTemplateTag: 19,30 |
| `app/api/v1/identities/resolve/route.ts` | `857ab04cb8aa2b00ce81802be0c706e98d66c28134e0968fefda7488085336f0` | 3654 | builderFrom: 59 |
| `app/api/v1/items/[id]/route.ts` | `bb9a5c116909c8e6e306810198d9eb10574bab8deb13b93b259b49dfd5de7387` | 2823 | builderFrom: 43 |
| `app/api/v1/items/route.ts` | `f61bcb0e928532fce9f4b647577892bec0dd45ab9a4bf6344d030b43b940cc64` | 14292 | builderFrom: 229 |
| `app/api/v1/me/slack-token/route.ts` | `1fc10f57d348f53dd5e786ec08ea1b669ac2fc136ec74f2a8b6500cb43407e3c` | 4467 | builderFrom: 87 |
| `app/api/v1/members/invite/route.ts` | `c9c93129727fdbc3da37df29b6154438264f7fe45488d5c4d87fb76dee848215` | 7291 | builderFrom: 58,68 |
| `app/api/v1/members/route.ts` | `b186f11c62c2300756688e7739941cb7bea0477c1c0faee6942ac9e972f242bb` | 3351 | builderFrom: 43 |
| `app/api/v1/okf-bundle/route.ts` | `04171b50d5d47196a1e7e3f46c5b77bdafe1d5cb6ad0620deb61547a9b8f6c81` | 6913 | builderFrom: 70,88 |
| `app/api/v1/projects/route.ts` | `7ac5488bc21b5bb63673e5b2f9663eaecd6ed5b165d6abe1fe4311878cf90af5` | 2296 | builderFrom: 35 |
| `app/api/v1/query/route.ts` | `1d9377f71f2df0287a5525b11187b7ebe16b1ff6be41fd3ae2f85a52b2d4fdfa` | 14781 | builderFrom: 74,82,127,139,192,249; builderMutationMethod: 193,249; sqlTemplateTag: 27,66 |
| `app/api/v1/tasks/route.ts` | `c082c54cd29aff77388409de06c0d24d7757dced9f87ce741b527cf9d7aea8ee` | 13128 | builderFrom: 165 |
| `app/page.tsx` | `eed5e035ead9668e8e0a828c1a400f318f6bfd8d03306493040f990420227031` | 675 | builderFrom: 11 |
| `app/t/[team]/admin/actions.ts` | `33e1c1380444dcaab9a143cf76d5d3ca13fb28a29dc3502417f96145a1212ebf` | 9314 | builderFrom: 118,119 |
| `app/t/[team]/admin/agents/page.tsx` | `18464e2dc0500f40ed3956b4bfecf5753c4c98dfbdf07f30d3b4cff0ad1267fa` | 9371 | builderFrom: 67,73,75 |
| `app/t/[team]/admin/approvals/page.tsx` | `8066412864755016126548418118006b0dacee96f11b51f4173072f72b03a6a3` | 3380 | builderFrom: 22,30,36 |
| `app/t/[team]/admin/audit/page.tsx` | `35a3fbb56149630c35a56fad442bb7635037860bad6cfe7b84d0e757322fa97c` | 2634 | builderFrom: 13,20 |
| `app/t/[team]/admin/brand/page.tsx` | `0cf9850d1b40d5cd7a621b1b51796c467257de0f47147ed0017567ad9efdd870` | 1492 | builderFrom: 12 |
| `app/t/[team]/admin/integrations/actions.ts` | `a3485174cd349076653dcbfd58646210b2eae0accde08f33d3b221178392b34d` | 47781 | builderFrom: 604,641,684,732,775,887,945,1025; builderMutationMethod: 604,641,733,776,888,946,1026 |
| `app/t/[team]/admin/integrations/page.tsx` | `02cf090ac7063d3be9cf3971b86fffdd2879e35b4c981575ea378d18e17dedee` | 13114 | builderFrom: 40,49,148; genericFromTarget: 148 |
| `app/t/[team]/admin/keys/page.tsx` | `3d841ce921af4ae7b2edacb1e4147ad780eca8bf64762c38b6729fa6a9b80cdc` | 3767 | builderFrom: 14,22,27 |
| `app/t/[team]/admin/layout.tsx` | `0c59574f9134069a52b8e482371106c31f3ab39f6f5af1c8a00fc7e03b5cf3a9` | 2369 | builderFrom: 21,26 |
| `app/t/[team]/admin/loading.tsx` | `38e68c9f581d8f9eca4472ea9a5b4daeab37396eb15b8406ff41c23e826fe508` | 1818 | builderFrom: 26 |
| `app/t/[team]/admin/members/actions.ts` | `184553adedf7410dd4c6573b866a479fa7473f7ba72e8c374f4115e838541340` | 16834 | builderFrom: 203,313,359 |
| `app/t/[team]/admin/members/page.tsx` | `b9e5eb869f6e3fc32bc45a85a74ca1363612d8f5f453972c1b8a5284b0c2b97d` | 7155 | builderFrom: 24,36 |
| `app/t/[team]/admin/pm-sync/actions.ts` | `85fe8b5c647c119735664ce6640fd027fe9d4347304e813a98f4083fa0619ca9` | 4310 | builderFrom: 30 |
| `app/t/[team]/admin/pm-sync/page.tsx` | `40f5d4c4a1f1429cd91706e732e2433118d14816a3a778c5c81e442f0a5438f0` | 10635 | builderFrom: 23,31,38 |
| `app/t/[team]/admin/policies/page.tsx` | `9509d0c4035805c6556a7072237b14d2e56fae6ba0470d9746eb5d3335b4e8d6` | 1185 | builderFrom: 9 |
| `app/t/[team]/admin/usage/page.tsx` | `9116662c6da74299698fcac52e77c7a2620f221c910fa6b2ba0fe9b3ba4170ba` | 8082 | builderFrom: 37,43 |
| `app/t/[team]/codebases/[slug]/actions.ts` | `3b1c07e3a1e8fbd1b832211b1260271ce6bbe7f6bc93eebc0c2b8b689e00a3c1` | 2258 | builderFrom: 30 |
| `app/t/[team]/codebases/[slug]/contributors/[author]/page.tsx` | `3395b470642eea369fcdf7f799245bc4b6261f2aa1f310cb48982a6fe00a9dbb` | 4422 | builderFrom: 46 |
| `app/t/[team]/codebases/[slug]/page.tsx` | `c6ec889881bcaeb6dc7bb1bb89dc99164a6fee68a04216b2bb576291408877d1` | 7706 | builderFrom: 45 |
| `app/t/[team]/codebases/github/page.tsx` | `145297a6ab564b01c0b2f30c5c7a20e92a61cd4e9e1b287b4ebf4ddce6aee462` | 7038 | builderFrom: 53 |
| `app/t/[team]/codebases/page.tsx` | `d364ad4dbcd3ce60028e3cfd14ebcb57628ae3ba68bd6bc62d506e2d1d771cb0` | 2732 | builderFrom: 27 |
| `app/t/[team]/decisions/page.tsx` | `4c32641ebd72ec856f7d1441008c578472c1888d1eb047f7985f8b5cbf1f3d41` | 5146 | builderFrom: 18,27,55,64 |
| `app/t/[team]/library/[itemId]/page.tsx` | `4912d4e66bd3a8e3640a23ea6757daca428e96408ee87329ff40cbf2050873df` | 6039 | builderFrom: 20,27 |
| `app/t/[team]/library/skills/page.tsx` | `115ea4eefacde538c56b2bab153847ec07c48ee5e31f757e65a4f4df43dd92b4` | 5771 | builderFrom: 70,83 |
| `app/t/[team]/loading.tsx` | `e95bb38aafcfdf5d8ab3fd60a4335500d3c73dcafc2827e17cd1f8c84d0da286` | 2152 | builderFrom: 27,37 |
| `app/t/[team]/maturity/page.tsx` | `8a7e54504021f84183980c401394525cfaef08be7984b6949b2e993ac08e85ac` | 5318 | builderFrom: 35 |
| `app/t/[team]/maturity/people/[handle]/page.tsx` | `853ac51a8fb13040dda056aef5620900ce29774cd66ad1ec9f8cae6e5484c822` | 5259 | builderFrom: 38 |
| `app/t/[team]/maturity/people/page.tsx` | `d32b1ed62243369c0d96681db097aa4892266d3e05d8ac2de8e036e34f524222` | 7714 | builderFrom: 49 |
| `app/t/[team]/meetings/actions.ts` | `54d1bf6be6e0831de1a8bf3eb7ed355dca0f0e3c68d2cd6a1187c16ec69a6711` | 21390 | builderFrom: 44,76,132,139,225,239,251,307,389,399,418,443; builderMutationMethod: 419; tableLikeHelperParameter: 353 |
| `app/t/[team]/page.tsx` | `2927dbb8fbc28d2aeedf799c41459e2a15c8171d63936a27d2e9f0cfae0985f2` | 16631 | builderFrom: 150,152; sqlTemplateTag: 85 |
| `app/t/[team]/people/[handle]/actions.ts` | `0ec18ad8772f83f58ed3cfd42cea3c2fe42c8a98f1a0e2aa7e899a8849a40d43` | 8234 | builderFrom: 43,53,194; tableLikeHelperParameter: 41 |
| `app/t/[team]/people/[handle]/page.tsx` | `93d776c4fbb84d5b702cc72f584389f73bc5c951201becf97acf090584107427` | 9229 | builderFrom: 43,63,77,126 |
| `app/t/[team]/projects/[project]/page.tsx` | `d7bcb2855736719a1d9a2c4208efb161fa9dbf3164419e8d935474b664fff2bc` | 11935 | builderFrom: 40,47,71,81,89 |
| `app/t/[team]/projects/page.tsx` | `8fd1d6aaf3ad38d1fc0a240795489bb3e9a7f7b4a9bd90ae2e5bd2aee6c4dbdc` | 3346 | builderFrom: 18 |
| `app/t/[team]/query/page.tsx` | `f65b471c6b6c97f75e8dfa232d6052f74848b102b2e11dce5e8030eca969787b` | 1086 | builderFrom: 19 |
| `app/t/[team]/social/actions.ts` | `1c551356abcfaaf6eca60031943f936e0f071b1b1665aabf23a6f466078206d0` | 14375 | builderFrom: 174 |
| `app/t/[team]/social/page.tsx` | `fd1e37aac8500202380dfd532413e1f9774af118dca2465b3646064e8cee2567` | 9009 | builderFrom: 30 |
| `app/t/[team]/tasks/extract/page.tsx` | `e5b08600bf677c4949f670e9544366617f345e3ecc3105525cbb09d72a842d09` | 2463 | builderFrom: 16 |
| `app/t/[team]/tasks/page.tsx` | `b2896eca3d74c290941c0154280fdf5885286df7188be0982ae22174e00d1a14` | 6201 | builderFrom: 20,62,66,72,78 |
| `app/t/[team]/team-tools/page.tsx` | `1e8c88ed0706d80b47ec5a402601761f93ddfe715aefbdff14285a66f7639f39` | 4290 | builderFrom: 18,31 |
| `lib/access/admission.ts` | `f3e5ee230a45085f8c1cc10ee01f82ee9dd03f4213eae8db2f03467cb23791e5` | 11047 | builderFrom: 77 |
| `lib/access/agent-tokens.ts` | `ceb112f8dbb9eb485328e43d740b430d173b62c4329f85131a4d718d4767fba3` | 11344 | builderFrom: 77,152,202,211,250,262,284; builderMutationMethod: 153,159,210,251,284; genericFromTarget: 211 |
| `lib/access/bootstrap.ts` | `246237f9b41169e12ce8b1ca8987fecced5647f75b3cc5d4b951e2a4ab5ba28b` | 11658 | builderFrom: 53,76,100,107,131,180; builderMutationMethod: 77,101 |
| `lib/access/enforce.ts` | `751eaa06bfb55a9991a7cd5004e588827a029e3631ae303fed844f2916dea27b` | 28846 | builderFrom: 77,105,117,507,514,523; builderMutationMethod: 192; tableLikeHelperParameter: 376 |
| `lib/access/groups.ts` | `3d163347585ec62307a5fe45602754f325371a9853e70eb7733b8c5cbcf43d07` | 52775 | builderFrom: 67,77,118,128,134,165,179,187,206,213,221,230,243,253,260,275,291,317,326,358,391,421,429,442,457,461,479,533,589,664,675,727,736,821,831,858,937,954,976,1017,1035; builderMutationMethod: 129,180,188,254,261,276,292,326,359,392,430,458,462,737,859,977; tableLikeHelperParameter: 85 |
| `lib/access/inspect.ts` | `2710daf7c4583030953de909092d70a298bf85fa6abcddcb8a0d66d0978f38c1` | 10873 | builderFrom: 65,66,84,122,132,133,177,178 |
| `lib/access/oracle.ts` | `edfd638f90f1aca39e0007859f52b71af951b6d75f1657198bc93348058e24c9` | 7170 | builderFrom: 79,88,110 |
| `lib/access/posture.ts` | `e4215d32976a1657f64a8c3f1451a9daa3d001385d9a6ffbbf2b5cb12eb06b33` | 2117 | builderFrom: 35 |
| `lib/access/repair-verb.ts` | `281c541c6537b337d11fdd74b1331ba647ae6f4a7e7e13388bb509fd7354ca85` | 5226 | builderFrom: 72,82,92 |
| `lib/actions/actions.test.ts` | `76517b668fc24ebb777cda495719efcfa17350e0ec9eb249d84f517b7f0529a2` | 20103 | builderFrom: 466,472,479,486,496,497,498; builderMutationMethod: 466,472,479,486 |
| `lib/actions/governed/contract.ts` | `b98251ab627e04b0a9414ddfd27d9c0f56009296e229f24af7aca6dc0ca350f4` | 5795 | builderMutationMethod: 205 |
| `lib/actions/governed/index.ts` | `66f804d6e101432a92830403ee29c3f693ef85245a70bc2c814b0824ea068e79` | 21553 | queryOrExecuteSink: 92,124,139,162,187,240,360,373,377,380,416,572,579,619; rawSqlDmlToken: 220,349,491,506; databaseLibraryImport: 3 |
| `lib/actions/governed/transaction.ts` | `beccbcf5488d64938b54aabd8eb23167076ec86c3c663fb7cc9d84c4c30b7835` | 3080 | builderMutationMethod: 38,51,69,85; queryOrExecuteSink: 58,59,60,63,71; databaseLibraryImport: 2 |
| `lib/actions/handlers.ts` | `5c4f332a57cb02c19708c6b7f260ecfe3d23c25f09f494046d886dba7328b34b` | 2762 | builderMutationMethod: 38 |
| `lib/actions/index.ts` | `8e68069cc427d84aa6903a753e03a3e22a8c4219abbdf6ce05ade66fe5de8abd` | 23027 | builderFrom: 131,153,277,290,295,351,366,437; builderMutationMethod: 132,154,438; queryOrExecuteSink: 539; tableLikeHelperParameter: 568 |
| `lib/admin/access-health.ts` | `ea6701bdce89c44807b9bcaed2bf7ef0fa05cdfb6831dd7348f6cbc879539c3c` | 15656 | builderFrom: 92,136 |
| `lib/admin/aliases.ts` | `744290a9327c58dfaac7d87664a522fb76e7ca847983589f6379a53efc0f00e3` | 4793 | builderFrom: 33,41,51,59,70,76,111,118; builderMutationMethod: 42,51,70,76,118 |
| `lib/admin/keys.ts` | `fecbd3ddc2e6a023c56b32178380f91ccca41aa8576037d5caa5a41cf10eb206` | 3268 | builderFrom: 21,49,82; builderMutationMethod: 21,25,50 |
| `lib/admin/members.ts` | `2a4c9fbcbc6007c45ef6d084eb7338385c8005d7e2ed5ee61075991ae0315e82` | 14631 | builderFrom: 64,88,89,166,197,210,218,253,263,274,306,318,327,331; builderMutationMethod: 88,89,166,218,275,327,332 |
| `lib/admin/teams.ts` | `dff8132fe11f8222c934188c91c00e45cdcb71797aad6c492c50bf94807f6f47` | 5983 | builderFrom: 31,38,119,131,143; builderMutationMethod: 39,144 |
| `lib/api/audit.ts` | `5edd45176510c9c4a9150c03431ca9af363f0c15c51c87d17c4e5d72311e7dd6` | 2048 | builderFrom: 21; builderMutationMethod: 21; queryOrExecuteSink: 49; rawSqlDmlToken: 50; databaseLibraryImport: 2 |
| `lib/api/auth.ts` | `9794676f0bcd7c9d7edb08066bcde2bda63379a50ea82dc10583f0b58129a4cd` | 7674 | builderFrom: 71,111,150,160; builderMutationMethod: 112,159; genericFromTarget: 160 |
| `lib/api/rate-limit.ts` | `589ed972def2c300fbc5871b0489e41f399aba7ff8715bf05f0ca05f1116fa13` | 2392 | builderMutationMethod: 22 |
| `lib/attribution/contributor-credit.ts` | `35249a0decac05af0c6348ed30df50ed8ad4d3a334c2f17aefc635f5bacf3dee` | 14580 | builderFrom: 113,117,146,178 |
| `lib/attribution/resolve-authors.ts` | `2f476396e74b75ae0fbaec621d0bf9b99a6367b59351f299af0492420be4fb5a` | 12914 | builderFrom: 211 |
| `lib/auth/cleanup.ts` | `61e39fa41268ee8589750480a774b020524942119c79ce61c13333ac2e054b02` | 1539 | rawSqlDmlToken: 26,30 |
| `lib/auth/guard.ts` | `fcc026722da9939047e91f6a0d634fc3748c48c563a40623ed7662568a603bac` | 2180 | builderFrom: 23 |
| `lib/auth/password.ts` | `268ee70a45026d3018388849629ffbc605f544cbd29da28aa6247dbb12f7e314` | 2486 | builderFrom: 41,42; genericFromTarget: 41,42 |
| `lib/auth/pg-login.ts` | `888490ef76692bdc21e92bebbd29e91254560b5f598c068672500f98927d0f39` | 10202 | builderMutationMethod: 179,210; rawSqlDmlToken: 20,119,182 |
| `lib/auth/session.ts` | `8c23edcda8f2f9455217132e03c4334990b6ed6bb8b85b3ac6e6edd25619cf4a` | 698 | builderMutationMethod: 20 |
| `lib/auth/slack-oauth-state.ts` | `76401e2a76b0737fadd996683ec924b87eab46b2738c2bba5d0ec4a104a5266e` | 3892 | builderFrom: 50,87; builderMutationMethod: 51,88 |
| `lib/auth/team-context.ts` | `ad036a325c7bee41f7b4533ab086bd33e326b5d29ba7a67d9024d09c44a170ae` | 2284 | builderFrom: 44 |
| `lib/brand/assets.ts` | `e0d0f94c5ee7bb05de3aed3861d89785a5d77382c0c53a6fd2794b4f4187c087` | 2917 | builderFrom: 33,50,82; builderMutationMethod: 51,82 |
| `lib/brand/manage.ts` | `cc075bfd3ef48ecdb197f8e3fd61ccac00031231ed2902cfce915141274fbf1e` | 2528 | builderFrom: 32,52; builderMutationMethod: 52 |
| `lib/cache/tier-invalidation.ts` | `1e2f30f359f6b096631f0f84aebbe2835d17741013c69033d1ae0623c191944c` | 6644 | builderFrom: 78 |
| `lib/chat/session.ts` | `cb7bdc3170b0fa1a79cd52c2918efb09b7e86c9f9523832ab5b30ad71a2bf00a` | 1050 | builderFrom: 16,19 |
| `lib/chat/store.ts` | `5b507d6b604ea0573c8c7446a69386c2e4b28cccfbe70d98954533a7dd52ae54` | 9726 | builderFrom: 53,68,93,113,128,153,164,184,194,213,239,262,277; builderMutationMethod: 54,94,114,240,263,278 |
| `lib/codebases/commits-to-items.ts` | `f9e93fc40ca29739b7fd8b5e32c0a4ee1f6f1a9cd6a74d5d28023213d6333a2a` | 5225 | builderMutationMethod: 41 |
| `lib/codebases/debt-intake-validation.ts` | `4b9137aa932e78199111172c382499ecc89e4725be705a938ccbc235e259dc11` | 12638 | builderMutationMethod: 56 |
| `lib/codebases/debt-intake.ts` | `29f1d054db7df88229122620f1d7f1f46f9a778cab6100e801bc5a6c3401fcca` | 12079 | queryOrExecuteSink: 58,59,60,143,187,192,196; rawSqlDmlToken: 188,193,197; databaseLibraryImport: 2 |
| `lib/codebases/github-api-scan.ts` | `9db547c816f8ad071bbe6e5e0d1e65e2c1b0da7ea2ac17061c9dfa34540d9ff1` | 13088 | builderFrom: 235,243,262,290; builderMutationMethod: 263,290 |
| `lib/codebases/github.ts` | `288cfbc7866fa60db61112351106525037a792e1cf3b5e32035872896e905a95` | 5341 | builderFrom: 109; builderMutationMethod: 110 |
| `lib/codebases/ingest.ts` | `e42efea2f438e92f107cc8803fa12eb30b7efd1117f0bb59dbe812199626d830` | 10259 | builderFrom: 39,93,177,214; builderMutationMethod: 40,94,177,214 |
| `lib/costs/ingest.ts` | `2212d1c37fb2cb52090907dfa937164157c2e731e6f0818ce571591ea1bca69f` | 2180 | builderFrom: 25; builderMutationMethod: 26 |
| `lib/costs/llm-usage.ts` | `b89d4212ba85a96f8088bc7d463e567a948e00836f3fa1ef6a22cf85004e808c` | 7837 | builderFrom: 76,143; builderMutationMethod: 76,143 |
| `lib/dashboard/doc-task-infer-run.ts` | `1c59375b3035db061dbaa760d7d0d5b603abd35cdd96ee6579ed26e73615aa99` | 36794 | builderFrom: 182,192,431,451,487,516,559,585,658,702; builderMutationMethod: 432,451,585 |
| `lib/dashboard/doc-task-infer.ts` | `5975a812125c82cbbbd795ada146f14c1240e6771d214bf1fa5e1a863c76eaba` | 18646 | builderMutationMethod: 232,233,234,235,236 |
| `lib/dashboard/nav-items.ts` | `0b709925ed1465e70c5370252119973cf352b8a3001183b99c7292a8228ef244` | 4316 | sqlTemplateTag: 37 |
| `lib/dashboard/timeline-cache.ts` | `88dbde0e7cd976722165ca61c8439cedd8859d59218cf4581381a34cd174982c` | 42320 | builderFrom: 331,422,456,509,510,532; builderMutationMethod: 83,422,448,456,499,509,510,529,532,566,574,575 |
| `lib/dashboard/timeline-evidence.ts` | `3a9f9652e7bbef1be35fd02f22bf72ac52deb12155972ba2f229d0924ee1a5cd` | 4870 | builderFrom: 33,36,46,68,74; builderMutationMethod: 68,74 |
| `lib/dashboard/work-timeline.ts` | `89aaa6c1f36ef85fa6d25510b64d41833fdc5596c548e5bfe01bd0c91d2ec1ca` | 53466 | builderFrom: 254,255,258,311,332,359,577,612,725,758 |
| `lib/db/pg/pool.ts` | `039406836d3ee39caa5f0082e74cc6e88be4597c65842d1f2e27bd79cd4d1819` | 4383 | queryOrExecuteSink: 96; databaseLibraryImport: 2 |
| `lib/db/pg/query-builder.ts` | `c5d18a3a3a62ff8a19b0a13c4e8182f1d5b49af9ae9e514e5cff668c4be1fc3c` | 17027 | queryOrExecuteSink: 223; rawSqlDmlToken: 445,465; tableLikeHelperParameter: 251 |
| `lib/db/pg/tx.ts` | `8d68b27b4dd4f702d3373c6a9fd1bccb65b5c4d3eb01e631ae1748f261798546` | 15382 | queryOrExecuteSink: 154,204,421,431; databaseLibraryImport: 2 |
| `lib/db/types.ts` | `0ce10eda0063ed24d272dd4d73acf6267a90e834627abf0e0741438b1012cad1` | 3867 | builderFrom: 5 |
| `lib/env/staging-marker.ts` | `017f84dce00082e37d4fe4d8082615aef00f9c85e1d8fc47c3d6d98ada6c5017` | 1891 | sqlTemplateTag: 8 |
| `lib/gateway/admin-persistence.ts` | `f1236941befcb448952b3333a84493675fdae796b17017dc02da0c88b1da9cc4` | 21755 | builderFrom: 426,427,452; builderMutationMethod: 11; queryOrExecuteSink: 115,130,177,187,192,208,213,318,332,339,345,359,368,374,387,393,407,412,466,478,498,503,524,525,533,539,541,544; rawSqlDmlToken: 116,193,218,333,340,369,388,394,491,499,534; genericFromTarget: 426,427,452 |
| `lib/gateway/canonical.ts` | `27dba19a5a912d947479b152387426b8ecc96ca618bbfa3233c5ef8f5e001809` | 1553 | builderMutationMethod: 44 |
| `lib/gateway/envelope.ts` | `250bcd2846634da89838b33f026964b9603865d8d9d82f435b9485b8e2f523e2` | 4480 | builderFrom: 27,28,37,41,50,63,101,102; builderMutationMethod: 59,117; genericFromTarget: 27,28,50,101,102 |
| `lib/gateway/http.ts` | `5473477c78586dc7d25d3e01da650287f4825ecf5a1fe5fd4acc3b1f771faa8d` | 5305 | builderFrom: 118; genericFromTarget: 118 |
| `lib/gateway/persistence.ts` | `44ad5a0dacbd49b32696ef25cb7d94e18a6ca796074edf7d2667d856b05b79b3` | 54972 | builderFrom: 39,40,94,95,132; builderMutationMethod: 17,106; queryOrExecuteSink: 48,55,139,171,180,210,255,312,330,345,392,396,397,440,454,458,510,515,605,662,666,675,681,686,730,736,741,752,761,773,791,800,870,1010,1046,1079,1191,1263,1267; rawSqlDmlToken: 49,56,181,211,248,256,313,336,346,398,459,687,742,762,856,871,1011,1054,1080,1134,1192,1268; databaseLibraryImport: 3; genericFromTarget: 39,40,94,95,132 |
| `lib/gateway/policy.ts` | `c6928d73753a14f471aac5d1d1d1ccacbc4d25e28d6e008b51a8c9eee773330b` | 3773 | databaseLibraryImport: 2 |
| `lib/gateway/sealed-credential.ts` | `ba9b2076cda75a088ad9e494ac3e1088fca25e6b9bde3009e1e2366a41fd3701` | 4413 | builderFrom: 26,31,58,102,103,104; builderMutationMethod: 12,70,145; genericFromTarget: 26,58,102,103,104 |
| `lib/graph/arc-cache.ts` | `d25b8b10e11832d3754d05b2967cf4c4f8355494cf848fc457d0cbc2247d3ed9` | 14114 | builderFrom: 69,113,133,148,173,240,263; builderMutationMethod: 113,133,148,173,240,264; rawSqlDmlToken: 197 |
| `lib/graph/arc-continuity.ts` | `2230fd886a0b4879e7d9f8701d8e6520e5c1f0cf7bd33fda669fb69ab3572616` | 17011 | builderMutationMethod: 69; tableLikeHelperParameter: 309 |
| `lib/graph/arc-corrections.ts` | `a0cf4d717952895829c2b1c17679e136ce22dcd806b15d3d058d50923545cc5f` | 8304 | builderFrom: 54,100; builderMutationMethod: 54 |
| `lib/graph/arcs.ts` | `bed4264bdb0cfc50e6f25fcadf831516138f638f9fa47c10bdbb76c698a23b78` | 87177 | builderFrom: 1060; builderMutationMethod: 174,915,916,917,918,919,984,1034,1047,1073,1281 |
| `lib/graph/arming-row.ts` | `415ba16b7c5e08f2c4c489dfbe3f98fe3214cb686645775bc6eda9da9853b08c` | 1309 | builderFrom: 20; builderMutationMethod: 20 |
| `lib/graph/arming.ts` | `cfce94e1627f51de6ca610a3e9ff2558a6cb35845a18a0ad7f166297d0734944` | 9404 | builderFrom: 36,50,120,157; builderMutationMethod: 158 |
| `lib/graph/cdc.ts` | `0ad3b17c954bfbe0bbfadf7483dbe58c99fe596eac672111dd319bc79895f8b5` | 16668 | rawSqlDmlToken: 22; tableLikeHelperParameter: 175 |
| `lib/graph/company-actors.ts` | `0a29bded703f3a66f0616019a34dd08f5f4bb00d96b38d16705f1468808ef916` | 6521 | builderFrom: 51,61,104,113,144,153,163; builderMutationMethod: 61,105,113,145,154,164 |
| `lib/graph/extraction-alert.ts` | `74e85028b3131430d6198b59d2435639f80006201ce7f18938a99850c6f3c21a` | 27320 | builderFrom: 72,295 |
| `lib/graph/fanout-surface.ts` | `554b6ff82f262f09ce35a4e5aa823ea413210fbaca8ab5b433e2c395a504203c` | 3700 | builderFrom: 45,55 |
| `lib/graph/human-actors.ts` | `a3726d9dfda4a7ec78466ab65ad796c415835e6930a1a8378acef6cd814e74fc` | 1985 | builderFrom: 23 |
| `lib/graph/landed-state.ts` | `024386a11dbd36d051ce0ff83d6363502ab19324538e05768e4c05e098633c4d` | 5224 | builderFrom: 41 |
| `lib/graph/partition-read.ts` | `8a26fff48ddfc3dd4098fac395a7390c826c836182271cc38addf52563745963` | 11121 | builderFrom: 57 |
| `lib/graph/pret3-boot-sweep.ts` | `09d056f5ab6faab7ae8c5222751dc4254d8f8cfc6455744c61414c16ab9cf3fa` | 3786 | rawSqlDmlToken: 27,33 |
| `lib/graph/project-pointer.ts` | `92055d42133d2cf66a50d7ecf9ed34c60eb96d95ca4a81f259af6c36ad4962ac` | 8400 | builderFrom: 43,83,98,121,133; builderMutationMethod: 122,134 |
| `lib/graph/project.ts` | `06774065ffd60f1fdfa11eb9154102dc799e8ccab1bb6273d52cdb480362ec8c` | 101256 | builderFrom: 458,481,503,590,604,621,640,731,753,847,921,972,999,1027,1046,1092,1150,1181,1215,1266,1297,1452,1583,1642; builderMutationMethod: 459,481,504,548,604,621,641,972,1000,1028,1047,1093,1151,1182,1216,1266,1298,1453,1583,1642 |
| `lib/graph/reconcile.ts` | `d4a77e7bed6ef87945e7490312e7cab796aeef4c8585627e497cd4af7647e580` | 53287 | builderFrom: 334,369,413,618,697,807,815,820,834; builderMutationMethod: 369,618,697,807,816,821 |
| `lib/graph/run.ts` | `67f985f5771a84767cf610ee27daab3e65cb61ce2911b927bda3f9d8952f3a66` | 26373 | builderFrom: 137 |
| `lib/graph/tier-groups.ts` | `59c109468a4d69d715c537871978360b89376f495318512fa03e848d91f58aa9` | 9980 | builderFrom: 67,88 |
| `lib/graph/walk-lock.ts` | `a2109c7bedaf8dd26c63d86166b65f6ad8c14d9452c666270d58ade535517936` | 2665 | queryOrExecuteSink: 49 |
| `lib/health/readiness.ts` | `498a11342b2dcc54f24c9385d708498508209519889eb6f071dc3f30c4f3ecee` | 1939 | queryOrExecuteSink: 38; databaseLibraryImport: 2 |
| `lib/identity/context.ts` | `a750a9b2c4ba9da101ec4d3a8a28244ce8737c97b2af8386c394b305ade0e99d` | 8759 | builderFrom: 120,133,139,145,239; tableLikeHelperParameter: 71 |
| `lib/identity/list.ts` | `864804646fc069daca2a205969256c49c6b8931087f52c1ed463650a3e2366fd` | 1978 | builderFrom: 38,46 |
| `lib/identity/member-identities.ts` | `6f4d1cb5b774b55d1d1256578830a6263117f3219b1f08c4092ae2f665c09e89` | 4589 | builderFrom: 52,62,68,74,109,118; builderMutationMethod: 63,68,75,118 |
| `lib/identity/profile.ts` | `6233b8bf11a72bb35025f1a2908f6c8eac6f21b2ef293c84206ca7506730db3b` | 21912 | builderFrom: 191,203,214,283,360,366,390,469,485,503,562; builderMutationMethod: 192,204,284,391,470,486,563; rawSqlDmlToken: 409 |
| `lib/identity/resolve.ts` | `e895d254392a5ce3c091b53928d722765b079e473d3b7fe46be87ee1729f4dc0` | 5712 | builderFrom: 39,64,75 |
| `lib/ingest/attribution-correction.ts` | `7261d951469133399326bb72692cfdb240924b72dd2feec9dde44fd851f4877a` | 3898 | builderFrom: 43,55; builderMutationMethod: 56 |
| `lib/ingest/cursors.ts` | `f3124e14d2f8ac2efd8e6e609d4b893360593dd636827fa52c5a4a43db37aa6b` | 2112 | builderFrom: 27,47,54; builderMutationMethod: 48,54 |
| `lib/ingest/decisions.ts` | `1b58d31a64d42167df962cc922eec101c3d733132b497adcfa1448e72cc7c63b` | 2140 | builderFrom: 15,42,50; builderMutationMethod: 15,50 |
| `lib/ingest/evidence.ts` | `464c3bdc394d19fc39c964b6259126e11891c7a5ea7f997c344974b4a3dddd42` | 3074 | builderFrom: 25,35,52,86; builderMutationMethod: 35,52,86; genericFromTarget: 25,35; tableLikeHelperParameter: 16 |
| `lib/ingest/forget-bodies.ts` | `9ebf508ce2ffee96bb1e602665bdd4cf0cf56c4212cba5410afbc4e193452716` | 2854 | builderFrom: 36,51; builderMutationMethod: 55 |
| `lib/ingest/github-watermark.ts` | `bde095a24353c3402559c5a7f7024fc3bc6aea8291e30226c6594b4716a4774f` | 4259 | builderMutationMethod: 88 |
| `lib/ingest/index.ts` | `70435b041e9056672cfe26b5d011782eee06e29d425028f84042a5a904c6fadd` | 34618 | builderFrom: 156,373,497,504,518,586,696; builderMutationMethod: 92,157,374,498,511,518,587 |
| `lib/ingest/purge.ts` | `34c407c84c4ceff5c81d6d640a4c462c63917053725ac7afa62b3a7479fed072` | 10687 | builderFrom: 59,135,174,203; builderMutationMethod: 174; rawSqlDmlToken: 17 |
| `lib/ingest/reassignment-log.ts` | `fe0924675935628b6de8dfaab4a66c59cb4b2f7bfb358f9d2217962abbc7e03f` | 5183 | builderFrom: 51,121; builderMutationMethod: 121 |
| `lib/ingest/reattribute.ts` | `2afaf30673ebfe3f585352df35afb74a9e1e30845601f9560d73e76aa9c0afd8` | 7336 | builderFrom: 41,46,68,75,123; builderMutationMethod: 68,75,123 |
| `lib/ingest/reclassify.ts` | `9092fb3147518203f10a805d68174860268be5588da882bca3320a91c5d092a6` | 6244 | builderFrom: 72; builderMutationMethod: 72; genericFromTarget: 72 |
| `lib/ingest/reconcile-attribution.ts` | `dc1e73bd2293185202ca726ccfd67c938f7d89f35a2b17b087f5d435f6ff5cba` | 3309 | builderMutationMethod: 60,64 |
| `lib/ingest/run.ts` | `4c5464615306b8ed2347043a0260c14bf6c9afad4835bc83d6f477fa9baa27ad` | 34438 | builderFrom: 63,85,94,130,338,462,510; builderMutationMethod: 95 |
| `lib/ingest/runs.ts` | `188d0a9159e6990197793aecc7f5e704d26c7a9251b70a2780fe4322e742d644` | 5531 | builderFrom: 63,98,99; builderMutationMethod: 63 |
| `lib/ingest/scheduler.ts` | `cfa4d10d1f257b25e571ef78857de95eef3c1930061d7891e3ca78f4b8732b8f` | 29341 | builderFrom: 259,447,487,505 |
| `lib/ingest/slack-cleanup.ts` | `7b39af7ea3d523efb75a971d3d85f15eb7f0f1f5f6c0029600d9d7730dc4cb90` | 5144 | builderFrom: 29 |
| `lib/ingest/sources/clickup-normalize.ts` | `2d4522046cf45e481c7a31ac83a8fd966c033ec54034b056a96e50ef2ffa7a23` | 30619 | builderMutationMethod: 38 |
| `lib/ingest/sources/github-files-normalize.ts` | `be70668a098a2172f0056402790e5fc89e5d6018368d259ca04f5707bf303c03` | 3254 | builderMutationMethod: 37 |
| `lib/ingest/sources/github-files.ts` | `5941e846c0074b364ada4810fd128aa304f508ebf5a680e99cd6e146d53a81d5` | 6046 | builderFrom: 128; genericFromTarget: 128 |
| `lib/ingest/sources/github-normalize.ts` | `2bebdefed66a6f2c681ab163d8afba48339f27c6226dac14035be3fd70c7b483` | 4541 | builderMutationMethod: 49 |
| `lib/ingest/sources/linear-normalize.ts` | `aad67a01667131535807e52eb186cbd1f2fe5971bb7ff43835ac8a1e0f0b599a` | 11816 | builderMutationMethod: 85 |
| `lib/ingest/sources/plane-normalize.ts` | `7e39562f912b386477cfad594b560f3ee0f3209ea807ec82b0a560fe097b2e40` | 11504 | builderMutationMethod: 90 |
| `lib/ingest/sources/slack-normalize.ts` | `c4020337b46137456cfcfe9e7c335875ff89c14492d563fe55b4cee1c84690f0` | 7177 | builderMutationMethod: 22 |
| `lib/ingest/tasks.ts` | `c9956cd08eb6c7ebcafcab3c985f5a60d56ac822d3397821e9731d6807c424b0` | 11275 | builderFrom: 61,122,195,210,239,253,263,275; builderMutationMethod: 78,196,210,240,263,276 |
| `lib/integrations/github-link.ts` | `e69b0799543dbfa868b39dff36906ba7d61d4621cb6f13e4ca4cb12a9ef177d5` | 12680 | builderFrom: 26,199 |
| `lib/integrations/manage.ts` | `abe0d3b8f7a367fd7c008e325c48fc0bc87c52e442f0854d704a5d5b7a2a8683` | 16436 | builderFrom: 34,75,99,107,143,156,191,226,259,288,320,362,405; builderMutationMethod: 35,76,108,191,227 |
| `lib/integrations/openrouter.ts` | `6050ca8412454e49070981edf648d0043ae0b809d0016833070c0cb79530cf2a` | 3102 | builderFrom: 47 |
| `lib/integrations/read.ts` | `d9967cfc6fc420b4666e4d23a31ef04500f405140e2f2b0dc8c863a2c8f40138` | 4116 | builderFrom: 42,72,75 |
| `lib/integrations/typefully.ts` | `afcbe2913fcc425652abefb3e3ca187aca044755766f5c61cb44fb6b9002ba2b` | 3208 | builderFrom: 23 |
| `lib/jobs/store.ts` | `beb36eefa93cde18bec9ef76387d46b07b369b822b3fcc22e6e5d8f03e48fafa` | 9225 | builderFrom: 34,56,73,92,102,144,154,162,180,198,218,226; builderMutationMethod: 73,103,155,163,181,199,219 |
| `lib/jobs/types.ts` | `93fa0c3b850cb3d9818d190512127a927168959ca5580598e21eb9f60531a077` | 2585 | sqlTemplateTag: 6 |
| `lib/library/channels.ts` | `6073180f20d71c0127983d9ddc3ffa0cf91882394e4d9c561129f7e2b0bf7632` | 4745 | sqlTemplateTag: 35 |
| `lib/llm/graph-proxy.ts` | `df9d6ba28c5ed61552d29df3c9c6ba9f235e36dd6d37b095e4333fba62601525` | 26223 | builderFrom: 82,83,104,110; genericFromTarget: 82,83; tableLikeHelperParameter: 368,418 |
| `lib/media/store.ts` | `4228b94de5cacb89d1a6ef9527fd04b4cc781e14bc92c32f7a9c336b0fec7865` | 5935 | builderFrom: 47,88,106,157; builderMutationMethod: 48,158; rawSqlDmlToken: 124 |
| `lib/meetings/extract-todos.ts` | `d325d6937df9919567d193b7383f28a7020fa7f25cd76432f295e0af56c56ec0` | 22386 | builderFrom: 193,218,252,265,273,301,312,364,369,376,420,430,442,482,489,500; builderMutationMethod: 62,219,273,313,369,377,483,490,500 |
| `lib/meetings/from-items.ts` | `6954c0d765305e4758d9a25f693617019ee82d4862cf80ea54bc1ae8444292b0` | 16566 | builderFrom: 160,178,185,205,243 |
| `lib/meetings/link-notes.ts` | `d436a3ae3f9e0142b8562e080403a9bc3176075125c5c929fcbf9325455cb0f4` | 7584 | builderFrom: 61,78,92,113,117,121 |
| `lib/meetings/loaders.ts` | `e7f51dbe5c2fbc459debd910028771b8e662a80b88caa5733986867b5cfafb27` | 2137 | builderFrom: 16 |
| `lib/meetings/merge.ts` | `95c138911c61f5f6834ad61f422bd5a5eb70de377babd2b1b0838e15996854ec` | 28474 | builderFrom: 129,144,401,418,426,468,496,502,530,538; builderMutationMethod: 87 |
| `lib/meetings/notes.ts` | `11f0f0426295291813714c6ec9e380715b5495afdc277a7d34d12f7a5aebc9c8` | 21923 | builderFrom: 94,155,169,213,222,237,260,270,277,289,308,313,368,380,381,433,445,446,447,461,484; builderMutationMethod: 81,94,155,170,222,238,261,271,277,290; tableLikeHelperParameter: 276 |
| `lib/meetings/refresh.ts` | `d6a450d070eff9229728a7d09674c71d6794ff47bb3c7f5aa54d7da52ace2ff5` | 5983 | builderFrom: 67,80,87,109 |
| `lib/meetings/schedule-backfill.ts` | `d8bc2e4e8a03ecb190af66e2e244dbfa58a649d7ccc0a4ed849f0be7f5b3a418` | 9857 | builderMutationMethod: 96,98 |
| `lib/meetings/target-status-db.ts` | `d0967b438b2c34448e9662d51430fc87cfc963878a12992ae59154f2a61d974f` | 1095 | builderFrom: 9,16; builderMutationMethod: 17 |
| `lib/member-secrets/manage.ts` | `0c1528ff84cd8082827dece2a236287f27bc2405c205cefd935af020a3988af1` | 3522 | builderFrom: 38,71,94; builderMutationMethod: 39,95 |
| `lib/metrics/codebases.ts` | `18e7217ecb3463f9e0e7874431735188969dd3f4641774c92355ab73bbbc4c31` | 45276 | builderFrom: 163,173,385,400,582,600,637,644,652,660,665,669,677,1075,1086,1144,1211,1240 |
| `lib/metrics/external-costs.ts` | `42c1618f2658dde5ed3bae07340c0333ff25abc5040a7150e6a5ee6686c934db` | 12250 | builderFrom: 151,162,166,289,386 |
| `lib/metrics/graph-efficiency.ts` | `5d3ebd3167bf71cbcdb1a781c2ae580ef41c4735dafef91a68ba21d101f6342b` | 9917 | builderFrom: 204 |
| `lib/metrics/individual-maturity-ingest.ts` | `39c1329621b215afcf20949d4b16287a22093d152bf9a6b8005745e56592cabf` | 5126 | builderFrom: 34; builderMutationMethod: 35 |
| `lib/metrics/individual-maturity.ts` | `ab8ebe10b855fd799cbacf126be4d3b0c1bd0cd6e0ef87e9ba15597e7dd810f5` | 14893 | builderFrom: 222,251,320,329 |
| `lib/metrics/llm-costs.ts` | `c8b5f86688c050b80272b8822169286130a27809a1ea11cb4c3041703ec3f475` | 12414 | builderFrom: 156,181 |
| `lib/metrics/members.ts` | `0ef24aa58e06ae61335b138c9d053efd6376ee57466889c0e923eec8fe68cfe9` | 10249 | builderFrom: 80,89,94,198,251,255 |
| `lib/metrics/pulse.ts` | `accb3040ccf3d80c01a6165371b98ddc5baba1db3642e8d6da5314f34766addd` | 15846 | builderFrom: 196,207 |
| `lib/metrics/subscriptions.ts` | `ca8c0b326e41d198527ce3fe35da76deef51fb31a6c3d33f8fb7d393ead10f58` | 2449 | builderFrom: 43,51 |
| `lib/pm-sync/after-write.ts` | `58d0b65ba1934fca5f1f9ca5c1a65e64228ca8f8369c9e2b583afc0efcfdc380` | 5175 | builderFrom: 29,73 |
| `lib/pm-sync/inbound.ts` | `9a238768a9cb3eeb9d5e8f00ce90eecd71b68a52d97a932edae0c9543073363d` | 29107 | builderFrom: 164,175,294,320,388,401,419,646; builderMutationMethod: 295,321,367; queryOrExecuteSink: 248,257,260,464,490; rawSqlDmlToken: 465 |
| `lib/pm-sync/index.ts` | `2730a28bbe231099b5c4e62197b58facfed01c2293437866c742ca1354213691` | 3199 | builderFrom: 73 |
| `lib/pm-sync/linear-client.ts` | `a2496a8c05fb27d704728c3e9476efe0bc7423d5004ab91ad183ddde2264d627` | 8961 | sqlTemplateTag: 16 |
| `lib/pm-sync/linear.ts` | `e0d72f723527aab3a88190f3ffea3b70f6fe994db6b63093b1b901a29432acf6` | 24456 | builderMutationMethod: 69 |
| `lib/pm-sync/project.ts` | `f84f7e9562601e2ac7c7e49e727f57808de50cbb826decd79601344cd81eb3df` | 24887 | builderFrom: 125,180,199,233,252,264,373,405,478,524; builderMutationMethod: 199,234,253,405,449; genericFromTarget: 478 |
| `lib/pm-sync/provider.ts` | `05209f399c0d4c15e605ae05b248166362094dfe3a05b150103d49967579790b` | 10995 | builderMutationMethod: 213 |
| `lib/pm-sync/reconcile.ts` | `9cad6dcd76888ac124559dcd904c8ac2afc8c261c80bf102e2e0b99c43d81f78` | 5689 | builderFrom: 100,120; builderMutationMethod: 121 |
| `lib/pm-sync/runs.ts` | `a40f3032d21594d9693485ac19f61fcbb7d93a1461f277e0947db6f0f36b87b9` | 9935 | builderFrom: 99; queryOrExecuteSink: 192 |
| `lib/policy/index.ts` | `e900a45018b49a64d537d3c42fcf9f5656d89a525ac89c910b799e91a74dfc2e` | 2813 | builderFrom: 51,85; builderMutationMethod: 86 |
| `lib/policy/manage.ts` | `00f79ad204fd6f240556e860449cd20d13c25bd4c4f3109b35f791e3a5cfd93b` | 6189 | builderFrom: 59,86,105,128,149,167; builderMutationMethod: 106,129,150,167 |
| `lib/projects/context/backfill-cursor.ts` | `984675fd49e395d73549b57331e1bb3f6a99573c363eedf5fabaeafa30e1aaa2` | 6280 | builderFrom: 74 |
| `lib/projects/context/backfill.ts` | `2a2249ce8b8a0de244f8254a4287535fcf08bd9f4be65fd04c0bfbbd06e2f3c0` | 16299 | builderFrom: 106,220 |
| `lib/projects/context/coverage.ts` | `43d7b498cb2569c6aab061342a4fcd7377db26e2ac6076df6dbfc9d5f90b838c` | 9773 | builderFrom: 181; sqlTemplateTag: 150 |
| `lib/projects/context/fanout-targets.ts` | `a9befbe7bd72385f633e6e3b85474d717c7b3740d267900f04385cf27f0d1f61` | 8551 | builderFrom: 59,71 |
| `lib/projects/context/memberships.ts` | `42561052cf4c153a1ec227e74d2374958a24218e64c2cc7daf1b1b58c1bd8224` | 15268 | builderFrom: 89,108,142,164,179,191,217,247,275,294,325,337; builderMutationMethod: 142,180,295 |
| `lib/projects/context/reconcile-item.ts` | `35788709805b2b1080d6a31e64d411d9f217d2dc5ddc23833b97a55bbbdc2438` | 6743 | builderFrom: 42,62 |
| `lib/projects/context/units.ts` | `e85cd65008d64b8ba19c0a2804ddcbb2aa3aee7907ff6c1f7c80a6c6a8fbd257` | 3664 | builderFrom: 37,85; builderMutationMethod: 86 |
| `lib/provisioning/run.ts` | `eb297c7c534691a456c92d67ca20a9b5882fe36bf9e83d073d99d6d744744bec` | 4883 | builderFrom: 50,129; builderMutationMethod: 50 |
| `lib/provisioning/settings.ts` | `de8f03d181b89a6aa53fbe32ee2977ad44554d7c8d5d34c9deec410eb97a7978` | 4226 | builderFrom: 33 |
| `lib/query/answering.ts` | `21243289e86c49a4e3af8c5a999d94697c43c4e835a4e84a6b4b2106ee50bb9e` | 3921 | builderFrom: 54; sqlTemplateTag: 10 |
| `lib/query/dense-index.ts` | `4f80d50b1c9a6dbb2004546f3ccd8f3466d5d46491cf1f4ec4576beb07a1147c` | 8685 | rawSqlDmlToken: 74,82,91 |
| `lib/query/embedding-key.ts` | `88c700445931d46babaef5514ff28e203a2a2832c40af6f35ba8ac4846a45126` | 3325 | builderFrom: 47 |
| `lib/query/evidence.ts` | `139a9ba31ac494c90fd8b8d7a77608c770bc7e0eb6774e321484188818f420c2` | 5132 | builderFrom: 16,17,18 |
| `lib/query/llm-backend.ts` | `a075477c25ae5f1cd824405a2badb12695106784f80384904c791e2c43ccfee0` | 18697 | sqlTemplateTag: 104 |
| `lib/query/retrieval-alert.ts` | `31afd138b97f3dd0a6a097265fe252b2b6ba9d90047aeeaa0f9d3716cda0e26a` | 3660 | builderFrom: 17,28 |
| `lib/query/retrieval-health.ts` | `ad3632563245c03174c962dcdf8bb8a2a57905b634b1acd1e6b90cbd57aea466` | 22294 | tableLikeHelperParameter: 184 |
| `lib/query/retrieve.ts` | `f26f1301959071cb3a6a011314df84100df12bfac5579557e3bbeb9d6a52db9c` | 59180 | builderFrom: 270,366,374,376,419,428,605,625,707,723,731 |
| `lib/query/stream-persist.ts` | `c85b589c663489944d724335d64fa2ce114a85c93b3c38e2fc85dcaa913cf286` | 10635 | builderFrom: 150; builderMutationMethod: 150 |
| `lib/query/turn-runs.ts` | `313440e8c507cb7379701dd2f261e948c8161e8301dabd9e292c2f56d4adec27` | 8375 | builderFrom: 85,110,123,137,157,170,191; builderMutationMethod: 86,111,124,138,158; sqlTemplateTag: 182 |
| `lib/secrets/crypto.test.ts` | `ed9f7d1cdb6003ed95e6f21cb33c1c2a77302756d9c03644d010d1d3b44d9185` | 1648 | builderFrom: 19,37,47; genericFromTarget: 19,37,47 |
| `lib/secrets/crypto.ts` | `e5c191939a162490412472161011e307bfcc7f985f2f3e062c43a4cc98b89d89` | 3934 | builderFrom: 57,58,73; builderMutationMethod: 65,81; genericFromTarget: 57,58,73 |
| `lib/social/analytics.ts` | `c97e536f929508b8b2b406e21cc6b529f0c12a8a14c3f64a50bc984121a40089` | 4139 | builderFrom: 35,65,75,117; builderMutationMethod: 35,118 |
| `lib/social/approvals.ts` | `867e4e36f42ade89f9469405aee5467ff13b46a42b8e11a0e232cb397e1598cd` | 7288 | builderFrom: 59,80,117,126,160,187; builderMutationMethod: 81,127,188 |
| `lib/social/discover-arcs.ts` | `654d2846094b71b566bc5ec4cc859dced2b7f67edf6c95b195dec3cbe9649b4d` | 7961 | builderFrom: 62,103 |
| `lib/social/discover.ts` | `4a1cc86c8d321892c5557f946fc4f29aaebd46135e9ef226b0204bd5a7f8cb1e` | 5436 | builderFrom: 85,98 |
| `lib/social/generate.ts` | `82476dc14bb8f9113cb377e5c628206ce4f010bab8875b68b918e65392daa664` | 12219 | builderFrom: 109,226 |
| `lib/social/plan.ts` | `01b8802bab1f30a8b5220caa926a4324c5c0725c17b23cce0778cb4b415e5bce` | 3846 | builderFrom: 74 |
| `lib/social/publications.ts` | `409ca5d547c9346e3f8a816823dd0d26482dcc6b69bdd914ff6786caaec4ff41` | 6566 | builderFrom: 39,80,102,125,140,162; builderMutationMethod: 40,81,103,163 |
| `lib/social/publish.ts` | `82f0288964fb8ab3dfe4b9ed21e2ca781a0d33b432b5493629b20fd108f12213` | 16989 | builderFrom: 76,79,87 |
| `lib/social/settings.ts` | `86b8f67bfb4cadda11cd8c41da362beae8254ef86e19a6b209115a7e061a49ba` | 2677 | builderFrom: 13,26,42,54; builderMutationMethod: 27,55 |
| `lib/social/store.ts` | `58a2e57bb979ff880a24e299a3c8ee4d80d4c1aa1bebd4c9c0008f8d93b5e6d5` | 24841 | builderFrom: 79,119,149,161,170,198,224,229,234,263,279,300,322,331,352,375,384,400,420,439,493,539,547,555; builderMutationMethod: 149,162,301,323,353,376,401,540,548,556; genericFromTarget: 439; tableLikeHelperParameter: 430 |
| `lib/staging/build-metadata.ts` | `8fcf852962c7d14f82482143c6f5b342a116f165cb87ad3fed4b51069ddc0f22` | 982 | builderFrom: 7; genericFromTarget: 7 |
| `lib/staging/runtime-policy.ts` | `ae54537b662b86119247e6084175f34a4422f704391c578daf68ac18e2a185c0` | 10096 | builderFrom: 130; sqlTemplateTag: 90; genericFromTarget: 130 |
| `lib/subscriptions/ingest.ts` | `c600878c164bfbc0f0ca1b5cf92473c1427a597a4582a88bc82d501a36ab033a` | 2001 | builderFrom: 32; builderMutationMethod: 33 |
| `lib/work-events/ingest.ts` | `e99f51db637f34d415afd1d312f4d93775cf04f2bc013171dcc07c82b274e03f` | 7021 | builderFrom: 47,65,77,136,161; builderMutationMethod: 78,140 |
| `lib/work-events/relink.ts` | `8f9a8839af95e6d29c096c8097b037bde5efa0087286f266245545472eb46feb` | 3131 | builderFrom: 24,38,63; builderMutationMethod: 64 |
| `scripts/admin.ts` | `2f68961bf15b8f46fc3fa03e95291b9e0218d94328875a72afced2a960ce1fb7` | 33840 | builderFrom: 42,101,201,211,226,229,258,265,276,295,302,366,371,490,507; rawSqlDmlToken: 505 |
| `scripts/backfill-meeting-attendance.mjs` | `94c168f4939796a113a71f58b624cf7d5013a87eae1c68ad90eec9e0e6abc385` | 7735 | queryOrExecuteSink: 102,122,128,150,153; rawSqlDmlToken: 150,154; databaseLibraryImport: 23 |
| `scripts/backfill-meeting-summaries.ts` | `36bac801e34d9989a404be5e92d9b21ff2f111d6ec38957ed8f76d99fa18c2e9` | 3847 | builderFrom: 39 |
| `scripts/brain-tasks.ts` | `45811ebccf4667a892511c1235b210a9130ae2147e5b3ba8c613316ad1454b99` | 18535 | builderFrom: 61,106,143,168,184,198,213,318,330,345,346; builderMutationMethod: 107,144,169,345,346 |
| `scripts/connectors.ts` | `db93bf2dbcaa15ad1cb27007badf3091f96566ba662a231f1c8a97c0ae349dd8` | 5000 | builderFrom: 47,52,61 |
| `scripts/debt-intake-migration-proof.mjs` | `d7c8c305fc51d1fff85b055096f2123cb11bf2efa79398356f12b1a3c57ae057` | 9152 | builderMutationMethod: 16; queryOrExecuteSink: 36,48,52,53,54,55,63,65,72,76,79,85,87,88,89,106; rawSqlDmlToken: 52,53,54,55,87,88,89; databaseLibraryImport: 10; tableLikeHelperParameter: 46,63,65 |
| `scripts/doctor.mjs` | `c37858aa13a5d838b41111e6f7a986d7ada2e4c95786736007344899c4593bf3` | 13464 | builderFrom: 122,123; queryOrExecuteSink: 251; genericFromTarget: 122,123 |
| `scripts/graph-ingest-cost.mjs` | `81efe2aaa3ec523091356bc89bb90e1ab8abd53ed0fa22be637d523b5364e824` | 17798 | queryOrExecuteSink: 202,204,215,228; databaseLibraryImport: 55 |
| `scripts/graph-window-battery/capture-tap.mjs` | `457cd822f0ca86dcf8c8dfc921b6933f761d7740be9da84ee884266f7a90433a` | 7168 | builderFrom: 101; genericFromTarget: 101 |
| `scripts/graph-window-battery/corpus.mjs` | `0afb17ded3b9890c61363ce49051b157969e382914bf24d34a472ad1cd7e4366` | 16186 | tableLikeHelperParameter: 158 |
| `scripts/graph-window-battery/harvest.ts` | `5f4f87dfaf4a3f60bf848b6f9262d557f87d488a4406203ebd049156fd38de29` | 3593 | databaseLibraryImport: 12 |
| `scripts/graph-window-battery/judge.mjs` | `83ea3437659f539336e4c59d07c402b5bcfac4909ab7cdd7b1cc94d29efc9959` | 10421 | queryOrExecuteSink: 200 |
| `scripts/graph-window-battery/phase-a-structural.mjs` | `bd1cdb1b7158728f87edcd461ecc462f270bd8e5f7e24fb0cf653697c37647d2` | 5393 | queryOrExecuteSink: 33,35,62; databaseLibraryImport: 22 |
| `scripts/graph-window-battery/seed-local.mjs` | `f554a5288e860a2c98b7bfcc81cb99c5bf81bd4153998ea1679f13af898e745f` | 9632 | queryOrExecuteSink: 54,61,94,97,111,133,142; rawSqlDmlToken: 61; databaseLibraryImport: 31; tableLikeHelperParameter: 53 |
| `scripts/meeting-pairing-report.ts` | `0ae14a81470e4f9dd17c266fa4f1df7f53a560336a0bb60e0749ddc444780d7b` | 11018 | builderFrom: 72,83,214 |
| `scripts/migrate-from-existing.mjs` | `24f54c02282dc21fe6e7262bce69ca6d8fb3d89ff5562c40cda36569f1392781` | 28855 | builderMutationMethod: 302,339; queryOrExecuteSink: 299,316,334,359,364; sqlTemplateTag: 5,7,10,13,21,30,31,39,185,245,433,467; databaseLibraryImport: 56 |
| `scripts/nda-scan.mjs` | `9f1cb63163a80f864ac8b503dc29b4e1819355dda7a55e02c8abaca508e1dc9f` | 29170 | builderFrom: 239,253; genericFromTarget: 239,253 |
| `scripts/pg-load-schema.mjs` | `e2ac6d87b43d96760693c4e24adabf73e07c37c2740d5baa12d420acf41f5e15` | 5966 | queryOrExecuteSink: 94,96,104; databaseLibraryImport: 20 |
| `scripts/pg-load-vector.mjs` | `065c009f2d81ab3f98909fe919d175f4ce428a396b649903045329450efc4918` | 1666 | queryOrExecuteSink: 35; databaseLibraryImport: 11 |
| `scripts/schema-fingerprint.mjs` | `8ab8e09ceb1c5101473dd5fbb0463287893b212f491561395a058f8bab13cb8a` | 9445 | queryOrExecuteSink: 186; sqlTemplateTag: 11,77 |
| `scripts/seed-demo.ts` | `6d86a6c26dfda8440590a17efb1f3ae495b497d03bfd04e03a00f43ed3447ff9` | 11407 | builderFrom: 115,140,162,224,241,256,258,260; builderMutationMethod: 116,141,162,166,183,224,241 |
| `scripts/setup/interview.mjs` | `4718d27a2ec56f5c170be19e12215b7ffdfab37681fe9e315339faa2eee356c9` | 6596 | tableLikeHelperParameter: 106 |
| `scripts/setup.mjs` | `d143e5d2677daf363e0a9ba771cf9b58103d969396761e786b9bee5fce8e053b` | 21546 | builderFrom: 114,116; genericFromTarget: 114,116 |
| `scripts/staging-ops/activation-evidence.mjs` | `c13d2c3edc946a48e0831589a42afa2ddcbcab44c9d507f8650ce6eb9396e237` | 32964 | builderFrom: 13,83,314,365,380,383; builderMutationMethod: 383,395; genericFromTarget: 83,314,365,380,383 |
| `scripts/staging-ops/activation-preflight.mjs` | `8beac8853d1d15256367782b36078714e9dc4e2f684e91d65014dbd5c6b957e0` | 64355 | builderFrom: 717,883; genericFromTarget: 717,883 |
| `scripts/staging-ops/bounded-process.mjs` | `77037005cd5ed7fb05fe524a5e9e19ee3fdb97517cc0f235d820e0f4e41c026c` | 5266 | builderFrom: 45; genericFromTarget: 45; tableLikeHelperParameter: 44 |
| `scripts/staging-ops/build-identity.mjs` | `cbc145d61be1f99ea12cff1e20487fb1be411deeb3022a4331e16547f54ee357` | 4370 | builderMutationMethod: 5 |
| `scripts/staging-ops/bundle-crypto.mjs` | `fe9ca26bbac218c37b55d45df2bf57cb3761ee80703e449227b647355f95c4af` | 6704 | builderFrom: 65,74,98,100,104,113,114; builderMutationMethod: 61,74,115; genericFromTarget: 65,74,98,100,104,113,114 |
| `scripts/staging-ops/bundle-format.mjs` | `7939dd217e21d1d8bfd76f745892854a346fcf9bf6bff2f33a1414fed139c36f` | 6781 | builderFrom: 10,15,22,27; builderMutationMethod: 6; genericFromTarget: 10,15,22,27 |
| `scripts/staging-ops/commissioning-case.mjs` | `3beb96ff6ae2c6f123ae15d0030d2c874c7778d4be6d598fdd93cfa65848eebd` | 21194 | builderMutationMethod: 171,175; tableLikeHelperParameter: 197 |
| `scripts/staging-ops/commissioning-journal.mjs` | `b492e5a6797685cab78091641eb4badb017967dfe474ca51f16fc987a7102838` | 51186 | builderFrom: 541,563; builderMutationMethod: 236,244; genericFromTarget: 541,563 |
| `scripts/staging-ops/commissioning-witness.mjs` | `0372dcd490f4889c5bee6e199ca8466d3b06bdda5e9de63d05e3019fb8c3f111` | 89928 | builderFrom: 943,1029,1232; builderMutationMethod: 136,137,180; genericFromTarget: 943,1029,1232 |
| `scripts/staging-ops/credential-fingerprint.mjs` | `38303e14b89dcfd0c3f01fc314718a8aefcc8be946bb33ac0727a30623662f92` | 4161 | builderFrom: 11,34; builderMutationMethod: 20,21,27; genericFromTarget: 11,34 |
| `scripts/staging-ops/exporter.mjs` | `d8e82a76856c1e1a2bb348798e541e359282fdc2f97f5da442022ed5eaa5681b` | 20742 | builderFrom: 147,274,293; builderMutationMethod: 23; queryOrExecuteSink: 32,99; databaseLibraryImport: 3; genericFromTarget: 274,293 |
| `scripts/staging-ops/fence-admission.mjs` | `e514028189b2949b436c2df2d5285464fd556f5db33d7f8f0f23a823e796ef97` | 5571 | queryOrExecuteSink: 40,48 |
| `scripts/staging-ops/image-audit/evidence.mjs` | `160b678858bb249d397cc8db6acda13901666eea246b5887e607ca2fa80d7995` | 14082 | builderMutationMethod: 237 |
| `scripts/staging-ops/image-audit/export-walk.mjs` | `78a8a36f989559eb5442f1bd7e2d6899f4d00499c792fe2bac13764a3dc2e62f` | 47872 | builderFrom: 244,289,297,832,908; builderMutationMethod: 136,599; genericFromTarget: 297,832,908 |
| `scripts/staging-ops/image-audit/layers.mjs` | `aeed58fff5b640a6ebd30fa37bfb02976fcc8561c8812903e6aed0e0a29c3188` | 26711 | builderFrom: 50,81; builderMutationMethod: 39,299,300; genericFromTarget: 50,81; tableLikeHelperParameter: 306,337 |
| `scripts/staging-ops/image-audit/recipe.mjs` | `c4c36e51f4af38b048fa43189b1d10394d81000abac7d7e0b40d0c2b47bdd96f` | 10995 | builderMutationMethod: 182 |
| `scripts/staging-ops/image-audit/registry.mjs` | `7035e6941c720733f91b7616f8aa332c970446634dabffbb0987907b2be0a288` | 18362 | builderFrom: 329; genericFromTarget: 329 |
| `scripts/staging-ops/image-audit/scan-surface.mjs` | `1243921cfd9dc17d80ae9151c7ab4db524761a0cd881f95aa61dede71051999a` | 11924 | builderFrom: 66,90,99,149,153; genericFromTarget: 66,90 |
| `scripts/staging-ops/image-audit/scanner.mjs` | `5b315665e968c8d5c369f3b3d5b6ea81dd71e0ed094184996f509697711979fa` | 23539 | builderMutationMethod: 188,201 |
| `scripts/staging-ops/image-audit/tar-reader.mjs` | `adb1ae1009b687b30595a1ba0e83e9f516360ef3cc75558f7028dfd7cb0856ec` | 34582 | builderFrom: 25,238; builderMutationMethod: 644; genericFromTarget: 25,238; tableLikeHelperParameter: 367 |
| `scripts/staging-ops/image-audit.mjs` | `61cd98cc6a84deef9250f0dc324eb269a4795c82dee731aeb2255ffa5a7a98fa` | 41819 | builderMutationMethod: 348 |
| `scripts/staging-ops/image-publication.mjs` | `60667a27934c05e9e62bd7b955ff6545a916ec66795e75423da1413ef4931856` | 32570 | builderFrom: 138; builderMutationMethod: 140; genericFromTarget: 138 |
| `scripts/staging-ops/importer.mjs` | `492859bdc0f1f19bf40c89015c02da6b26ac3c4ad424805d46d3e1bae18c996e` | 147267 | builderFrom: 146,358,707,1466; builderMutationMethod: 43,789,1689; queryOrExecuteSink: 229,245,251,253,276,457,479,1688; databaseLibraryImport: 4; genericFromTarget: 146,358,707,1466; tableLikeHelperParameter: 697 |
| `scripts/staging-ops/journal.mjs` | `510158b22ef6ce407855dfc4540f1aab30beaafe063d8b1c58111558370ac781` | 26493 | queryOrExecuteSink: 96,101,109,113,117,125,135,142,163,223,239,280,300,315,367,379,394,421,439; rawSqlDmlToken: 37,380,422 |
| `scripts/staging-ops/local-object-store-service.mjs` | `ba8822161fe7c6493909c01004661d34d533e7a43ebe14afaa1850b55afde4a3` | 7193 | builderFrom: 51,81; builderMutationMethod: 12,13,50; genericFromTarget: 51,81 |
| `scripts/staging-ops/neo4j-codec.mjs` | `6268cf1927e34c933f57056577648984c8c46dab4e246d11a62bab416855ecd0` | 2954 | builderFrom: 12,36; genericFromTarget: 12,36 |
| `scripts/staging-ops/object-store-acl-probe.mjs` | `279244c8ae3697470584e0a8497822cdb8286ebdc8a48edcb227e7747f530210` | 1528 | builderFrom: 9 |
| `scripts/staging-ops/object-store.mjs` | `554487bbfca3f58f1d963fb2db7c31b5b2348a51fdd3b7bc2bb9d3035f3e5a87` | 7276 | builderFrom: 28,93; builderMutationMethod: 13; rawSqlDmlToken: 92; genericFromTarget: 28 |
| `scripts/staging-ops/offbranch-probe-operator.mjs` | `816136c59e4649e89bf0206ba170ffc131f1dba1904f0eda7c704c8a887a7c30` | 100772 | builderFrom: 80,460,544,552,604; builderMutationMethod: 64; genericFromTarget: 80,460,544,552,604; tableLikeHelperParameter: 457 |
| `scripts/staging-ops/offbranch-probe.mjs` | `5acf6a8185b276c123e2617f4bc2d9331facbceca636353167508704843221c1` | 146143 | builderFrom: 1006; builderMutationMethod: 390; genericFromTarget: 1006 |
| `scripts/staging-ops/operation-deadline.mjs` | `01550893a3b2d3d2396045b3e789e1c20b82d5e64d0b1ec90b724ac6f65b3274` | 8288 | builderMutationMethod: 85; queryOrExecuteSink: 162 |
| `scripts/staging-ops/pg-paired.mjs` | `0575df0d2c499c23adb62f807bbca8edbc1dab348e6df9ca95591890fe14cc36` | 25960 | queryOrExecuteSink: 51,53,55,63,66,85,88,98,100,102,108,111,217,229,231,252,253,255,259,262,263,266,267,273,274,277,278,281,282,285,288,322,324; sqlTemplateTag: 14; rawSqlDmlToken: 324; tableLikeHelperParameter: 228,259,266,273 |
| `scripts/staging-ops/policy-commissioning.mjs` | `30d9987d53da85b8e14ac6b4c184ffaf8996bd9ced3b6c2fe60510d9e64ad0b8` | 590326 | builderFrom: 951,1046,1094,1109,1129,1144,1232,1243,1768,4630,7517; builderMutationMethod: 6402,6403,6969; sqlTemplateTag: 406; genericFromTarget: 951,1046,1094,1109,1129,1144,1232,1243,1768,7517; tableLikeHelperParameter: 947,4650 |
| `scripts/staging-ops/postgres-target.mjs` | `8679f5e96010473da65adfa85bb4b583bc4b2179ad34fa3092e615aecc5971e6` | 6733 | builderFrom: 14,15; queryOrExecuteSink: 98; genericFromTarget: 14,15; tableLikeHelperParameter: 91,112 |
| `scripts/staging-ops/private-store.mjs` | `f5b7c660991e1caecfef12e77dbb22e307053c860b0a067c75e26b676f146329` | 4285 | builderFrom: 32; builderMutationMethod: 55; rawSqlDmlToken: 64; genericFromTarget: 32 |
| `scripts/staging-ops/reapply-testers.ts` | `b43bfb710d26ebdcf7ef8bf9950104c0c6633cdee957e28383d81ada7c5a9c22` | 2608 | builderFrom: 14 |
| `scripts/staging-ops/release-controller.mjs` | `9aca898d769195c4ba261cb698ec3547df5a89dd7dc4581f9c95ee2cf773db22` | 30909 | builderFrom: 249; genericFromTarget: 249 |
| `scripts/staging-ops/reviewer-negative-probe-operator.mjs` | `3f96d9e167377a5fa19c11f9da1a12c114e2d666f26f7b4a92a92a6d6ad18185` | 74897 | builderFrom: 25,26,27,28,210,279; genericFromTarget: 25,27,28,210,279 |
| `scripts/staging-ops/reviewer-negative-probe.mjs` | `b8daf0823c08a6dd4066d49d70b42ddef85e73e9cbb35c85bb91a5537da9bb39` | 63862 | builderFrom: 52,56,86; builderMutationMethod: 37,110,296; genericFromTarget: 52,86 |
| `scripts/staging-ops/source-read-oracle.ts` | `467b89198583f936dabf2b9a86d2d8c7dda06782b7c574a6d41bc3a6e632f9d8` | 8959 | builderFrom: 83,84,90; builderMutationMethod: 59,83,84,90 |
| `scripts/staging-ops/staging-pair-fixture.mjs` | `02f3b2b3ae2e6cf85421b44b55f1663aa0a093df7e6abf676068f2b6e8f2109f` | 40206 | builderMutationMethod: 94,101,109,114,216,217,226; queryOrExecuteSink: 80,81,82,85,86,88,90,94,96,102,103,104,107,112,116,120,124,131,198,199,202,203,216,217,293,294,302,306,313,334,346,348,351,373,377,390,421,488,491,496,497; rawSqlDmlToken: 80,81,82,85,86,88,90,94,96,102,103,104,108,113,117,121,199,202,204,377,390; databaseLibraryImport: 4 |
| `scripts/staging-ops/startup-fence.mjs` | `e2be7559089577b3b4edcaabaf6aadc1d2d71192b80a4bc9d4d79711b6996923` | 10150 | databaseLibraryImport: 3 |
| `scripts/staging-refresh-decision.mjs` | `fdb272e51b5e8a7872ff4899498ab3027578f6f984ede01ff7f5fcf583de8b2f` | 30583 | sqlTemplateTag: 49,124; tableLikeHelperParameter: 191 |

### B.1 Corrections to v10 Appendix B labels and source observations

| Old location/claim | Correct v11 observation | Remaining limitation |
|---|---|---|
| Title “Durable semantic census” and 311/14 split | Frozen lexical candidate census with proposal-era dispositions. Original family totals preserved above. | Neither counts nor a nonmatch proves safety or sink completeness. |
| Matcher raw UPDATE and omitted helpers | The pattern ending `[A-Za-z_]\b` misses multi-character identifiers in relevant forms; `runSql`/`executeSql` were not lexical families. Original review identified 108 such helper sites in 42 files. | That review count is evidence of omission, not a replacement semantic census or a newly credited scan. |
| Row 74, `enforce.ts` line 376 | `canWriteStructuredRow` is table-dependent through `STRUCTURED_WRITE_TABLES`; it is not uniformly N. Six runSql sites use runtime `$n` parameters and nested fragments. Crypto `.update` at line 192 is non-DB syntax. | V10's fragment/placeholder abstraction was insufficient; general flow proof deferred. Narrow comment masking alone supplies no SQL proof. |
| Rows 122–124: pool/query-builder/tx | Real generic execution infrastructure with caller/receiver-dependent behavior. Tx lines 154/421/431 are transaction controls, not unexplained protected writes. | Preserve real generic flows; whole helper/receiver closure remains unproved and deferred, not a narrow gate prerequisite. |
| Admin persistence 318/345/374; governed transaction 59/60 | The inspected constant SELECT and SET LOCAL controls are not protected DML. | Correct historical U labels for these exact observations only; do not generalize to arbitrary SQL/callers. |
| Row 230, unit owner | `executeSql` line 53 executes `update project_context_units`; the lexical matcher omitted it. It is an actual owner-table write. | Not retroactive candidate matcher coverage; no permission for other tables. |
| Rows 265/323 | All five actual raw writes and their database contexts are enumerated in §4.1. | Uncovered residuals, no test-authority waiver, AIO-1230 owner agreement/accepted deferral still absent. |
| Literal task/decision callers and SQL fragments | A literal caller table does not establish semantics of all nested fragments/receiver flows. `provenance-sql.ts` constructs relevant SQL. | H2 remains a valid v10 counterexample. |
| LOCK, SET LOCAL, SHOW, SELECT FOR UPDATE, DISCARD TEMP, CREATE/DROP DATABASE, functions and `.rpc` | Statement/control distinctions must not be collapsed into a false `U means mutation` label or `SELECT means no side effects` claim. | General SQL statement/function analysis is withdrawn/deferred. Frozen materializer call controls remain required. |

### B.2 Exact supplemental identities, not retroactive candidate membership

The following identities are drawn separately from the 678-source index and the scope decision. Their membership in the original 325 set is reported explicitly. Reading a source identity is not an all-callers safety proof.

| Source | SHA-256 | Bytes | Original lexical candidate? |
|---|---|---:|---|
| `lib/access/provenance-sql.ts` | `b01c0884764cf74f49ff529777d5ac0a84a8d50e409851ae0e1f94bd3e39edbf` | 14801 | No — supplemental only |
| `lib/access/enforce.ts` | `751eaa06bfb55a9991a7cd5004e588827a029e3631ae303fed844f2916dea27b` | 28846 | Yes |
| `lib/db/pg/pool.ts` | `039406836d3ee39caa5f0082e74cc6e88be4597c65842d1f2e27bd79cd4d1819` | 4383 | Yes |
| `lib/db/pg/client.ts` | `d8ae792a1f1a3c500e51815a5e8bf00ece649468708e555f584447246d22e7db` | 4736 | No — supplemental only |
| `lib/db/pg/query-builder.ts` | `c5d18a3a3a62ff8a19b0a13c4e8182f1d5b49af9ae9e514e5cff668c4be1fc3c` | 17027 | Yes |
| `lib/db/pg/tx.ts` | `8d68b27b4dd4f702d3373c6a9fd1bccb65b5c4d3eb01e631ae1748f261798546` | 15382 | Yes |
| `lib/access/groups.ts` | `3d163347585ec62307a5fe45602754f325371a9853e70eb7733b8c5cbcf43d07` | 52775 | Yes |
| `lib/access/agent-tokens.ts` | `ceb112f8dbb9eb485328e43d740b430d173b62c4329f85131a4d718d4767fba3` | 11344 | Yes |
| `lib/projects/context/units.ts` | `e85cd65008d64b8ba19c0a2804ddcbb2aa3aee7907ff6c1f7c80a6c6a8fbd257` | 3664 | Yes |
| `lib/projects/context/memberships.ts` | `42561052cf4c153a1ec227e74d2374958a24218e64c2cc7daf1b1b58c1bd8224` | 15268 | Yes |
| `lib/ingest/fake-supabase.ts` | `8f1f69743f8a42ec98b14c9cee75e5d66d31438a6c6f82679267698e5fc7f062` | 10385 | No — supplemental only |
| `app/t/[team]/admin/agents/actions.ts` | `d5a1e6314dd9959e8e4cdb3ecf83bf7579e5642c9a3a61521bcf5a3bb480dde0` | 5945 | No — supplemental only |
| `app/actions/tasks.ts` | `4a561b345b9bb027ce86aec33692982b734da614008841cde036bdf75db8b46e` | 10096 | Yes |
| `app/actions/decisions.ts` | `f28b752a85aae0ee519e4e41abae58ceab199cb973ec98013275ed233e0eb09a` | 4717 | Yes |
| `scripts/staging-ops/staging-pair-context.ts` | `17e13c4b54799ec12bbeef63bfe1c0220c6fde5fdf73ca0224dc489fd7395a20` | 5662 | No — supplemental only |
| `scripts/staging-ops/staging-pair-fixture.mjs` | `02f3b2b3ae2e6cf85421b44b55f1663aa0a093df7e6abf676068f2b6e8f2109f` | 40206 | Yes |
| `scripts/debt-intake-migration-proof.mjs` | `d7c8c305fc51d1fff85b055096f2123cb11bf2efa79398356f12b1a3c57ae057` | 9152 | Yes |

## Appendix C. Frozen evidence identities and continuity

Input content was read and exact regular-file hash/size identities reverified. Identity verification does not convert historical limitations into execution or semantic coverage. Original private reports/values/streams and private stored Linear bytes are excluded. The full source identity closure remains bound by the frozen 678-file index; the separately corrected lexical closure remains 325.

| Evidence role | Safe reference | SHA-256 | Bytes |
|---|---|---|---:|
| repository instructions | `AGENTS.md` | `e4117721d454be48f881a878037a07353ea7b355741e366169746276466bdb72` | 13460 |
| canonical shared workflow skill | `canonical shared astra-spec-claude-build/SKILL.md` | `6a41d617810415980c209348d403e0dade7b52eae097b0105684b599c348284a` | 32572 |
| immutable accepted v9 including full Appendix | `docs/design/aio1217-server-action-auth-v9-f4-e4-round1.md` | `0a19ddf87f9247d960cd5ed0247e14962963df3f99ae3c4b1a1546cd4342985f` | 203946 |
| authoritative Astra HIGH material-revision adjudication | `resume-ci-astra-high-adjudication.final.md` | `0a89130cbaf05b57a4f2bca67abeecef0c26099aaa0f172050b232de01320b71` | 29357 |
| Astra HIGH lifecycle status | `resume-ci-astra-high-adjudication.status.json` | `628380afa2d69813557dd30026b16ca2dbdc3716106904c97db767c1f8934c95` | 903 |
| fresh sanitized Linear attachment proof | `resume-ci-linear-native-attachment-proof.sanitized.json` | `9e7fb2034a6b4f7c8233bbc61f398807f3c7c93f62ce89163ad511c667fe66ed` | 864 |
| Linear expectation correction | `resume-ci-linear-native-attachment-contract-correction.json` | `d143545472dcc49933f906e85de8df73d66aa611ca410de3df5ed5ca6f2a7113` | 2098 |
| completed author-evidence parent result | `resume-ci-v10-author-evidence-parent.result.json` | `fd46663f25e59f2b80f0eb0cc82dacd891d713f2f0d90b39a1813312662abd6a` | 1270 |
| author-evidence clean preflight | `resume-ci-author-evidence-preflight.json` | `48b796f53c1f8fc2fcc41be30ecb7b5b4dfcbf9ebefe124c7535ab1c3733ceab` | 393 |
| 325-file lexical candidate census and hash map | `resume-ci-v10-source-census.sanitized.json` | `71be3f16e72d6154843f30924c100dd4732b30100c171d65557ffbe38cc4f50a` | 116800 |
| 678-file complete app-lib-scripts identity index | `resume-ci-v10-all-source-files.sanitized.json` | `aea0ccfdc5c6cae0a410d6a4d69fd2c9720d9baf8bdafeeeca504d704a11ec2a` | 112306 |
| value-free gitleaks 8.18.4 schema capabilities | `resume-ci-v10-gitleaks-schema.sanitized.json` | `d1fb1cc1a11c5c11a83a2d2d7a8d21716f1eb9f9544fd5dc2da0aa4c5b7c0cda` | 5698 |
| safe scanner finding classification | `resume-gitleaks-safe-classification.json` | `309ed9a9002fe443d3c68bc900a53fb4ceac28cfe335194c14428db8e50bd6d6` | 600402 |
| historical Astra blocked disposition | `review-public-support/f4-e3-affected-review-frozen/packet/admission/05-astra-disposition.md` | `a91197e7ce7494a419e49de6351aeac55fc9c9e03aa90e04a96a2d7a29978f54` | 7654 |
| affected behavior Opus limitations | `resume-adm-affected-review.final.md` | `71bb8e1ff730515f499adfbf8ae3dccfba922f7c236d5aaf5f42dbc6c1b96a46` | 14034 |
| bounded current versus staging diagnostic result | `resume-ci-bounded-diagnostic.result.json` | `fd77e03620307ecf725a2ca1295d515fe7b9c3abe38b19d270038ffbf753245a` | 6111 |
| current versus staging selected source patch | `resume-ci-current-vs-staging-source.patch` | `8aa88e492e4b41137c5db693924bdbe2efd49e92ac983bae983589d88c8ec3bc` | 2222 |
| current versus staging document corpus delta | `resume-ci-current-vs-staging-corpus.json` | `b191253b41ab2e9641bda6dec991c4f5078bf2f1315b90b651c834a20d605d42` | 1958 |
| current CDC sweep | `resume-ci-cdc-sweep-current.json` | `a34f29a422f1b8fcfeb27d58a9f0897e348a5b53d0cf181c99b508657b4aa6b8` | 12842 |
| staging CDC sweep | `resume-ci-cdc-sweep-staging.json` | `19c32971d00e7b814675d32282acfdb6d04f45ae95ebf9ab07fc217c913af071` | 12210 |
| gitleaks configuration | `.gitleaks.toml` | `79a28348f99acf97a60274feaa31fa7fc72edd118f5d87623a697c4f17b7aec3` | 1660 |
| CI workflow | `.github/workflows/ci.yml` | `025fb1062d7b214bf3353c759fa395fae0585189ebf1a4b14ee8bcd3c8475be9` | 18783 |
| repository security policy | `SECURITY.md` | `e18a9efe11c4610c9369c6e4ab3f3df9f9b50942b4fae2d0e95dcc663419b358` | 2987 |
| archive contract README | `docs/archive/aio1217/README.md` | `76fba174231ad2ac9e429e154fc9d06c10b9c1e33481a06c5ed005beef2bf092` | 14429 |
| archive exact-byte artifact index | `docs/archive/aio1217/artifact-index.json` | `0d8885acc0599477b0b18cdf391def2c83aaf30589a24cc9a5b5f2974f75d0c3` | 74073 |
| archive publication manifest | `docs/archive/aio1217/publication-manifest.json` | `d26d63265ef10637a0ab48c820861bc4ebfccd58c9e272be03ec9e94e59241d5` | 31731 |
| current access single-writer guard | `test/guards/access-single-writer.test.ts` | `4eb66ef4ba7b2b9cebb859a5eb7113b62edcf2e738d578aa720beddf49bc8806` | 13210 |
| access enforcement source | `lib/access/enforce.ts` | `751eaa06bfb55a9991a7cd5004e588827a029e3631ae303fed844f2916dea27b` | 28846 |
| access oracle source | `lib/access/oracle.ts` | `edfd638f90f1aca39e0007859f52b71af951b6d75f1657198bc93348058e24c9` | 7170 |
| access group owner source | `lib/access/groups.ts` | `3d163347585ec62307a5fe45602754f325371a9853e70eb7733b8c5cbcf43d07` | 52775 |
| CDC unit and fixture contract | `test/graph-cdc.test.ts` | `4ae834ec40f229d6f1e2b329401871a31529820e880902f4fad33980a5de7fa9` | 62866 |
| production CDC source | `lib/graph/cdc.ts` | `0ad3b17c954bfbe0bbfadf7483dbe58c99fe596eac672111dd319bc79895f8b5` | 16668 |
| CDC graph consumer | `lib/graph/project.ts` | `06774065ffd60f1fdfa11eb9154102dc799e8ccab1bb6273d52cdb480362ec8c` | 101256 |
| CDC sweep source | `scripts/cdc-churn-sweep.mjs` | `8b89658c873da66224d18a5d033888fb906c49b05249321cb79664fc91176bbc` | 29074 |
| CDC append design contract | `docs/design/cdc-append-churn.md` | `30af0df4eef4181971d3e53b17f572b408ebf99a95eebbdebd4ace9586822358` | 30680 |
| content-defined chunking design | `docs/design/content-defined-chunking.md` | `11a5aa47f2a88f597d24e382a783575a44e45b67fd470d84d6cde59cfadcf0eb` | 25702 |
| CDC boundary design | `docs/design/cdc-boundary-overlap.md` | `14ef072440385cbca183f829d392a0dddae313205ff3494e39b45d37454ec094` | 17471 |
| CDC durable delta datamechanics contract | `test/datamechanics/graph-chunk-delta.datamechanics.test.ts` | `428af1b2838fab09deb577a16931079ed8d9fb296c203cfaef4245fc8ae31689` | 43128 |
| graph episode chunking contract | `test/graph-episode-chunking.test.ts` | `2effc856f06b141079aa24907d3954d7e793c779fe8d9a88c385700a4d12f809` | 3652 |
| chunk ledger schema | `postgres/migrations/20260803230000_graph_episodes_chunk_ledger.sql` | `059d242220888ff54ad7e0e15b39d6187269b2a6889c1a35f49bb614051ad874` | 1358 |
| fixture secret entropy guard | `test/guards/fixture-key-id-entropy.test.ts` | `94aa6faba09f85975cbd601b3159b375273fc09612d506120d73c589e39e92cc` | 9439 |
| dependency declarations | `package.json` | `a29bfa2129bbec35b0270be083a1bfe0e67a8457475f7db68d91c1270c8a32ef` | 5708 |
| dependency lock | `package-lock.json` | `5bc556334030556408a79f56164108fe43025d83c85139e253669afc0831e64a` | 520379 |
| unaccepted complete v10 proposal | `docs/design/aio1217-server-action-auth-v10-ci-contract.md` | `4570e5cbb3b1b008697d5e49c0787cf169aec695f3682c40431c91bdbff1133e` | 187114 |
| original unqualified Opus review with 2 HIGH 8 MEDIUM 6 LOW | `resume-ci-v10-opus-high-spec-review.final.md` | `9e6f61042eb35aab3097676366599a8f8c7f11b809e21ae57b1cc07b709931ee` | 26217 |
| original Opus review lifecycle and denial status | `resume-ci-v10-opus-high-spec-review.status.json` | `5150d58d692848b921bd37ff95d21efb9aaccfce9a25c6676d38894982ec863c` | 30148 |
| fresh Opus coverage repair | `resume-ci-v10-opus-coverage-followup.final.md` | `dc8f178811b5650e57a12f16aaff0413f60c8844a1e7faf9b4d56994b6e02d63` | 10413 |
| coverage repair lifecycle status | `resume-ci-v10-opus-coverage-followup.status.json` | `a0ad24d3ea465795a1f098038a8e42f392a155e3f50d1e893f9f1981e4f84ff4` | 13497 |
| fresh independent H1 skeptic finding stands | `resume-ci-v10-opus-skeptic-h1.final.md` | `3b00a1f6a8b554ec3363783668c923ddb9dd568961b8d8eaa1a6e779c9c0b0cd` | 7996 |
| H1 skeptic lifecycle status | `resume-ci-v10-opus-skeptic-h1.status.json` | `0ab4a906979bf156dd8890b50c6a6c71910aa0750a6f904dedb0a03391964446` | 11048 |
| fresh independent H2 skeptic finding stands | `resume-ci-v10-opus-skeptic-h2.final.md` | `9ea5017cdad5940003c6344f89efd8d44bdad829c1f70c030c71e1f0f4d6590c` | 8188 |
| H2 skeptic lifecycle status | `resume-ci-v10-opus-skeptic-h2.status.json` | `88c440160d50eb1a71785d5436b15d9fdcf503978bc0100f84cb5a0c53f94e39` | 11256 |
| three-stage review repair batch result | `resume-ci-v10-review-repair-batch.result.json` | `e353b583e244f1e44ef7ed4b8859fe5e23f614a59e1ff0c8fad1f461f1090a3d` | 1319 |
| original review all-input postflight | `resume-ci-v10-opus-review-postflight.json` | `252813c37e9cbe3cdc23b79e0984c12dcf143fc435c1441bb126d4c4c3d1ce8f` | 666 |
| normative Astra HIGH narrow Contract-A decision and exact section 6 amendments | `resume-ci-v10-contract-scope-astra-high.final.md` | `2532206d3173b4a4600913ccd63febdc18d71710244a2737659c0b7a94b79fe5` | 29053 |
| Astra HIGH decision lifecycle status | `resume-ci-v10-contract-scope-astra-high.status.json` | `0a7dcad93597161ab530779947f3b315824a80fdc58389f3a9a91f213e145cbc` | 719 |
| pinned gitleaks 8.18.4 detect help and supported flags | `resume-ci-gitleaks-8.18.4-help.txt` | `c1efa81b32c2ed2c14eb6cdcd3a9cefc255c213a449060ce7938e6817c0ec7ef` | 3765 |
| official gitleaks release and selected-rule proof | `resume-ci-gitleaks-primary-release-proof.json` | `6cb4363aebfa6deac741d0f7a9de0a593fb04d38b5d913bf494ea1c06aafa0f3` | 827 |
| official gitleaks 8.18.4 release checksums | `resume-ci-gitleaks-release-source/gitleaks_8.18.4_checksums.txt` | `6f2a2620b5a3e8595a5480d25504040299eaf2189ad30cc1adcbd0ff5dcc4aa0` | 1099 |
| official tagged gitleaks default configuration | `resume-ci-gitleaks-release-source/gitleaks-default.toml` | `b94aad1d0f105e4d7cb230872461705a4b04a7743c656836144ae6853cb33e1b` | 79554 |
| exact two selected official gitleaks rules | `resume-ci-gitleaks-selected-rules.toml` | `9e9e9cbc6c73086ff3b1f01981bb76ee2daff3a66deaf33decb84433e4d3c487` | 20802 |
| rejected first occurrence projection result | `resume-ci-v11-gitleaks-occurrence-projection.result.json` | `f3dec2618439b95608e44213329fcc43a101aa59a9df266d69d3128454ccac9c` | 347 |
| value-free first-projection alignment diagnosis | `resume-ci-v11-projection-alignment-diagnostic.json` | `2b980057e223a763c5d7f6aeaa85b5e3882b0243010db30ba2400e5d110993b5` | 191 |
| successful v2 projection parent result | `resume-ci-v11-gitleaks-occurrence-projection-v2.result.json` | `e9ff3362195ad4cfcdafcdd2608e24230b68d350b9b727e493db50725c112b53` | 873 |
| complete value-free v2 occurrence projection | `resume-ci-v11-gitleaks-occurrence-projection-v2.sanitized.json` | `8546ecafb5155a8600e26928f542f4d35ea4151243aa2ee87cc26b919fc3833a` | 971860 |
| verified residual routing before creation | `resume-ci-guard-residual-linear-routing.json` | `50d0ecb136bcc66eb3c682bd44eb4a5bb432ffe80646340fe7fd720181cf7165` | 650 |
| exact requested AIO-1230 description | `review-public-support/resume-ci-v11-residual-linear/packet/residual-description.md` | `0d1cb92ba8c1947d301d4c0f95adbd2ab20ab3d1ce5050531e7749b006c99c30` | 4060 |
| single-created AIO-1230 result and exact routing/readback | `resume-ci-v11-residual-linear.result.json` | `30343d1d5f50143d2b54b43d9728d46bde0f0779f3e8b7154207da41028837c2` | 1599 |
| value-free AIO-1230 serialization normalization proof | `resume-ci-v11-residual-description-normalization.json` | `d5148da025b1d6a2e009648a6e4e7a304e7e2f96115a5c64f1b7618ece5d2a7a` | 5372 |
| last qualifying clean remote proof before v10 author | `resume-ci-v10-author-preflight.json` | `014cd989ee98080f066871b232aecee8ed5650c6c27973ddcfbde0aba822ebba` | 435 |
| first preserved overdue checkpoint record | `resume-ci-v10-overdue-checkpoint.json` | `2381349f8434b50dcad4eb5a3fd1da397e25323efac09260211495ffac77d788` | 419 |

Recovery continuity identities supplement the frozen evidence above; they do not supply application/scanner/CDC measurements.

| Role | Safe reference | SHA-256 | Bytes |
|---|---|---|---:|
| Original v11 author manifest | `review-public-support/resume-ci-v11-astra-medium-author/packet/input-manifest.json` | `1f9ba6e8590a2034c80904e58b88f51bcc5fc28ec06446726e3ae9e6c49c2adb` | 11176 |
| Inherited complete v10 author manifest | `review-public-support/resume-ci-v10-astra-medium-author/packet/input-manifest.json` | `98f8ff4dd7d9ae039a4e0082df4d8b065302589f0a1a23bfcfddf16e7435ab72` | 13443 |
| Sanitized prior-author interruption; lifecycle/scope only | `resume-ci-v11-astra-medium-author.interruption.json` | `97db56d9962c6af830aa7fb753890c039a7b1e9876e61f1c9bc1a1c7a8d9d1e3` | 1864 |
| Preserved local-checkpoint result; lifecycle/scope only | `resume-ci-v11-interrupted-local-checkpoint.result.json` | `266d8b71ea92b08a9195540a8c4e82f1df1916ce2ecb9d5c042c4df3c593a0ab` | 1134 |

The v6/v7 original Linear description continuity remains historical (185181 bytes, SHA-256 `fa17678bd795a64c207e42443c52f2b9a9c66e6bc7144cb046eb60e08020c9ac`). Native v9 attachment identity is separate from that description; equality between the description and later attachment is not required. V11 is not uploaded, attached or accepted. Native v11 attachment verification will require exact bytes, with no Markdown serialization-normalization tolerance. AIO-1230's routine description normalization does not relax this requirement.

## Appendix D. Every normative Astra HIGH §6 amendment

The following exact table and AC effects are incorporated requirements. Each maps to the corresponding v11 core/appendix/closing table above or below. References to v10 locations name superseded proposal text, not edits to the preserved v10 file.

**6. Exact successor-spec amendments**

Create one complete successor; preserve accepted v9 and proposed v10 unchanged.

| V10 location | Required successor amendment |
|---|---|
| §1 and §1.1 | Record this explicit material supersession of prior Astra Contract A; identify retained v9 invariants and withdrawn expansion separately. Preserve proposal/review history. |
| §2 | Replace claims of general structural write discrimination with the finite contract above. Correct the claim that this section restates the complete F4 operational contract; retain the actual v9 F4 contract by exact incorporation. |
| §3 | Separate source/check evidence at `813f61…` from the document-only checkpoint `9753e…`. Preserve overdue/unreset backup state and all execution limitations. |
| §§4.1–4.5 | Replace structural/SQL abstract interpretation with the specified parser-comment mask, original evidence channels, exact owner map, frozen exceptions and production-entry controls. Remove requirements for generic SQL summaries and eight-extension coverage. |
| §8 B-A1 | Record five actual uncovered writes, their target contexts and required separate routing. Remove the assertion that today’s guard already detects them. No test-authority waiver. |
| §8 B-A2/B-A4 | Reclassify unimplemented generic semantic closure as deferred coverage. It is not a narrow-parser implementation obligation or a safety certificate. Retain provenance of the original blockers against v10. |
| §8 B-A3 | Separate retained frozen materializer controls from deferred loader/function-call closure. The latter is not required to claim the former. |
| §9.1 | Preserve stable AC text and IDs. State amendments separately rather than silently rewriting accepted meanings. |
| §9.2 | Replace “complete semantic census” credit with exact finite detector/control evidence. Keep all current acceptance cells unearned. |
| Appendix A | Add this packet, adjudication, exact inspected-source identities and inspection limitations. Preserve historical identities and dates. |
| Appendix B title/preamble/B.1 | Describe a frozen lexical census with proposal-era dispositions, not a completed semantic census. Remove whole-repository completeness implications. |
| Appendix B row 74 | Correct the treatment of the table-dependent helper at line 376; document the six `runSql` sites and missing parameter/fragment abstraction under v10. |
| Appendix B supplemental closure | Add `provenance-sql.ts` and relevant inspected dependencies as separately identified supplemental evidence. Do not pretend they belonged to the original 325 candidates. |
| Appendix B rows 122–124 and B.3 | Preserve actual generic infrastructure and unresolved flows; distinguish deferred semantic resolution from narrow guard pass/fail. |
| Appendix B row 230 | Record the raw unit-owner SQL omitted by the lexical matcher’s limitation. |
| Appendix B rows 265/323 | Identify all five actual writes and target contexts. Neither “W” nor fixture status grants authority. |
| Appendix B aggregates | Keep original counts as frozen matcher counts; label corrections/new observations separately. The 311/14 split is not safety coverage. |
| Appendix C | Add this scope decision and continuity limits without changing historical BLOCKED, archive or attachment semantics. |
| §10.1 | Implement the revised finite contract only after renewed gates. Gate 2 verifies the already specified policy; it does not invent seed authority or SQL abstractions. |
| §10.2 | Narrow the guard allowlist to the parser/mask, retained scan implementation, controls and necessary wiring/reference artifacts. Remove mandatory generic SQL analyzer work. Retain runtime/source prohibitions. |
| §§10.3–10.4 | Preserve holds, exact-snapshot validation and failure/recovery rules. Do not reinterpret an overdue checkpoint as reset or a publication authorization. |
| §11.1 | Replace the AST/SQL replacement row with the explicit coarse-comment-input amendment and finite ownership/identity controls. |
| §11.2 | Keep deferred coverage visible without representing it as implemented protection. Preserve all unrelated uncredited evidence. |
| §§12.1–12.2 | Require full-entry discriminating controls and the exact renewed role/attachment sequence. No helper-only or index-only admission. |

The AC effects are:

- **AC-11 retained:** no unauthorized production owner/schema/membership changes, no fixture-created authority, no access-policy redesign. Separate verified routing is required for newly identified residuals.
- **AC-12 amended only in additional Contract-A evidence:** record parser-mask fidelity, retained detector behavior, exception identities, production-entry mutations and candid coverage limits. Withdraw v10’s promised complete semantic census. Historical evidence remains tied to its original snapshot.
- **AC-13 expressly amended for this detector:** syntactic comments cease contributing to the coarse fallback; existing direct/raw protections, ownership, oracle/wiring and non-vacuity obligations remain. General alias/SQL resolution is deferred. All other required validations remain.
- **AC-14 gates remain:** this adjudication neither accepts a successor nor establishes readiness.

Contracts B and C, including standing scanner/CDC review concerns, remain pending material contracts. This decision supplies no new evidence to resolve or weaken them.


## Appendix E. Exhaustive nineteen-criterion old-text replacement table

Each old text below is the exact complete frozen §3 bullet, identified by its stable position solely for documentation editing (these positions are not scanner occurrence ordinals). Replace it with the complete corresponding new bullet.

### Criterion 1

Exact old text:

> `test/graph-cdc.test.ts` — for every live corpus document at every swept append length and append content, set churn is asserted `<= |C1| - L` where L is the common prefix of the two ADMITTED CHUNK arrays, per document rather than as a corpus maximum one outlier can dominate.

Replacement:

- For every eligible live document and listed append recipe, assert admitted set-membership churn <= max(0, |C1|-L), with L the common equal-content prefix of admitted arrays; keep positional counts separate.

### Criterion 2

Exact old text:

> `test/graph-cdc.test.ts` — an ABSOLUTE ceiling `churn <= (1 + floor((max-1)/min)) + ceil(A/min)` is asserted per document, derived from the size envelope rather than from the chunker's output, so a chunker that re-cuts deeply reddens it.

Replacement:

- For nonblank bases assert churn <= (1 + floor((max-1)/min)) + ceil(A/min), equal to 4 + ceil(A/1250) at defaults. Whitespace-to-nonblank activation instead uses the admitted-array bound and explicitly qualified structural checks.

### Criterion 3

Exact old text:

> `test/graph-cdc.test.ts` — the divergence depth is asserted per document against the DERIVED ceiling of 4, never the observed 2, and the observed maximum is recorded as an observation.

Replacement:

- Assert tail locality, size envelope and divergence depth against the derived ceiling 4, never observed 2; record observed maxima only as observations.

### Criterion 4

Exact old text:

> `test/graph-cdc.test.ts` — a CAPPED fixture asserts churn 0 AND that the shared chunk prefix reaches the cap; a fixture asserting only "the document exceeds the cap" must fail, since a document at exactly 80 boundaries churns 1.

Replacement:

- Retain CAPPED: churn zero AND shared admitted chunk prefix reaches cap; retain exactly-at-cap contrast so total document size cannot substitute for the shared-prefix condition.

### Criterion 5

Exact old text:

> `test/graph-cdc.test.ts` — a MERGE fixture, checked in rather than read from the live corpus, asserts the boundary count FALLS on a one-character append, the vanishing boundary is present before and absent after, and the bound still holds.

Replacement:

- Retain MERGE with a checked-in actual disappearing boundary, boundary count falling on one-character append and both applicable structural bounds passing.

### Criterion 6

Exact old text:

> `test/graph-cdc.test.ts` — a DUPLICATE fixture asserts set churn is strictly below the bound while the positional count equals it, pinning the rule as an inequality rather than an equality that happens to hold.

Replacement:

- Retain DUPLICATE: set churn strictly below the admitted-array bound while positional equals it; preserve the inequality and separate metrics.

### Criterion 7

Exact old text:

> `test/graph-cdc.test.ts` — a GROWTH fixture asserts churn is non-decreasing in append length, reaches at least 4 by a 9,000-character prose append, and DIFFERS between two append contents of the same length; no constant ceiling is asserted for any length.

Replacement:

- Retain GROWTH: nondecreasing churn over the specified fixture lengths, at least four by prose-9000, differing contents at equal length; no universal constant ceiling.

### Criterion 8

Exact old text:

> `test/graph-cdc.test.ts` — a WHITESPACE fixture asserts the bound holds for a whitespace-only base, the case that falsified the boundary-coordinate form of the rule.

Replacement:

- Retain WHITESPACE and the 20000-space plus x six-chunk witness: admitted-array bound remains valid; nonblank absolute ceiling must not be applied to activation of an initially blank base.

### Criterion 9

Exact old text:

> `test/graph-cdc.test.ts` — the `max(cdc) <= max(legacy)` comparison for append is replaced by a PER-DOCUMENT `cdcChurn <= legacyChurn + 1` gated to appends shorter than `min`, with the longer-append gap reported and the measured reason recorded at the site; the comparison is untouched for the insertion and deletion scenarios.

Replacement:

- Replace the falsified universal short-append legacy +1 comparison with BOTH structural checks and independently admitted exact-byte per-specimen maximum CDC churn and maximum CDC-minus-legacy gap across all listed short and long recipes. Never universal +2. Keep insertion/deletion comparisons unchanged.

### Criterion 10

Exact old text:

> `test/graph-cdc.test.ts` — the `append at end — CDC re-extracts <= 1 chunk(s)` assertion is GONE, with the measurement that refutes it recorded at the site.

Replacement:

- Retain removal of the unconditional append <=1 assertion and record the exact refuting witness without modifying its document bytes.

### Criterion 11

Exact old text:

> `test/graph-cdc.test.ts` — the live-corpus equality census is reported rather than gated, and a `documents > 5` floor is asserted, because a bound assertion over an empty or single-document corpus is green by construction.

Replacement:

- Report equality census, assert eligible documents >5 and nonzero samples, inventory every direct candidate and include all intended design/specification documents.

### Criterion 12

Exact old text:

> `scripts/cdc-churn-sweep.mjs` — `--op append` reports the bound, the absolute guard, the divergence depth against its derived ceiling, the falsified candidate, the falsified boundary-coordinate form, and the merge, cap-parity, verbatim-duplicate and legacy-envelope probes.

Replacement:

- Append sweep reports admitted-array bound, qualified absolute guard, tail locality, derived depth, falsified candidates, merge/cap-parity/verbatim-duplicate/legacy probes AND exact specimen IDs, both-legacy cross-check and frozen-budget status.

### Criterion 13

Exact old text:

> `scripts/cdc-churn-sweep.mjs` — the append mode exits non-zero on a refuted invariant OR a vacuous run (empty corpus, zero samples, no synthetic leg, synthetic depth past the derived ceiling, `duplicateProbe` going tight, `verbatimChunkProbe` going slack, a shared prefix at the cap costing anything); probe ROT is a reported warning and not a failure, and running it from a directory with no `docs/` must exit 1 rather than 0.

Replacement:

- Append mode exits nonzero on any invariant, tail-locality, identity, cross-check, schema, missing/extra/stale/duplicate specimen, budget or non-vacuity failure. Preserve all existing synthetic, duplicate, verbatim and shared-prefix controls. A probe-ROT observation may remain a labelled diagnostic only when it does not waive a required frozen specimen/control; no-docs root fails.

### Criterion 14

Exact old text:

> `scripts/cdc-churn-sweep.mjs` — `--exclude <paths>` is comma-separated, omits documents in BOTH modes, and REFUSES when a named path is not in the corpus; both design documents this ticket edits are excluded from every published figure.

Replacement:

- Exploratory --exclude retains exact comma-separated validation and rejects nonmembers, but such runs are labelled NON_ACCEPTANCE. Acceptance CI forbids exclusions and includes both design documents and all accepted/proposed specifications. Earlier published excluded-corpus figures retain their historical scope.

### Criterion 15

Exact old text:

> `scripts/cdc-churn-sweep.mjs` — every degraded input refuses with a reason and a non-zero exit: an unknown `--op`, a flag-shaped value for any flag, and a non-integer or zero `--step`.

Replacement:

- Refuse unknown op, flag-shaped values, noninteger/zero step, unknown flags and any acceptance-mode corpus-filter/baseline-update request with a categorized nonzero exit.

### Criterion 16

Exact old text:

> `scripts/cdc-churn-sweep.mjs` — the `prose-b` filler replaces before slicing, so the "same length, different content" comparison is not length-confounded; the false "the same corpus the test reads" comment is corrected; the in-place mode's INVARIANT reproduces unchanged (rule agreement equal to samples, zero mismatches) — its sample count is corpus-dependent and is deliberately not pinned.

Replacement:

- Retain prose-b replacement-before-slicing; correct the inaccurate corpus comment. In-place invariant remains unchanged with agreement equal to samples, zero mismatches and corpus-dependent sample counts.

### Criterion 17

Exact old text:

> `docs/design/content-defined-chunking.md` — the acceptance table's `append at end` row states the bound, the shared-prefix cap condition, and that growth depends on the appended content as well as its length; the prose carries the measured CDC-vs-legacy envelope.

Replacement:

- The append acceptance row states admitted-array bound, shared-prefix cap condition, tail/depth/size constraints, nonblank absolute bound and whitespace qualification, content/length dependence and independently reviewed CDC/gap specimen budgets; historical envelopes are labelled finite observations.

### Criterion 18

Exact old text:

> `docs/design/content-defined-chunking.md` — the summary table's legacy `| append at the end | 1 |` is SCOPED to the 66-character append it measures rather than left unqualified, since a 2,501-character append churns 2 under byte offsets too.

Replacement:

- Keep the legacy summary one-chunk result scoped to its actual 66-character append and retain the 2501-character two-chunk counterexample; do not relabel that historical table as current CDC evidence.

### Criterion 19

Exact old text:

> `docs/design/content-defined-chunking.md` — the corrected `append at end` row states NO unconditional number, and a test pins the row's own claim against `fixtureAppend.churnDistribution`, so a gloss like "1 for a short append" cannot pass the other sixteen criteria while contradicting the measurement.

Replacement:

- Keep the corrected append row free of an unconditional churn number. Test its stated structural and frozen-budget claims against fixtureAppend.churnDistribution and the admitted fixture, including the v9 2/0/2 witness; all nineteen criteria remain required.


## 8. Clause-by-clause supersession and finding dispositions

### 8.1 V9 / v10 / v11 clause mapping

| Stable predecessor requirement | V10 proposal | V11 controlling disposition |
|---|---|---|
| V9 authority, user outcomes, full original Appendix, F4/F4-E4 operational contract | §2 abbreviated orientation incorrectly implied full restatement | Complete exact v9 incorporated in Appendix A; unchanged application obligations retained, no summary substitution. |
| V9 identity-derived guards, action registration, ID binding, state/effect boundaries, denial conventions | §§1–2 retained | Retain without change; CI slice does not admit runtime edits. |
| V9 ownership and no authority by fixture; AC-11 | Expanded detector exposed five writes but supplied no reachable pass state | Keep six table owners; withdraw expansion; preserve five uncovered residuals and verified AIO-1230 routing without waiver/agreement/accepted deferral. |
| V9 discovery/census and runtime evidence | V10 semantic-census implication | Retain discovery obligations; Appendix B is historical lexical evidence only, supplements separate. No whole-action or SQL safety coverage credit. |
| Existing static/coarse/raw/SQL/oracle/materializer/wiring guard contract | V10 §§4.1–4.5 general AST/SQL abstract interpretation/eight extensions | Replace entire expanded contract with §4's exact narrow detector and production-entry controls, comment mask only on coarse input, per-table owners and frozen identities. |
| V10 B-A1 | Mandatory newly detected edge-write refusal with forbidden source fixes | Withdraw new detection premise; uncovered residuals remain separately routed and uncredited. |
| V10 B-A2/B-A4 | Generic flow resolution prerequisite | Deferred coverage; not a narrow-parser prerequisite and not certified safe. |
| V10 B-A3 | Whole SQL loader/function closure combined with materializer | Preserve exact frozen definition/required-call controls; defer generalized loader/function closure. |
| Archive immutable evidence and active scanner | V10 Contract B lacked proven occurrence mapping/platform/control split | §5 exact pinned Linux job, safe descriptor bijection, group ambiguity, metadata integrity and separate actual controls; original bytes/scanner rules retained. |
| CDC production cdc1, corpus and independent controls | V10 Contract C incompletely specified recipe/baseline/docs | §6 structural plus exact specimen budget contract; §7/Appendix E exhaustive replacements; parent final-byte baseline explicitly outstanding. |
| False universal short-append <= legacy+1 | V10 withdrew it but lacked full executable admission detail | Withdraw only universal claim; no universal+2. Preserve witness and all unrelated CDC requirements. |
| V9 AC-01–AC-10 | Stable IDs and meanings | Exact text in Appendix A, unchanged; no whole-acceptance credit. |
| V9 AC-11 | Scope/compatibility | No owner/schema/membership change; separate verified routing as above, no authority waiver. |
| V9 AC-12 | Evidence/RED requirements | Add exact finite A controls, B bijection/ambiguity and C exact budgets; withdraw promised semantic census. Existing runtime/RED gaps remain. |
| V9 AC-13 | Required checks, CI and quality | Explicitly amend coarse comment input; replace false CDC universal only; add actively scanning reviewed reconciliation, preserve all other checks. |
| V9 AC-14 and version-specific future gate wording | V10 pending future order | Renew full §10 sequence for complete v11; old reviews/attachment never attest it. |
| V10 Appendices A/B/C | Input identities, mislabeled semantic evidence, continuity | Appendices B–D correct labels and observations, retain counts/historical limits and all §6 rows; no retroactive semantic membership. |
| V10 §§7/10–12 | Incomplete replacements, expanded implementation allowance | Exact replacements/allowlist/sequence below; generic SQL analyzer path removed, actual scanner controls separated from unit discovery. |
| Historical pre-edit admission and evidence | Already BLOCKED | Remain BLOCKED; later current checks cannot repair historical timing. |

### 8.2 All sixteen original review findings, individually dispositioned

The source for each finding is `resume-ci-v10-opus-high-spec-review.final.md`; every row also identifies supporting/corrective evidence. “Corrected in proposal” does not mean independently resolved or reviewed.

| Finding | Correction in v11 | Retained limitation / pre-builder fact still outstanding | Clause / AC and evidence |
|---|---|---|---|
| HIGH-1 | Withdraw expanded detector's unreachable pass requirement; adopt exact narrow policy and route five actual raw edge writes. | Valid against v10. Writes remain uncovered; AIO-1230 owner agreement and accepted deferral absent. Reviewer must confirm no implied waiver. | §4.1, AC-11/12/13/14; H1 skeptic, Astra HIGH §§4–8, routed child/readback. |
| HIGH-2 | Withdraw finite SQL-fragment/placeholder abstract interpretation and require unmodified enforce to pass through comment-only coarse correction. | Valid against v10. General fragment/receiver/function safety is deferred, NOT VERIFIED. Production-entry pass/control evidence outstanding. | §4, AC-12/13; H2 skeptic, enforce/provenance-sql identities, scope decision. |
| MEDIUM-1 | Correct semantic-census label, preserve matcher definitions/counts, document omitted helpers/UPDATE limitation and separate supplements. | No exhaustive semantic census claimed. Exact controls remain to be built/reviewed; deferred generic closure supplies no credit. | Appendix B, AC-01/12; census/index, review and scope §6. |
| MEDIUM-2 | Separate retained finite channels from unimplemented statement-kind/function invocation analysis. No SELECT/function blanket-safe assertion. | General SQL/function/RPC closure deferred; frozen materializer and executable required-call controls remain mandatory. | §4, AC-11/12/13; actual SQL controls and scope decision. |
| MEDIUM-3 | Remove v10's unimplementable general untyped-receiver proof obligation; preserve existing evidence channels honestly. | Generic client/receiver and raw edge flows NOT VERIFIED; no new safety classification. | §4/Appendix B, AC-12/13; pg infrastructure and scope decision. |
| MEDIUM-4 | Pure tests require no scanner; exact provisioned Linux actual-control job and script are separate from npm test. | Extracted binary identity, provisioning/control completion and safe error receipts need parent verification before readiness. | §5.1/5.4/§9, AC-13; package/CI, official checksums/help. |
| MEDIUM-5 | Verified supported suppression-neutralizing flags; exact-root absolute normalization; no baseline/ignore/inline bypass; metadata zero findings. | Actual pinned flag/error/path/coordinate controls and reviewed ledger still outstanding. Never infer privacy from redaction alone. | §5.1–5.4, AC-12/13; primary help, schema, v2 projection. |
| MEDIUM-6 | Exact versioned fixture, 43 recipe IDs/definitions, function-level CDC and both legacy identities/cross-check, deterministic candidate admission workflow. | Exact final-v11 measured artifact, generator/function digests, independent reproduction and reviewed budgets still missing. Builder cannot supply its own approval. | §6, AC-12/13/14; actual CDC/unit/sweep/project sources and historical sweeps. |
| MEDIUM-7 | Exact anchored replacement spans and every one of nineteen old bullets/new bullets; fix related long-append and whitespace claims. | Future one-to-one documentation diff and resulting document baseline admission need independent review. | §7/Appendix E, AC-12/13; frozen two CDC designs and original criteria. |
| MEDIUM-8 | Distinguish executed 813f61c evidence from untested 9753e94 and future v11. | No new check/baseline results exist; final exact snapshot checks pending. | §§1/3/6, AC-12/13/14; diagnostic/preflight/source/corpus receipts. |
| LOW-1 | Reproduce full accepted v9 including complete F4 and Appendix; orientation no longer falsely claims full restatement. | Original application/runtime gaps remain; incorporation does not rerun tests. | §2/Appendix A, AC-01–14; immutable v9 hash. |
| LOW-2 | Explicit finite roots/extensions/SQL detector, coarse exemptions/fake identity and per-table authority; withdraw broad expansion. | Bounded detector is not semantic closure; frozen identities/controls need verification. | §4/§9, AC-11/12/13; guard/source/scope decision. |
| LOW-3 | Explicit brain-tests Node20 guard/sweep entry commands and separate provisioned secret-scan job. | Actual CI required-job results outstanding, no Codacy pass claim. | §9.2/10, AC-13; CI/package evidence. |
| LOW-4 | Explicitly exclude extra roots/extensions from coverage claims, without an absence-of-DB claim. | Components/instrumentation and other out-of-contract execution coverage deferred/uncredited; routing alone is not safety. | §4.1, AC-01/12; 678 identity scope and scope decision. |
| LOW-5 | Correct constant SELECT/transaction-control observations and table-dependent helper/owner SQL; preserve U history separately. | No general statement-kind or whole-caller theorem; exact supplemental observations only. | Appendix B, AC-12; actual source and scope §6. |
| LOW-6 | Put complete inherited material and evidence in named appendices, then contiguous closing disposition/allowlist/gate sections. | Cosmetic organization earns no acceptance. Full-byte review still required. | Document structure, AC-14; original review. |

### 8.3 Complete AC-01–AC-14 acceptance matrix and exact deltas

The full immutable wording of all fourteen criteria is reproduced in Appendix A. This matrix gives each stable identity its current evidence obligation and unearned state; no cell claims complete acceptance.

Exact predecessor AC text, retained with the separately enumerated AC-11/12/13/14 deltas below:

- **AC-01 — Complete discovery.** Executed inventory reconciles current 20/96/13/0 census; filesystem mutations discover alternate-root/extension/nested module actions and inline directive forms; every unsupported action shape fails closed. Comments/non-prologue strings/types do not fabricate actions.
- **AC-02 — Complete policy rows.** Every runtime export has exactly one protected/protocol registration with guard owner, refusal, protected effects, stated client-ID binding classification/limits and actual executing evidence; stale, duplicate or missing entries/reasons/evidence paths fail. All 96 rows below must be reconciled before acceptance; counts are not a bypass allowlist.
- **AC-03 — Genuine invocation.** Full-policy mutants for removed/downgraded guard, comments/import/unused helper, spare guarded export, lexical shadow, wrong owner/export, unawaited async invocation, generator and stale exception fail; ordinary awaited local/delegated helper, sync predicate and renamed dynamic-import/directly awaited literal Promise.all controls pass; stale owner completion mode fails; unawaited/shadowed combinator controls fail. Exact guard sets preserve co-guard requirements. Run existing AIO-1208 regressions if its helper changes. Browser action arguments cannot select trusted system_import or omit/override server-created browser_member/mandatory member target. Executing omission/trusted-arm-substitution mutants must fail.
- **AC-04 — Actual boundary denial.** Valid-input direct execution of each 95 protected exports refuses missing identity/admin/member authority before that row’s protected effect, including secret/provider/model calls, writes/audit-success/revalidation/after callbacks. For later conjunctions use the case-specific permitted prerequisite versus forbidden subsequent-effect contract above; guard-owner reads and authorized scope arming are not blanket forbidden effects. Existing tests count only when they execute the action and assert the relevant refusal/effect; a helper-only or source-read test is insufficient. For each action’s applicable documented conjunction, earlier checks admit and valid feature-enabled input reaches its refusal arm: role, posture, content, target and selected scope plus lookup error. Registered call retained but denied verdict ignored, and removed inline role/posture mutants must fail executing tests. Shared-owner cases may establish primitive semantics; the action must separately honor the verdict. Representative admitted controls for each distinct guard family prevent vacuity. For both actual `scanMeetingTodosAction` and `discoverNow`, execute all four resolver faults (`members`, `group_members`, `project_groups`, `project_context_memberships`) after identity/posture admission: exact `{ok:false,error:"visibility resolution failed"}`, zero scanner/discovery/private source load/opportunity write/cache revalidation and unchanged durable rows. Fault-free nonempty/partial controls, item-membership-empty controls and distinct genuine oracle-zero-project/no-error controls for each export must pass with successful consumer execution (including discovery revalidation); discarded-error/consumer-continuation and empty-projects-as-error executable substitution mutants must fail. Execute all 15 scope connections above across 14 exports: successful empty/partial/exact actor scopes must constrain consumers and outputs, with nonempty controls and applicable omitted/widened/wrong-principal mutants; real-PG action-to-scanner proof and recording graph/model/provider consumer evidence are required. createMeetingTodosAction proves its current membership/posture refusal only; the absent desired content gate is explicitly DEFERRED AIO-1225, not PASS. Administrator issueApiKey proves its existing admin conjunction only; its missing desired same-team member-target denial is DEFERRED AIO-1226, not PASS. Identity/alias target denials and attribution drill-down viewer-scope policy are likewise DEFERRED AIO-1227/1228; prove only their recorded existing admin conjunctions.
- **AC-05 — Guard owners and policy compatibility.** Real session/active-same-team/member/posture owner tests discriminate absent/foreign/disabled member, role, and current membership-derived admin posture in both stale legacy-tier directions; permitted members/admins pass. Preserve People self/admin-other rules, project-member creation, task/decision content writer/project checks, existing meeting/social content gates, selected-project mint admin AND launcher visibility and existing `VisibleProjectRows.error` arms only (oracle-leg narrowing through the legacy wrapper remains fail-closed, not v6-certified refusal; explicit all-reachable mode remains non-enumerating), and owned-path hold subject only to the verified v6 ownership decision. Preserve the legacy `visibleProjects` API and genuine-empty admission; propagate existing oracle failures at the shared materializer, with the ten-call-site compatibility decision and evidence in Production caller census and compatibility decision. Pin the chain gate's changed `visibility resolution failed` text with zero effects, second-draft refusal before consumer on an invocation-two fault after real chain admission, member-key evidence search 500 `enforcement check failed`, and meetings-list/Social-page error-boundary outcomes instead of successful empty. Pin unchanged dashboard-media 404, People explicit empty and inspect ignored-flag behavior. Disclose/pin delegated agent-token 200-empty as a legacy-wrapper residual, not a correction or uniform API guarantee. Preserve the existing per-refusal ordering/prerequisite boundaries, including authorized internal keys and bounded read-side graph arming before late scope faults. No complete content-protection claim for the deferred meeting-todo create/export path or complete key-target binding claim for the deferred administrator-issued credential path.
- **AC-06 — Account protocol.** Sign-out clears only current browser auth and redirects without needing identity; stale/missing cookie is harmless. Welcome uses own identity and only-if-unset password writer; change password uses own identity plus current-password verification. Missing identity/invalid old password/already-set account refuse with zero credential change; admitted credential controls work. No active tenant membership requirement is added.
- **AC-07 — Approval team binding RED→GREEN.** Two real teams, authenticated administrator A, B legacy approval/action: approved and denied requests refuse indistinguishably from absent, all B rows/audit unchanged, no handler/sandbox/revalidation. The regression fails on unchanged base for the intended durable-state/dispatch observation; same-team approve/deny pass after correction. Foreign governed identity links return the identical absent shape before routing, zero governed/legacy/sandbox/audit/revalidation; same-team governed compatibility remains.
- **AC-08 — Approval state/fault boundary.** Every resolver/shared runAction transition/completion is team/id/expected-state bound with checked returned errors and affected rows; governed tenant is identity-derived and never dispatches legacy. Explicit cardinality, context.action_id producer readiness, genuine standalone and inconsistent foreign/forward/reverse/running/terminal cases refuse correctly. Atomic pending claim permits one decision; post-claim prepare/deny failure retains claim with zero dispatch. Real-PG faults/zero rows pin prepare/deny/finish and shared runAction, with success/returned-failure/throw/missing-handler controls. Completion persistence failure is separate from handler failure: no false terminal response/audit, failed rewrite or replay. Producer barrier/resumption and two competing requests keep deliberate outcomes consistent. Governed-intent/terminal-link precedence is pinned; zero sandbox means run/allocation, not pure factory. New faults use fixed sanitized message plus allowlisted phase/actionId/actual dispatch log, with unchanged route500 tests and no client retry/idempotency guarantee.
- **AC-09 — People tenant target RED→GREEN.** Admin A cannot profile/avatar-upsert, add time-off or new goal for member B in another team; absent/foreign uses not-allowed, no row/audit/revalidation. B profile row team_id and content remain unchanged (base upsert can re-home it). Same-team self and admin-other—including retained target status/kind and actor editor posture—controls, partial profile update and avatar validation remain compatible. Reproduce actual base acceptance/mutation before fix.
- **AC-10 — People child owner RED→GREEN.** Supplying self target with peer time-off/goal ID, explicit peer goal update, or peer imported dedup key cannot remove, alter or reassign peer content. Atomic team/member/resource filters, zero-row and owner-change races refuse without success audit. Admitted own rows, admin legitimate peer target, same-member imports and trusted system_import explicit-ID reassignment and dedup compatibility pass; runtime omitted mode throws without mutation and browser substitution mutant fails.
- **AC-11 — Ownership and rollout.** No production edits to recorded owned paths or schema/membership writers without a verified owner decision. The v6 `enforce.ts` correction requires verified PR714 owner, branch/checkpoint, dependent callers, permitted outcome and integration order recorded in `../aio1217-handoff/` before that edit, without altering the attached spec hash; unresolved ownership leaves the six oracle-leg cases BLOCKED/FAIL and holds publication while independent unrelated evidence may continue after review/readiness and attachment/readback; no separate action patches or membership/access-policy redesign. No migration/backfill, production credentials/queries/member mutations or live external provider calls. Repeat ownership/base census before publication; verified AIO-1225 owner-backed deferral covers both meeting-todo overwrite and whole-project export and qualifies inventory claims; verified Medium Backlog AIO-1226 separately owns admin-issued key target binding, High Backlog AIO-1227 owns identity/alias targets under held PR714 integration, and Medium Backlog AIO-1228 owns attribution viewer-policy reconciliation. Desired deferred boundaries are never PASS. Release note states foreign/peer ID calls now refuse, prepare/uncertain legacy delivery remains operator-managed, and deferred content protections are not fixed. It also names the intended chain refusal-text/second-draft early-refusal changes, member evidence-search 500, meetings-list/Social-page error boundaries, unchanged three caller outcomes and delegated-token residual from the ten-call-site census.
- **AC-12 — Falsification and evidence.** Named base runtime RED results, in-memory and filesystem mutant outcomes, caller/owner census, stable source hashes and test commands/results are saved durably with actual run snapshot. Do not launder delayed reconstruction as a prebuild execution. Reviewer independently reads code before author matrix. All pending or skipped evidence remains labelled. Record both-export × four-leg fault/adapter activation, exact response, consumer/effect counts, durable-row comparisons, nonempty/partial/item-membership-empty and separate oracle-zero-project/no-error controls, and executable source/test-substitution propagation/continuation/empty-as-error mutant outcomes. Pre-correction RED is exactly the six oracle-leg action cases; the two `project_context_memberships` cases are already green before correction and remain green afterwards. AST registry mutations cannot stand in for executing these propagation mutants. Content isolation or S4/D4 exit-zero alone cannot establish refusal; preserve prior registry/People/approvals evidence at its original snapshot without inflating 15-connection coverage.
- **AC-13 — Validation.** Scoped unit/checker/action tests, required real-PG target/fault/concurrency and existing affected PG tests pass; `npm run typecheck`, lint, docs checks and `npm run build` pass with actual commands/results. Run full unit coverage with existing assertions/thresholds and report default timeout failures honestly if worker-limited retry is needed. Distinguish direct action execution from Next action-wire proof. No broad datamechanics or 96-action wire claim unless actually run. Validate all eight resolver-fault cases and admitted controls through actual exports/real adapter, plus the ten-call-site caller evidence: chain text/zero effects, second-draft invocation-two fault after real chain admission (one oracle-leg actual-export case plus shared-owner coverage), and named regressions with fault-free controls for member evidence-search 500, meetings-list error boundary and Social-page error boundary. Verify the three unchanged caller outcomes and delegated agent-token residual; no general API guarantee. Include separate oracle-zero-project/no-error controls for each target export. Distinguish synthetic executor rejection from native-driver outage. Existing unaffected evidence remains valid only for its recorded snapshot; rerun checks invalidated by the correction.
- **AC-14 — Required reviews and attachment.** Independent subscription Opus 5.5 spec/code reviews and fresh Astra permissioning design/final reviews resolve confirmed in-scope failures; HIGH/blocker requires independent per-finding skepticism per workflow. For this material revision, affected independent subscription Opus 5.5 HIGH spec review, fresh Astra permissioning design review and readiness must complete, followed by full exact accepted Markdown attachment in AIO-1217 and complete readback/hash, before any implementation resumes. Verified PR714 ownership/integration additionally gates only the `enforce.ts` edit; record owner/branch/checkpoint/outcome in the durable handoff without altering the attached spec hash. Only the three outcomes in the revision record are valid. While unresolved, the six oracle-leg action cases are BLOCKED/FAIL, never PASS/DEFERRED, and publication is held; independent unrelated evidence may continue after the review/readiness and attachment gates. Earlier reviews/attachment do not attest v6. Subsequent code review and fresh Astra HIGH final review must cover the shared correction, affected callers and executable refusal evidence. Publication uses the earned review line and staging target; ticket stays In Progress until its merge/squash commit is verified contained in remote main under the current workflow Stage 7. A staging merge alone is explicitly insufficient; this lifecycle does not change the staging feature base or PR target.


| AC | Required evidence / v11 delta | Present credit |
|---|---|---|
| AC-01 | Complete discovery: current census reconciliation and filesystem/directive/unsupported-shape controls. | Historical pre-edit census/runtime admission BLOCKED; no new complete executing census. |
| AC-02 | Complete policy rows: exactly one registration per runtime export with exact owners, refusals, effects, client-ID limits and executing evidence. | Whole 95-action/14-AC coverage remains unearned; historical inventory is not current proof. |
| AC-03 | Genuine invocation: exact owner identities/completion modes and all full-policy positive/mutation controls, including trusted-mode/browser-target enforcement. | No new checker or mutant execution; retained evidence is snapshot-scoped. |
| AC-04 | Actual boundary denial: all 95 protected exports, each documented conjunction, eight resolver-fault cases, 15 scope connections/14 actions and non-vacuous admitted controls. Retain F4-E1/E3 consequences. | Expired-cookie, guard-read-fault and whole-action coverage gaps persist; deferred protections are not passes. |
| AC-05 | Guard owners and policy compatibility: real session/member/posture predicates, stale-tier directions, visibility propagation, ten-call-site compatibility and exact residual outcomes. Retain F4 ADM/caller compatibility. | Existing scoped owner evidence only; caller/UI/E6/wire and revocation limits remain. |
| AC-06 | Account protocol: own-cookie sign-out, own-identity welcome/password change, only-if-unset/current-password refusals and admitted controls without a new tenant-membership requirement. | No new account-protocol execution or complete acceptance. |
| AC-07 | Approval team binding RED→GREEN: foreign legacy/governed IDs match absent refusal with durable non-effects; same-team approve/deny compatibility. | No new paired runtime or durable-state evidence; historical qualifications persist. |
| AC-08 | Approval state/fault boundary: team/id/state-bound transitions, cardinality, producer readiness, atomic pending claim, competing requests, dispatch and uncertain-completion faults. | This is the approval state machine, not PM F4; no new native concurrency/fault proof or broader guarantee. |
| AC-09 | People tenant target RED→GREEN: foreign-team profile/avatar/time-off/goal refusal with durable non-effects; preserved self/admin-other controls. | No new People target execution; original RED and snapshot qualifications remain. |
| AC-10 | People child owner RED→GREEN: team/member/resource binding, peer IDs/import dedup, zero-row/race refusal, explicit trusted import and browser-mode mutants. | No new ownership/race/mode evidence or whole-task acceptance. |
| AC-11 | RETAIN owner/schema/membership compatibility. New delta is verified separate routing of raw edge residuals without waiver. | AIO-1230 routing verified; owner agreement/accepted deferral NOT VERIFIED; no production edits admitted. |
| AC-12 | RETAIN historical evidence and RED duties, including v9's bounded F4-E4 retrospective route and its permanent chronology qualification. ADD finite A mask/channel/identity/full-entry controls; B exact bijection and ambiguity; C exact measured specimen budgets. WITHDRAW v10 whole semantic census promise. | All new executable evidence and independently reviewed final-v11 baseline/ledger outstanding; original chronology and six unreached reference repeats receive no new credit. |
| AC-13 | RETAIN all unrelated required tests/checks and F4 affected validation. AMEND coarse channel comment input only; preserve raw/static/ownership controls. REPLACE false universal CDC envelope with both gates; reconcile active scanner findings with exact approvals. | Current CI/Codacy state remains failed/unearned; none rerun for 9753e94, f757d75 or final v11. |
| AC-14 | REPLACE future version-specific admission references with fresh Opus HIGH spec → resolved findings/required independent HIGH skeptics → separate Astra HIGH readiness → exact native attachment verification → sole builder → three later reviews. | Every complete-v11 gate pending; no attachment/readiness/PR publication credit. |

The compact matrix preserves each original AC identity and subject; the full retained wording controls every detailed obligation. PM reconciliation F4 continues to map to AC-04/05/11/12/13/14 as v9 specifies; it does not rename AC-08 or the People/account criteria. Contracts A/B/C are evidence subcontracts, not replacement or renumbered ACs.

## 9. Exact future implementation scope, sequence and parent-owned checks

### 9.1 Writable-file allowlist after admission only

This list is a future reviewed CI slice, not this author's permission to edit. `new` authorizes only that exact path. No extra generic SQL analyzer, dependency, fixture directory or runtime write is implied. All controls may create disposable synthetic trees at test execution time; no additional committed files are implicitly allowed.

| Exact repository path | Bounded purpose |
|---|---|
| `scripts/check-access-single-writer.ts` (new) | Actual guard entry: finite inventory, retained channels, owners, frozen exceptions/oracle/wiring/materializer and categorized failures. |
| `scripts/guards/access-comment-mask.ts` (new) | Position-preserving TS-parser syntactic-comment masking only; existing locked parser. |
| `test/guards/access-single-writer.test.ts` | Invoke actual retained guard and preserve existing controls; remove early whole-owner bypass. |
| `test/guards/access-comment-mask.test.ts` (new) | Fidelity/parser-error controls, supplementary to real-entry tests. |
| `test/guards/access-single-writer-controls.test.ts` (new) | Every normative positive/negative/mutation control through actual entry. |
| `scripts/reconcile-aio1217-gitleaks.mjs` (new) | Pinned wrapper, private report parsing, safe descriptor reconciliation/index integrity. |
| `scripts/aio1217-gitleaks-controls.mjs` (new) | Actual pinned Linux binary controls in explicitly provisioned CI only. |
| `test/guards/aio1217-gitleaks-reconciliation.test.ts` (new) | Pure schema/path/bijection/ambiguity/integrity/error unit tests without scanner. |
| `docs/archive/aio1217/scanner-exceptions.v1.json` (new) | Independently reviewed value-free occurrence/group approvals. |
| `docs/archive/aio1217/scanner-index.v1.json` (new) | Noncyclic supplementary integrity schema. |
| `.github/workflows/ci.yml` | Exact Node20 guard/sweep wiring and provisioned pinned secret-scan, preserve all unrelated required jobs/checks. |
| `test/graph-cdc.test.ts` | Replace only false append envelope with both gates; preserve all unrelated controls/fixtures. |
| `scripts/cdc-churn-sweep.mjs` | Shared strict validation and accurate exit/report behavior; retain recipes and in-place controls. |
| `scripts/guards/cdc-append-contract.ts` (new) | Nonproduction schema/inventory/function/recipe/budget validation shared by unit/sweep. |
| `test/fixtures/cdc-append-regression.v1.json` (new) | Encode independently admitted exact specimen measurements; no self-baselining. |
| `docs/design/cdc-append-churn.md` | Only §7/Appendix E anchored replacements and directly conflicting identified claims. |
| `docs/design/content-defined-chunking.md` | Only corresponding append row/prose/current-claim corrections, historical scopes preserved. |

The current v11 file is the sole author-stage output. After review/attachment it remains frozen; it is not a builder scratch file. A change to it requires renewed exact-byte gates, not an unrecorded edit. V10's `scripts/guards/sql-write-analysis.ts` and generalized `access-write-analysis.ts` are removed from scope. The v10 scanner `*.test.ts` actual-binary control path is also removed in favor of the explicit `.mjs` job control.

Forbidden implementation writes: every `app/**` and `lib/**` file, including `lib/access/enforce.ts`, `oracle.ts`, `groups.ts`, `agent-tokens.ts`, `provenance-sql.ts`, both project-context owners, auth/posture owners, action registry/dispatcher, profile identity, pg pool/client/query-builder/tx, governed owners, `lib/graph/cdc.ts` and `lib/graph/project.ts`. Also all `postgres/**`, schema, migrations, chunk ledger, environment configuration and data; both raw-edge scripts; staging workflows/loaders and every other script outside the exact list; `.gitleaks.toml`, `SECURITY.md`, package manifests/lock/dependencies; accepted v9, unaccepted v10, all existing archive/index/manifest/receipt bytes; all existing fixtures except the specific bounded test source edits above; fixture-entropy guard, CDC boundary design, graph-delta datamechanics and graph-episode tests. No migration, backfill, owner waiver, new table/scan root/extension or access-policy change is part of this slice. Unmet original runtime obligations need a separate explicit reviewed implementation scope, not silent expansion of this one.

### 9.2 Exact implementation and verification order

1. Parent verifies the recovery delta in this one retained file, predecessor hashes, source/evidence identity and all author-stage restrictions. Preserve exact proposed bytes and overdue cadence state. A normal local documentation checkpoint requires its ordinary qualification; this author makes no Git write or push decision.
2. Obtain fresh independent Opus 5.5 HIGH review of COMPLETE v11, resolve each finding (HIGH/blocker requires independent per-finding skepticism), and verify the already specified narrow policy rather than invent SQL abstractions or seed authority. Parent acquires/reviews the outstanding Linux provisioning/coordinate/suppression controls, value-free ledger dispositions and exact v11 CDC measurement packet under producer/reviewer separation. If exact final bytes change, repeat affected complete-byte review and measurements.
3. Fresh separate Astra HIGH readiness reviews Contracts A/B/C, all dispositions, exact baseline/ledger receipts and AIO-1230 limitations. No readiness with an invented baseline, ambiguous individual category mapping, unqualified review or implied owner agreement. Then upload exact complete reviewed v11 as a NEW native AIO-1217 attachment and independently download/read back full hash/size. Preserve v9 native attachment and original description continuity. No builder until all these gates are satisfied.
4. Verify sole future Opus 5.5 HIGH builder identity and fresh subscription capacity, stop latch and single-writer/overlap ownership. No API key billing, nested writer or automatic provider switch. Parent owns visibility, 90% stop, checkpoints and authorized remote backups under the workflow; attach display without restarting existing work. This author does not dispatch that worker.
5. Builder implements the retained guard/mask and full production-entry controls first. Keep runtime bytes immutable. Prove unchanged enforce passes and every expected violation category is discriminated. Build parser/setup fault controls and mutation-kill controls; hash-check frozen exemptions/materializer and source prohibitions.
6. Implement pure scanner reconciliation/schema/index controls, encode only independently reviewed descriptors/group dispositions, then actual Linux wrapper/controls and checksum provisioning. Preserve old archive integrity and prove zero raw findings in new metadata; actual checkout reconciliation remains active and exact.
7. Implement CDC shared validator and encode only admitted baseline. Replace false assertion, preserve controls/recipes, wire actual sweep. Apply exactly the two documentation replacement sets; parent measures and independently admits changed document specimens before the baseline can pass. Builder does not approve its own output.
8. Wire `brain-tests` on Node20 to run `node --import tsx scripts/check-access-single-writer.ts --root .`, ordinary `npm test`, and mandatory `node --import tsx scripts/cdc-churn-sweep.mjs --op append` using acceptance defaults: no exclusions, no baseline update and shared complete-fixture validation. Missing fixture/root/recipe or identity fails. The existing sweep `.mjs` imports the TS shared validator through the explicit tsx loader. `secret-scan` separately executes §5's exact provisioning and actual-control/wrapper commands. Preserve all other existing checks and thresholds; no only-new-tests shortcut.
9. Parent runs required tests/lint/typecheck/security/archive/CI checks appropriate to the exact bounded changes, retained unit/synthetic/live-corpus controls and source-diff prohibitions. Records exact candidate hash, source/function/config identities and safe results. Existing runtime/PG evidence remains governed by v9; this CI slice cannot manufacture missing PG/live/wire acceptance or run production migrations. No previous 813f61c pass attests reconstructed/new bytes.
10. Later independent subscription Opus 5.5 HIGH code review, fresh Astra HIGH code review and mandatory blind GPT-6.1 Sol HIGH final review cover the final exact snapshot and all relevant evidence; resolve findings and repeat invalidated checks. Only earned review gates can permit a qualified checkpoint push/PR publication decision. PR target remains staging; no merge/deploy/main/Done authorization is granted.

### 9.3 Parent-owned failure handling, recovery and rollback

Preserve original evidence and exact candidate snapshots on any failure. Parser uncertainty/inventory/identity failure stops the guard; scanner ambiguity/error/missing occurrence stops reconciliation; corpus/budget/function/recipe drift stops CDC admission. Produce safe categorized diagnostics without private values. Never turn a failure into an exception, autoapprove a ledger/baseline, edit historical evidence or exclude a document. A reviewed policy change requires a successor and renewed gates.

At phase transitions/interruption/quota warning the parent preserves all task-owned partial/untracked edits in a verified durable checkpoint and sanctioned remote backup, records actual worker stop/usage and exact snapshot, and retries under normal controls. The already overdue deadline stays overdue until qualifying verification; no timestamp/readback fiction. No paid API fallback or second writer. Missing evidence must be re-created by the authorized parent workflow and independently verified; earlier results do not attest reconstructed code. Do not delete a worktree/checkpoint until a separate recoverable replacement is verified.

Rollout is atomic adoption of the bounded checks plus their controls and independently reviewed metadata. Do not land a permissive scanner wrapper, empty/missing baseline bypass, broad exemption or deleted test in isolation. There is no runtime/database rollout or migration. Rollback is a reviewed revert of this CI implementation on the task/integration branch with evidence preserved; reverting can restore known guard/CDC/secret-scan failures and must be reported as such. Do not roll back application authorization, production cdc1, scanner rules or immutable archive/specification bytes. Required-check failure holds PR readiness. Rollback earns no acceptance or release credit.

## 10. Still-uncredited ledger and final role gates

Unresolved facts/gates include: historical pre-edit census/runtime admission BLOCKED; expired-cookie and guard-read-fault gaps; 95-action/14-AC whole-coverage gap and historical census reconciliation; E6/UI/Server Action caller/wire gap; live-provider and concurrency/revocation limits; all affected-review qualifications; current CI/Codacy failures/unverified state; original Opus review's historical denial; first projection's rejected alignment; actual Linux binary digest/provisioning/suppression/path/coordinate/error controls; independent safe occurrence/group approvals and new-metadata zero-finding proof; exact final-v11 CDC function/generator identities, measured baseline, both-legacy cross-check and independent reproduction/admission; future changed-doc specimen admission; full-entry guard controls; five uncovered raw edge writes and lack of AIO-1230 owner agreement/accepted deferral; all generic SQL/extra-root/extension coverage explicitly deferred; renewed complete-byte reviews/readiness/native attachment; overdue remote backup; later implementation/check/code/final review obligations. A routed child is progress on routing only.

**Pre-builder evidence checklist (all still pending unless explicitly identified as preserved routing/identity evidence):** parent verification and freezing of the complete recovered bytes and one-file delta; fresh qualified independent subscription Opus 5.5 HIGH complete-spec review and resolution of findings with separate independent HIGH/blocker skeptics; reviewed pinned Linux executable digest/provisioning and actual suppression/path/coordinate/error/completion controls; independently reviewed value-free occurrence/group approval candidate and metadata zero-finding evidence; parent-produced exact-final-v11 corpus/function/recipe/legacy-cross-check measurements with independent reproduction and specimen-budget admission; fresh separate Astra HIGH readiness assessing those receipts and the verified AIO-1230 routing with owner agreement/accepted deferral still absent; exact complete new native Linear attachment plus independent full download/readback hash/size equality; and verified sole Opus 5.5 HIGH worker identity, subscription capacity/stop-latch status, source ownership/overlap, exact allowed scope and recoverable handoff. Parent controls and measurement harnesses must themselves be independently inspected and identity-bound; a source-only proposal cannot replace their actual results. Any spec-byte change invalidates affected measurement/review/attachment identities and returns to those gates.

Full-entry guard mutation results, final implemented scanner/CI results, post-edit CDC-design specimen admission, parent verification and the three code/final reviews are subsequent implementation/completion obligations. They remain unearned but are not falsely required as already-implemented proof before admitting the sole builder. AIO-1230's absent owner agreement is retained for readiness's explicit limited-scope disposition; no agreement or accepted deferral may be inferred from its verified routing. Historical production admission remains separately BLOCKED regardless of a future bounded CI-builder admission.

These are not requests for this author to exceed scope. They are explicit parent-owned admission and evidence gates. Whole acceptance is unearned. There is no PR readiness, merge, remote-main containment, deploy, release or Done credit. Staging remains the feature/PR destination; merging and deployment require their own authorization. The inherited lifecycle's remote-main-containment requirement for eventual Done is not permission to merge or push main.

Required final sequence, without collapsing roles:

1. **Fresh independent subscription Opus 5.5 HIGH specification review of the complete exact v11 bytes**, with findings resolved and fresh independent skepticism for each HIGH/blocker. Historical reviews do not substitute.
2. **Fresh separate Astra HIGH readiness**, after Opus resolution, explicitly assessing Contracts B/C's measured/approved artifacts and Contract A/AIO-1230 limitations. Authoring and the previous narrow scope decision are not readiness.
3. **Exact complete v11 NEW native Linear attachment upload, full readback, independent download and SHA-256/byte-size verification**, preserving accepted v9 and historical description continuity. Description normalization is irrelevant to native-byte identity. Outstanding until actually performed.
4. **Sole future subscription Opus 5.5 HIGH builder**, only after those gates, exact allowed files and verified worker/capacity/single-writer ownership. No implementation was admitted by this author.
5. **Later independent Opus 5.5 HIGH code review**, **fresh Astra HIGH code review**, and **mandatory blind GPT-6.1 Sol HIGH final review**, each on the exact relevant snapshot with complete qualified evidence. Neither coordinator nor author may attest its own work.

END OF COMPLETE V11 ROUND-2 PROPOSAL — UNREVIEWED, UNACCEPTED, NOT READY, NOT ATTACHED, NOT IMPLEMENTED, NOT PUSHED, NOT ATTESTED.
