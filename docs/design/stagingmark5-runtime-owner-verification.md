# STAGINGMARK-5 runtime owner — verification note

Companion to the accepted design [`stagingmark5-runtime-owner.md`](./stagingmark5-runtime-owner.md)
(AIO-1132, spec v2.2, SHA-256 `6576da78bbbc07f9bd7c750863444b3e76048ee56b5744ce7b98f540edf23662`).
Measurements were taken on 2026-10-02. This note records what was measured and on which profile.
Operational limits and residuals are in [`docs/OPS.md` §11](../OPS.md) ("Runtime recovery limits").

**Status: final acceptance pending.** The final independent code and security reviews have been
returned and their accepted findings fixed (see [Final reviews](#final-reviews)). A focused review
of the follow-up fixes and the final acceptance decision are still pending. The pull request
records the final review and acceptance disposition. This note does not claim acceptance is
complete.

## What is being verified

Boot, scheduler retry and the confirmed attended CLI now invoke the one frozen SQL function
`materialize_builtin_membership_once()` through `materializeBuiltinMembershipOnce`
(`lib/access/groups.ts`). That service runs one engine-owned transaction: BEGIN, READ COMMITTED
pinned before any snapshot, transaction-local `statement_timeout = 120000` and
`lock_timeout = 2000`, one function SELECT, exactly-one-boolean validation, then COMMIT. Membership
and marker commit or roll back together. `ran` is reported only after an acknowledged COMMIT. A lost
acknowledgement returns `outcomeUnknown` and is not replayed within that invocation. The SQL body,
the schema, the configuration and the public RPC surface are unchanged.

Two snapshots were measured:

- **Capacity (AC-12a), before conversion:** source `2a633d6e7f45888947982a7d4f1effdc3a8c3c52` with
  the canonical SQL from `283e68bc10f668df3123513583afce9c2de8713a`. The unchanged SQL was executed
  directly on a pinned connection with the same 120 s / 2 s settings.
- **Startup (AC-12b), after conversion:** runtime source `22560991b001916c700f839a485a5eb938074181`,
  production `next build` with the default build, real boot through `instrumentation.ts`.

## Test profile

- PostgreSQL 16.14 (aarch64) on an owned, disk-backed Docker volume. The **PostgreSQL container's**
  limits were measured at 2 CPU / 2 GiB. `fsync`, `full_page_writes` and `synchronous_commit` were
  on; autovacuum was on; `shared_buffers` was 128 MB and `work_mem` 4 MB.
- Capacity coordinator: Node 25.9.0 with `pg` 8.22. Startup: a native local production Next 16.3
  server on Node 25.9.0. The application process was not shown to share the database container's
  resource limit.
- **Not tested:** Node 20, the Docker entrypoint/deployment wrapper, Railway sizing, healthcheck or
  restart policy, production PostgreSQL settings, and OS page-cache flushing. "Cold" means a fresh
  markerless fixture and a fresh connection.

## Fixtures and assertions

Each trial used a fresh markerless database with 100,000 members and no private corpus. Every
team covered all 36 kind × connector × status × tier combinations. Each trial verified:

- the exact builtin rows created, removed and preserved, with their timestamps;
- that unrelated custom and person-singleton edges were retained;
- the exact `added`/`removed` UUID sets in the audit rows;
- the marker;
- that the same backend's settings were restored afterwards.

A second, marked call returned `false` and left the state byte-identical. Lock samples were taken
during each run, and lock release after COMMIT was observed.

## Capacity (AC-12a)

The interval for each trial runs from the function SELECT through the acknowledged COMMIT.

| Shape | Trial 1 | Trial 2 | Trial 3 |
|---|---|---|---|
| Balanced, 100 teams × 1,000 members | 1.568 s | 1.578 s | 1.495 s |
| Concentrated, 1 team × 100,000 members | 1.518 s | 1.872 s | 1.286 s |

All six trials met the required ≤ 60 s envelope. These are synthetic results for the tested
envelope, not an SLA or a live-fleet sizing.

## Interference with a held winner (AC-12a)

A test-owned materializer transaction was deliberately held open after its SELECT while proxies
contended with it. This is an interference witness, not one of the six capacity timings.

| Contender | Outcome |
|---|---|
| Governed SHARE proxy (its existing 1.5 s lock cap) | `55P03` after 1.507 s |
| Ordinary member INSERT proxy (**test-only** 2 s lock cap) | `55P03` after 2.004 s |
| Queued `members` ACCESS EXCLUSIVE DDL (the loader's 15 s budget) | `55P03` after 15.015 s |
| Plain `members` SELECT issued after the DDL queued | Blocked by the queued DDL; completed at 15.033 s when the DDL timed out, not by its own 45 s timeout. All five winner locks were still held. |

The winner's lock hold, measured through its acknowledged COMMIT, was at most 20.312 s. Afterwards
every proxy retried successfully and no proxy row leaked. The 2 s cap was a measurement device. It
is not a production writer setting: ordinary pool writers have a 30 s statement cap by default
(configurable) and no lock cap, so a real writer may wait longer than 2 s.

## Startup (AC-12b)

The marker was absent immediately before the server started. The boot was observed returning
`ran:true`, and the health endpoint reported the expected commit. Readback then compared the database state before
and after each startup:

| Startup | Elapsed | Marker | Members | Groups | Edges | Audits |
|---|---|---|---|---|---|---|
| Markerless (before → after) | 3.139 s | 0 → 1 | 100,000 | 360 → 400 | 53,560 → 100,200 | 0 → 200 |
| Marked (state unchanged) | 0.801 s | 1 | 100,000 | 400 | 100,200 | 200 |

The exact membership and audit sets were also read back. Both task servers were stopped
afterwards. This is evidence from local production Next. It is not proof of Railway healthcheck
or restart behavior, or of the deployment wrapper. Socket readiness or a healthy health response
is not, by itself, treated as proof that boot registration completed; the evidence is the observed
`ran:true` together with the exact state readback.

## Repository tests

Two portable test files live in the repository. They are run by the ordinary suites:

- `test/datamechanics/stagingmark5-runtime-owner.datamechanics.test.ts` (real PostgreSQL) covers
  AC-01, AC-02 and AC-04 to AC-11.
- `test/guards/materializer-sql-caller-owner.test.ts` covers AC-03. It is a bounded literal guard,
  not a whole-program proof.

To run them, together with the repository-wide checks:

```bash
npx vitest run test/guards/materializer-sql-caller-owner.test.ts
npm run test:datamechanics:iso -- test/datamechanics/stagingmark5-runtime-owner.datamechanics.test.ts
npm run typecheck
npm run lint
npm run check:docs
```

The durable-PostgreSQL capacity runner and the startup harness are ignored, coordinator-local
tools. They are not in the repository and should not be treated as portable recipes.

## Validation recorded so far

These results were verified by the coordinator. According to the coordinator's checkpoint reviews,
the runtime source has been `22560991` since conversion. Later checkpoints changed tests and docs.
The only production-source change in the latest checkpoint `ede72d2c` is to comments, so runtime
behavior is unchanged. Failures and retries are listed as they happened; none is waived.

| Check | Snapshot | Result |
|---|---|---|
| Existing policy suites: access-groups, posture-cutover, stagingmark2, pret6 | post-conversion | 4 files / 41 real-PG tests pass |
| Runtime-owner dm suite and order/deadline mutants | `4569d2c8` | 31 real-PG tests pass. Mutants killed: deadline removal, session misroute and swallowed 57014. The order mutant survived the restoration-only case and was killed by the normative order case. |
| Runtime-owner dm suite and unit/guard suites | Stage 5 tests (`062d7aa9`) | 34 real-PG tests pass. 7 files / 81 unit/guard tests pass. Typecheck and lint pass. |
| Stage 5 mutants | same | Killed: bounded in-call replay (2 connects), dropped `outcomeUnknown` flag (CLI case), and bare boot / `.mjs` / `.cjs` / `.js` callers. Canonical reruns pass: guard 10/10 and AC-10 3/3. |
| Capacity and interference | `2a633d6e` (pre-conversion) | Six trials pass (≤ 60 s); interference measured as above |
| Startup | `22560991` | Markerless and marked startups pass |
| AC-03 guard span correction and private-helper control | up to `a4815204` | First run: 10 pass, 1 failed on the default 5 s test timeout. Retry: 11/11 pass. Both results retained. `check:docs`, typecheck and lint pass. |
| AC-07 negative harness correction | up to `a4815204` | The original negative case failed its client-side bound (37,010 ms observed against a bound of < 31,000 ms). It was replaced by a finite 45 s negative harness that asserts the exact 30 s settings, `57014`, ROLLBACK and no effects; the positive case (31 s statement under the local 120 s) passed. This is not a waiver of the product timeout, and no cause is inferred for the delay. |
| Existing item-context suites | up to `a4815204` | 2 files / 62 cases: 61 pass, 1 existing timing case failed on its unchanged 16 s harness bound. The exact unchanged held-lock case then passed in isolation in 10.57 s. Both results retained; no cause is inferred. |
| Existing disposal units | up to `a4815204` | 3 files / 15 tests pass |
| Unit/guard suites after the final follow-up fixes | `ede72d2c` | 10 files / 99 tests pass, including 13 AC-03 guard cases, under the unchanged default 5 s test timeout. Typecheck, lint and `check:docs` pass. The guard's baseline cache is an efficiency fix; it is not claimed as the exclusive cause of the earlier timeout. |
| Runtime-owner dm suite, first run after the follow-up fixes | `ede72d2c` | 31 pass, 3 timing failures, 1,071.87 s total: one `beforeEach` hook timeout (30 s), one 30 s case timeout (AC-05 slow contender), and the AC-07 bare-default case, whose client-side measurement was 11.684 s against its ≥ 29.95 s bound although the server canceled at its 30 s default. No code cause is assumed and no test bound is waived. |
| Runtime-owner dm suite, rerun with the machine kept awake | `ede72d2c` | 34/34 real-PG tests pass in 99.52 s. The coordinator independently confirmed that the run exited with status 0. The earlier failed run above is retained, not superseded. |

## Final reviews

Independent final reviews were run on `a4815204`:

- **Code review (Opus):** no correctness, privacy or permission blocker.
- **Security review (Astra):** pass, with no actionable security findings.

Adjudicated findings: two MEDIUM items were accepted. The AC-03 guard's repeated full-surface
scanning (F2) was fixed in `ede72d2c`; this note's reconciliation (F1) is this update. LOW items
were also accepted and fixed in `ede72d2c`: monotonic elapsed timing in the new PostgreSQL tests
(F3), the `outcomeUnknown` comment and OPS wording (F5), and historical documentation (F6). An
inherited scheduler failure-ledger recovery item (F4) is deferred outside this slice as a
follow-up. The startup-evidence and runtime-profile limits (F7, F8) are retained above.

**Pending:** a focused review of the follow-up fixes in `ede72d2c` and the final acceptance
decision. Node 20 CI results will be reported only once they have actually run.

## Evidence provenance

The coordinator's evidence is kept locally in an ignored directory. It is not attached to this
repository and is not needed to understand the results above. The SHA-256 values below are the
ones the coordinator recorded.

| Artifact (ignored, local) | SHA-256 |
|---|---|
| capacity-evidence.md | `48fae03f0bcf46f7ee15fe60b654b7eb52b4906d356ef6eab58f474f3aef5d17` |
| capacity-gate.json | `2768213c37ba583027d5cb666f64709f555e9d6f8ed28bfd304078bce9e42184` |
| interference report (balanced) | `5de19e0c8c505c0e3fbf4337cc03d2e598e8d7b110748af1b3b9e288d0d71661` |
| capacity runner | `b7c3b0af7057b4b50833e131cfd3792afc0473f7f419586838761f0c08f29978` |
| startup-gate.json | `7119aba47af7a0bafa79ef30ec9d48546fa381b49d48fe6ae6f8259e80a67ed1` |
| startup-proof.json | `770ba7b8e61cc18d19ab620cb2e5c79367d378db52dd18cabffb46a9bbcb5629` |
