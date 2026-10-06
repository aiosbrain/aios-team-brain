## Verdict: CHANGES REQUIRED — 2 HIGH, 3 MEDIUM, no BLOCKER

The F4 contract itself (DTO, ordering, owners, runtime block) is correct against the Astra decision and the declared sources. v7 is not yet attachable as a complete contract, and one evidence gate rests on a premise no declared path establishes.

**Limits of this review.** I had no shell or Git, so the manifest SHA-256 values and commit identities are unverified. I compared the focused patch to the on-disk v7 by reading only. For v6 I read lines 1–351 in full and, beyond that, only the 20 module headers and the two `pm-sync` rows.

## HIGH

**H1 — v7 attaches as a delta with a dead link, not as v6 plus v7.**
- **Location:** `docs/design/aio1217-server-action-auth-v7.md:9`, gate row `:142`, sequence `:149`, handoff `:155`.
- **Problem:** v6 is "incorporated by reference" through a repo-relative link plus a hash, and the attachment gate attaches only "full exact reviewed v7 Markdown". On Linear that leaves AC-01..14, the inventory and the deferrals as an unresolvable link.
- **Compounding:** v7 calls v6 "accepted", but the cited file describes itself as PROPOSED with attachment and readback uncompleted (`aio1217-server-action-auth.md:3`, `:11`, `:245`). v7 cites no acceptance or readback record.
- **Correction:** Make the attached artifact self-contained. Either attach the verbatim v6 text at `be9788fb…` together with v7 and read back both hashes, or require a readback proving the ticket's existing v6 attachment hashes to `be9788fb…` and cite that record. Also cite the v6 acceptance evidence in §1.

**H2 — The outcome table omits an owner branch, and the Plane admitted controls rest on an uninspected premise.**
- **Location:** v7 §3 table `:45-52`, fact 5 `:29`, exclusion `:69`, F4-E2 `:94`; source `lib/pm-sync/reconcile.ts:80-83`.
- **Problem:** `reconcileProviderState` has a third early return when the adapter lacks `fetchSeenStates`. It returns a named provider, zero counts and a `reason`, which the action then audits and reports as `ok: true`. That is the same false-success shape as F4.
- **Gap in v7:** it says only that this is "not a new marker case". It gives the branch no outcome row and no snapshot fact.
- **Unverified premise:** F4-E2 requires Plane changed and unchanged controls with provider reads, which goes beyond the decision's wording. `plane.ts` and `provider.ts` are outside the manifest, so nothing I read shows Plane supports inbound reconcile. If it does not, those cells are unsatisfiable and §3 rows 4–6 are wrong for Plane.
- **Correction:** Inspect the Plane adapter and add a snapshot fact on whether it implements `fetchSeenStates`. Add a §3 row for the unsupported-adapter branch with its preserved outcome. If Plane lacks support, restate the Plane controls and return that branch to Astra. If Plane supports it, this reduces to a one-line fact plus the table row.

## MEDIUM

**M1 — The specification gate is ambiguous on Astra design review and reviewer model.**
- **Location:** v7 `:141`, `:149`, `:155`; v6 AC-14 `:230`; `AGENTS.md:48`.
- **Problem:** The gate row says "retaining applicable fresh Astra design review requirements", but the sequence and handoff omit it. v6 AC-14 requires a fresh Astra permissioning design review for a material revision. Separately, `AGENTS.md:48` assigns required spec and code reviews to Fable 5.1, while v7 names Opus 5.5 without citing the override.
- **Correction:** State explicitly whether a fresh Astra design review of the v7 text is a pre-attachment gate, in the row, the sequence and the handoff. Cite the instruction that governs the reviewer model.

**M2 — Caller census timing and snapshot are ambiguous.**
- **Location:** v7 §6 `:108` against the runtime admission row `:143`.
- **Problem:** §6 says "before runtime readiness/publication … against the exact implementation snapshot". The gate row makes caller readiness a precondition of the runtime writer.
- **Correction:** Require the census of the four symbols against the pre-edit snapshot before a writer is admitted, and a recheck against the candidate before publication.

**M3 — F4's behavior change is missing from the release, compatibility and rollback obligations.**
- **Location:** v7 `:137`; v6 AC-11 `:227`; v6 compatibility section `:259`.
- **Problem:** v6 enumerates the named behavior changes for the release note. "Without amendment" leaves out F4, which turns `ok: true` into `ok: false` and stops the `team.reconcile_divergence` audit row for this state.
- **Correction:** Extend AC-11 and the compatibility text with the F4 change, state that historical audit rows are not deleted or backfilled, and state that rollback restores the false success.

## Checked and found correct
- **F4 contract:** the two-key DTO and omitted keys match the decision; the three stored states all map to the one resolver result at `project.ts:128-134`.
- **Ordering:** ADM, then same-team resolution, then return before link scan, provider request, audit, revalidation and run creation, consistent with `actions.ts:88-106`.
- **Owners:** two production files, an optional marker derived from structured state, no DTO spread; the exclusions match the decision.
- **v6 preservation:** AC IDs, the 20/96/13/0 baseline, AIO-1225–1228 deferrals and the PR714 hold are retained, with no new registration.
- **DTO compatibility:** both substituted-owner fixtures stay compatible with an optional marker.
- **Runtime block:** stated explicitly at `:143`, `:151` and `:155`, with all evidence labelled unearned.

## Non-blocking notes
- `f4-v7-astra-spec-author-scope.md` (`:11`) has no hash or location.
- `projectBoardAction` has the analogous named-provider, no-integration success path (`actions.ts:36-70`, `project.ts:519-521`). v7 excludes edits to it but records no disposition.
- The existing native fixture compares the owner result with `toEqual`, which ignores `undefined` properties. The key-presence requirement at `:114` needs an explicit owner-result key-list assertion.
- Consider adding mutants for: marker set on a null-provider result, DTO spread or leak, and same-team alternate-provider rescue.
- The `?? "no primary PM provider configured"` fallback is unreachable natively, because the resolver always supplies a reason.
- The alternate-provider control causes one permitted same-team decrypt in every F4-E1 cell; trace assertions should expect it.