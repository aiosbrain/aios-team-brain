# Astra adjudication — adjacent AIO-1167 run failure accounting

Reviewed exact R51 counter-correction candidate, base `5ecd2989e21fded915b41b508477bb267aaec06d`. Read-only adjudication; no code, commands, tests or worker activity.

## Adjacent duplicate run-level charges — ACCEPT/FIX (Low)

AC-07 requires accurate failed counts (`accepted-spec.md:262,335`). The R51 Note A policy is to count a terminating run once while retaining distinct diagnostics; it is not limited to exception-valued `cause`.

Evidence in `ingestion/aios_ingest/gdrive_sync.py`:

- `:1532` charges unresolved roots at run level.
- `:1552–1559` reaches a no-streams flush after either that charge or `selection_unresolved` accounting at `:1554`. The flush has no cause, so its default charges again.
- `:1711` may also charge again after unresolved-root accounting when drain hold publication loses authority.
- `:447–450` distinguishes a single run failure from independent document failures.

Generalize the accounting signal to an explicit **run failure already accounted for**, separate from `cause`, which continues to control terminal-cause publication suppression. Track only identified coordinator/run charges. Do not infer prior run accounting from `total.failed > 0`, arbitrary categories or document failures. Pass the state through the relevant flush and drain paths. Preserve original categories, authority/unpublished categories once each, accumulated progress, local evidence, immediate return and existing status classification. Do not cap counters or alter scheduling.

Required regressions, each over `stale_execution` and `connection_unavailable`:

1. **No streams:** retain both selected unresolved roots; at least one supplies a named 503 minimum so publication is attempted. Refuse the flush. Assert `failed == 1`, unresolved-root count retained, authority and `document_restriction_unpublished` once, local minimum retained, exactly one refusal and no later provider/checkpoint activity. Also exercise the `selection_unresolved` fallback-accounting arm with a bounded fixture if normal selected-root setup cannot reach it.
2. **Unresolved root plus active drain:** retain an unresolved selected root while another stream drains, trigger quota and refuse the hold checkpoint. Assert `failed == 1`, original unresolved count, quota and authority categories retained, applicable unpublished categories once, partial progress retained, local hold retained and no activity after refusal.
3. **Controls:** retain the existing no-prior-run-charge flush `failed == 1`; explicitly assert `failed == 1` in drain refusal coverage. Add an independent document-failure control: document failures remain counted and terminal authority adds one run failure rather than being suppressed by a nonzero document-failure total.

## Binding-catch no-later-call assertion — ACCEPT/DEFER (Low, optional)

The binding caller returns immediately at `gdrive_sync.py:1517`; shared flush behavior is covered by the standing-hold sentinel/revision test (`test_flush_authority_outcome.py:60–81`), and the binding regression exercises the actual catch for both authority codes (`:208–231`). This is optional hardening, not a demonstrated defect or required acceptance gap. Do not add it in this slice; the standing-hold test already protects the no-subsequent-call invariant.

Keep Note B deferred, R49 F6 and all other prior open findings/release gates open. Final blind reviews wait until this bounded correction is verified and reviewed. No whole-branch readiness claim.
