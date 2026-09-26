# MCP next release: proposed contract companion

Status: proposed specification, not an implemented server capability. Tracking authority:
[AIO-1185](https://linear.app/je4light/issue/AIO-1185), under
[AIO-1108](https://linear.app/je4light/issue/AIO-1108).

The normative supplement and machine-readable schemas live in
`aios-workspace/docs/contract/mcp-next-v1/`. Brain vendors its JSON artifacts in
`test/fixtures/mcp-next-v1/`; the manifest records their SHA-256 hashes. Edit the
canonical Workspace artifacts first, then copy the exact bytes and regenerate the
manifest. These files specify future behavior; passing their tests does not prove
that Brain routes implement it.

## Version boundary

At the inspected Brain base commit `5b9400e74ff9b470682b785dcd33366cfbd74172`,
`BRAIN_API_VERSION` and the existing conformance fixture declare **1.23**, while
the canonical Workspace contract declares member API **1.27**. That pre-existing
discrepancy is recorded, not resolved by declaring unimplemented capabilities.
The proposed supplement has its own version **1.0.0**. It does not change the
runtime version constant, existing fixture, or member endpoint behavior. Reconcile
the implemented member contract with evidence before release; a documentation
revision or fixture copy alone cannot establish runtime compatibility.

## Implementation seams

- `lib/actions/index.ts` is the policy/action lifecycle seam. Its existing
  request and camelCase result are a legacy contract, distinct from the proposed
  versioned envelope. New authorization, replay, durable recovery, and status
  retrieval require implementation and executable acceptance under AIO-1186.
- `lib/actions/handlers.ts` currently uses `note.create` for path-based deliverable
  ingestion. It must not silently interpret the new append-only note request as
  that legacy operation. The existing `code.run` handler is outside the launch
  MCP action allowlist.
- Shared decision and task services must preserve domain authorization,
  project visibility, server-derived attribution, and provenance used by the
  read surfaces. API policy permission is not a substitute for those checks.
  The existing approval resume path does not establish the proposed live
  authorization guarantees.
- Task feeds and ingestion currently lack the proposed revision protocol.
  The four-field reconciliation and provider outcomes are future contracts,
  not guarantees conferred on existing ingestion by these fixtures.

## Validation and rollout

`test/guards/mcp-next-contract.test.ts` checks the vendored manifest, compiles
the proposed schemas, and executes the valid/invalid shape vectors. Workspace
owns the canonical contract checks and cross-repository byte comparison.
Implementation issues must add runtime authorization, concurrency, fault,
and recovery tests; shape vectors cannot validate these behaviors.

No migration, feature enablement, or deployment is part of this companion.
Reverting the companion leaves runtime behavior unchanged. Candidate acceptance
and public artifact verification remain separate gates in AIO-1195 and AIO-1196.
