**SPEC_REVIEW_REQUIRES_REVISION**

Proposed v8 (`82c3b9ff…`) is close: the chronology, anti-laundering, runtime contract and gate order are sound, and no HIGH/blocker finding stands. Three MEDIUM findings in the acceptance mapping and dating need a narrow text or record fix before Astra readiness. This is a review verdict only; it is not Astra readiness, author acceptance, Linear attachment/readback or dependent acceptance.

All paths below are under `inputs/` in the repaired-review root.

## Coverage and limits

- **Present and read:** all 18 manifest artifacts exist. I read v6, v7, v8 (all 770 lines, including Appendix A), the change map, the patch (1,420 lines) and the adjudication, E6 census, CURRENT and author artifacts in full.
- **Partly inspected:** in `05-…status.json`, line 191 (the embedded manifest heredoc) exceeded the read cap; its body is artifact 12, which I read in full. In `07-….jsonl` I read all 97 event headers, all 44 commands, every hash output, all six agent messages and the exit codes, but not every echoed `cat`/`sed` output byte.
- **Not done:** I computed no hashes. Byte-identity statements rest on the parent's pins, the author's captured hash outputs, and my own reading.

## Answers to the five review questions

1. **Chronology and AC-12: yes.** `10-…v8…md:137`, `:183` and `:217` state the original RED-before-correction chronology was missed, forbid backdating, and require "retrospective" labels with actual timestamps. The AC-12 quote matches `08-…v6.md:228` verbatim. One loose end is L1.
2. **Retained contracts: yes in the body text, qualified in §9.** By my full read, v8 `:25–133` equals v7 `:21–129` and v8 `:157–177` equals v7 `:135–155`, covering the DTO, marker, ordering, non-effects, E1–E3, caller/UI, E5, E6 and R1/R2. Whole-task and final-review holds are at `:197` and `:221`. The §9 qualification is M1.
3. **E4 evidence precision: mostly.** Six cells, stored-premise readbacks, durable comparisons, loading provenance and the `reach()` limit are precise. The `reach()` claim is accurate: `17-….patch:783–837` asserts after one invocation, and case 4 calls it twice at `:1022–1023`. The gap is M2.
4. **Sequence: yes.** Opus review, then fresh Astra, then exact v6 plus reviewed-v8 attachment/readback with hashes (`:192`, `:195`, `:202–204`, `:213`). The pre-edit census gap is disclosed (`:21`, `:219`), but its consequence for acceptance is not fixed (M1).
5. **Change map and author boundary: line references are accurate; acceptance effects are incomplete (M1, L5).** The author capture is consistent with a support-only, no-credit run: 44 commands, all exit 0, only `rg`/`cat`/`sed`/`sha256sum`, five relative-path writes, no git, network or test executables. Captured output hashes match the manifest pins for artifacts 10–14.

## Findings

**M1 (MEDIUM): "applicable" qualifiers weaken the dependent-acceptance gate, and the census gap has no acceptance consequence.**
- **Evidence:** v7 `09-…v7.md:177` requires "All runtime, evidence, compatibility and review gates complete". v8 `:211` says "All applicable …", and `:217` adds "as applicable" to E1–E3/E5/E6, caller evidence, mutations and validation. v8 `:193` has no such qualifier, so v8 is internally inconsistent.
- **Interaction:** `:205` leaves the existing candidate "not retrospectively admitted", and `:219` only says to "record that separate gap and return any material impact/permissioning issue to Astra".
- **Expected:** the only gate changed for the preserved candidate is E4 chronology.
- **Actual:** a reader could treat the unsatisfiable pre-edit census and runtime-admission gate as "not applicable" and proceed. `11-change-map.md:19–20` and `:30` assert no relaxation and do not mention the qualifiers.
- **Correction:** remove both qualifiers, or name the single prospective-only step that does not apply. Add to `:219` that an unresolved pre-edit census or runtime-admission gap keeps dependent PM acceptance BLOCKED until an explicit Astra disposition. Add a change-map row.

**M2 (MEDIUM): admitted baselines on the reference runtime are no longer explicitly required for the retrospective route.**
- **Evidence:** v7 `:133` says "Record all six provider/state cells and admitted baselines". In v8, `:145` covers cells only, `:151` names no runtime for the controls, and `:217` attaches "with non-vacuous controls" to the candidate step alone. Only the "ordinarily" sentence at `:137` and the "same cases" definition at `:141` imply both runtimes.
- **Expected:** an unchanged E4 evidence requirement.
- **Actual:** six reference cells plus candidate-only controls could be claimed as complete E4.
- **Correction:** one sentence in `:151` and `:217` requiring the F4-E2/E3 controls to run against both the reference runtime and the candidate under identical test and harness bytes, with the reference record showing them alongside the six failing cells.

**M3 (MEDIUM): the authoring date is uncorroborated and contradicted by supplied timestamps.**
- **Evidence for 2026-10-06:** v8 `:3`, `12-author-manifest.json:11`, and the change map's "actual authoring date" (`11-change-map.md:7`).
- **Evidence against:** the CURRENT the author read (`07-….jsonl:22,24`) is stamped `2026-10-05T22:38:49Z` with the author launch still pending. The frozen CURRENT (`01-CURRENT.json:3`, `:43`) is stamped `2026-10-05T22:52:18.180309Z` and already cites v8's hash and the failed first Opus attempt.
- **Unresolved:** the event stream has no timestamps and the status file gives only a 342.9-second duration. I cannot tell whether v8's date or the frozen CURRENT's stamp is wrong.
- **Correction:** the parent reconciles from the host launch capture. Either replace `:3` with actual UTC start/end timestamps, or record in the handoff that CURRENT's `updatedAt` was not advanced.

**L1 (LOW): the "original compliant record" alternative is unscoped in the tables.** `:137` says the chronology "was missed", yet `:155`, `:191` and `:207` still offer "the original compliant record" without limiting it to work not yet corrected. Scope it to future runtime changes and state that only the retrospective route exists for `ceb184db → cd0387e8`.

**L2 (LOW): the terminology rule does not name committed prose.** `:183` covers "retained evidence and release wording". The committed test prose says "no RED was observed" (`17-….patch:357–360`, `:1220`) and will need correcting (`:21`). Extend the rule to committed test and documentation prose, and state that correcting it creates a new candidate identity requiring the reruns at `:217`.

**L3 (LOW): preservation hashes predate the final edit.** The three preservation hashes (`07-….jsonl:62–72`) were captured before the last `sed -i` on v8 (`:74`); the final hash came after (`:83`). I confirmed the substituted phrase occurs nowhere in v6 or v7, and my read found the ranges and appendix identical at fixed offsets. The parent should recompute the three range hashes on the frozen file.

**L4 (LOW): run-environment symmetry.** `:143` requires cache isolation only for the reference execution and records, but does not require equal, dependency, toolchain and schema identities across the two runs. Make both symmetric, and consider pinning the reference owner blobs (`7a472cb9`, `28586d53`; `17-….patch:2,18`).

**L5 (LOW): change-map omissions.** It does not list the §1 heading rename (v8 `:9`) or the status-cell rewordings at `:205–208`, including "UNEARNED" becoming "Not completed here".

**L6 (LOW): supersession and Linear mechanics.**
- v8 has no sentence saying it governs over v7's E4 text once admitted and that v7 governs until then.
- `:15` says "attach" v6, while CURRENT records v6 already attached "once each" (`01-CURRENT.json:26`). Say whether to verify the existing attachment or add another.
- The HTML comment delimiters at `:231` and `:770` may not survive Linear's Markdown round-trip.

**Notes on author provenance (no action required on v8):**
- The author read only patch lines 1–80 and self-disclosed truncated reads (`12-author-manifest.json:262`, `:288`), so its `reach()` statement came from the adjudication; I verified it against the patch.
- The author's model identity is configured, not attested: the capture holds the argv and a thread id only.
- v8 pins CURRENT `f926ab0a…`, while I was given the successor `3602f269…`. The claims v8 attributes to CURRENT match both.
- I cannot attest the user-authorized Opus override of the Fable default in `18-AGENTS.md:48`; v8 `:195` correctly holds the gate if it is unverifiable.

## Explicitly unearned

- **E4 execution:** no reference or candidate comparison has been run or credited.
- **E6 / UI / action-wire:** source-only census; no rendered UI, Server Action wire, serialization or revalidation evidence.
- **Full task:** the 95-action, 15-connection, 14-AC work, the pre-edit census gap, stale committed prose, and the R1/R2 residuals all remain open.
- **PR, merge, deployment:** none.