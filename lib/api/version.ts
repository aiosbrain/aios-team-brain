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
 */
export const BRAIN_API_VERSION = "1.14";

/** Server-only Executor gateway negotiation; independent of the member API surface. */
export const GATEWAY_CONTRACT_VERSION = "1.10";
