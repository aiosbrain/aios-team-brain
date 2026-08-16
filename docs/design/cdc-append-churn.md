# Append churn is a bound, not a number — CDCAPPEND-1

**Status:** spec, draft 1 · **Date:** 2026-08-16 · **Owner:** Chetan · **Task:** `CDCAPPEND-1`
**Related:** [`content-defined-chunking.md`](./content-defined-chunking.md) (the table this corrects),
[`cdc-boundary-overlap.md`](./cdc-boundary-overlap.md) (`CDCCHURN-1`, the row above this one).
**Code:** `test/graph-cdc.test.ts`, `scripts/cdc-churn-sweep.mjs`, `lib/graph/cdc.ts` (read only —
no product change; that IS the finding, exactly as it was one row up).

**Every number below comes from one run of `node scripts/cdc-churn-sweep.mjs --op append`**, which
stamps its own `revision` (SHA + whether the tree was dirty) for the reason this ticket's neighbour
learned the hard way: a published measurement stopped reproducing, and the retraction story was wrong
too. Figures here were taken at `46aad5c` with this spec present in the tree — **which matters, because
the design documents ARE the corpus**: this file is ≥ 15,000 characters, so it joined the measured set
and took it from 28 documents to 29. Re-run the sweep rather than trusting a number quoted here.

---

## 0. What is wrong

`docs/design/content-defined-chunking.md`'s acceptance table currently reads:

| scenario | byte-offset (today) | CDC (required) |
|---|---|---|
| append at end | 1 of 20 | conditional, not yet characterised (`CDCAPPEND-1`) |

That cell is `CDCCHURN-1`'s deliberate statement of ignorance, left in place rather than filled with a
fourth invented rule. This slice fills it — and, in measuring it, found that the **test** guarding the
row asserts two things that are not properties of appends at all (§0e).

### 0a. Four characterisations of this row, all four falsified by measurement

Three were falsified during `CDCCHURN-1`'s review. **The fourth was this draft's own, and it was wrong
too** — which is why the rule below was measured before it was written, the order that ticket ended on.

1. *"Churn is 1."* — The original acceptance-table claim. False in both directions: `docs/ARCHITECTURE.md`
   churns **0** (146 boundaries against an 80-chunk admitted cap, so an append lands past the admitted
   prefix and is dropped entirely), and for the test fixture's own 66-character append **4 of 29**
   corpus documents churn **2** (`fixtureAppend.churnDistribution`: `{0: 1, 1: 24, 2: 4}`).
2. *"1 unless the appended text splits the final chunk, then 2."* — False in both halves. The 0 case
   breaks the floor, and the 2s are not "the append split the final chunk": the new cut lands inside the
   **appended** region, which moves the final boundary and therefore changes the chunk before it too.
3. *"2 is the ceiling."* — Holds only for appends shorter than `min`. A 9,000-character prose append
   churns 4–5 and a 60,000-character one churns 23–24 (§0d).
4. *(this draft's first candidate)* *"churn = 1 + the number of new chunks, or 0 when capped."* —
   **469 of 580 samples, 80.9%.** Every miss is in the same direction, and `docs/TODO.md` is the
   clearest witness: it says 1 where the answer is 2, at four different append lengths. The mechanism is
   §0d — a document's final chunk frequently has no cut at all, the text simply ended, so extending the
   tail lets the chunker *find* a cut inside the appended region and move the last boundary **without
   adding a chunk**. The candidate is kept runnable in the sweep (`candidate1`) so the refutation
   reproduces rather than being asserted.

### 0b. The rule, and it is a BOUND with a proof, not a fitted constant

Let `B₀` and `B₁` be the (uncapped) boundary sequences of the document before and after the append, and
let `L` be the length of their longest common prefix — the index of the last boundary the two chunkings
**share**. Then:

> **churn ≤ max(0, min(cap, |B₁|) − L)** — the number of ADMITTED chunks lying after the last shared
> boundary.

**The bound is a theorem, not a measurement.** Chunks `0 … L−1` are byte-identical across the two
chunkings, so under the SET metric the ledger pays (`lib/graph/project.ts:1222-1223` filters by
`new Set(chunk_shas)` MEMBERSHIP) none of them can be re-pushed; at most the chunks after `L`, truncated
at the cap, can be. Stating it as a bound rather than an equality is the correction: all four earlier
attempts stated an equality, and an equality is what keeps being falsified.

**And it is measured tight.** 29 documents × 10 append lengths × 2 append contents = **580 samples;
bound holds 580/580; exactly tight 580/580 under both the set metric and a positional diff; zero
violations, zero slack.**

**The cap term is a CONSEQUENCE, not a term.** "0 when the document already fills the admitted cap" was
this draft's second clause. It is redundant: an append can only move boundaries near the end (§0d), so a
document with more than `cap` boundaries always has `L ≥ cap` and `min(cap, |B₁|) − L` is already ≤ 0.
`CDCCHURN-1` deleted a predicate term for exactly this reason — "a term no test can redden is one the
code would be asserting on trust" — and the same standard applies to prose. The clause is gone; a
fixture asserts the property instead.

### 0c. Where the bound is NOT tight, and why that is the safe direction

The set metric comes in **below** the bound when a new chunk's content already appears elsewhere in the
document — an identical chunk is never re-pushed, so it costs nothing. Constructed (`duplicateProbe`):
appending a 60,000-character document **to itself** re-cuts the tail into 25 positionally-changed chunks
of which **23 are byte-identical to chunks that already exist**, so the ledger pays **2** where the bound
says 25. (`CDCCHURN-1` found and pinned the same asymmetry for in-place edits; this is that finding one
row down.)

Two things make this the right shape rather than a hole:

- **The error direction is conservative.** The bound over-states cost, never under-states it, so a churn
  budget derived from it is safe. `CDCCHURN-1`'s published-78 incident was the opposite direction — a
  positional count quoted as a cost — and this row must not repeat it.
- **Appending duplicate text does not generally save anything.** Appending one existing chunk *verbatim*
  still churns the full predicted amount, because the boundary shift means the re-cut chunks are not
  byte-identical to the original one. Only a realignment that reproduces **whole** chunks pays off,
  which is why self-concatenation is the witness and a smaller duplicate is not.

### 0d. The mechanism: an append disturbs only the tail — and can DELETE a boundary there

**The structural claim.** In `cdcBoundaries` (`lib/graph/cdc.ts:222`), the boundary ending chunk `k` is
computed from `text[startₖ … min(startₖ + max, n))`, and `n` enters only through `hardEnd` and the
`n − start <= min` short-tail exit. So every boundary whose chunk **start** lies at least `max` (4,000)
code units before the original end is computed from unchanged input and cannot move. Verified across all
580 samples: `movedOutsideMaxWindow` is **0**. Measured divergence depth `|B₀| − L`:

| boundaries moved | 1 | 2 | ≥ 3 |
|---|---:|---:|---:|
| samples (580) | 462 | 118 | **0** |

That is why §0b's cap clause is redundant, and it is also the death of "the appended text splits the
final chunk": an append routinely changes the chunk **before** the last one.

**And it can remove a boundary entirely.** `docs/design/work-timeline-context-layer.md` has 12
boundaries; appending **one character** leaves it with 11 — the cut at 28,384 disappears and two chunks
merge. The mechanism is the backup boundary, documented in the module without this consequence ever
being drawn (`lib/graph/cdc.ts:218-220`): no primary mask fires anywhere in that final chunk's search
window, so the cut comes from the backup mask, whose preference order is *"the first backup hit at or
after `target` if there is one, otherwise the first backup hit at all"*. Appending one character extends
`hardEnd` by one; that character's position satisfies the backup mask **and** sits past `target`, so it
outranks the earlier backup and the previous cut ceases to exist. Confirmed by re-running the module's
own hash roll at that chunk start: primary cut `−1` in both versions, backup `28384` before and `29665`
after. The bound holds through it (`L = 10`, `|B₁| = 11`, predicted 1, measured 1) — which is the point
of stating the rule against the shared-boundary prefix rather than against the chunk count.

### 0e. Churn depends on the appended CONTENT, not only its length — so the guarding test is not a property

The new boundaries are content-defined, so two appends of the *same length* churn differently. Measured
(`perLength`, prose filler vs a hash-quiet run of one repeated character):

| append length | prose filler | hash-quiet filler |
|---|---|---|
| 2,500 | `{0:1, 2:17, 3:11}` | `{0:1, 1:26, 2:2}` |
| 9,000 | `{0:1, 4:9, 5:19}` | `{0:1, 3:26, 4:2}` |
| 60,000 | `{0:1, 23:9, 24:19}` | `{0:1, 16:28}` |

A hash-quiet run yields few cuts, so 60,000 characters of it become 16 chunks where prose becomes 24.
Growth is therefore *roughly* one chunk per `target` characters **of ordinary prose**, and any statement
of the form "an append of N characters churns K" is under-specified. This is the fifth thing the row
never mentioned, and it kills a constant more thoroughly than length alone does.

It also decides the two assertions guarding the row today:

- **`append at end — CDC re-extracts <= 1 chunk(s)`** (`test/graph-cdc.test.ts:368`) is asserted against
  one 50,000-character fixture and one 66-character append. Over the corpus that same append churns 2 on
  4 of 29 documents, and the same fixture with a 2,500-character prose append churns 3.
- **`CDC must never be worse than byte offsets`** (`test/graph-cdc.test.ts:433`) is **not a property, and
  its outcome is decided by content nobody chose deliberately.** At the fixture's own append, CDC is
  strictly worse than byte offsets on **4 of 29** documents and the comparison passes anyway, because it
  compares max against max **across different documents** and a fifth, unrelated document churns 2 under
  legacy. Change the append content at one fixed length of 2,500 and the same comparison **fails**
  outright under one prose filler (`maxCdc 3 > maxLeg 2`), **passes** under a second prose filler, and
  passes under the hash-quiet filler with CDC strictly *better* on 26 of 29. `CDCCHURN-1` removed this
  comparison for `edit in place` and named the max-versus-max flaw where it survived — this is that
  flaw, firing.

So the honest trade for this row: **CDC is mildly worse than byte offsets on append** for ordinary prose
— it re-cuts the tail where byte offsets only extend it — and dramatically better on insertion (CDC 1
against legacy 80). That is the same shape `CDCCHURN-1` documented for in-place edits, and the table
should say it rather than imply parity.

## 1. The claims that cannot hold

- The acceptance table's `append at end` row cannot carry a constant: churn grows with append length,
  varies with append content at fixed length (§0e), and collapses to 0 past the cap.
- The summary table at the top of `content-defined-chunking.md` (`| append at the end | 1 |`) measures
  **legacy** behaviour on a 50,000-character document, where 20 full chunks plus a 66-character append
  yields exactly one new chunk. It is correct as written for what it measures and is left alone — the
  same adjudication `CDCCHURN-1` reached for the row above, recorded here so it is not re-opened.

## 2. The decision

### 2a. The table row states a bound, its mechanism, and the trade

`append at end` becomes: **at most the number of admitted chunks after the last boundary the two
chunkings share — 1 for a short append to an uncapped document, 0 once the document fills the cap, and
growing with both the length and the entropy of the appended text.** The prose names the mechanism (only
boundaries within `max` of the end can move; the backup-boundary preference can delete one) and carries
§0e's trade, so the row states both directions at once.

### 2b. The test asserts the bound per document, never a constant

For every live corpus document × append lengths spanning the regimes (below `min`, around `target`,
multiples of it) × two append contents, from the two boundary sequences the test already computes:

1. `L` and the predicted admitted count;
2. set churn **≤** predicted — the theorem, which holds for every input;
3. equality on the live corpus, with the count of strict cases reported, so the duplicate-content case
   becomes visible rather than silently absorbed into a `≤`.

No constant ceiling is asserted for any append length, because a ceiling is what made this row wrong
four times.

### 2c. Four checked-in fixtures, because the live corpus cannot guarantee any of these branches

`CDCCHURN-1`'s lesson exactly: a live-corpus assertion that quantifies over an empty set is green.

- **CAPPED** — a document past the admitted cap, asserting churn 0 AND that it exceeds the cap, so the
  assertion cannot pass by the document simply being short. Today only `docs/ARCHITECTURE.md` reaches
  the cap on the live corpus; one refactor and that branch is empty.
- **MERGE** — a document whose final cut comes from the backup mask, asserting the boundary count
  **falls** on a one-character append, the specific boundary is present before and absent after, and the
  bound still holds. Without the before/after assertions the fixture can silently stop exercising it.
- **DUPLICATE** — self-concatenation, asserting set churn is strictly **below** the bound while the
  positional count equals it. This is the one branch that proves the rule is an inequality; nothing on
  the live corpus reaches it.
- **GROWTH** — one document across the length sweep under two append contents, asserting churn is
  non-decreasing in length, reaches ≥ 4 by 9,000 characters of prose, and **differs between the two
  contents at the same length** — so §0e's content-dependence is pinned by a test, not only by prose.

### 2d. The false comparison goes, with its measurement recorded at the site

`max(cdc) ≤ max(legacy)` is removed for `append at end` and §0e is recorded at the removal site, naming
both why it passes today (max-versus-max across different documents) and that its outcome flips with the
appended content at a fixed length. The `<= 1` scenario assertion is replaced by the bound. The
comparison is **kept** for the insertion and deletion scenarios, where it is true per-document and is
the reason this lever exists.

### 2e. The sweep script gains the append operation

`scripts/cdc-churn-sweep.mjs` gains `--op append`: documents × lengths × append contents, reporting both
metrics, the divergence depth, the falsified candidate, the legacy comparison per document, and a
`revision` stamp. It also gains a corrected corpus definition — a comment claimed its `> 4,000`-character
set was "the same corpus `test/graph-cdc.test.ts` reads", which it never was (the test reads three
directories at ≥ 15,000 characters). That is a number measured over one population and asserted over
another, which is this ticket's own failure mode.

## Dependencies

**Deps: none.** One test file, four small fixtures, one script, and one table row in one design
document. No product code, no schema, no API surface.

## Build-with

**Build-with tier: Fable / high effort.** Four characterisations of this row have now been falsified, one
of them this draft's own first candidate at 80.9%. A fifth wrong answer ships as documentation and as a
test that pins it. Two adversarial spec reviews (Fable + Codex) before any code, two on the diff.

## Tier safety

No tier surface changes: a test, four fixtures, a script, and a design document. No product code, no
schema, no API route, no change to `visibleItems`/`visibleTasks`/`visibleGroupIds`.

## 3. Acceptance criteria

- `test/graph-cdc.test.ts` — for every live corpus document at every swept append length and append content, set churn is asserted `<= max(0, min(cap, |B1|) - L)`, per document rather than as a corpus maximum one outlier can dominate.
- `test/graph-cdc.test.ts` — a CAPPED fixture asserts churn 0 AND that the document exceeds the admitted cap, so the branch cannot pass by the document being short.
- `test/graph-cdc.test.ts` — a MERGE fixture asserts the boundary count FALLS on a one-character append, the vanishing boundary is present before and absent after, and the bound still holds.
- `test/graph-cdc.test.ts` — a DUPLICATE fixture asserts set churn is strictly below the bound while the positional count equals it, pinning the rule as an inequality rather than an equality that happens to hold.
- `test/graph-cdc.test.ts` — a GROWTH fixture asserts churn is non-decreasing in append length, reaches at least 4 by a 9,000-character prose append, and DIFFERS between two append contents of the same length; no constant ceiling is asserted for any length.
- `test/graph-cdc.test.ts` — the `append at end — CDC re-extracts <= 1 chunk(s)` assertion and the `max(cdc) <= max(legacy)` comparison for append are GONE, with the measured reason recorded at the site (4 of 29 documents strictly worse at the fixture's own append; the comparison's outcome flips with append content at a fixed length).
- `test/graph-cdc.test.ts` — the live-corpus equality census is reported and a `documents > 5` floor is asserted, because a bound assertion over an empty or single-document corpus is green by construction.
- `scripts/cdc-churn-sweep.mjs` — `--op append` sweeps documents x lengths x append contents, reports SET and POSITIONAL churn, divergence depth, the falsified candidate and the per-document legacy comparison, and stamps the revision it measured.
- `scripts/cdc-churn-sweep.mjs` — the corpus helper names its two definitions explicitly and the false "the same corpus the test reads" comment is corrected; the in-place mode's existing numbers reproduce unchanged.
- `docs/design/content-defined-chunking.md` — the acceptance table's `append at end` row states the bound, the cap collapse, and that growth depends on the appended content as well as its length; the prose carries the measured CDC-vs-legacy trade in both directions.
- `docs/design/content-defined-chunking.md` — the summary table's legacy `| append at the end | 1 |` is deliberately untouched, with the adjudication recorded so it is not re-opened a third time.

## 4. Scope

**In:** the `append at end` acceptance row and its prose, the append scenario's two false assertions,
four fixtures, the sweep script's append mode and corpus correction.

**Deferred, each with its reason:**

- **Changing the chunker so appends never re-cut the tail.** The obvious fix — remember the previous
  chunking and keep its boundaries — makes chunking depend on the PREVIOUS chunking, and
  "same body ⇒ same chunks ⇒ same hashes" is the invariant the whole delta ledger rests on
  (`lib/graph/cdc.ts:11-13`). Rejected on that ground, not on cost.
- **The orphan-tail question the MERGE case raises.** When two chunks merge, the vanished chunk's
  episode is still in the graph and nothing purges it. That is the same orphan-tail issue
  `content-defined-chunking.md` already records for a cap shrink, it predates this slice, and it is a
  product decision about purge rather than a churn measurement.
- **Re-litigating CDC vs byte offsets.** §0e shows append is a mild loss and insertion a large win.
  Whether the balance is right is a design question with its own measurements; this slice makes the loss
  visible instead of asserting a parity that is not there.
- **A cross-operation churn budget.** Three rows of that table are now conditional. Turning them into one
  predictive cost model for the projector is separate work with a separate consumer.

## 5. What would falsify this

Wrong if any document at any append length and content churns **more** than the bound — that would mean
a chunk at an index below `L` changed, contradicting the byte-identity the proof rests on, and would mean
the divergence-depth window in §0d is not what the code does.

Wrong in the other direction if the DUPLICATE fixture's set churn ever **equals** the bound, which would
mean the fixture stopped exercising the inequality and the rule is being pinned as an equality again —
the failure this row has now had four times.
