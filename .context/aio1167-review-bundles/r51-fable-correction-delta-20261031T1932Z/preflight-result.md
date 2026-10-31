# Fable 5.1 no-tools preflight result

Preflight acknowledged. No tools, MCP, or memory writes used; no verdict follows.

**The four R51 review targets I understand:**

1. **Restrictions suppressing verified removals.** A restricted item must not hide a removal the provider has verified. The review checks that removal processing proceeds without an unauthorized or early document read, while unresolved removals stay preserved until it is safe to act.
2. **Cross-stream removal probes swallowing ProviderDeferred.** Probes must surface deferral rather than absorb it. Quota and resource Retry-After evidence must survive. Resource-only minima stay retained without widening account authority, and account calls stop under a quota hold.
3. **Watch renewal calling Google during an account hold.** Renewal must not reach the provider before the verified account's hold expires.
4. **Standing service-account identity prerequisite skipping publication recovery.** Retained restriction publication must retry without an identity provider read, so a standing prerequisite cannot short-circuit recovery.

**Safety boundaries I will hold the review to:**

- Restrictions remain durable and correctly scoped.
- Claim and credential boundaries, and existing recovery behavior, are preserved.
- Account authority is not widened as a side effect of any correction.

**Out of scope:** The legacy mixed-case identity tombstone finding is held. PR #714 owns the overlapping identity writer, so the review should not recommend editing that slice here.

The review itself will assess the diffs in the ingestion modules, watch renewal, and the new restriction and hold test files against these targets. I am not asserting correctness of any of that code at this stage.
