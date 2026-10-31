Review result: CHANGES REQUIRED. This is not readiness or publication approval.

1. [P1] A parent-root restriction can prevent suppression of an explicitly trashed document.
Trigger: an imported document belongs to a selected folder whose metadata is under a standing provider restriction; a subsequent changes page explicitly reports file.trashed=true.

gdrive_sync.py:2577 combines trash with ambiguous removal evidence. At line 2614, both pass through absence_withheld; a restricted parent returns held at line 2444, so no removal obligation is created. The replacement enumeration then retains that root’s previous membership at line 2962.

Actual: the brain claim and previously visible content survive until the unrelated parent restriction expires, potentially indefinitely. Expected: explicit trash evidence retires this connection’s claim through the existing claim-aware suppression owner without reading the restricted parent. This violates AC-05 trash/removal behavior and prevents AC-06’s suppression barrier from being established.

Focused regression: import a nested document, restrict its selected folder, emit a change containing trashed=true, and assert prompt claim retirement and last-claim suppression, zero restricted-root reads, and preservation of another connection’s valid claim.

2. [P2] Renewal ignores Retry-After learned from its own watch requests.
The new admission check at watch_renewal.py:448 honors previously recorded account holds. However, a watch creation returning HTTP 429 is converted to WatchRefused by gdrive_watch.py:139. watch_renewal.py:352 retires that attempt and returns to the stream loop, which can immediately dispatch another watch. Cleanup similarly records a failed stop and continues at line 397.

Actual: neither path persists the named deadline nor stops further account calls. Expected: quota responses enter the shared durable account-hold protocol and prevent further provider work until the deadline. AC-04’s Retry-After requirement remains unmet despite the new renewal admission guard.

Focused regression: two due streams plus pending cleanup; return 429 Retry-After: 3600 from creation or stopping. Assert no subsequent account call, durable hold publication, and enforcement by polling and renewal after restart.

No additional uncertain concern is promoted to a confirmed defect.

I verified all three packet fingerprints, all 46 candidate file hashes, and every archive entry against the manifest. I inspected the complete changed surface and targeted unchanged extraction, authorization, claims, cleanup, identity-repair, HTTP and Timeline/cache contracts. No tests or shell commands ran, no files changed, and no prohibited historical artifacts were consulted.

Full acceptance certification is unverified: the permitted packet contains no independently verified live sandbox, two-tenant/person, rendered-UI, or 24-hour soak evidence. The broader transitive retrieval/export/graph surfaces were not exhaustively audited; this review therefore does not issue PASS.

Verdict: CHANGES REQUIRED.
