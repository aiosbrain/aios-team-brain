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
 *        (graph legs omitted, §5.8b) regardless of `teams.access_enforcement`; delegated
 *        queries are stateless — `conversation_id` answers 422, no thread is read or
 *        written; rate limits and cost metering attribute to the launching member. The
 *        Phase A 403 `delegation_not_supported` is retired for this route. Member `aios_*`
 *        keys are byte-for-byte unchanged.
 * 1.20 — POST /api/v1/items payload limits become explicit and STRICTLY MORE PERMISSIVE (AIO-923).
 *        `rows` is bounded at 5,000 per payload (`MAX_PAYLOAD_ROWS`) on every row-bearing kind, and
 *        the whole-request transport gate is raised from ~1.2 MB to ~4.2 MB so 5,000 rows actually
 *        fit. `body` stays capped at 1 MB. Net effect for a client: a push that used to die at
 *        ~1,100 rows on a bare `413 payload_too_large / "max 1 MB"` now succeeds, and a push that
 *        genuinely exceeds the ceiling gets a `422 invalid_payload` naming `rows` and the limit.
 *        No request that was accepted before is rejected now, so no client change is required and
 *        an old client against a new server is unaffected; a NEW client sending >1.2 MB against an
 *        OLD server still gets the pre-1.20 413, which is the same failure it already handled.
 */
export const BRAIN_API_VERSION = "1.20";

/** Server-only Executor gateway negotiation; independent of the member API surface. */
export const GATEWAY_CONTRACT_VERSION = "1.10";
