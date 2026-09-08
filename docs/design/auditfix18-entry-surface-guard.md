---
eval_tier: deterministic
spec_gate: block
---

# AUDITFIX-18 — inventory ingestion entry surfaces through reverse imports

Status: accepted by Astra after user-authorized substitute reviews; focused directory-manifest clarification review CLEAR, 2026-09-07.
Brain task: **AUDITFIX-18**; [Linear AIO-1148](https://linear.app/je4light/issue/AIO-1148/phase-a-lane-b-enforce-ingestion-entry-surface-inventory-using-reverse).
Base: staging `d6bdf62a834b2a5c6b22e3c1f542c28fe7990c5c`.
Parent: `docs/specs/project-context-classification-v1.md` (internally V2), §11;
plan: `docs/design/phase-a-remediation-plan.md`, Lane B 17 → 14 → 18.

**Build-with:** Opus 5 / high through Claude subscription authentication only. Astra medium owns
specification/adjudication; fresh Astra reviews spec and code in the user-approved substitution
for Fable for this slice after Fable exhausted its credits. A separate fresh Astra high performs
final review. Opus remains the subscription-authenticated builder.
**Deps:** AUDITFIX-17 and AUDITFIX-14 are complete; accepted spec and deterministic SPEC_READY
(`--no-llm`) precede implementation. Target staging. No external contract prerequisite.

## What and why

A new route, action, component or script importing an already-classified ingestion wrapper must
require an explicit inventory decision in the same change. The guard follows reverse module
imports to a fixpoint; it does not infer which exported function actually runs. Its observable
outcome is an actionable unit-test failure naming the unclassified surface and its import path
to the canonical writer, not a claim about runtime access, reconciliation execution or latency.

In scope: extend `test/guards/context-hook-callsites.test.ts`, with a test-only helper if useful;
add a separate entry-surface inventory and synthetic controls; update the architecture map and
superseded boundary descriptions in `docs/design/auditfix2-writer-inventory-guard.md` §3e.
Out of scope: ingestion/reconciliation runtime changes, HTTP contracts, schema/migrations,
AUDITFIX-16 codebase reconciliation/admission work, semantic whole-program call graphs, runtime
module discovery, and adding reconciliation to any newly inventoried path. The user accepts the
existing delayed codebase visibility (roughly 8–30 minutes historically); this guard establishes
no fresh timing measurement or guarantee, especially when the scheduler is disabled.

## Re-derived premises and ownership

- The existing guard discovers **direct calls** to canonical `lib/ingest/index.ts:ingestItem`,
  including aliases and writer re-export barrels. Its seven-file inventory pins counts, reasons,
  direct reconcile shapes and stale entries. Retain these checks and adversarial positive twins.
- `app/api/v1/codebases/route.ts` imports `lib/codebases/ingest.ts`, which reaches the direct
  writer in `lib/codebases/commits-to-items.ts`. A second route importing that wrapper changes
  no direct-writer count. This is the actual missing detection boundary.
- Other confirmed paths are actions route/admin approvals → `lib/actions`; manual dashboard
  query and `scripts/connectors.ts:verify` → `runManualSync`; four admin Run now functions →
  `lib/ingest/run`; meetings actions → meeting writers; `instrumentation.ts` dynamically imports
  the scheduler. AUDITFIX-14 now supplies the bounded manual context pass. Do not restore its
  obsolete “no reconcile” description or demand inline calls in each action file.
- A module can export both readers and writers. Importing a reader from such a module still enters
  the closure, as do client components importing server actions. These are expected conservative
  inclusions, not evidence of an executed ingest. An exploratory read-only regex inventory found
  about 79 closure modules / 50 boundary files; that is feasibility evidence only, not the AST
  acceptance oracle or an exact expected baseline. The builder must inspect the actual discovered
  set and write reasons, not approve that preliminary count.
- The current walk covers app/components/lib/scripts and root sources; excludes named directories
  with reasons and checks tracked top-level coverage. The writer's canonical file is excluded from
  the direct-call walk intentionally; the new graph must add it explicitly as its seed.
- Existing source discovery includes .cjs but its resolver's extension candidates omit .cjs;
  explicit emitted .js → source .ts substitution is also absent. Do not claim that resolver
  already supplies the new graph's resolution contract.

`docs/ARCHITECTURE.md` owns the map, the guard owns this build invariant, and `lib/ingest` remains
the item writer. Context/access primitives and their real-Postgres outcome tests remain authoritative
for visibility. Installed Next route and use-server guides were read: routes use special route files;
`use server` can be a source-file directive or a function-body directive. No Next runtime code changes.

## Decision: graph, boundary and inventory

Build a file graph from the same source contents used by real-tree analysis and synthetic fixtures.
For a runtime module reference in file A resolving to B, record A → B. Starting only at the canonical
writer module, repeatedly add its importers until no file is new. Do not seed from the hand-maintained
inventory: that would let an omitted writer erase its own callers. Keep traversal through lib wrappers,
barrels, surfaces and cycles; do not stop at an already-classified module. A visited worklist over a
finite file set terminates; cache parsing and graph construction once per real-tree run. Store one
deterministic witness chain per reached file for useful, stable diagnostics. No arbitrary hop limit.

A **surface file** means any reached source under `app/`, `components/`, or `scripts/`, any reached
root-level source, and any reached `lib/` file containing a real `use server` directive in a source
or function-body directive prologue. This deliberately includes pages, layouts, read-only consumers,
script helpers and client components, not only filenames `route.ts` or `actions.ts`. A quoted string
in a comment, type, arbitrary expression or non-prologue position is not a directive. Other reached
lib modules are intermediate graph nodes and need no entry record unless they meet the surface
predicate. Direct writers retain their separate original INVENTORY obligation without duplication. Adding another function inside a classified file
is explicitly outside this file-level addition detector.

Maintain a separate exact-key entry inventory, one record per discovered surface file, with a class
and a nonempty concrete reason identifying the relevant chain/operation and coverage limitation:

- `RECONCILES`: existing after-response, inline or bounded-manual orchestration; reason must state
  which applies and whether pending/failure is possible. This class adds no new textual shape check.
- `SWEEP_DEPENDENT`: a real ingestion entry relies on scheduled/explicit later repair; reason states
  that dependency and disabled-poller limitation where applicable.
- `IMPORT_ONLY`: conservative dependency inclusion with no identified ingest operation at that
  surface, e.g. reader-only export or a UI consumer. State the actual import responsible.

All three are **review declarations**, not machine-certified safety or execution facts. The old direct
writer classes keep their existing distinct structural checks. A missing record, unknown class or
blank reason fails. A record whose file disappeared, lost its writer path, or ceased to meet the
surface predicate fails as stale. Removing an edge that still leaves another path is not staleness.
Do not auto-generate acceptable reasons or use directory-wide records. A witness/role change within
an existing record can still require human review even when the exact-key guard stays green.

## Module syntax, resolution and explicit limits

Graph input uses the current walk and its top-level coverage control, adding .jsx alongside .ts,
.tsx, .mts, .cts, .js, .mjs, .cjs consistently for discovery and parsing. Type declarations
(`.d.ts`, `.d.mts`, `.d.cts`), test sources, the existing fake DB double, dependencies, hidden/generated
paths and the existing named non-walked roots remain excluded. Keep their reasons and the existing
coverage assertions. Docker shell/bootstrap launchers and Python HTTP clients are excluded boundaries;
this graph does not follow child-process launches, HTTP requests or callbacks crossing module APIs.
A runtime local source reference resolving into an excluded source must produce an actionable
violation that fails the guard, not merely an unasserted diagnostic list.

Recognize static imports (default, named, namespace, side-effect), export-from declarations (named,
renamed, star, namespace), TS import-equals external require, literal `import(...)` with or without
await, and literal `require(...)` anywhere in the AST. Follow module edges regardless of imported
symbol spelling or whether it is called. Exclude explicit `import type`, `export type`, type-only
named specifiers when the entire declaration is type-only, and TS import-type expressions. Mixed
value/type imports retain an edge. An empty side-effect import retains an edge. Strings/comments and
unrelated identifiers are not imports. A no-substitution template literal is a literal module name.

Resolve `@/` and relative references to normalized repository source paths using TypeScript's installed
bundler-resolution behavior with the repo's relevant compiler settings and an explicit source host.
Cover extensionless files and indexes, explicit extensions, and emitted `.js/.jsx/.mjs/.cjs` names
resolving to applicable TS sources. Fixtures must resolve solely against supplied virtual files, not
accidentally against real disk files. Keep local resolution inside the repository; an unresolved or
outside-root local code reference fails with file/specifier/location. Literal `file:` module URLs
are unsupported local references and must be refused before external-package handling; recognize
the scheme case-insensitively without decoding or resolving the URL.

Local directory-manifest resolution is unsupported. For an @/ or relative runtime reference,
if package.json exists directly under its normalized reference base, fail with an
unsupported-directory-manifest diagnostic before source/index/asset fallback. This conservative
refusal applies irrespective of manifest contents or a competing same-base source file. Use an
explicit source-file reference. Probe only that manifest's existence within the injected repository
root; do not interpret redirects, inspect ancestor manifests or crawl dependencies. Metadata never
becomes a graph node. An ordinary JSON data import and explicitly type-only references retain their
existing treatment. Virtual fixtures can supply this metadata but never borrow ambient disk files.
 Resolve possible local source targets before treating an asset-like suffix as terminal: a reference
such as ./x.css that resolves to source ./x.css.ts must retain its code edge. If no source resolves,
recognized non-code asset imports (e.g. CSS/JSON) are terminal dependencies, not writer edges.
The unsupported # alias refusal precedes asset handling, including #theme.css. Literal external package
and node-builtin imports are terminal; do not crawl node_modules. Runtime module references beginning
with `#` are not external packages: refuse them explicitly as unsupported package-import aliases,
with source file, specifier and location, regardless of whether package.json currently declares an
imports mapping. This slice does not resolve package.json imports. Type-only references remain
excluded as above. Pin the supported alias setting so a
new repo alias cannot silently look like an external package. Do not change the old direct resolver's
semantics casually; sharing resolver code is optional and must retain all old controls if chosen.

A nonliteral `import(...)` or syntactic `require(...)` in scanned production sources must produce a
refusal even outside the current closure: ignoring it there would let the hidden edge prevent its
own discovery. This is fail-closed **for these recognized loading forms**, not a proof against eval,
aliased loaders, custom bundler plugins or arbitrary runtime execution. Allow narrowly reviewed,
explicit exceptions for external loading; do not ban unrelated external package behavior at runtime.
The known `lib/actions/sandbox/e2b.ts` exception must match the `defaultLoader` import of `E2B_MODULE`
and its unchanged top-level const binding to `"@e2b/code-interpreter"`, with a concrete external-package
reason and exactly one occurrence. Changing binding, expression, function, count or file fails; removing
the load makes the exception stale. No file-wide or identifier-only exemptions. A new computed local
loader cannot borrow that exception. Parse errors and unresolved code references must not be swallowed.

## Acceptance criteria and matrix

- **AC18-01 — original invariant retained:** all existing direct-writer classifications, exact counts,
  structural obligations, directory coverage and evasion/innocent-twin controls remain effective.
- **AC18-02 — new surface detected:** a new route importing an existing classified wrapper through
  multiple layers fails with its path and writer witness, while the direct-writer set stays unchanged.
  Classifying that surface with a valid reason makes the same fixture pass.
- **AC18-03 — fixpoint and forms:** renamed/star/namespace barrels, side-effect/default imports,
  literal dynamic import/require, import-equals, extension substitutions and directory indexes reach
  the seed. A reverse-ordered chain of at least four edges and cycles terminate with the exact set.
- **AC18-04 — boundary and innocent twins:** fixtures cover new app pages/actions, components,
  scripts, root files and lib source/function directives. Type-only imports/reexports and import-type
  expressions, unrelated local functions/strings, unrelated modules and fake directives do not enter
  the closure. Mixed imports do; importing a reader from a writer-bearing module does and requires
  an IMPORT_ONLY record. Non-surface lib wrappers are traversed without becoming surface records.
- **AC18-05 — no quiet resolution escape:** test .jsx discovery, .cjs and emitted-name resolution,
  aliases/relative spellings and virtual-host isolation. Missing local code, outside-root resolution,
  parse failure and unsupported alias drift fail with specific diagnostics. A new surface importing
  `#scan` (including the scenario where package.json maps it to a classified local wrapper) must fail
  with an unsupported-package-alias diagnostic rather than disappear as external. A literal external
  package import and node-builtin import are passing twins; known non-code assets still pass.
  Through the actual filesystem discovery seam, a local directory manifest redirect plus harmless
  index must fail with the named unsupported-directory-manifest diagnostic. Verify the redirect's
  TypeScript target independently in the fixture; removal of the manifest makes the index twin pass.
  A benign directory manifest is also refused; an explicit source-file reference and ordinary root
  package.json must not cause an ancestor-wide refusal. Literal file-URL static/dynamic references
  fail with importer/specifier/location; package and builtin twins remain clean.
- **AC18-06 — exact exceptions and staleness:** nonliteral loads fail even in an otherwise unrelated
  surface. The narrowly matched external E2B fixture passes; changing its const to a local wrapper,
  adding another load or broadening its expression fails. Removing it fails the stale-exception check.
  Missing/blank/unknown entry records and deleted or disconnected classified files fail; a surviving
  alternate path preserves classification. No exception is inferred from an empty closure.
- **AC18-07 — real tree and mutation proof:** real discovered surface keys equal the reviewed inventory,
  with witness paths for all entries. Independently assert inclusion of the known codebases route,
  actions route, approvals actions, manual query, integrations actions, meetings actions,
  instrumentation, connectors CLI and seed-demo. Reversible mutations: add a route through an already
  classified wrapper; stop traversal after one hop or at a classified wrapper; skip dynamic edges;
  stop checking stale entries; weaken the computed-load exception. Each must redden its named control.
  A control that fails everything is defeated by the corresponding valid classification/innocent twin.

| AC | Observable evidence / tier |
| --- | --- |
| 01 | Existing guard suite plus retained direct-call negative controls; unit |
| 02–04 | Same analyzer on small virtual modules; exact sets and diagnostic kinds; unit |
| 05–06 | Resolution/refusal and passing twins; exact stale diagnostics; unit |
| 07 | Real source inventory, independently named known paths, mutation outcomes; unit/coverage |

This changes a source guard, not persistence. No new real-DB or HTTP tests are required. Do not use
models or live services to decide graph membership. Record measured guard/coverage runtime during
verification; no current runtime estimate is asserted by this spec.

## Implementation, recovery and rollout

Increment: one PR delivers this guard-only extension; runtime remediation and other follow-ups
remain deferred as listed in scope.

1. Write spec-derived fixtures demonstrating the new-wrapper-entry escape against the baseline,
   including positive twins. Coordinator records the intended red outcome.
2. Add the graph and exact surface inventory, inspect every discovered record, preserve old checks,
   and include witness paths in failures. Keep helper code test-only.
3. Correct the guard header and AUDITFIX-2 §3e's whole-callgraph claim; update the architecture row
   to distinguish direct-writer structural checks from reverse-import review declarations. Refresh
   stale manual/codebase-bound wording only where these boundary descriptions are touched.
4. Run focused guard tests and coverage/mutations, TypeScript and docs checks, required reviews.
   Do not solve an inventory finding by adding runtime reconciliation in this slice.

On failure, fix a missing edge/resolution bug or review and add/remove a precise inventory entry;
never recover with a global ignore. No data migration, retries, locks, runtime privacy changes or
companion API revision. Merge to staging under the existing workflow. Rollback removes only the new
inventory extension and documentation, leaving the original direct-writer guard operational; the
lost entry-surface tripwire must be disclosed. No production visibility improvement is claimed.
