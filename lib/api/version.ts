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
 */
export const BRAIN_API_VERSION = "1.3";
