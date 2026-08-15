# CDC churn 1 holds unless the edit destroys a boundary — CDCCHURN-1

**Status:** spec, pre-review.
**Related:** `docs/design/content-defined-chunking.md` (the requirement table this corrects). Surfaced by the
LLMOBS-2 slice, whose spec document joined this test's live corpus and happened to straddle a chunk
boundary — that document is on an unmerged branch, hence no path reference here.

---

## 0. What is wrong, and what is NOT

`test/graph-cdc.test.ts` carries an `it.fails` naming this ticket: over the live corpus of repo
markdown, one document churns **4** chunks for a same-length in-place edit where
`docs/design/content-defined-chunking.md`'s acceptance table requires **1**.

**The ticket blamed the wrong thing, and so did the comment in the test.** Both said the edit lands in
"a run of structurally repetitive markdown bullets — low entropy — and the boundary realignment
propagates". That was a guess. Measured:

| edit offset | churn | distance to nearest boundary |
|---:|---:|---:|
| **20,000** | **4** | **1** |
| 19,000 | 1 | 1,001 |
| 18,000 | 1 | 841 |
| 17,000 | 1 | 159 |
| 21,000 | 1 | 999 |
| 22,000 | 1 | 519 |
| 15,000 | 1 | 491 |

The scenario edits 20 characters at a FIXED offset of 20,000. In this one document a boundary sits at
**20,001**, so the edit overwrites the very content that produced the cut. The chunk merges with its
successor and the anchor chain re-syncs three chunks later. At every other offset tested — including
ones only 159 bytes from a boundary — CDC delivers exactly the required churn of 1.

**So the chunker is behaving correctly and as designed.** Zero of the ten chunks in that document take
the `max`-length fallback, which was the other plausible mechanism and is refuted. What is wrong is a
documented claim and a test's construction.

## 1. The claim that cannot hold

`docs/design/content-defined-chunking.md`'s acceptance table states:

| scenario | byte-offset (today) | CDC (required) |
|---|---|---|
| edit in place, same length | 1 of 20 | **1** |

For byte offsets that 1 is a theorem: offsets do not move, so exactly the containing chunk changes.
For CDC it cannot be a theorem, because a content-defined boundary is part of the content: an edit
that OVERLAPS a boundary destroys it, and the chunk necessarily merges with its neighbour. The spec's
own prose already concedes the general shape — *"realignment after an insertion is empirical rather
than guaranteed"* — but the table promises an unconditional 1 for this row, and that is what the test
was asserting.

The exposure is small and quantifiable: for a 20-character edit against a ~2,500-character target
chunk, roughly **20 in 2,500 ≈ 0.8%** of offsets overlap a boundary. Across a 23-document corpus with
one fixed offset, the chance that at least one document is hit is substantial — which is exactly what
happened, and only when a 26k-character document was added.

## 2. The decision

**Correct the claim, and make the test measure the property that is actually true.**

### 2a. The requirement table states the real property

The `edit in place, same length` row becomes: **1 when the edit does not overlap a chunk boundary;
bounded realignment when it does** (measured ceiling 6 over this corpus, the same bound the other
scenarios already carry). The prose beside it names the mechanism — a content-defined boundary is part
of the content, so an edit through it removes the cut — so the next reader does not have to re-derive
what this ticket re-derived.

### 2b. The test asserts that property, and stops depending on luck

`repoDocs()` reads a LIVE corpus and the scenario edits at a fixed offset, so which documents overlap
a boundary changes whenever anyone adds or edits a long markdown file. That is the real defect in the
test: not that its assertion was too strict, but that whether it passes depends on content nobody is
thinking about when they write it.

The scenario therefore SPLITS by the thing that actually determines the outcome:

- documents whose edit does NOT overlap a boundary must churn exactly **1** — the strict property,
  asserted strictly, on every such document;
- documents whose edit DOES overlap must churn within the existing ceiling (**6**), which is the
  honest bound for realignment.

Boundary overlap is computable from `cdcBoundaries` directly, so the split is derived from the corpus
rather than hard-coded, and a future document that happens to straddle a cut is classified rather than
breaking the build.

### 2c. The `it.fails` goes away

It exists only because the assertion was wrong. Once the assertion states a true property, a passing
test is the honest artefact and an `it.fails` would be recording a defect that does not exist.

## Dependencies

**Deps: none.** `test/graph-cdc.test.ts` and one table in `docs/design/content-defined-chunking.md`. No product
code changes — which is the finding, not a shortcut.

## Build-with

**Build-with tier: Fable / high effort.** Justification: the whole slice is a claim about an algorithm's
guarantees, and the previous two attempts to characterise this failure were BOTH wrong (a "the spec
disclaims it" argument that the spec contradicts, and a "low-entropy content" mechanism the measurement
refutes). A third wrong characterisation would be worse than the original bug, because it would ship as
documentation. Two adversarial review rounds.

## Tier safety

No tier surface changes: a test and a design document. No product code, no schema, no API route, no
change to `visibleItems`/`visibleTasks`/`visibleGroupIds`.

## 3. Acceptance criteria

- `test/graph-cdc.test.ts` — for every corpus document whose same-length in-place edit does NOT overlap a chunk boundary, CDC churn is exactly 1, asserted per document rather than as a corpus-wide maximum that one outlier can dominate.
- `test/graph-cdc.test.ts` — for a document whose edit DOES overlap a boundary, churn is within the existing ceiling of 6 — and the test proves such a document is actually present in the corpus, so the branch is not vacuous.
- `test/graph-cdc.test.ts` — the boundary-overlap classification is derived from `cdcBoundaries`, not from a hard-coded document name or offset, so a corpus change reclassifies rather than reddens.
- `test/graph-cdc.test.ts` — the `it.fails` for CDCCHURN-1 is GONE, and no scenario is skipped: the "never worse than byte offsets" comparison is restored for every scenario, since the reason it was scoped out no longer stands.
- `docs/design/content-defined-chunking.md` — the acceptance table's `edit in place, same length` row states the conditional property and names the mechanism, so the unconditional claim cannot be re-derived from the document.

## 4. Scope

**In:** the acceptance-table row and its prose, the split scenario in `test/graph-cdc.test.ts`, removal
of the `it.fails` and of the scoped-out comparison.

**Deferred, each with its reason:**

- **Changing the chunker.** Nothing is wrong with it. Making a same-length edit through a boundary
  churn only 1 would require boundaries that are not content-defined, which is the property being
  bought.
- **Making the corpus a fixture.** `docs/design/content-defined-chunking.md` explicitly chose a live corpus
  ("measuring against the corpus as it is now, and a snapshot would stop being real the week after").
  This slice removes the luck without removing the liveness; freezing it is a different trade and
  would need its own argument.
- **The other scenarios' offsets.** Insertion and deletion have the same fixed-offset property, but
  their assertions are ranges rather than an exact 1, so a boundary-overlap document does not break
  them. Worth revisiting only if it ever does.

## 5. What would falsify this

Wrong if a document whose edit does NOT overlap a boundary still churns more than 1 — that would mean
overlap is not the mechanism and the low-entropy theory (or another) is back in play. The per-document
strict assertion is what would catch it, where the old corpus-wide maximum hid it behind one outlier.

Wrong in the other direction if realignment for an overlapping edit ever exceeds 6, which would mean
the bound is not a bound. Both directions are asserted rather than assumed.
