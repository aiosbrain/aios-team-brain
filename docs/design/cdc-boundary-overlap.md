# CDC churn is the number of chunks the edit touches — CDCCHURN-1

**Status:** spec, draft 3. Drafts 1 and 2 were each BLOCKED by two independent cold reads, and **each
draft's central claim was falsified by measurement, not by argument**. Draft 3's rule is the first that
was tested against the corpus BEFORE being written down (§0b).
**Related:** `docs/design/content-defined-chunking.md` (the requirement tables this corrects).
**Code:** `test/graph-cdc.test.ts`, three checked-in fixtures. `lib/graph/cdc.ts` is read only — no
product change; that IS the finding, not a shortcut.

---

## 0. What is wrong, and what is NOT

`test/graph-cdc.test.ts` carries an `it.fails` naming this ticket: over the live corpus of repo
markdown, one document churns **4** chunks for a same-length in-place edit where
`docs/design/content-defined-chunking.md`'s acceptance table requires **1**.

### 0a. Four characterisations, three of them wrong

Each wrong answer was cheap prose that would have shipped as documentation:

1. *"The test over-asserts; the spec disclaims the guarantee."* — False: the table **requires** 1.
2. *"Low-entropy repetitive bullets propagate the realignment."* — False: churn is indifferent to entropy.
3. *(draft 1)* *"The edit OVERLAPS a boundary, destroying the cut."* — True of the failing document,
   not the rule: a cut is decided by the ~32 code units ending at it, so an edit **near** a boundary
   destroys one it never touches, and spliced text can **create** one. Swept across the hazard band,
   9,480 of 15,719 non-overlapping offsets churn > 1.
4. *(draft 2)* *"Churn is exactly 1 when the boundary SEQUENCE is unchanged."* — False in **both**
   directions, and both reviewers constructed witnesses:
   - **churn 2** with the sequence unchanged — `docs/ARCHITECTURE.md` @[5132,5152) spans a *surviving*
     boundary at 5142, so both adjacent chunks change (reproduced here, exactly);
   - **churn 0** with the sequence unchanged — an edit past the 80-chunk admitted prefix is dropped
     entirely (`docs/ARCHITECTURE.md` admits 80 of its 145 boundaries, prefix ending at 226,302), and
     an edit whose replacement equals the original text changes nothing at all.

### 0b. The rule that is actually true, verified before being written

**When the boundary sequence is unchanged, churn equals the number of ADMITTED chunk intervals that
intersect the changed span.** Exactly 1 requires two things together: the edit changes text, and it
lies wholly inside one admitted chunk. (This draft first wrote a third condition — "no boundary strictly
inside the edit span" — which a mutation then proved redundant; see §2b.)

Verified by sweeping every corpus document ≥25k characters at 97-character offset steps and comparing
the count this rule predicts against the measured churn: **5,658 unchanged-sequence samples, 5,658
agreements, zero mismatches** (measured at `2b1778d`; see the staleness note below). The 0-churn (past-cap) and 2-churn (spans a surviving boundary) cases
fall out of the same rule rather than needing exceptions.

### 0c. When the sequence DOES change, there is no usable ceiling

Draft 2 proposed asserting a re-synchronisation ceiling of 6 (the existing test's threshold, one over a
measured worst case of 5). Measured across the same sweep, restricted to edits inside the admitted
prefix, the changed-sequence bucket is:

| churn | 2 | 3–6 | 7–20 |
|---|---:|---:|---:|
| samples | 223 | 211 | 5 |

**Observed maximum 9 of 80 admitted chunks** at `docs/ARCHITECTURE.md`@178,189 — against a legacy
churn of **1** for the same edit — measured at `9c81efd`. Stated as an OBSERVED LOWER BOUND, not "the
maximum": the sweep steps 97 characters, so it samples ~1% of offsets, and two runs differing only in
start offset reported 8 and 9. A reviewer independently constructed a document reaching 8 at the test's
own fixed offset. The existing ceiling of 6 is therefore fitted to one offset, is already exceeded on
live content, and **no ceiling is assertable** — asserting one against a fixture would pin the fixture,
not the algorithm. This slice asserts the changed branch's *classification* and *direction* (≥ 2,
boundary provably destroyed), never a magnitude.

### 0f. The retracted "78" was the wrong METRIC, not stale data

An earlier draft published a maximum of **78 of 80** here, and then — worse — explained the retraction
as corpus drift ("a merge lengthened `ARCHITECTURE.md`"). Review falsified BOTH. The number reproduces
identically on the pre-merge and post-merge file, and the pre-merge file was *shorter*, so the drift
story had its direction backwards. That was the fifth wrong characterisation in this ticket, and the
first one that was mine to catch.

The real cause is the metric. Churn can be counted two ways:

- **SET** — chunks in the edited version whose content appears nowhere in the original;
- **POSITIONAL** — chunks that differ at the same index.

**Only the set count is a cost the product pays.** `lib/graph/project.ts:1222-1223` builds
`alreadyPushed = new Set(existingRow.chunk_shas)` and filters `episodes` by MEMBERSHIP, so a chunk
whose content survives while its index shifts is never re-pushed and costs nothing. The 78 was a
positional count of a state that costs **2**. `scripts/cdc-churn-sweep.mjs` now reports both, precisely
so the two cannot be confused again: at `9c81efd` the same sweep gives set max 9 and positional max 80.

The rule in §0b agrees with both metrics — but only in the unchanged-sequence bucket, where they are
provably equal (every non-intersected chunk is byte-identical). Carrying "agrees under both" across to
the changed bucket, where they diverge by ~40x, is what produced the 78.

### 0d. The trade, with both directions measured

This is what the acceptance table is really claiming, so it belongs in it:

| edit (measured at `2b1778d`) | CDC | byte offsets |
|---|---:|---:|
| in-place, same length, boundary-changing (`docs/ARCHITECTURE.md` @181,517) | **8** | **1** |
| in-place, same length, boundary-preserving (@20,000) | 1 | 1 |
| insertion of 33 chars near the top | **1** | **80** |

CDC is **not** "never worse than byte offsets". It is dramatically better on insertion — the case it
was adopted for, where byte offsets churn the entire downstream tail — and dramatically worse on an
in-place edit that disturbs a boundary. That is the trade; the tables currently state only the half
that flatters it.

### 0e. Two more things the earlier drafts got wrong

- **10 of 25 corpus documents never receive the edit.** Below 20,020 characters,
  `slice(0,20000) + "X"*20 + slice(20020)` is a 20-char **append**. The scenario has been silently
  measuring two operations under one name.
- **The `append at end` row is also false, and draft 2's replacement for it was false too:**
  `ARCHITECTURE.md` churns **0** on append (the appended text lands past the cap), and the "2" ceiling
  holds only for appends shorter than `min` — a 9,000-character append churns 5. Correcting that row
  properly needs its own measurement pass (§4).

**So the chunker is behaving correctly and as designed.** What is wrong is a documented claim, and a
test whose outcome depends on content nobody is thinking about.

## 1. The claims that cannot hold

`docs/design/content-defined-chunking.md` states an unconditional `1` for `edit in place, same length`
in its **acceptance table**. One reviewer read the summary table near the top as making the same claim
and asked for both to be corrected; the other adjudicated and the first was wrong — that table sits
under "Chunking is byte-offset … verified directly against the real function" and measures LEGACY
behaviour, where 1 is a theorem. It is correct as written and is left alone. For byte offsets that 1 is a theorem, because offsets do not
move. For CDC it cannot be: a content-defined boundary **is** content.

## 2. The decision

### 2a. Both tables state the property that is true, and the severity

`edit in place, same length` becomes: **1 when the edit lies wholly inside one chunk and disturbs no
boundary; otherwise the number of chunks it touches, which is unbounded in practice — measured to 78 of
80 on this repo's own corpus.** The prose names the mechanism (a cut is decided by the ~32 code units
ending at it) and carries §0d's trade table, so the next reader sees both directions at once.

`append at end` is marked **conditional and not yet fully characterised**, pointing at the follow-up
(§4) — a true statement of ignorance rather than a fourth invented rule.

### 2b. The test classifies by what determines the outcome, in the right coordinates

Per document, from the same two chunkings the test already computes:

1. is the document long enough to receive an in-place edit (else it is excluded — the operation is an
   append and belongs to that scenario);
2. is the `cdcBoundaries` sequence unchanged;
3. does the edit span lie wholly inside one **admitted** chunk.

The third condition draft 3 first specified — "and no boundary strictly inside the edit span" — turned
out to be DEAD, and a mutation is what proved it: a boundary strictly inside the span necessarily
splits it across two admitted intervals, so condition 3 already covers it. Deleting the redundant term
reddened nothing, and this repo's rule is that a predicate term no test can redden is one the code
would be asserting on trust. It is gone; the SPANNING fixture pins the property it was reaching for.

Only documents satisfying all three are asserted `churn === 1`. Everything else is classified and
reported, never gated. **The coordinate mismatch is named rather than left to be re-derived:**
`cdcBoundaries` is uncapped while churn is measured on the cap-80 chunking, which is exactly why a
past-cap edit can change the sequence and still churn 0.

The partition sum (`strict + reported + excluded === total`) is asserted, and stated for what it is: a
TAUTOLOGY for any total classifier, which pins totality and nothing else. What actually stops a
reports-everything classifier is the STRICT fixture plus a `strict > 0` floor on the live census — an
earlier draft claimed the sum caught it, which review showed it cannot.

### 2c. Both branches get a checked-in fixture, because a live corpus cannot guarantee either

Draft 2 put the changed branch on a fixture and left the strict branch live. Review showed both need
one, for the same reason in mirror image:

- **A strict fixture** — an edit verifiably far from every boundary, asserting sequence-unchanged and
  churn 1 — because if the classifier ever marks every document "changed", the live strict assertion
  quantifies over an empty set and greens.
- **A changed fixture** — an edit centred on one of its own boundaries — asserting the branch is
  *actually* exercised: the boundary exists before, is **absent** after, the sequences differ, and churn
  ≥ 2. Centring is not a guarantee of destruction (the mask can re-fire on the new content, which is one
  of the constructed witnesses above), so without those assertions the branch can go silently dead.
- **A short fixture** (~16k characters) so the excluded bucket is non-empty deterministically. Draft 2
  asserted the live excluded count is non-zero, which re-pins corpus contents:
  `docs/design/graph-extraction-cap.md` is 56 characters from leaving that set.

The live corpus keeps the strict assertion, which is where its liveness pays and where no unrelated
document can redden it: a document that disturbs a boundary simply classifies into the reported bucket.

### 2d. The `it.fails` goes, and the never-worse comparison goes with it

The `it.fails` exists only because the assertion was wrong. The `max(cdc) ≤ max(legacy)` comparison is
**removed for the same-length scenario**, with §0d's measurement recorded at the site: it asserts
`78 ≤ 1` in the general case and `1 ≤ 1` on the strict subset, so it is either false or vacuous. It is
also max-versus-max across *different* documents, which is named where it survives for other scenarios.

## Dependencies

**Deps: none.** `test/graph-cdc.test.ts`, three small fixtures, and two tables in one design document.
No product code changes.

## Build-with

**Build-with tier: Fable / high effort.** Three of the four characterisations of this defect were wrong,
including both previous drafts of this spec, each falsified by a reviewer's constructed or measured
witness. A fourth wrong answer ships as documentation. Two adversarial review rounds on the spec (done —
both BLOCKED, twice) and two on the diff.

## Tier safety

No tier surface changes: a test, three fixtures, and a design document. No product code, no schema, no
API route, no change to `visibleItems`/`visibleTasks`/`visibleGroupIds`.

## 3. Acceptance criteria

- `test/graph-cdc.test.ts` — a checked-in STRICT fixture (edit far from every boundary) asserts sequence-unchanged AND churn exactly 1, so the strict branch cannot go vacuous when the classifier is wrong.
- `test/graph-cdc.test.ts` — a checked-in CHANGED fixture asserts the targeted boundary exists before the edit, is ABSENT after, the sequences differ, and churn ≥ 2 — proving the branch is exercised rather than assuming a centred edit destroys a cut.
- `test/graph-cdc.test.ts` — no ceiling is asserted for the changed branch on any input, and the median assertion is KEPT for the in-place scenario (metric-robust, and it would have caught the original defect); the observed envelope is recorded with its witness and its metric.
- `test/graph-cdc.test.ts` — for every LIVE document classified strict (long enough, sequence unchanged, edit inside one admitted chunk), churn is exactly 1, asserted per document rather than as a corpus maximum one outlier can dominate.
- `test/graph-cdc.test.ts` — a `strict > 0` floor on the live census, because the partition sum is a tautology for any total classifier and cannot catch a reports-everything one; the STRICT fixture is the other half of that guard.
- `test/graph-cdc.test.ts` — a checked-in SHORT fixture makes the excluded bucket non-empty regardless of the live corpus; the live excluded count is reported, never gated.
- `test/graph-cdc.test.ts` — the `it.fails` for CDCCHURN-1 is GONE and the `max(cdc) ≤ max(legacy)` comparison is removed for the same-length scenario, with the measured reason recorded at the site.
- `docs/design/content-defined-chunking.md` — the ACCEPTANCE table's unconditional 1 for `edit in place, same length` is corrected to the conditional property and the prose carries the measured trade in both directions; the summary table above it measures byte offsets, where 1 is a theorem, and is deliberately untouched.
- `docs/design/content-defined-chunking.md` — the `append at end` row is marked conditional and points at the follow-up ticket, rather than carrying either the old unconditional 1 or an unverified replacement.

## 4. Scope

**In:** the two `edit in place` table rows and their prose, the reclassified scenario, three fixtures,
removal of the `it.fails` and of the same-length never-worse comparison.

**Deferred, each with its reason:**

- **`CDCAPPEND-1` — characterising the append row properly.** Draft 2's replacement was falsified twice
  (a past-cap document churns 0; an append longer than `min` churns 5), and inventing a third rule here
  would repeat this ticket's entire history one row down. This slice removes the false claim and states
  the gap; measuring the real rule is its own pass.
- **Changing the chunker.** Draft 1 said no scheme could do better, which review correctly called too
  strong: the cascade length is partly a consequence of restarting the search at the previous chunk's
  start plus the 4,000-character maximum. It is rejected on a different ground — any prior-boundary-aware
  recovery makes chunking depend on the PREVIOUS chunking, and "same body ⇒ same chunks ⇒ same hashes"
  is the invariant the whole delta ledger rests on (`lib/graph/cdc.ts:11-13`).
- **Re-litigating CDC vs byte offsets.** §0d shows the trade is real in both directions. Whether the
  in-place tail justifies the insertion win is a design question with its own measurements; this slice
  makes the trade visible instead of documenting only its good half.
- **Making the whole corpus a fixture.** The live corpus was a deliberate choice and still pays for the
  strict assertion; §2c removes the luck from everything that gates.

## 5. What would falsify this

Wrong if a document classified strict — sequence unchanged, edit inside one admitted chunk, no interior
boundary — still churns anything but 1. That is the rule verified at 4,962/4,962, so a counterexample
means a fifth mechanism exists and the classifier is measuring the wrong thing.

Wrong in the other direction if the changed fixture's targeted boundary survives its own centred edit,
which would mean the fixture is not exercising the branch it claims — the reason that assertion exists
rather than trusting the construction.
