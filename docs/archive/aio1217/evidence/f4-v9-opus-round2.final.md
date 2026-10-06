**SPEC_ROUND2_ACCEPT**

Proposed v9 (`0a19ddf8…`) closes M1, M2 and M3 in its text, and I found no HIGH or MEDIUM finding. Four LOW items remain; none needs a v9 text change before Astra readiness. This is an affected spec-review result only: it earns no Astra readiness, author acceptance, Linear attachment/readback, E4 execution, E6/UI/action-wire, full-task, PR, merge or deployment credit.

Paths are under `inputs/`. "v9" is `aio1217-server-action-auth-v9-f4-e4-round1.md`, "v8" is `10-…v8-f4-e4-amendment.md`, "v7" is `09-…v7.md`, "v6" is `08-…v6.md`.

## Coverage and limits

- **Read in full:** the manifest, prompt and launch request; v6 (538 lines), v7 (185), v8 (770) and v9 (789) including both Appendix A copies; both change maps; the round-one final, status, capture and guard; all five author artifacts plus the author manifest; the adjudication; the E6 census; CURRENT; AGENTS; the patch (1,420 lines).
- **Partly inspected:** `05-opus-scoped-review.jsonl` (505 lines). I checked all 48 tool requests, both tool errors (read-cap messages, not denials), the terminal `permission_denials: []`, and the event timestamps. I did not read every echoed tool-result byte.
- **Not done:** I computed no hashes. Byte-identity statements rest on the parent's pins plus my reading and anchor checks.
- **Not used:** the denied first Opus attempt.

## M1 — closed

- **Qualifiers removed.** v8 `:211` "All applicable … gates" is now "All runtime, evidence, compatibility and review gates" (v9 `:213`). v8 `:217` "as applicable" is gone (v9 `:219`).
- **Acceptance consequence stated.** v9 `:213` and `:221` keep dependent PM acceptance BLOCKED on any unresolved pre-edit census or runtime-admission gap until an explicit Astra disposition. v9 `:221` grants no such disposition, retrospective admission or waiver.
- **Remaining "applicable" phrases narrowed, not relaxed.** v8 `:58`, `:116`, `:151` became case-specific wording at v9 `:60`, `:118`, `:153`. Each is equal to or stricter than v7 `:54`, `:112`, `:133`.
- **Appendix qualifiers covered.** A grep for "applicable" finds it in the v9 body only at `:231`, the table's own preamble. Every appendix occurrence (v8 `:248`–`:620`, v6 `:17`–`:389`) is covered by the table at v9 `:233`–`:242`, and each row matches the v6 sentence it glosses.
- **Map discloses it.** `change-map-v9.md:12–18`, `:20`, and `:24` (which notes the two edits inside the formerly byte-identical v7 §§2–6 range).

## M2 — closed

- v9 `:153` requires all F4-E2/E3 controls, including admitted non-vacuous baselines, on both the exact preserved reference runtime and the exact candidate with identical test and harness bytes. The reference record must show them alongside all six failing cells, "not candidate-only or inferred controls".
- v9 `:219` mirrors this in the retrospective route and adds repeated admitted controls on both runtimes, subject to the reach limits at `:155`.
- This is feasible against the supplied fixture. Cases 1–3 and 5–8 in the patch (`17-….patch:1038–1209`, the `admit` change at `:743–759`) assert only unmarked results, so they hold on the reference runtime unchanged.
- The `reach()` statement is still accurate: one invocation then assert (`:783–837`), and case 4 calls it twice (`:1022–1023`).

## M3 — sufficient

Withdrawing the label and adding the reconciliation requirement is enough, for four reasons:

1. **The defect is removed.** v9 `:3` asserts no verified authoring timestamp, and `change-map-v9.md:8` and `:33` drop "actual authoring date". `author-revision-manifest.json:68` and `final-status.json:15` carry `authoringTimestamp: null`.
2. **Nothing is invented.** The only timestamps in v9 are record stamps attributed to their sources (`:9`, `:15`).
3. **The contract does not depend on the authoring date.** Retrospective labels need execution timestamps with timezone (`:145`). Admission order is proven by gate records. Implementation-before-RED is fixed by commit identity (`:5`, `:219`).
4. **The conflict fails closed.** v9 `:9` marks it UNRESOLVED and bars dated authoring assertions until the parent reconciles. `01-CURRENT.json:43` carries the same hold.

The interval evidence stays contextual; I did not use it to establish any timestamp.

## Unchanged items

| Item | v9 location | Result |
| --- | --- | --- |
| Missed chronology, anti-backdating, AC-12 quote | `:139`, `:157`, `:185`, `:219`; quote matches v6 `:228` | Intact |
| Scope, DTO, marker, non-effects | `:50–87`, differing from v8 only at `:60` | Intact |
| E1–E3 | `:93–120`, differing only at `:118` | Intact |
| E5, E6, R1/R2 | `:159–181` | Intact |
| Caller/UI gate | `:124–133` | Intact |
| E6 source-only limitation | `:23`, `:210` | Intact |
| Diff identity | `:5`; patch has 5 file headers, 37 hunks, two production owners, three test files | Consistent |
| Review order and Linear gates | `:17`, `:194`, `:197`, `:204–206`, `:215` | Intact |
| No-credit boundaries | `:3`, `:25`, `:199`, `:223`, `:227` | Intact |
| Appendix A | `:250–789`; 38 headings and 28 qualifier anchors align with v6 at a constant +250; no `v8`/`v9` token inside | Aligned by reading; not hash-verified |

## LOW findings (non-blocking)

**L1 — status line overstates the date finding.**
- **Where:** v9 `:3` against `:9`.
- **Expected:** the status line asserts nothing the M3 paragraph calls unresolved.
- **Actual:** `:3` says the label is "not an actual UTC authoring date"; `:9` says the records "do not establish which date/stamp is wrong".
- **Fix:** "not a verified UTC authoring date".

**L2 — scope and discharge of the reconciliation requirement.**
- **Where:** v9 `:9`, `:227`.
- **Expected:** the bar covers assertions about when v8/v9 were authored, with a stated outcome if the capture is unrecoverable.
- **Actual:** it reads "any externally dated assertion of authoring or chronology", and "chronology" elsewhere in v9 means E4. Discharge is only by actual UTC start/end or a stale-CURRENT explanation. `01-CURRENT.json:43` says the capture "was not captured".
- **Reading I applied:** narrow, because `:9` ends by keeping the §§7–9 execution-timestamp requirements mandatory.
- **Fix:** Astra readiness records that reading and that an unrecoverable capture leaves the authoring date permanently unasserted. Alternatively, one sentence at the next text change.

**L3 — mechanics of the Astra disposition.**
- **Where:** v9 `:213`, `:219`, `:221`.
- **Expected:** where the disposition is recorded, where it sits in the retrospective route, and whether one that accepts (rather than cures) the timing gap is a material amendment.
- **Actual:** unstated. `:221` ("grants no … waiver", "sole changed historical acceptance route is E4 chronology") implies such a disposition needs the §9 review chain, but does not say so.
- **Fix:** Astra readiness states it and places the disposition before the publication gate.

**L4 — M1 table is not self-resolving and one gloss is loose.**
- **Where:** v9 `:231–242`.
- **Expected:** references resolvable from the attached v6 and v9.
- **Actual:** the table cites v8 line numbers, and v8 is not attached (`:17`). `:235` says "every well-typed mutation of its named consumer contract", which is wider than v6 `:220` "applicable omitted/widened/wrong-principal mutants".
- **Fix:** cite v6 lines 17, 33, 72, 74, 84, 95, 132, 154, 181, 220, 237, 326 and 378–389 (v8 minus 231; v9 minus 250). Reword to "each named omitted/widened/wrong-principal mutant that is well-typed for that connection".

Round-one L1–L6 remain open by design (`change-map-v9.md:3`).

## Parent actions and notes

- **Appendix hash.** Compute the extracted v9 Appendix A hash and confirm `be9788fb…` before readiness or attachment. The author computed none (`author-revision-manifest.json:79`), while v9 `:248` asserts identity.
- **CURRENT identities.** v9 pins `f926ab0a…` (`:15`) and `3602f269…` (`:9`); this packet carries `0f225634…`. I could not read the `3602f269…` copy; its stamp is corroborated by `05-….jsonl:12` and the round-one final at `:38`. The acceptance claims v9 attributes to CURRENT appear in my copy at `:24–26` and `:49`.
- **Context for M3 reconciliation (not a resolution):**
  - The round-one stream runs `2026-10-05T23:05:33.844Z` to `23:15:02.035Z` (`05-….jsonl:2`, `:504`) and shows v8 already carrying the `2026-10-06` label (`:24`).
  - In `01-CURRENT.json`, `updatedAt` equals `remoteReadbackAt` to the microsecond (`:3`, `:18`), yet `:43` already records v9, about 3m20s after the round-one terminal. That fits a stamp that tracks remote readback rather than content edits.
  - My own session's supplied date reads 2026-10-06; I have no clock.

## Explicitly unearned

Astra readiness, author acceptance, Linear attachment/readback, E4 execution, E6/UI/action-wire, full-task, final reviews, PR, merge and deployment. Dependent PM acceptance stays BLOCKED.