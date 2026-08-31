/**
 * The brain-api contract version this server implements.
 *
 * Source of truth for the wire contract is `aios-workspace/docs/brain-api.md` (the pinned
 * sync contract shared by the workspace CLI/MCP and this server). This constant is the
 * single server-side declaration of which contract version the implementation targets —
 * keep it in lockstep with that document and with `docs/ARCHITECTURE.md`.
 *
 * Guarded by `test/guards/contract-version.test.ts` (asserts shape + agreement with the
 * architecture doc). Bumping the contract = bump this constant + the doc in the same PR.
 *
 * WHAT THE GUARD CANNOT SEE: it checks that this constant AGREES with the doc's "implements
 * brain-api vX.Y" sentence. Both can be stale together. 1.14 shipped in review with a new request
 * param, a new response field and a 200→400 change, while this still said 1.13 and the guard was
 * green — a wire change is invisible to a consistency check between two things the same edit
 * forgot. Changing the wire is the trigger to bump; the guard only stops the two drifting apart.
 *
 * 1.14 — `GET /api/v1/tasks?mode=table&keys=A,B`: the by-key lookup + `unknown_keys`.
 * 1.15 — POST /api/v1/codebases accepts the optional, provenance-only
 *        `metrics.codebase_health` object (AIO-609; persisted verbatim, never recomputed).
 * 1.16 — documents the already-shipped GET /api/v1/attribution and GET /api/v1/timeline
 *        reads; contract alignment only, with no runtime or wire-shape change (AIO-718).
 * 1.17 — accepts codebase_health v2 with epistemic state, repository capability profile,
 *        fail-closed maintenance admission, and a redacted normalized finding ledger (AIO-610).
 * 1.18 — ADDITIVE: delegated agent tokens (`aiosd_<token_id>_<secret>`, spec §10 / PCCA-2).
 *        Phase A surface: GET /api/v1/items accepts them (oracle-filtered to the token's
 *        effective project set); POST /api/v1/query answers 403 `delegation_not_supported`;
 *        every other route rejects the prefix (401). Existing `aios_*` member keys are
 *        byte-for-byte unchanged — an old server rejects the unknown prefix with today's
 *        401, so no version negotiation is required.
 * 1.19 — POST /api/v1/query accepts delegated `aiosd_*` tokens (Phase B slice 3, spec
 *        §10/§17-B): retrieval is ALWAYS attenuated to the token's live effective set
 *        (graph legs omitted, §5.8b) unconditionally (the rollout flag retired in PRET-6); delegated
 *        queries are stateless — `conversation_id` answers 422, no thread is read or
 *        written; rate limits and cost metering attribute to the launching member. The
 *        Phase A 403 `delegation_not_supported` is retired for this route. Member `aios_*`
 *        keys are byte-for-byte unchanged.
 * 1.20 — POST /api/v1/items payload limits become explicit and, for every realistic client, MORE
 *        PERMISSIVE (AIO-923). `rows` is bounded at 5,000 per payload (`MAX_PAYLOAD_ROWS`) on every
 *        row-bearing kind, and the whole-request transport gate rises from 1.2 MB to 5.4 MB
 *        (`MAX_REQUEST_BYTES` = (1 MB + 5,000 x 700 B) x 1.2) so 5,000 rows actually fit. `body`
 *        keeps its independent 1 MB cap. Net effect: a push that used to die at ~1,100 rows on a
 *        bare `413 payload_too_large / "max 1 MB"` now succeeds, and a push that genuinely exceeds
 *        the ceiling gets a `422 invalid_payload` naming `rows` and the limit.
 *        HONEST EDGE: this is not a pure superset. >5,000 rows that were COMPACT enough to fit the
 *        old 1.2 MB gate (~60-130 B/row minimal rows) were accepted before and now 422. That window
 *        is narrow and the new failure names its cause, where the old one did not; the alternative
 *        (no row bound) leaves the opaque 413 in place. A NEW client sending >1.2 MB to an OLD
 *        server still gets the pre-1.20 413 — the failure it already handles — so no negotiation is
 *        needed. The cap is WIRE-ONLY: `ingestItem` re-parses with the uncapped storage schema, so
 *        the in-process Linear/GitHub/Plane mirrors (up to 20,000 rows) are unaffected.
 * 1.21 — the canonical task status set gains `in_review`, between `in_progress` and `blocked`
 *        (AIO-950; aios-workspace PR #603). The WIRE SHAPE is unchanged — `rows[].status` is still
 *        a free `string(120)` the server folds via `normalizeTaskStatus` — so this adds a
 *        normalization TARGET and rejects nothing that used to be accepted. Two observable effects:
 *        (1) a Linear state NAMED "In Review" (type `started`) now resolves by name to `in_review`
 *        instead of falling through to its type as `in_progress` — fidelity that was previously
 *        discarded, and unrecoverable because the adapter canonicalizes before ingest so
 *        `raw_status` was written NULL; (2) a client pushing the literal `"In Review"` now lands on
 *        `in_review` rather than `backlog` + `raw_status`. Additive for any reader that treats
 *        status as an opaque string; breaking only for one that hardcodes the five-member list —
 *        which is why the workspace's own `CANONICAL_TASK_STATUSES` mirror moved in the same window.
 *        NEEDS A MIGRATION: `tasks.status` is the `task_status` ENUM
 *        (postgres/migrations/20260819180000_task_status_in_review.sql).
 * 1.22 — ADDITIVE: POST /api/v1/codebases `metrics` gains six optional, nullable raw measures so
 *        a coverage percentage arrives with the scope it was measured over and a degraded test
 *        run announces itself (AIO-995). `test_coverage_lines_total` /
 *        `test_coverage_lines_covered` are the coverage denominator (instrumented lines, and how
 *        many were hit); `tests_total` / `tests_passed` / `tests_skipped` / `tests_failed` are the
 *        run-integrity counts. Every one defaults to null, so a pre-1.22 scanner is byte-for-byte
 *        unaffected and an older brain ignores the unknown keys. NULL MEANS UNKNOWN, NEVER ZERO —
 *        the same rule `test_coverage_pct` already carries. The brain derives and persists
 *        `coverage_breadth_pct` from `test_coverage_lines_total / loc`; it is displayed and
 *        deliberately NOT folded into agentic_score/health_score yet (rationale in
 *        lib/codebases/score.ts).
 *        NEEDS A MIGRATION: seven new columns on `code_metrics`
 *        (postgres/migrations/20260820140000_code_metrics_coverage_denominator.sql).
 * 1.23 — ADDITIVE: recent commits may carry a versioned Conventional Commit classification and,
 *        for fixes, counts-only first-parent line-blame evidence (AIO-1073). The brain validates
 *        numeric coherence, persists the observations, and derives debt mix, age, coverage, and
 *        fix-on-fix KPIs without accepting source paths or excerpts. Legacy commit objects remain
 *        valid; no database migration is needed because recent_commits is already JSON.
 * 1.24 — ADDITIVE: POST /api/v1/codebases `metrics` gains two optional, nullable scanner-identity
 *        fields — `scanner_version` (the ingestion package build, `aios_ingest.__version__`) and
 *        `scanner_sha` (the aios-team-brain commit it ran from, provenance only) — so a scan
 *        declares WHICH SCANNER BUILT IT (AIO-1011). The brain persists both verbatim and derives
 *        a `current` / `stale` / `unknown` reading from `scanner_version` alone, against the
 *        contract's declared `codebasePayloadContract.minScannerVersion` (0.2.0 at this revision).
 *        WHY: 1.22's coverage denominator shipped and never arrived. All seven consuming repos
 *        pin the scanner to an exact commit in their own `.github/scripts/fetch-brain-scanner.sh`
 *        (a deliberate supply-chain control), and all seven were pinned to a build predating the
 *        field. Every scan returned 200, nothing went red, and the dashboard showed an
 *        unexplained `(scope unknown)` for the whole fleet until a human noticed. The pin is not
 *        the defect; the absence of staleness DETECTION is.
 *        NULL MEANS UNKNOWN, AND SPECIFICALLY "PREDATES 1.24" — never "current". Every row
 *        already in `code_metrics` is in that state and cannot be backfilled, so unknown is the
 *        COMMON state and is rendered as a caveat, not a pass.
 *        NEVER A REJECTION: both fields are typed as a bounded string with no pattern, and an
 *        unparseable value normalizes to unknown at READ time. A 422 would drop the repo's entire
 *        scan and return before the ingest run is recorded, so the failure would not even be
 *        logged; provenance can never be worth that.
 *        Staleness is a DECLARED MINIMUM, not a commit distance — commit distance is undefined
 *        across branches and forks, needs a git history the brain does not hold at runtime, stops
 *        existing when the scanner ships as a package, and says nothing about whether anything
 *        the contract needs actually changed. The cost: raise `minScannerVersion` in the same PR
 *        as any revision requiring new scanner output, or detection is silently off for it.
 *        NEEDS A MIGRATION: two new columns on `code_metrics`
 *        (postgres/migrations/20260831120000_code_metrics_scanner_identity.sql).
 */
export const BRAIN_API_VERSION = "1.24";

/** Server-only Executor gateway negotiation; independent of the member API surface. */
export const GATEWAY_CONTRACT_VERSION = "1.10";
