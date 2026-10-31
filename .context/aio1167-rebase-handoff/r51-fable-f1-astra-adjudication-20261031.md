# Astra bounded adjudication — R51 Fable F1–F3

## Snapshot and evidence

Feature worktree: `/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree`.
Base and HEAD: `5ecd2989e21fded915b41b508477bb267aaec06d` (HEAD verified). The uncommitted candidate is identified by `.context/aio1167-review-bundles/r51-adjacent-count-20261031T1729Z/manifest.json`, not HEAD alone. Independently checked both relevant source hashes against that manifest:

- `ingestion/aios_ingest/gdrive_sync.py`: `47714e163ec0e469f1b7a07b346c3998db57299f8c32359a263a4207ccb61b65`.
- `ingestion/tests/test_flush_authority_outcome.py`: `19077b33c2bc40624b1eb9c2acf3aa58b7789ffa94119265f9408bdeac5086d1`.
- Bundle `review-source.diff`: `3fba7ef58921884657d101cb3694683a2a25482d5a1cb0db10c1bd0554f3de40`.

Read the current full Fable report from `.context/aio1167-rebase-handoff/r51-adjacent-count-fable-20261031T1742Z/review.stream.jsonl` (complete report at one-based JSONL line 306, corresponding to supplied event 305). The bundle's curated Fable report was not used as the current verdict. Accepted spec: `.context/aio1167-rebase-handoff/accepted-spec.md:260–264,335`; controlling R51 control #3: bundle `astra-adjudication.md:22`.

## F1 — ACCEPT/FIX (Low): required test correction

AC-07 requires accurate counts; control #3 specifically requires that a nonzero independent-document failure total cannot suppress the terminal authority run charge. The existing fixture tests preservation but does not discriminate that condition. It accumulates doc-a's failure in the current stream. At `gdrive_sync.py:1747` the authority charge is decided before `closed.partial` is merged at `:1752–1753`. Thus a forbidden `charge=total.failed == 0` at that decision still produces the asserted final `failed == 2`. This is a genuine gap in the explicitly accepted regression obligation, not an established production defect: the inspected production uses `charge=not run_failure_counted` and documents the separation at `:429–434`.

Minimal required correction, owned by the existing sole writer:

1. Add a helper control parameterized over `stale_execution` and `connection_unavailable`, reusing `_RefusingClient` and the standing local account-hold setup already in the test file.
2. Before invoking the helper, construct `IngestSummary("docs", failed=1, failure_categories={"incomplete_extraction": 1})`. This is solely an independent document failure: no coordinator run charge and no authority category already present.
3. Call `_flush_restriction_evidence(client, execution, state, "account", total)` with neither `cause` nor `run_failure_counted` supplied (default False).
4. Assert `total.failed == 2`, exact categories `{"incomplete_extraction": 1, code: 1, "account_hold_unpublished": 1}`, `client.sent == 1`, and the local account hold remains retained. The nonzero document total therefore exists at the charge decision, and the forbidden counter inference would leave `failed == 1` and fail the assertion.

Keep the current stream fixture as preservation coverage. A two-drive ordering fixture is optional, not required to close this bounded control: the helper exercises the exact prohibited inference with the cheapest deterministic setup. No production counter inference, cap, category inference, or source change is authorized by this finding. Do not rename this helper coverage as proof of a pre-populated drain total.

## F2 — ACCEPT/DEFER (Low, reachability unestablished)

The reconciliation catch at `:1853–1860` does not retain/pass `cause` to the end flush at `:1895–1896`. This is a real structural asymmetry, but an extra checkpoint requires both terminal refusal and an outstanding minimum. The inspected reconciliation eligibility at `:1809–1830` excludes unresolved root coverage and incomplete streams; Fable could not find an in-run source of a minimum that also permits reconciliation. This adjudication establishes no reachable trigger. Do not add speculative production edits or another fixture in this correction. Retain as a follow-up: establish a reachable minimum plus reconciliation-terminal-refusal sequence, then thread explicit terminal cause and assert zero subsequent checkpoint attempts. Deferral does not claim the path impossible.

## F3 — ACCEPT/DEFER (Low, pre-existing; two distinct follow-ups)

The unresolved-root charge at `:1554` followed by a start-token BrainError charge at `:1618` can structurally stack two coordinator charges. This is a credible residual AC-07 accounting issue; it is not rejected or declared correct. It predates this delta and is outside the named authority-publication correction. Keep it explicitly open for a separate bounded correction: reproduce an unresolved selected root plus another stream's token BrainError, then gate only the second identified run charge on explicit `run_failure_counted`; preserve both diagnostic categories and assert one coordinator charge. Do not infer the gate from `total.failed` or document categories.

The independent stream-terminal early return at `:1802` can omit the unpublished-minimum diagnostics otherwise added by the flush. Retain with existing Note B, requiring a reachable root-minimum plus terminal stream refusal regression and no publication under terminal authority. This review does not establish the full trigger or authorize a general stream accounting rewrite. Neither observation is silently closed; neither expands the present F1 test-only correction.

## Gate and limits

Writer correction and focused verification followed by a Fable delta re-review are REQUIRED before blind final reviews. Freeze and identify the corrected snapshot, update control #3's evidence mapping, and have the existing writer add only the minimal discriminating test. Preserve the single-writer owner and normal checkpoint/review controls. No need to rerun unchanged broad checks solely for this adjudication; the coordinator selects required verification for the actual correction. Fable's no High/Medium and no HOLD verdict remains accurately reported, while the explicit test obligation remains incomplete until corrected and re-reviewed.

F2/F3, Note B, binding-catch optional hardening, R49 F6 and other prior rollout gates retain their existing open/deferred status. This is not whole-branch or release approval. No tests, source edits, worker dispatch, publication, or whole-branch review were performed; only bounded evidence reads, identity checks and this durable report write. The containing `.context` path was confirmed Git-ignored before writing.
