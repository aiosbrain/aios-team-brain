# Astra adjudication — Fable R51 correction-review lows

Candidate: `ed821d771cf1da1cbf78a3422b46e9dff3f76230`. Scope: adjudicate only the two Low observations in the Fable report; this is not a fresh overall code review. No edits or tests were made.

1. **DEFER — LOW: positive control for the filtered warning helper.** This is useful future-proofing, not a current acceptance gap. `test_watch_late_quota.py:856–863` filters on the same logger and prefix emitted at `watch_renewal.py:885`, and the deadline tests assert absence before the recovery sweep. That satisfies the prior adjudication and distinguishes the swallowed generic path from the explicit deadline handlers. A positive control could protect against future message rewording, but no source change is required before blind final review.

2. **DEFER — LOW: narrow the `ValueError` catch.** The catch at `gdrive_watch.py:190–193` encloses only `_service(deadline)`; request construction, final authority gate and execute are outside it. The production cleanup caller supplies `run.deadline` (`watch_renewal.py:724–727`), so the no-deadline gate branch does not enter this catch. Authority exceptions retain their types, and the parameterized setup regression (`test_watch_late_quota.py:1118–1162`) covers unchanged state/attempts, spent slot and continuation. Narrower placement would clarify credential intent, but no current misclassification or acceptance failure is demonstrated. No change is required before blind final review.

**Disposition:** proceed with exact candidate `ed821d771cf1da1cbf78a3422b46e9dff3f76230` to the blind final reviews.
