---
eval_tier: deterministic
spec_gate: block
---

# AUDITFIX-17 — bound codebase scan requests

Status: accepted, 2026-09-07. Brain task **AUDITFIX-17**;
projected Linear ticket **AIO-1136**. Phase A remediation Lane B item 17 only.
Baseline: `0006d51f798deebdd008855767de9498ab88b048` (`origin/staging`, after Lane A PR #694).
Governing parent: `docs/specs/project-context-classification-v1.md` (internally V2) and
`docs/design/phase-a-remediation-plan.md`. Implementation follows accepted spec and SPEC_READY.

**Build-with:** Opus / high. Astra owns spec decisions; Fable reviews spec and code; fresh Astra /
high performs final code review. The CLI gate is explicitly deterministic
(`--no-llm`); substantive Astra/Fable reviews run separately and remain required.

**Deps:** Lane A PR #694 is already merged into staging. Before server implementation, prepare
and review the canonical contract edit and supplement in the isolated companion worktree; a
companion merge is not required before local implementation. Canonical contract merges to staging
before the brain merges to staging. Companion remote staging setup is a publication prerequisite
owned by the coordinator, not a blocker to local spec/contract preparation.

## Scope and outcomes

Bound admission at `POST /api/v1/codebases`, preserve ordinary scans and existing auth/rate behavior,
and prove whole-request rejection before scan writes. Deliver the reader, schema cap, focused
boundary/HTTP/sidecar tests, canonical admission supplement and architecture documentation.

Deferred: Lane B items 14/18, scheduler/reconcile hooks, access semantics, other ingestion loops,
and a fleet concurrency allocation. A named **Wave 3 cross-route request-admission follow-up
(unfiled)** owns the same header-only pattern in `app/api/v1/items/route.ts`,
`app/api/v1/metrics/route.ts`, `app/api/v1/costs/route.ts`, and
`app/api/v1/subscriptions/route.ts`; coordinator records that destination in the remediation plan.
No existing AUDITFIX key is assumed for that follow-up. Do not retrofit those routes here.

## Re-derived problem and precedents

The scanner is bounded: `ingestion/aios_ingest/analyzers/codebase.py:309` appends only while
`len(recent) < 20`. The old line-159 citation is stale. Changing the scanner is unnecessary.
The HTTP boundary is not bounded equivalently: `lib/api/schemas.ts:348` accepts an arbitrary
`metrics.recent_commits` array. `app/api/v1/codebases/route.ts` is the only production caller of
`ingestCodebaseScan`; a valid team-posture API key can bypass the scanner. The ingest owner
writes the codebase and metrics before projecting each commit through `ingestItem` synchronously
(`lib/codebases/ingest.ts`, `lib/codebases/commits-to-items.ts`). This is an admitted-work issue,
not evidence that the scanner emits unlimited commits or a measured denial-of-service incident.

The route currently rejects only `parseInt(Content-Length) > 2_000_000 * 1.2` and then calls
`req.json()`. Its effective declared-length ceiling is **2,400,000 bytes**, despite saying
“max 2 MB.” Missing length defaults to zero, so a chunked body can pass the check without a
body bound. Both gaps remain at this baseline. Contributions and issues already have separate
5,000-element caps; their algorithms are outside this slice.

Precedents constrain this decision:

- `lib/gateway/http.ts:readGatewayJson` counts stream `Uint8Array.byteLength` before parsing.
  Reuse the technique, not its gateway-specific status codes, strict UTF-8 or encoding policy.
  The installed Next route guide confirms Route Handlers use the standard Web Request API;
  Pages Router `bodyParser` configuration is inapplicable.
- `lib/api/item-payload-schema.ts` puts a diagnosable wire count limit before storage work.
  Its 1.20 change narrowed formerly accepted requests while remaining on `/api/v1`.
- `docs/design/auditfix2-writer-inventory-guard.md:213` records 205 historical pushes and a
  maximum of 100 “items,” but its original measurement query/producer is not established here;
  the route's run `updated` field counts contributions, not recent commits. Do not treat that
  historical number as proven recent-commit cardinality. Choose **100** as explicit engineering
  headroom, five times the current scanner's 20, while making direct-client amplification finite.
  Current scanner compatibility is supported; arbitrary direct-client compatibility and safe
  runtime duration are not measured. This is not a fleet concurrency allocation.
- The same document §6b deliberately declined post-response reconciliation. This fix does not
  reopen it. Items 14/18, new reconcile hooks, scheduler behavior, writer inventory, and access
  semantics remain separate work.

## Decision and wire behavior

Scope is `POST /api/v1/codebases` only. Use named immutable constants for the two bounds and
one small bounded-JSON reader under `lib/api/` (or route-local equivalent). Do not retrofit
other endpoints or alter the shared gateway reader.

| Boundary | Inclusive limit | Failure |
|---|---:|---|
| `metrics.recent_commits` | 100 array elements, counted before normalization/deduplication | `422 invalid_payload` |
| Request body exposed by `Request.body` | 2,400,000 bytes, including JSON syntax, whitespace and unknown fields | `413 payload_too_large` |

The commit array remains required and accepts zero elements. Existing commit-object validation,
optional analytical fields, unknown-field behavior, and the rest of the payload remain unchanged.
Count all elements, including duplicate SHAs or objects without a usable SHA: downstream skipping
must not be an input-budget escape. Reject the entire request; never silently truncate it.
Apply the count cap to `codeMetricsSchema.recent_commits`, which is consumed by the HTTP payload
schema. There is no production in-process reparse requiring the separate wire/storage factory
used by `/items`; do not introduce one without a demonstrated caller.

Use the existing error envelope. Specify these messages so the route's first-issue-only response
still identifies the field, ceiling and recovery:

- Count: `metrics.recent_commits: at most 100 entries per scan; send a complete scan with a smaller recent-commit window; do not split a snapshot across pushes`
- Bytes: `body: at most 2400000 bytes per scan; reduce the scan payload and retry; do not split a snapshot across pushes`
- Invalid JSON, empty body, or body-read failure: existing `422 invalid_payload` / `body must be JSON`.

The exact count message is required when count is the payload's only schema violation. If an
array element or another field also violates the existing schema, the existing first-issue message
may win; the request still returns `422 invalid_payload` before ingest. Do not add a duplicate
raw-array precheck just to reorder multiple validation errors.

The complete scan and full aggregate metrics remain required. Reducing recent-commit detail must
not change full-window aggregate counts or remove required metrics. Do not offer batching as
recovery: the same `(codebase_id, head_sha)` upsert replaces the metrics snapshot. For oversized
non-commit detail, the producer must reduce optional detail or source scope coherently and retry
one complete snapshot. Neither 413 nor 422 is transient; the existing sidecar already raises
`BrainError` without retrying these statuses. Preserve its 429/5xx retry behavior.

## Stream algorithm, precedence, and side effects

Preserve this order: authenticate → team-posture check → existing rate limit → bounded body
read → JSON parse → complete schema validation → ingest → scan-run recording. Thus 401, 403,
and 429 retain precedence, existing rate bucket and `Retry-After`; do not consume the body on
those paths. An oversized body takes precedence over malformed JSON/count validation once
body admission begins.

A syntactically decimal, nonnegative Content-Length greater than the cap MUST reject early.
It is only an optimization. Missing, invalid, or misleading low declarations cannot bypass the
stream counter; ignore an unusable declaration at application level and measure actual bytes.
Do not add a new Content-Length syntax error contract. HTTP parsers may reject malformed wire
framing themselves; unit Requests, not contradictory real-socket framing, test spoofed headers.

Read chunks once, sum each chunk's **byteLength before storing/decoding it**, and stop when the
sum exceeds the cap. Never call `req.json()`, `text()`, or `arrayBuffer()` first and check later.
On overflow, stop application reads, release the reader lock, and return 413 without cancelling
the request body or waiting for EOF. Release the lock on success/read failure too. Do not retain
the crossing chunk in the accumulator or JSON-parse the oversized prefix. The HTTP runtime owns
unread-body/connection cleanup and may drain remaining bytes; the application reader does not.
A chunk may already be larger than the cap when supplied by the platform; this bounds application
retention, not upstream allocation, total bytes sent, or the size of one delivered chunk.

This release-only choice removes unnecessary cancellation lifecycle handling. Adapter-level
loopback diagnostics using the installed NextRequestAdapter on Node 20 and 25 returned JSON 413
for awaited cancellation, unawaited cancellation and release-only variants. Node's stream destroyer
detaches a server request's socket before destroying it. These observations cover the adapter
path; AC17-06 still proves the full `next start` response path and must not be replaced by the
adapter diagnostic.

Currently `proxy.ts` excludes `/api/`, so Next middleware's clone/prebuffer path does not run for
this endpoint. If that matcher changes, the installed Next clone-size truncation behavior must
be considered and the real-socket 413 test retained. The app cap is below the current default
10 MB clone ceiling. Production proxy limits/buffering remain unmeasured.

At EOF within the cap, combine/decode using Web Request JSON-compatible UTF-8 behavior and
parse once. Count raw bytes, not JavaScript character count or decoded/re-encoded text; split
multibyte characters across chunks must round-trip. Preserve ordinary `Request.json()` decoding
semantics (including UTF-8 replacement behavior and BOM handling), avoiding an unrelated new
strict-decoder rejection. Empty/read-failed/invalid JSON returns the existing 422. No new request
compression feature or Content-Encoding policy is introduced: count the bytes the platform
exposes, and invalid compressed JSON follows the existing malformed-body path.

“No writes on rejection” means **no scan-domain writes**: do not enter `ingestCodebaseScan`,
project commits, reconcile finding state, emit `codebase.scanned`, or call `recordIngestRun` for
body/count rejection. This preserves the current pre-validation boundary. It is not a claim of
zero database mutations: authentication already marks `api_keys.last_used_at` and can audit
failures, and rate limiting already writes its bucket. Preserve those operations. Rejection is
diagnosed to the caller through 413/422 and leaves no scan-source `ingest_runs` row; that existing
operational visibility limitation is deliberate and new rejection telemetry is out of scope.

## Contract seam and compatibility decision

The primary workspace checkout is dirty and stale (doc 1.14). The authoritative read-only
snapshot of its remote main at `f3c5f764715c3b803d8cfc7c9c0891e3e3122c18` says member API 1.24,
whereas this brain implements/pins 1.23. Revision 1.24 adds scanner identity semantics outside
this slice. Do not silently claim those semantics by bumping `BRAIN_API_VERSION` to 1.25.

A new count cap changes accepted requests; documenting only an implementation tweak would be
false. The canonical policy broadly asks for `/v2` for breaking semantics, but the published
1.20 row-cap tightening is a directly relevant exception in practice. The canonical 2026-06-19
same-route full-metrics requirement is an even closer dated tightening without a version bump.
Make the exception explicit:
a versioned, diagnosed resource-admission limit may harden an existing v1 endpoint while keeping
its successful payload/response semantics. This is an intentional narrowing for oversized direct
callers, not a claim that every old request still succeeds.

Minimal cross-repo change: create canonical
`aios-workspace/docs/contract/codebase-request-limits-v1.json` (new file) and vendor identical bytes
as `test/fixtures/contract/codebase-request-limits-v1.json` (new file), with a SHA-256 pin.
Use `kind: aios-codebase-request-limits`, supplement `revision: 1`, method/path,
`memberApiMajor: 1`, `appliesFromMemberApiVersion: "1.23"`, `maxBodyBytes: 2400000`,
`maxRecentCommits: 100`, and error statuses/codes/messages. This covers subsequent member 1.x
revisions until explicitly superseded/withdrawn, not `/api/v2`; do not use a finite version list
or a non-URI `$schema`. Include independent boundary cases: count 0/20/100 admitted, 101 rejected;
byte limit/exceeded behavior. Cases assume other payload constraints pass.

The canonical brain-api doc receives a dated AUDITFIX-17 revision entry, the resource-hardening
policy exception and endpoint limits/recovery, explicitly naming this separately versioned
supplement. Preserve historical schemas/fixtures in their owning repos; Brain currently vendors
and pins only the 1.23 payload artifacts. The effective contract is the existing payload shape
plus this admission supplement; old valid fixtures must still pass. Keep server
`BRAIN_API_VERSION=1.23`, existing `test/fixtures/contract/brain-contract.json`, and canonical member
feature version 1.24 honest; no parallel negotiation header or runtime version switch.

A conformance guard must run the actual schema against generated boundary payloads using literal
expected 100/101 cases and the pinned supplement, and reader/route tests must exercise literal
2,400,000/2,400,001-byte inputs. Comparing exported constants to themselves is insufficient.
Update `docs/ARCHITECTURE.md` in this PR to describe the admission supplement and bounded codebase
flow. Do not imply a full member-version upgrade. Companion contract edits must exist and be
reviewed locally before server implementation; merge the canonical contract before the brain.
All PR targets/merges are staging; companion remote staging setup gates publication only and is
coordinator-owned. Do not require canonical merge before local code work.

## Acceptance matrix

These IDs are stable. Tests are written from these outcomes before implementation, and the
regression tests must fail against baseline for the intended reason. No database/test execution
is claimed by this specification.

- **AC17-01 — commit count:** Valid 0, 20 and 100 element arrays are accepted; 101 otherwise
  valid elements return the exact named count 422. Duplicate/skip-worthy elements still count.
  A separate schema violation may supply the first error message but still returns 422 before
  ingest. Prove through pure schema boundary tests and supplement conformance; retain analytics
  validation tests.
- **AC17-02 — bytes:** Exactly 2,400,000 bytes are admitted; 2,400,001 returns the exact 413.
  Missing/low length cannot bypass; high valid declaration rejects without consuming the body.
  Prove with reader/route tests using UTF-8 byte-sized valid JSON, including whitespace padding.
- **AC17-03 — early return:** Overflow stops application reads, does not parse/retain the
  crossing chunk, releases the reader lock and returns 413 without waiting for EOF or cancelling.
  Reader tests use remaining queued data and a source that stays open after crossing the limit;
  observe response completion/read calls and unlocked stream. Runtime cleanup may read/drain.
- **AC17-04 — decoding:** Multibyte UTF-8 split across chunks round-trips; byte count wins over
  character count; ordinary replacement/BOM behavior is preserved; malformed/empty/read-failed
  body returns existing 422. Prove with reader tests against Web Request.json reference behavior
  and literal byte boundaries, including lock release on read failure.
- **AC17-05 — existing outcomes:** 401/403/429 preserve precedence, no body reads or ingest,
  and 429 Retry-After; accepted requests retain the 201 envelope. Route tests may mock auth,
  rate limiting and ingest for orchestration; existing rate-limit tests remain green.
- **AC17-06 — real rejection:** An authenticated real-socket chunked body above the byte limit
  receives application JSON 413; a bounded 101-valid-commit request receives named 422. Neither
  creates/changes scan-domain state. Use production `next start` and isolated real Postgres,
  Node HTTP chunks without Content-Length, and the scoped before/after inventory below.
- **AC17-07 — recovery and persistence:** A corrected complete scan succeeds after rejection;
  all 100 unique valid commits persist as items and in the recent_commits snapshot; prior accepted
  state survives invalid replacement. Same HTTP/DB suite: accepted seed → rejected replacement →
  unchanged exact rows → corrected new scan; verify item paths/snapshot and no partial success.
- **AC17-08 — contract:** Shared supplement/pinned bytes agree with actual acceptance behavior;
  historical valid fixtures remain accepted; API versions remain truthful. Contract guards and
  companion tests check digest plus literal boundary behavior, not constants-only equality.
  Canonical documentation includes the coordinated rollback procedure below.
- **AC17-09 — caller recovery:** Sidecar 413/422 retain the new status/code/message without retry;
  existing 429/5xx behavior survives. Use focused MockTransport error cases and existing retry
  tests. Scanner max20 is premise evidence only, not a lasting acceptance cap or a new temp-git
  test requirement; a future scanner can widen within the admitted100.

For AC17-06/07, use a fresh seeded team, real API key, unique repo slugs/commit SHAs, and snapshot
before/after rows scoped to that team/codebase: `codebases`, `code_metrics`, `code_contributions`,
`github_issues`, `codebase_findings`, `codebase_finding_events`, `items`/`item_versions`, and scan-source
`ingest_runs`. Include transitive commit ingestion state: team `projects` (including
`last_synced_at` and `graph_group_id`), `project_context_units`, `project_context_memberships`,
`codebase.scanned` audit rows and target-scoped `item.*` audit rows. When no target IDs existed
before rejection, scope by the dedicated test team's item audit actions so unexpected new IDs
cannot escape the comparison. Include both rejected new slug and existing
snapshot replacement; the accepted control proves the DB assertions are not vacuous. Route spy
tests prove ingest/run functions are never entered; real DB equality proves persisted outcome.
Use allowed auth/rate mutations as explicit exceptions, not a failing whole-database snapshot.

## Verification and rollout limits

Implement and test only after the accepted Astra/Fable spec review and SPEC_READY, with canonical
contract edits prepared/reviewed first locally. Required verification: targeted
unit/contract tests; focused Python tests; real-socket HTTP cases backed by isolated Postgres;
TypeScript/lint and docs drift checks appropriate to touched files. The current HTTP harness boots
`next start` against a prebuilt `.next`; configure this worktree's test DB/port independently and
never run shared destructive DB reset during parallel work. One HTTP suite provides persistence
proof here; an extra FakeSupabase or duplicate data-mechanics suite is unnecessary.

No schema migration, new writes, background jobs, timeout promise, or request concurrency policy.
Merge the companion contract first and brain enforcement second, both to staging. Review staging
before any later promotion; never merge directly to main. A complete rollback is coordinated:
first publish an explicit withdrawal/superseding resource revision and canonical doc update that
removes this supplement's normative applicability, accepting the temporary stricter-server period;
then revert server enforcement and update its vendored supplement/pin to the withdrawn/superseding
canonical state. Do not silently rewrite revision1 history or leave a live normative100 cap while
the server accepts101. A standalone emergency brain revert is temporary contract non-conformance,
not completed rollback; record and repair it. Removing enforcement reopens the resource exposure;
no data repair is needed for requests rejected before ingest. Existing accepted scan failures
remain non-transactional behavior outside this admission fix.

Unmeasured: current fleet payload/count distribution, peak memory and latency at100 commits,
production proxy prebuffering/upstream limits, and concurrency across keys. Current Next adapter
behavior and proxy matcher have source/diagnostic evidence above; real-socket full-server tests
remain required and do not prove Railway proxy behavior. Report any runtime rejection earlier
than the application as such. Neither historical ambiguous max100 nor the chosen headroom is a
benchmark, timeout guarantee or bound on total fleet work.
