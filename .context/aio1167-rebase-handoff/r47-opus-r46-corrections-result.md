# AIO-1167 R47 writer result — Astra R46 corrections (Opus 5.5 HIGH, sole writer)

Source: HEAD `5ecd2989e21fded915b41b508477bb267aaec06d` (unchanged; the writer made no commits) + uncommitted diff, `git diff HEAD` SHA-256 `6df6e85c1f96343927e091fcc351578eb494c7c7a9a7827ebcbee05973c32fc7` (tracked files only; the 6 new test files are untracked). Writer session `628402d5-a1c6-42b7-b736-e84358c1a749`. No commit, push, PR change, review dispatch, merge or deployment. Acceptance detail: `r47-acceptance-mapping.md`.

## Scope implemented
F1, F3, F5, F6, F8, F2 as adjudicated. F4's conservative gate was preserved and pinned. The F7 general claim was rejected (no change). Legacy/synthetic namespace cleanup deferred.

## Changed paths
Production:
- `lib/identity/member-identities.ts` — `canonicalIdentityId`, `respectTombstone`, canonical-collision refusal (F1/F8)
- `lib/integrations/gdrive-oauth.ts` — publisher passes `respectTombstone` for subject and email (F1)
- `app/t/[team]/admin/members/actions.ts` — link action canonicalizes the requested `author-email:` id (F8)
- `lib/integrations/gdrive-authority.ts` — Admin authority carries the stored ceiling. Adds `refreshGdriveAdminAccess`, plus a shared `refreshedGrantScopes` that the broker also uses (F6)
- `app/t/[team]/admin/integrations/actions.ts` — test, Picker and manual-root paths use the shared refresh; sanitized authority errors (F6)
- `components/admin/identity-conflicts.tsx` — historical/legacy labelling (F2)
- `ingestion/aios_ingest/state.py` — `connection_holds` table, `hold_connection`, `connection_hold`, `_instant` (F5)
- `ingestion/aios_ingest/connector_state.py` — `ACCOUNT_HOLD_KEY` (F5)
- `ingestion/aios_ingest/gdrive_sync.py` — account hold open/adopt/check/publish/carry (F5). `_AcknowledgmentUncertain` with stage-based post-push handling and coordinator stop (F3)
- `ingestion/aios_ingest/brain_client.py` — checkpoint uncertainty latch, identical-payload transport retry, `gdrive_progress_uncertain` (F3)
- `docs/ARCHITECTURE.md` — map updates for F1/F2/F3/F5/F6/F8

Tests (new): `test/datamechanics/gdrive-identity-tombstone-email.datamechanics.test.ts`, `test/datamechanics/gdrive-admin-grant-policy.datamechanics.test.ts`, `ingestion/tests/test_account_hold_before_streams.py`, `ingestion/tests/test_checkpoint_acknowledgment.py`, `ingestion/tests/test_checkpoint_uncertainty_latch.py`, `ingestion/tests/test_exhaustion_is_not_completion.py`.

Tests (updated):
- `test/datamechanics/identity-discovery-conflicts.datamechanics.test.ts` — R47 reachability describe; compatibility label on the raw-SQL fixture
- `test/datamechanics/gdrive-authority.datamechanics.test.ts` — OAuth existing-owner refusal through the real callback
- `test/identity-conflicts-view.test.ts` — new labels
- `test/datamechanics/gdrive-admin-test.datamechanics.test.ts`, `gdrive-admin-credential-race.datamechanics.test.ts`, `gdrive-oauth-lock-order.datamechanics.test.ts` — fixtures now record a real grant. The old fake `"drive"` scope, or no grant at all, is exactly what the F6 ceiling must refuse; no assertion was weakened
- `ingestion/tests/test_gdrive_poll_reporting.py` — the provider-deferred identity-read case now expects a held partial (failed 0, skipped 1), per F5. Other cases unchanged

## Commands and results (writer, 2026-10-31)
- `npx tsc --noEmit` → exit 0. ESLint on all changed TS/TSX → exit 0. `npm run check:docs` → congruent.
- `npm run test:datamechanics:iso -- <52 gdrive/identity/provider-identity/attribution/meeting-identity/slack-identity/items-author dm files>` → 52 files / 619 tests passed. TIERRET dm (7 files) → 73 passed.
- Focused dm: tombstone/email 10/10; Admin grant policy 12/12; the 4 Admin suites 73/73; conflicts + authority 55/55.
- `cd ingestion && .venv/bin/python -m pytest tests -q` → 742 passed, 28 skipped.
- `npx vitest run` (unit, full) → 9298 passed, 3 failed, plus 25 failing files that are archived copies under `.context/` (the known scratch-tree collection issue). The 3 real failures are unrelated:
  - `node-tls-floor-workflows` — environment: local Node 25.9 is not a supported line.
  - `staging-policy-commissioning` — passes in isolation, so load flake.
  - `graph-cdc` ENVELOPE — deterministic, but a pure test; this diff touches neither it nor `lib/graph`. Not compared against HEAD.
- `npx vitest run test/guards` → 1890 passed, 1 failed (the same Node TLS-floor environment limit).
- Mutation checks: every new guard turned red under its targeted source mutation, and all source was restored (byte-identical by `cmp`). Totals: F1 1, F8 1, F6 3, F5 7, F3 6 (client and coordinator tiers), F2 2, F4 1.
- Not run by the writer: HTTP tier (`npm run build` + `vitest.http.config.ts`), and `scripts/e2e.sh`. Python has no configured linter (ruff is not installed).

## Notes for the coordinator and reviewers
- **F3 behaviour change to review:** any sent-but-unacknowledged checkpoint (including a brain 429 whose Retry-After does not fit) now ends the run partial instead of continuing other streams. This is deliberate and conservative, since the revision is unknown. The R45 M5 deferral semantics (no charge, `not_before` kept) are preserved.
- **F5 status change:** early provider rate limits now report `partial` (skipped) instead of `failed`, matching the drain-phase hold.
- **F8:** `removeMemberIdentity` is exact-spelling by design, so an Admin can remove a legacy mixed-case row before relinking canonically.
- **Test-quality finding, out of scope, not changed:** `ingestion/tests/test_account_hold_phases.py` (R45) passes `progress=w.progress` by reference into `GdriveExecution`. Its "published" assertions can therefore be satisfied by the coordinator's local update of the same dict. The new F5/F3 harnesses copy on the wire, and the F5 publish mutation proved this aliasing masks a real regression. Recommend the same one-line copy fix there.
- Fable code review of this exact delta is required before push (the user's global loop). Previously deferred items (M2/M4/L5/L6/H2), release gates M-b/M-c/M-d, and live Google certification remain open.
