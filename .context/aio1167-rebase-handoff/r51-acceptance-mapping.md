# AIO-1167 R51 acceptance map — status at writer dispatch

Source correction stage: R51, based on Astra R50 adjudication SHA-256 `8be1cbb60fdd0d462f14c316a5584d20987f96c81fe21ec248d0d2811b328791`. Writer: existing Claude Opus 5.5 HIGH session `628402d5-a1c6-42b7-b736-e84358c1a749`. Exact bounded prompt SHA-256 `6e2d202f8e38b37c4d92be6c3fac871085664c1cbc1f6526cdf6f2aefb09b1bf`.

At dispatch, none of the R51 corrections had been implemented or tested. Do not inherit R50 PASS results as R51 evidence. The sole writer was active and the first timed WIP source bundle was stable; no test commands have been run for R51.

| Astra requirement | Expected evidence | Status |
|---|---|---|
| Deferred folder ancestry: nested retained document under an incompletely enumerated deferred root cannot emit inferred removal; membership/claim and root recovery remain; independent overlap and verified positive loss still reconcile | Regression rows in `astra-r50-adjudication.md` “Nested retained scope”, “Persistence and overlap”, and “Recovery and positive loss” | Writer in progress; not run |
| Binding ordering: each provider minimum is journaled at observation time and survives later quota/BrainError/authority/local-budget short circuits; failed publication stays truthful and recoverable | Adjudication “Binding order”; success/reacquisition and failed publication coverage | Writer in progress; not run |
| Drain hold publication: separate unpublished hold/resource diagnostics, recovery after drain and standing-hold early return after reacquisition; no provider calls under hold; uncertainty latch and checkpoint error retained | Adjudication “Hold publication”, “Lost acknowledgment” and “Combined restrictions” | Writer in progress; not run |
| Timeout deferral does not repeatedly relist healthy siblings solely due to a deferred timeout root; bounded once-per-root probe and eventual recovery | Adjudication “Repeated timeout polls”, including persistent restriction and quota controls | Writer in progress; not run |
| Deadline provenance: local fallback is not persisted as provider-owned external minimum; valid, unrepresentable, brain-owned and legacy minima retain protection | Adjudication “Rearm provenance” | Writer in progress; not run |
| Deadline labels: dispatch_deadline and run_deadline remain distinct, local-only, with no account/resource hold or consumed document budget | Adjudication “Deadline diagnostics” | Writer in progress; not run |
| Accepted behavior boundary: only exhausted unrestricted work is rearmed; non-exhausted backoff remains | Negative/positive rearm controls required by adjudication | Preserve; not yet rechecked in R51 |
| Deferred R49 F6 and uncovered R47 Admin/grant-policy + root-coverage interactions | Keep explicit scope limits; fresh Fable review must cover omitted R47 and root-coverage/direct-removal/overlap interactions | Open; not writer implementation |

After writer returns, coordinator must inspect the entire actual diff and update this map with exact test names, commands, pass/skip/fail counts and environment limits. Run the focused Python regressions and full sidecar suite. Rerun affected authority/hold/overlap/Postgres and protocol tiers where seams changed. Then obtain a fresh Fable review on the exact verified snapshot and adjudicate before blind final reviews.
