F4 is implemented in the two owners and covered in the three focused tests, but nothing has been executed: no tests, typecheck, lint, RED run, or mutants, per your constraints. I read only the manifest's listed inputs and touched no docs, UI, PR714, Plane/project sources, or Git.

## Production change
- **`lib/pm-sync/reconcile.ts`**: `ReconcileResult` gains optional `notRunReason?: "integration_unavailable"`. The combined early return is split, so the marker is set only when a provider is named and its integration is null. Null-provider, Plane-unsupported, no-link, and resolved returns are unchanged and unmarked.
- **`app/t/[team]/admin/pm-sync/actions.ts`**: after the existing null-provider refusal and before `audit`/`revalidatePath`, the marker returns exactly `{ ok: false, error: "primary PM integration is unavailable" }`. `projectBoardAction`, the success DTO, and the audit fields are untouched.

## Tests
- **Native action fixture** (`aio1217-pm-reconcile-action-native…`):
  - Case 4 covers the six cells (Linear/Plane × missing/disabled/secret-less), each seeded with eligible links, a usable other-provider integration in the acting team, and a usable same-provider integration in the other team.
  - Each cell asserts ADM refusal first, the owner's exact five-key answer, the two-key DTO, a whole trace with no link read, provider request, audit, or revalidation, an empty durable diff, and an identical repeat.
  - Cases 5–8 pin the preserved branches: Linear no-link, Plane unsupported with and without links, both null-provider reasons, and the sole-enabled fallback for Linear and Plane.
  - The existing `admit` helper now also asserts the owner's key list, so a marker present as `undefined` on a success path fails.
- **Owner test** (`reconcile-divergence…`): `toStrictEqual` on the six marked cells, plus unmarked no-link, Plane-unsupported, fallback, and both null-provider results.
- **Unit test** (`aio1217-admin-operations-auth…`): new group R covers the marked refusal for both providers, three unmarked results still reported as success, and both null-provider refusals.

The header and TODO text in the native and unit files were updated to match the new line numbers and to list the F4 RED and mutant runs as still owed.

## Things to check when you run it
- **Fixture assumptions outside the read list:**
  - `integrations.status` accepts `'disabled'`.
  - `secret_ciphertext` can be nulled on an enabled row.
  - `upsertIntegration` accepts a `plane` row with an invented workspace/project config.
  
  In the native fixture a wrong guess fails as a labelled `FIXTURE PREMISE`; in the owner test it fails as a plain readback assertion in `seedIntegration`.
- **`seedWorld` refactor**: I split its team/cast/project setup into a new `seedStage()` and added an optional `{ primary: "unset" }` argument. Cases 1–3 should behave as before, but this is the one place I restructured existing code rather than only adding to it.
- **Two pins beyond the brief**, both in group R:
  - `projectBoardAction` still returns success for a named provider with no usable integration (residual R2, labelled "pinned as current, not endorsed").
  - A named provider carrying the unusable-integration reason but no marker is still reported as success, so the action cannot key off reason text.
  
  Drop either if you would rather not pin them.