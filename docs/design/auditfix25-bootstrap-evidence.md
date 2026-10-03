---
type: issue-spec
eval_tier: deterministic
spec_gate: block
safety: true
---
# AUDITFIX-25 — bounded bootstrap evidence and admin disclosure

Version: v3.1, proposed; round-2 adjudication wording aligned, not implementation or acceptance.
Brain row: AUDITFIX-25. Linear: AIO-1062, read-back verified In Progress.
Ticket: https://linear.app/je4light/issue/AIO-1062/split-out-of-auditfix-23-on-2026-08-24-at-spec-round-3s-high-5-the
Base: origin/staging `283e68bc10f668df3123513583afce9c2de8713a`.
Branch: `codex/auditfix-25-bootstrap-evidence`; isolated auditfix25 worktree.
PR 738 is unmerged and is not a dependency; its materializer changes are outside this slice.

## Problem and outcomes

The existing scheduler runs convergence and a system-edge census independently for each team.
Its outcome transports only a single error: a census error replaces a simultaneous convergence error.
The census description is truncated before aggregation, so it cannot exercise the inverse long-arm case.
The callback writes no structured metadata, and the existing panel hides metadata whenever a row has errors.
Operators therefore cannot inspect bounded structured findings on the supported failed-row surface.

Preserve detector correctness and completion-time ledger writes while carrying both named errors and a
bounded, explicitly sampled finding envelope. Show that envelope alongside the error in the existing
Integrations → Recent ingestion runs panel. This is a diagnostic read surface, without repair actions.
The old ticket's lost-row-at-cardinality claim is a hypothesis, not a reproduced production incident.
This change bounds its own serialized metadata before the best-effort writer receives it.
Literal exhaustive ledger names are deliberately replaced by bounded structured samples plus exact full
counts, the ticket's expressly allowed bounding alternative. Complete enumeration remains an authorized
read-only administrative procedure documented below; no unbounded ledger/export endpoint is promised.

## Dependencies and build-with

AUDITFIX-3/21/22/23/24 provide the existing sanctioned-edge policy, census, per-team callback and fleet
heartbeat contracts on this staging base. The supported repair-system-edge CLI already exists.
No dependency on PR 738, new schema, provider connection, new endpoint, or database capability is needed.
Use the installed Next 16.3 server-component and authentication guides, not remembered Next conventions.
Sol 6.1 high authors/adjudicates; subscription-authenticated exact Claude Opus 5.5 reviews and implements;
fresh GPT-6 Astra high reviews privacy/security and adjudicates substantive disagreements.
No Anthropic API-key coding. The coordinator attaches the exact accepted spec to AIO-1062 before RED/build.

## Scope and integration points

Existing production owners: `lib/access/bootstrap.ts`;
`lib/ingest/access-bootstrap-leg.ts`; `components/admin/ingest-runs-panel.tsx`;
`app/t/[team]/admin/integrations/page.tsx`; narrow pipeline-health branch of `app/t/[team]/page.tsx`.
Existing `lib/ingest/runs.ts` remains the ledger writer/reader. Its generic arbitrary-meta behavior and
unrelated callers remain unchanged contracts: caller-owned bounds fully satisfy this slice, so no generic
clamp work is required, deferred or scheduled; this fence excludes no required task or hidden follow-up.
Existing `censusTeamSystemEdges`, sanctioned pairs, SQL, schema, permission predicates, membership
ownership, bootstrap repair order, scheduler triggers, source names, confirmation thresholds and retention
remain the already implemented authoritative contracts. No changes to them are required to deliver this
slice; their preservation excludes no required work and defers no work or follow-up.
`lib/admin/access-health.ts` also uses `describeUnsanctionedEdges`: retain its useful existing short-input
human format and useful diagnosis. The existing repair CLI, rather than its stale 'until then' wording,
is the documented remediation. The new compound formatter takes raw findings, not that helper's
already capped output. No claim is made that every legacy human formatter acquires the new byte bound.

## Typed contract and budgets

Extend TeamBootstrapOutcome with optional typed `evidence`, not arbitrary caller metadata.
For a failed team outcome, populate version 1 evidence and one labelled error string; wholly clean
convergence plus a complete zero-finding census keeps the existing ok outcome without evidence.
The ledger callback passes only `{ accessBootstrapEvidence: outcome.evidence }` as its new metadata.
The envelope has this semantic shape (exact exported type names may follow repository conventions):

```text
version: 1; teamId: UUID
convergence: { status: "ok" | "failed", error?: { message: string, truncated: boolean } }
census: { status: "complete" | "failed", total: integer | null,
          error?: { message: string, truncated: boolean } }
sample: [{ projectId: UUID, groupId: UUID, projectSlug: string, groupSlug: string,
           projectSlugTruncated: boolean, groupSlugTruncated: boolean }]
omitted: integer | null
```

| Convergence | Census | Outcome/evidence | Required errors |
| --- | --- | --- | --- |
| ok | complete, total=0 | ok, no evidence | none |
| failed | complete, total=0 | failed, evidence, omitted=0/sample=[] | convergence only |
| ok | complete, total>0 | failed, evidence, omitted=total-sample.length | census summary only |
| failed | complete, total>0 | failed, evidence, omitted=total-sample.length | convergence and census summary |
| either | failed, total=null | failed, evidence, omitted=null/sample=[] | census reason; convergence iff failed |

Each emitted failing phase requires its error object, including census.status=complete with findings.
Clean phases omit error. The byte wrapper is exactly `{"accessBootstrapEvidence": envelope}`, including
key/braces, not only its value. Metadata can arrive as an object or legacy JSON string: reject a string
above 8,192 UTF-8 bytes before parsing; bounded parse failures fail closed. Project only known validated
fields from objects, with array/type/length checks before iteration; do not serialize arbitrary unknown meta.

A completed census reports the exact full finding count, including zero. Its omitted count equals
total minus sample.length. A returned census read failure or census throw reports total/omitted null,
sample empty, and a named bounded error: unavailable evidence is never represented as zero findings.
The convergence phase's failed status is independent of the census status and finding count.
Do not expose exceptions, stacks, SQL text, or arbitrary exception properties as structured evidence;
use the existing returned error/message or fixed non-Error fallback, bounded as below.

Budgets are finite application presentation budgets, not database capacity estimates:

- Maximum recorded metadata: **8,192 UTF-8 bytes of actual JSON.stringify of the entire namespace object**.
- Maximum sample: **16 edges**; every display slug: **96 UTF-8 bytes**, including any truncation cue.
- Both failing phases: **reserve 224 UTF-8 bytes per arm**, including its truncation cue; unused budget
  is redistributed below, without letting a long arm erase the other's reservation.
- A lone failing phase uses the **480-byte total minus its label**: census 472, convergence 467 bytes.
- The single compound ledger error: **480 UTF-8 bytes**, including reserved labels/separators.

Normalize NUL and isolated high/low surrogate code units to U+FFFD in every new error/evidence string
before ordering, truncation and measurement; preserve valid surrogate pairs. Actual local PG16 SELECT
probes rejected NUL/unpaired high surrogate in jsonb and accepted newline. Size alone is insufficient.
Truncate on code-point boundaries; do not create half of a surrogate pair. Explicit flags communicate
every shortened display slug/error. Keep UUID identities exact. Display slugs are not exact repair commands.
Select the first 16 by full normalized, untruncated tuple `(projectSlug, groupSlug, projectId, groupId)`, using stable
locale-independent JavaScript lexical comparison with IDs breaking slug ties. Do not deduplicate findings.
A bounded top-k implementation avoids a new whole-array sort/copy, verified by code inspection, not a
black-box memory claim; the existing census still materializes
all results. There is no new global memory bound, query pagination, or census execution-time claim.
Measure actual serialized JSON after string escaping. If 16 samples exceed 8,192 bytes, remove samples
from the end of that deterministic order until they fit, recomputing omitted after every removal.
The fixed count/status/error envelope with an empty sample fits the same budget; keep it rather than
dropping the failure or pretending completeness. Fixed known fields and bounded strings avoid cycles.

Build both error arms from raw phase results. Census grammar is `N unsanctioned edge(s) on system
projects: ` plus the ordered raw sample's `projectSlug→groupSlug` pairs joined by `, `. Reserve the exact
count head; truncate the diagnostic prefix with a visible ellipsis within the contextual arm budget.
This text may end within a display name; its typed truncation flag is explicit. It promises no complete
pair list or '+N more' text; structured total/omitted remain authoritative. Returned/throw failures retain
their named phase reason. Reserve labels and
independent arm budgets before assembling `census: …; convergence: …` when both fail. A single failure
also stays named and can use its otherwise unused compound budget; persist that same contextual message
and truncation flag in evidence. Real adoption-refusal guidance that fits a lone arm remains untruncated.
The census arm remains first; neither arm consumes the other's guaranteed dual-failure budget. For dual
failures, start allocations at min(normalized full-message bytes,224); from the remaining 457 message
bytes, extend census toward its full length first, then convergence. Truncation cues count within these
allocations. A short census leaves room for the realistic adoption-refusal repair suffix. The final string
fits the existing 500-JavaScript-character writer clamp, and remains one error/error_count contribution.
Two guaranteed 224-byte allocations plus 23 label/separator bytes occupy471; redistributed total≤480.
Unlike a 192-byte arm, this leaves a testable diagnostic region beyond the old 200-character preclamp.

## Flow and privacy boundary

1. Run convergence, then the census, in their existing separate guards even if convergence throws.
2. Safely extract only string messages (guard property access; non-string/throwing getters use fixed
   failed/threw fallback, never String(arbitraryObject)). Build evidence/error in its own third guard
   before the summary/callback. On builder failure, preserve phase/count failure in a fixed ASCII named
   error, omit evidence and continue later teams: census finding count/unavailable and convergence failed
   stay explicit. Formatting failure must not convert a healthy result into failure or abort the fleet.
   Pin an injected module-builder fault through test mocking, without a production test hook.
3. Write exactly one per-team scheduler access_bootstrap row as that team completes. A callback throw
   remains observability failure, cannot become a convergence failure, and cannot abort later teams.
4. Keep access_bootstrap_all as a distinct ok:true liveness row and existing zero-team/global-failure
   access_bootstrap semantics. NULL-team rows contain aggregate counts and fixed named global reasons,
   never a team's IDs, slugs, evidence or arbitrary returned/thrown error text. Preserve rethrow behavior.
   Narrowly sanitize the current global throw/meta.threw and global read-error forwarding in this leg;
   this is necessary because listRecentIngestRuns merges own-team rows with NULL-team rows.
   Fixed global read reason: `teams read failed`; fixed throw reason/meta.threw: `bootstrap threw`.
5. In the integrations page, resolve the active session membership and membership-derived viewer posture.
   Apply existing canAccessAdmin({role, tier: resolvedPosture}) before elevated Promise.all/ledger reads.
   Missing membership, non-admin, external/unknown posture and resolution failures fail closed.
   Reuse the resolved posture for existing freshness reads. Do not substitute stored members.tier.
   Preserve layout/listIntegrations defenses and denial UX; the page can return a closed leaf on denial.
6. Pulse/home also receives the changed compound via client PipelineHealthBanner props. Gate only its
   getPipelineHealth fetch with a distinct canReadPipelineHealth using existing canAccessAdmin(role,
   membership-derived me.tier from resolveTeamContext). Keep isAdmin unchanged for onboarding,
   usage/spend, metrics and LLM health. Visual 160-character clipping/dismissal does not protect full props.
7. The server panel decodes only known version-1 evidence on non-NULL access_bootstrap rows, requiring
   evidence.teamId to equal row.team_id. Validate types, UUIDs, status/count relationships and budgets;
   project only known fields. Malformed, oversized, mismatched, future-version and legacy rows fall back
   to their existing error presentation. Do not recursively dump arbitrary failed-row metadata.

The bundled authentication guide explicitly says a layout hiding/swapping children does not stop nested
segments or their RSC payloads. Admin-layout markup alone is not the privacy boundary for enriched reads.
Real HTML and RSC authorization controls below must exercise the page, not merely a mocked policy helper.
No new permission policy, RLS architecture, API/export endpoint, logging sink or cross-team lookup is added.
Fixed global reasons deliberately omit arbitrary fleet error text. Existing adapter/scheduler diagnostics
may retain details; no complete raw-diagnostic promise is added. Sibling context_backfill_all's pre-existing
raw-text behavior is an adjacent residual, outside the bootstrap-envelope producer/consumer scope.
Other existing NULL producers (graph_project sample/detail and pret3_sweep/pret4_materialize raw errors)
and successful generic RunMeta are residuals; this is bootstrap-owned privacy, not an all-ledger audit.
Home LLM health stays role-only and invited activation follows existing team context. Banner dismissal
already persists its error-containing signature in localStorage; the gate prevents new disclosure,
not historical browser-state erasure. No client-storage purge or unrelated policy change is included.

## UI behavior

Keep the current table, status, short error preview and useful error title. A recognized failed evidence
row additionally shows native `<details>` with a concise Evidence summary, closed by default.
Inside show phase status, exact total/omitted or evidence unavailable, sampled names/UUIDs, and shortening
indicators. Render strings as React text; no raw HTML, command generation, automatic repair or provider data.
Use bidi isolation for each new display label next to its UUID; do not interpolate names as commands.
The UI labels samples as samples and shortened slugs as display labels, without claiming exhaustive names.
Truncated labels cannot form repair CLI commands: operators must use the exact IDs in an authorized
administrative/DB lookup for complete slugs, then use the existing repair-system-edge CLI. No new lookup UI.
Keep unrelated successful RunMeta behavior and older failed-row behavior. Remain a server component.
Use current styles; allow wrapping within the existing table and verify narrow-view disclosure usability.

## Acceptance criteria

- **AC01 — structured transport:** A real forbidden system edge produces a failed team outcome and
  exactly one scheduler ledger row carrying matching typed evidence, exact IDs and the full finding count.
  A clean team stays ok with no new evidence. Control: remove callback metadata; the persisted-row assertion fails.
- **AC02 — independent phases:** Returned convergence failure and thrown convergence both still run
  census; returned/throw census failure records unavailable counts, while clean census records zero.
  Both failure arms survive in outcomes and actual stored errors. Control: restore census-wins merge/skip census on throw.
- **AC03 — independent error budgets:** Test long convergence/short census and long census read/throw
  error/short convergence using raw results; both named arms survive with independent 224-byte reservations,
  contextual redistributed caps, and a total 480-byte bound, including the
  actual 500-character ledger clamp. Include many raw findings without the old 200-character preclamp.
  Pin a raw-finding diagnostic sentinel after the legacy 200-character pre-label summary boundary but
  inside the new arm, using multiple pairs (the old enormous-first-pair fallback can exceed 200).
  A real lone adoption refusal with clean census round-trips its repair suffix within the larger lone cap.
  A realistic short-census/dual-refusal also retains the suffix through unused-budget redistribution.
  Controls: whole-compound clamping or restoring the legacy finding preformatter loses a required arm/sentinel.
- **AC04 — serialized bound:** Quote/backslash/control-character and non-BMP slugs, including an enormous
  first slug, produce actual serialized namespace JSON at most 8,192 bytes, at most 16 samples and
  96-byte display slugs with truthful flags. Verify the resulting real jsonb row persists with correct omitted.
  Controls: raw-string character accounting, missing final JSON measurement, and stale omitted each fail.
  A thrown convergence message containing NUL and isolated high/low surrogates persists in real JSONB
  with U+FFFD replacements in stored error/evidence; valid pairs remain intact. Removing normalization fails.
- **AC05 — deterministic samples:** Permuted inputs and equal raw slug pairs with differing IDs produce
  identical ordered samples/omitted counts; truncation does not determine order. Control: input-order sampling
  or missing ID tie-break fails. Verify top-k storage remains bounded without claiming bounded census memory.
- **AC06 — ledger compatibility/privacy:** Two teams, one failed and one clean, retain completion-time
  writes, one row per team per tick, one error contribution, separate fleet liveness, and existing zero-team/
  fleet-failure behavior. Callback throw does not abort/misattribute. Inject a tenant-marked global read/throw
  and prove NULL rows contain only safe reasons/counts. Controls: duplicate summary writes or global text forwarding.
  Non-string/getter-fault messages and an injected builder fault preserve bounded named phase/count
  failure without evidence, and later teams still complete. Removing the third guard must fail this test.
- **AC07 — reader isolation:** Real own-team-plus-NULL reader returns team A evidence and safe global
  rows while excluding team B evidence. Unknown/invalid/mismatched envelopes are not rendered as evidence.
  Controls: remove reader team filter or accept a mismatched envelope; marker assertions fail.
- **AC08 — failed-row UI:** Server-render the actual panel with failed typed evidence and verify error
  plus closed disclosure, exact/omitted counts, unavailable status, IDs and truncation flags. Hostile names
  are escaped; unrelated/legacy rows keep existing presentation. Existing access-health short-format and
  diagnosis remains useful; include unrelated pm_sync rows from the shared panel consumer. Controls:
  restore error-versus-meta ternary or dump arbitrary failed metadata.
  All five state-table cases round-trip through actual producer→real JSONB→recent reader→decoder→actual
  panel; fabricated envelopes alone are insufficient. Include boundary trim, legacy-string meta and malformed
  rejection. Assert exact wrapper measurement/last fitting sample, not accidental sample sizes.
- **AC09 — HTML/RSC authorization:** Real authenticated unrestricted admin can retrieve a seeded evidence
  marker through HTML and an actual RSC response. Anonymous, internal non-admin, external-posture admin,
  disabled member (login before disabling) and foreign-team/nonmember cannot retrieve that marker.
  Use full-payload and targeted next-router-state-tree RSC:1 requests with correct _rsc from the installed
  runtime helper/header profile; authenticated payload cases assert 200/text/x-component and expected
  nonsecret denial/route protocol, not redirect/HTML absence. Anonymous separately asserts proxy login
  redirect/destination. At most follow a same-origin _rsc correction preserving headers/cookie; never count
  its 307 as authorization evidence. Positive controls must contain the marker in each actual RSC profile.
  Record the tree and prove targeted skips the admin layout: full response has its proper Admin shell/
  Admins only sentinel, targeted does not, for admitted and denied membership personas; mismatch-driven
  full payload is not targeted proof. Marker-bearing HTML/RSC responses assert private/no-store directives.
  Include populated Pulse fixtures: unrestricted admin receives both markers, one beyond the 160-character
  preview; external admin/nonadmin/disabled/nonmember do not. Page-unit spies deny protected elevated
  integrations reads after posture resolution and deny home getPipelineHealth on restricted/faulted posture.
  Capture actual baseline/mutant transport RED; independently remove each page gate. Verify home isAdmin
  metrics/onboarding/LLM semantics unchanged. Missing genuine RSC RED is a gap, never an inferred pass.
- **AC10 — health/detector compatibility:** Existing sanctioned-edge, repair, bootstrap, ledger and
  access-health controls pass unchanged in meaning. After two failed ticks, the affected team's pipeline
  card carries both stored errors; short messages visibly name both, long legDetail raw previews retain
  the existing 160-character clip and link to the authorized disclosure. Another team remains healthy.
  Test short/long legDetail behavior; do not promise both long arms in visible card text. No duplicate confirmation.
- **AC11 — bounded display smoke:** Loopback synthetic panel preview using existing CSS supports keyboard
  expand/collapse at desktop and narrow widths with long labels; no new production route/client component.
  Record manual browser observations separately from deterministic server-markup assertions; no secrets/real data.
- **AC12 — operational documentation:** Document version/budgets, sampled/not-exhaustive evidence,
  unknown counts, existing repair workflow, own-team/NULL privacy and page-local gate. State unchanged
  best-effort writes/retention and existing full-census memory behavior; no unverified production capacity claim.
  Document literal exhaustive-name deviation and a team-bound read-only SQL join of project_groups to
  projects/groups selecting complete IDs/slugs/kind/is_builtin. Enumerate all system-project candidates,
  join both tables on team_id and ID. Only kind=system is the census domain (reserved source adoption
  is a separate guard); unresolved project/group is a finding. Sanctioned requires is_builtin plus one
  exact pair: general→everyone, external-shared→everyone, external-shared→external; general→external
  is forbidden. Identify unsanctioned candidates, then use complete slugs with the
  authorized repair-system-edge CLI. This is administrative retrieval, not a new runtime predicate/API.
  Actual repair argument order is group-slug then project-slug, with --actor and optional --team.
- **AC13 — verification/review:** Run appropriate unit, real-PG and production HTTP suites plus typecheck,
  changed-file lint and docs checks. Retain baseline/new RED, canonical GREEN and intended mutation failures
  with exact source/spec provenance. Fresh Opus/Astra reviews have no unresolved HIGH/blocker before publication.
  HTTP runs record effective non-secret poller settings, source/diff fingerprint and .next/BUILD_ID;
  fresh canonical build is mandatory. INGEST_POLL_ENABLED=false prevents ingestion overwriting fixtures;
  GRAPH_PROJECT_ENABLED=false/no GRAPHITI_URL and SOCIAL_JOBS_ENABLED not true keep other pollers inert.
  Verify actual controls, not unrelated SOCIAL_AUTORUN naming. Production policy is unchanged for tests.

## Implementation sequence and verification tiers

First attach the agreed exact spec, then write spec-first failing unit/PG/HTTP controls (without production
test hooks). Implement the pure builder and raw-result bootstrap seam, then callback transport/global privacy,
then validated disclosure and the page-local gate. Preserve one writer; add docs last and review a frozen diff.
New files to create:

- New file to create: `lib/access/bootstrap-evidence.ts` (pure typed builder/decoder).
- New file to create: `test/bootstrap-evidence.test.ts` (unit budgets/grammar/normalization).
- New file to create: `test/datamechanics/bootstrap-evidence.datamechanics.test.ts` (real ledger mechanics).
- New file to create: `test/http/bootstrap-evidence.http.test.ts` (production HTML/full/targeted RSC).
- New file to create: `test/integrations-page-access.test.ts` (protected read ordering).
- New file to create: `test/home-pipeline-access.test.ts` (narrow home health admission).
- New file to create: `docs/design/auditfix25-bootstrap-evidence.md` (durable accepted design).

Extend `test/ingest-runs-panel-meta.test.ts`; reuse datamechanics helpers, real HTTP login/session fixtures
and existing census/bootstrap-ledger/ingest-runs/system-edge-repair/access-health cases.
Safety tier: permission/privacy change; real PG is required for ledger/isolation/counts and production
HTTP for HTML/RSC. Mock-only success is insufficient. Functional local PG may use fsync off, disclosed
without durability/performance claims. No capacity benchmark or live production query is required.
Already verified baseline: 5 targeted unit files / 25 cases and 6 PG files / 70 cases passed on unchanged
base; these are baseline provenance, not new acceptance evidence. All new acceptance remains pending.

## Rollout and limitations

Additive optional metadata requires no migration; old rows remain readable and future versions fail closed.
Create-time API-trigger bootstrap rows from lib/admin/teams.ts remain unenriched/legacy-compatible;
up to 8 KiB metadata per failing team per tick plus existing row/error overhead accumulates under unchanged
retention. This slice adds no pruning guarantee.
The existing source-diversity cap can fill remaining slots, so a 30-row panel can contain more than15
bootstrap rows; collapsed evidence is still transmitted. No lazy-fetch/page-weight reduction is claimed.
Mixed application versions can omit evidence or retain old page behavior, so do not claim rollout-complete
privacy until serving replicas carry both reviewed page gates. Existing census/repair permissions are unchanged.
Sample omission and error shortening are explicit; this is not an exhaustive evidence export or audit archive.
Best-effort ledger write failures can still lose rows; a bounded payload does not make persistence guaranteed.
No unresolved product decision is evident. Revisit only if the user changes the default collapsed presentation.
