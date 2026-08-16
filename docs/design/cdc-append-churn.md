# Append churn is a bound, not a number — CDCAPPEND-1

**Status:** spec, draft 3. Drafts 1 and 2 were each BLOCKED by two independent cold reads. Draft 1's
central claim was falsified twice over (whitespace-only bodies; the cap), so draft 2 restated the bound in
the coordinates the cost is paid in — and draft 2 then smuggled the ORIGINAL false constant back in as the
replacement row's gloss (§2a), which the round-2 reads caught. Six characterisations of one table row have
now been falsified; three of them were mine.
**Date:** 2026-08-16 · **Owner:** Chetan · **Task:** `CDCAPPEND-1`
**Related:** [`content-defined-chunking.md`](./content-defined-chunking.md) (the table this corrects),
[`cdc-boundary-overlap.md`](./cdc-boundary-overlap.md) (`CDCCHURN-1`, the row above this one).
**Code:** `test/graph-cdc.test.ts`, `scripts/cdc-churn-sweep.mjs`, `lib/graph/cdc.ts` (read only —
no product change; that IS the finding, exactly as it was one row up).

**Every number below comes from one run of**

```
node scripts/cdc-churn-sweep.mjs --op append --exclude docs/design/cdc-append-churn.md
```

which stamps its own `revision` (SHA + whether the tree was dirty). `--exclude` is not a convenience: the
design documents ARE the corpus, this file is over 15,000 characters, and **draft 1's §0e table had
already gone stale by the time it was reviewed because writing the draft moved the document it was
measuring into a different churn bucket.** Both reviewers caught it. Excluding this file makes the
published distributions stable against the document that publishes them.

---

## 0. What is wrong

`docs/design/content-defined-chunking.md`'s acceptance table currently reads:

| scenario | byte-offset (today) | CDC (required) |
|---|---|---|
| append at end | 1 of 20 | conditional, not yet characterised (`CDCAPPEND-1`) |

That cell is `CDCCHURN-1`'s deliberate statement of ignorance, left rather than filled with a fourth
invented rule. This slice fills it — and, in measuring it, found that the **test** guarding the row
asserts two things that are not properties of appends at all (§0f).

### 0a. Six characterisations of this row, all six falsified by measurement

Three were falsified during `CDCCHURN-1`'s review. **Three more were falsified in this ticket, and all
three were mine** — one by my own sweep, two by the reviewers of draft 1. That is the reason this row
gets a bound with a proof instead of a fifth constant.

1. *"Churn is 1."* — The original claim. False in both directions: `docs/ARCHITECTURE.md` churns **0**
   (146 boundaries against an 80-chunk cap, so an append lands past the admitted prefix), and for the
   test fixture's own 66-character append **4 of 28** corpus documents churn **2**
   (`fixtureAppend.churnDistribution` = `{0: 1, 1: 23, 2: 4}`).
2. *"1 unless the appended text splits the final chunk, then 2."* — False in both halves; the 2s are not
   splits of the final chunk (§0d).
3. *"2 is the ceiling."* — Holds only below `min`. A 9,000-character prose append churns 4–5, a
   60,000-character one 23–24 (§0e).
4. *(draft 1, mine)* *"churn = 1 + the number of new chunks, or 0 when capped."* — **449 of 560
   samples, 80.2%** (`candidate1`). Every miss is in the same direction; `docs/TODO.md` is the clearest
   witness, saying 1 where the answer is 2 at four different append lengths. Mechanism in §0d.
5. *(draft 1, mine — found by BOTH reviewers)* *the bound stated over the **boundary** sequences.*
   `chunkCdc` returns `[]` for a whitespace-only body (`lib/graph/cdc.ts:271`) while `cdcBoundaries`
   still returns boundaries, so a whitespace base has a non-empty shared boundary prefix and an **empty**
   before-set. **20,000 spaces plus one `x` churns 6 against a boundary-form bound of 1.** The proof's
   premise — "those chunks are byte-identical so cannot be re-pushed" — fails because they were never
   pushed. §0b restates the bound over chunks, where the premise is true by construction.
6. *(draft 1, mine — found by Fable)* *"0 once the document fills the cap."* — False, and it was in the
   proposed table row, which would have made it the fifth wrong characterisation shipping as
   documentation. What must reach the cap is the **shared prefix**, not the boundary count, and an append
   moves the last one or two boundaries. Constructed and committed as `capProbe`:

   | boundaries | append | shared chunks | bound | churn |
   |---:|---:|---:|---:|---:|
   | 79 | 66 | 78 | 1 | 1 |
   | 79 | 2,500 | 78 | 2 | 2 |
   | **80 (= cap)** | 66 | 79 | 1 | **1** |
   | **80 (= cap)** | 2,500 | 79 | 1 | **1** |
   | 81 | 2,500 | 80 | 0 | 0 |

   A document sitting exactly at the cap churns **1**, not 0.

### 0b. The rule, in the coordinates the cost is paid in

Let `C₀` and `C₁` be the **admitted chunk arrays** (`chunkCdc`, i.e. already capped) before and after the
append, and `L` the length of their longest common prefix. Then:

> **churn ≤ |C₁| − L** — the number of admitted chunks after the last chunk the two chunkings share.

**A theorem with no preconditions.** Chunks `0 … L−1` of `C₁` are byte-identical to chunks of `C₀` and
therefore members of the before-set, so `lib/graph/project.ts:1222-1223` — which filters by
`new Set(chunk_shas)` MEMBERSHIP — can never re-push them. The whitespace case (characterisation 5) is
covered rather than excluded: a whitespace base gives `C₀ = []`, hence `L = 0` and a bound of `|C₁|`,
which is trivially satisfied. The cap needs no term either: `C₁` is already truncated.

**Measured tight: 28 documents × 10 append lengths × 2 append contents = 560 samples, bound holds
560/560, exactly tight 560/560.** One honesty note the reviewers were right to force: of the three
figures in that sentence, **only set-metric tightness is a measurement.** "Holds 560/560" is the theorem
restated, and positional tightness is near-tautological (chunks after `L` differ at their index by
construction, up to byte coincidence). The informative claim is that the SET metric — the one that costs
money — sits exactly on the bound everywhere except duplicate content (§0c).

### 0c. Where the bound is NOT tight, and why that is the safe direction

The set metric falls **below** the bound when a new chunk's content already exists in the document.
Committed as `duplicateProbe`: appending a 60,000-character document **to itself** shares 22 chunks and
re-cuts the tail into 25 positionally-changed chunks of which 23 are byte-identical to existing ones, so
the ledger pays **2** where the bound says 25.

- **The error direction is conservative** — the bound over-states cost, so a churn budget derived from it
  is safe. `CDCCHURN-1`'s published-78 incident was the opposite direction (a positional count quoted as
  a cost), and this row must not repeat it.
- **Appending duplicate text does not generally save anything.** Committed as `verbatimChunkProbe`:
  appending one existing chunk *verbatim* churns the full bound of 2, because the boundary shift means
  the re-cut chunks are not byte-identical to the original. Only a realignment reproducing **whole**
  chunks pays, which is why self-concatenation is the witness and a smaller duplicate is not.

### 0d. The mechanism: an append disturbs only the tail — and can DELETE a boundary there

**The structural claim.** In `cdcBoundaries` (`lib/graph/cdc.ts:222`) the boundary ending chunk `k` is
computed from `text[startₖ … min(startₖ + max, n))`, and `n` enters only through `hardEnd` and the
`n − start <= min` short-tail exit. So a boundary whose chunk **start** lies **more than** `max` (4,000)
code units before the original end is computed from unchanged input and cannot move —
`movedOutsideMaxWindow` is **0** across all 560 samples.

"More than", not "at least": review produced a witness at exactly `max`. For
`"0".repeat(3999) + "\uD800"` the single boundary sits at 4,000, and appending a low surrogate moves it
to 4,001 through `avoidSurrogateSplit` (`lib/graph/cdc.ts:194`). Malformed UTF-16 only, and the depth and
absolute ceilings both survive it (starts in `[n − max, n)` spaced at least `min` still number at most
4) — but the instrument tested `> max` while the prose said `≥ max`, so the prose was a paraphrase of
what was actually checked, which is the failure mode this repo names "mutate with the real shape".

**The provable ceiling on divergence depth is 4, and the observed maximum is not it.** Non-final chunks
are at least `min`, so at most `1 + ⌊(max − 1)/min⌋ = 4` chunk starts can lie inside that window. The
sweep observes a maximum of **2** on the live corpus and **3** on its 400 synthetic documents
(`absoluteGuard.synthetic.maxDepthObserved`; Codex independently constructed one at seed 1307). So the
corpus figure is an observation, not a ceiling. One reviewer proposed that depth ≤ 2 "looks provable" for
these parameters — **that is refuted by the committed script's own output**;
the assertions in §2 use the derived 4, never the observed 2, which is the same discipline `CDCCHURN-1`
adopted after publishing a sparse-grid maximum as if it were a bound.

This also kills "the appended text splits the final chunk": an append routinely changes the chunk
**before** the last one. And `docs/TODO.md` shows the mechanism behind characterisation 4 — its final
chunk is a 485-character short tail taken by the `n − start <= min` exit, so appending gives that region
a real cut and moves a boundary **without adding a chunk**.

**An append can also remove a boundary, and which characters do it is content-dependent.** Committed as
`mergeProbe` against `docs/design/work-timeline-context-layer.md` (12 boundaries): appending `q`, `%` or
`5` deletes the boundary at 28,384 and leaves 11; appending `x`, `a`, `z`, space, `.` or newline leaves
all 12. Draft 1 said "appending **one character**" without naming it — false as an unqualified claim, in
a spec whose §0e is about content-dependence, and the sweep's own length-1 samples use `z` and `a`, so
the committed script never observed the event it described. It does now.

The mechanism is the backup boundary, documented in the module without this consequence being drawn
(`lib/graph/cdc.ts:218-220`): no primary mask fires in that final chunk's search window, so the cut comes
from the backup mask, whose preference is *"the first backup hit at or after `target` if there is one,
otherwise the first backup hit at all"*. The appended character extends `hardEnd` by one; if that
position satisfies the backup mask **and** sits past `target`, it outranks the earlier backup and the
previous cut ceases to exist. The bound holds through it (bound 1, churn 1).

**This witness is live content and is expected to rot.** It is illustrative; the durable version is the
checked-in MERGE fixture (§2c).

### 0e. Churn depends on the appended CONTENT, not only its length

Two appends of the same length churn differently, because the new boundaries are content-defined
(`perLength`, prose filler vs a hash-quiet run of one repeated character):

| append length | prose filler | hash-quiet filler |
|---|---|---|
| 2,500 | `{0:1, 2:16, 3:11}` | `{0:1, 1:25, 2:2}` |
| 9,000 | `{0:1, 4:9, 5:18}` | `{0:1, 3:25, 4:2}` |
| 60,000 | `{0:1, 23:9, 24:18}` | `{0:1, 16:27}` |

A hash-quiet run yields few cuts, so 60,000 characters of it become 16 chunks where prose becomes 24.
Growth is *roughly* one chunk per `target` characters **of ordinary prose**, and any claim of the form
"an append of N characters churns K" is under-specified.

### 0f. The two assertions guarding this row today

- **`append at end — CDC re-extracts <= 1 chunk(s)`** (`test/graph-cdc.test.ts:368`) is asserted against
  one 50,000-character fixture and one 66-character append. Over the corpus that append churns 2 on 4 of
  28 documents; the same fixture with a 2,500-character prose append churns 3.
- **`CDC must never be worse than byte offsets`** (`test/graph-cdc.test.ts:433`) is **not a property of
  appends, and its outcome is decided by content nobody chose.** At the fixture's own append CDC is
  strictly worse on 4 of 28 documents and the comparison passes anyway, because it compares max against
  max **across different documents** and a fifth, unrelated document churns 2 under legacy. It is the
  max-versus-max flaw `CDCCHURN-1` named where it survived, firing.

  **Deleting it outright is what draft 1 proposed, and both reviewers refused it** — that removes a
  cross-algorithm guard and leaves nothing to catch a CDC regression that makes appends much worse.
  §2d replaces it instead.

So the honest trade: **CDC is mildly worse than byte offsets on append** — it re-cuts the tail where byte
offsets only extend it — and dramatically better on insertion (CDC 1 against legacy 80). Measured
(`legacyEnvelope`), the per-document loss is at most **+1 chunk for appends shorter than `min`**, on both
the live corpus and 300 synthetic documents; for longer appends it reaches +1 on the corpus and +2
synthetically, so the general claim is weaker than the short-append one.

## 1. The claims that cannot hold

- The acceptance table's `append at end` row cannot carry a constant: churn grows with append length,
  varies with append content at fixed length (§0e), and reaches 0 only once the shared prefix fills the
  cap (§0a.6) — not merely once the document does.
- The summary table at the top of `content-defined-chunking.md` (`| append at the end | 1 |`) measures
  **legacy** behaviour on a 50,000-character document, where 20 full chunks plus a 66-character append
  gives exactly one new chunk. Draft 1 called it "correct as written" and left it; one reviewer agreed and
  the other showed the adjudication was too broad — **a 2,501-character append churns 2 under legacy, and
  9,000 churns 4**, so that row is conditional on append length in exactly the way the CDC column was.
  It is not rewritten (it does measure what it says it measures) but it is **scoped to the append it
  measures**, which is the minimum honesty the neighbouring correction demands.

## 2. The decision

### 2a. The table row states a bound, its mechanism, and the trade

`append at end` becomes: **at most the number of admitted chunks after the last chunk the two chunkings
share — commonly 1 for a short append, but 2 on 4 of 28 corpus documents at the fixture's own
66-character append; 0 once the shared prefix itself fills the cap; and growing with both the length and
the entropy of the appended text.** The prose names the mechanism (only boundaries within `max` of the
end can move; the backup-boundary preference can delete one) and carries §0f's trade.

**Draft 2's version of this sentence said "1 for a short append to a document below the cap", and that is
characterisation 1 walking back in as the row's gloss** — refuted by the run this spec commands
(`fixtureAppend.churnDistribution` = `{0: 1, 1: 23, 2: 4}`, all four of those 2s below the cap). It would
have been the seventh wrong characterisation, and the sixteen criteria of draft 2 would all have passed
with it in place, because they constrained what the row must mention and never what it must not claim.
Criterion 17 now pins the row's number against that distribution.

### 2b. The test asserts the bound per document — and an ABSOLUTE ceiling that cannot self-adjust

The bound in §0b is computed from the chunker's own output, and review sharpened just how weak that makes
it as evidence: draft 2 said "any prefix-stable chunker satisfies it", and the truth is stronger —
**every chunker does, and so does every pair of string arrays**, since `L` is defined as their common
prefix and elements below it are members of the before-set by definition. So `boundHolds 560/560` is a
theorem restated, not a measurement, and a `bound violated` counter is a structurally dead one. The
informative measurements are set-metric TIGHTNESS (§0b) and the two assertions below. So the test asserts
three things:

1. **the bound**, per document per append content — `churn ≤ |C₁| − L`;
2. **an absolute ceiling derived from the SIZE ENVELOPE, not from behaviour**:
   `churn ≤ (1 + ⌊(max − 1)/min⌋) + ⌈A/min⌉` for an append of length `A` — at most 4 tail boundaries can
   move (§0d) and the appended text adds at most `⌈A/min⌉` chunks. Zero violations across the 560 corpus
   samples and a further **8,400 samples over 400 synthetic documents** (`absoluteGuard.synthetic`, in
   the committed script — 28 real files are not evidence about an algorithm);
3. **the divergence depth**, per document, against the derived 4 — never the observed 2.

Equality with the bound is **reported, not gated** (a future document quoting another one verbatim would
otherwise redden CI on an unrelated docs edit); the fixtures gate it where it is deterministic.

**And here is what this set does NOT catch, stated rather than left to be discovered.** The absolute
ceiling is loose: at a 60,000-character prose append the corpus churns 23–24 against a ceiling of
`4 + ⌈60000/1250⌉ = 52`. A regression that cut the appended region at `min` instead of `target` would
roughly **double** every long append's cost and still pass the ceiling, the self-adjusting bound, the
depth gate and GROWTH. Both reviewers found this independently. Tight coverage exists only in the
**short-append regime**, where the `legacyChurn + 1` envelope sits at zero headroom (4 documents are at
exactly gap 1 today). The ceiling's real job is the gross case — a chunker that re-cuts the document —
and §4 defers the long-regime gate rather than pretending this covers it.

### 2c. Four checked-in fixtures, because the live corpus cannot guarantee any of these branches

- **CAPPED** — asserts churn 0 AND that the **shared chunk prefix reaches the cap**, which is the real
  condition; a fixture asserting only "the document exceeds the cap" would be red at 80 boundaries
  (§0a.6).
- **MERGE** — a document whose final cut comes from the backup mask, asserting the boundary count
  **falls**, the specific boundary is present before and absent after, and the bound still holds.
  Constructed and checked in rather than pinned to the live file the §0d witness names.
- **DUPLICATE** — self-concatenation, asserting set churn is strictly **below** the bound while the
  positional count equals it. The one branch that proves the rule is an inequality; nothing on the live
  corpus reaches it.
- **GROWTH** — one document across the length sweep under two append contents, asserting churn is
  non-decreasing in length, reaches ≥ 4 by 9,000 characters of prose, and **differs between the two
  contents at the same length**, pinning §0e by test rather than by prose.

### 2d. The false comparison is REPLACED, not deleted

`max(cdc) ≤ max(legacy)` goes, and in its place a **per-document** comparison gated on the regime where
the envelope is measured: for appends shorter than `min`, `cdcChurn ≤ legacyChurn + 1`. For longer
appends the per-document gap is reported, not gated, with the measured corpus and synthetic maxima
recorded at the site — because a synthetic maximum is a lower bound and this file does not gate on
lower bounds. §0f's reasons are recorded at the removal site: why the old form passed, and that its
outcome flips with the appended content at a fixed length.

### 2e. The sweep script

`--op append` sweeps documents × lengths × append contents and reports both metrics, the divergence
depth against the derived ceiling, the absolute guard, the falsified candidate, the falsified
boundary-coordinate form of the bound, and probes for the merge event, the cap parity, the verbatim
duplicate and the legacy envelope.

**It exits non-zero on a refuted invariant OR a vacuous run — and draft 2 claimed that before it was
true.** Review found three ways it failed open: an empty corpus (a wrong working directory) exited 0 with
zero evidence, the synthetic leg's divergence depth was computed and reported but never counted, and the
probes had no expectations at all, so `duplicateProbe` could report set === bound — the rule silently
becoming an equality again — with nothing noticing. There are explicit expectations now, including a
corpus floor. Probe **rot** is deliberately not a failure but a `warning`: the merge witness is live
content that this spec says is expected to rot, and conflating that with a refuted invariant would make
the check cry wolf.

It also gains `--exclude`, **honoured in both modes** — this file is around 79 characters below the
in-place sweep's 25,000-character floor, so one more paragraph would silently move the 573/573 the
in-place mode is required to reproduce, which is the went-stale-by-being-measured bug in the other mode.
And a corrected corpus definition — a
comment claimed its `> 4,000`-character set was "the same corpus `test/graph-cdc.test.ts` reads", which
it never was — and a fix to the `prose-b` filler, which replaced text **after** slicing and so appended
2,602 characters at a nominal 2,500, confounding the very "same length, different content" comparison it
was evidence for.

## Dependencies

**Deps: none.** One test file, four small fixtures, one script, and one table row in one design document.
No product code, no schema, no API surface.

## Build-with

**Build-with tier: Fable / high effort.** Six characterisations of this row have now been falsified,
three of them in this ticket and all three mine. A seventh wrong answer ships as documentation and as a
test that pins it. Two adversarial spec reviews per round (Fable + Codex); round 1 BLOCKED on both.

## Tier safety

No tier surface changes: a test, four fixtures, a script, and a design document. No product code, no
schema, no API route, no change to `visibleItems`/`visibleTasks`/`visibleGroupIds`.

## 3. Acceptance criteria

- `test/graph-cdc.test.ts` — for every live corpus document at every swept append length and append content, set churn is asserted `<= |C1| - L` where L is the common prefix of the two ADMITTED CHUNK arrays, per document rather than as a corpus maximum one outlier can dominate.
- `test/graph-cdc.test.ts` — an ABSOLUTE ceiling `churn <= (1 + floor((max-1)/min)) + ceil(A/min)` is asserted per document, derived from the size envelope rather than from the chunker's output, so a chunker that re-cuts deeply reddens it.
- `test/graph-cdc.test.ts` — the divergence depth is asserted per document against the DERIVED ceiling of 4, never the observed 2, and the observed maximum is recorded as an observation.
- `test/graph-cdc.test.ts` — a CAPPED fixture asserts churn 0 AND that the shared chunk prefix reaches the cap; a fixture asserting only "the document exceeds the cap" must fail, since a document at exactly 80 boundaries churns 1.
- `test/graph-cdc.test.ts` — a MERGE fixture, checked in rather than read from the live corpus, asserts the boundary count FALLS on a one-character append, the vanishing boundary is present before and absent after, and the bound still holds.
- `test/graph-cdc.test.ts` — a DUPLICATE fixture asserts set churn is strictly below the bound while the positional count equals it, pinning the rule as an inequality rather than an equality that happens to hold.
- `test/graph-cdc.test.ts` — a GROWTH fixture asserts churn is non-decreasing in append length, reaches at least 4 by a 9,000-character prose append, and DIFFERS between two append contents of the same length; no constant ceiling is asserted for any length.
- `test/graph-cdc.test.ts` — a WHITESPACE fixture asserts the bound holds for a whitespace-only base, the case that falsified the boundary-coordinate form of the rule.
- `test/graph-cdc.test.ts` — the `max(cdc) <= max(legacy)` comparison for append is replaced by a PER-DOCUMENT `cdcChurn <= legacyChurn + 1` gated to appends shorter than `min`, with the longer-append gap reported and the measured reason recorded at the site; the comparison is untouched for the insertion and deletion scenarios.
- `test/graph-cdc.test.ts` — the `append at end — CDC re-extracts <= 1 chunk(s)` assertion is GONE, with the measurement that refutes it recorded at the site.
- `test/graph-cdc.test.ts` — the live-corpus equality census is reported rather than gated, and a `documents > 5` floor is asserted, because a bound assertion over an empty or single-document corpus is green by construction.
- `scripts/cdc-churn-sweep.mjs` — `--op append` reports the bound, the absolute guard, the divergence depth against its derived ceiling, the falsified candidate, the falsified boundary-coordinate form, and the merge, cap-parity, verbatim-duplicate and legacy-envelope probes.
- `scripts/cdc-churn-sweep.mjs` — the append mode exits non-zero on a refuted invariant OR a vacuous run (empty corpus, zero samples, no synthetic leg, synthetic depth past the derived ceiling, `duplicateProbe` going tight, `verbatimChunkProbe` going slack, a shared prefix at the cap costing anything); probe ROT is a reported warning and not a failure, and running it from a directory with no `docs/` must exit 1 rather than 0.
- `scripts/cdc-churn-sweep.mjs` — `--exclude <path>` omits a document from the corpus in BOTH modes, since this spec sits under 100 characters below the in-place sweep's 25,000-character floor.
- `scripts/cdc-churn-sweep.mjs` — the `prose-b` filler replaces before slicing, so the "same length, different content" comparison is not length-confounded; the false "the same corpus the test reads" comment is corrected; the in-place mode's existing numbers reproduce unchanged.
- `docs/design/content-defined-chunking.md` — the acceptance table's `append at end` row states the bound, the shared-prefix cap condition, and that growth depends on the appended content as well as its length; the prose carries the measured CDC-vs-legacy envelope.
- `docs/design/content-defined-chunking.md` — the summary table's legacy `| append at the end | 1 |` is SCOPED to the 66-character append it measures rather than left unqualified, since a 2,501-character append churns 2 under byte offsets too.
- `docs/design/content-defined-chunking.md` — the corrected `append at end` row states NO unconditional number, and a test pins the row's own claim against `fixtureAppend.churnDistribution`, so a gloss like "1 for a short append" cannot pass the other sixteen criteria while contradicting the measurement.

## 4. Scope

**In:** the `append at end` acceptance row and its prose, the summary row's scoping, the append
scenario's two false assertions, five fixtures, the sweep script's append mode, probes, `--exclude` and
corpus/filler corrections.

**Deferred, each with its reason:**

- **Changing the chunker so appends never re-cut the tail.** The obvious fix — remember the previous
  chunking and keep its boundaries — makes chunking depend on the PREVIOUS chunking, and
  "same body ⇒ same chunks ⇒ same hashes" is the invariant the whole delta ledger rests on
  (`lib/graph/cdc.ts:11-13`). Rejected on that ground, not on cost.
- **The orphan-tail question the MERGE case raises.** When two chunks merge, the vanished chunk's episode
  is still in the graph and nothing purges it. That is the orphan-tail issue
  `content-defined-chunking.md` already records for a cap shrink, it predates this slice, and it is a
  product decision about purge rather than a churn measurement.
- **Gating the long-append legacy envelope.** The synthetic maximum (+2 here, higher under other
  generators) is a lower bound, and this file does not gate on lower bounds — the short-append regime is
  where the envelope is measured on both populations.
- **A cross-operation churn budget.** Three rows of that table are now conditional. Turning them into one
  predictive cost model for the projector is separate work with a separate consumer.

## 5. What would falsify this

**Clause 1 is proof-checked, not measurement-checked, and draft 2 mislabelled it.** `churn ≤ |C₁| − L`
holds for any two string arrays whatsoever, so no run of the sweep can refute it and the counter that
watches for a violation is structurally dead. It is listed because it is what the row asserts, not
because the instrument could catch it failing — and the mechanism draft 2 named (a chunk below `L`
re-pushed, contradicting `lib/graph/project.ts:1222-1223`) is an event the sweep computes `setChurn`
itself and could not observe even if the product had that bug. What WOULD falsify the row is the
translation: if the projector's membership filter ever stopped being a set-membership test, the bound
would still be true about chunk arrays and false about cost. (Draft 1's boundary-coordinate form was a
real, refutable claim, and it was refuted — by the `chunkCdc` blank-body guard.)

Wrong if any document exceeds the absolute ceiling of `(1 + ⌊(max − 1)/min⌋) + ⌈A/min⌉`, which would mean
the structural window in §0d is not what `cdcBoundaries` does.

Wrong in the other direction if the DUPLICATE fixture's set churn ever **equals** the bound, which would
mean the fixture stopped exercising the inequality and the rule is being pinned as an equality again —
the failure this row has now had six times.
