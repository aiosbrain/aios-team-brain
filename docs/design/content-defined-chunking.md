# Kill the insertion cascade — content-defined chunking

**Status:** spec, pre-plan-review · **Date:** 2026-08-07 · **Owner:** Chetan
· **Task:** `PIPEFF-3` → [AIO-826](https://linear.app/je4light/issue/AIO-826)
· **Parent:** `PIPEFF-1` / [AIO-820](https://linear.app/je4light/issue/AIO-820) —
  [`graph-ingestion-efficiency.md`](./graph-ingestion-efficiency.md), lever 1

## The problem, measured

Chunking is byte-offset: `slice(i, i + CHUNK_CHARS)` stepping by `CHUNK_CHARS`
(`lib/graph/project.ts:chunkContent`). Every boundary is a fixed distance from the start of the body,
so **an insertion anywhere shifts every boundary after it**. Verified directly against the real
function on a 50,000-char document:

| edit | chunks re-extracted (of 20) |
|---|---|
| edit in place, same length | 1 |
| append at the end | 1 |
| **insert 33 chars near the top** | **21 — all of them, plus the new tail** |

The chunk-delta ledger (#485) already skips unchanged chunks by comparing per-chunk hashes, so it
handles the first two rows perfectly. It cannot help with the third, because after an insertion
*every* stored hash mismatches — the content is the same, the windows moved.

**On 2026-08-05 this churn was ~167 of 427 episodes** — 20 documents averaging 50,000 chars,
re-extracted because an edit shifted their boundaries. Adding a heading, a paragraph, or a bullet
near the top of a document is the normal way documents are edited.

## Why this lever is a different proposition from lever 2

**Its benefit is deterministic arithmetic, provable for free.** Lever 2 (the predecessor filter)
needed a $8 battery across six LLM runs because its effect was on model behaviour. CDC's effect is on
*which byte ranges hash the same*, which is pure computation:

> Take a real document, apply a real edit, chunk both versions under each algorithm, count how many
> chunk hashes changed. No LLM, no cost, exactly reproducible.

So this spec's central claim is testable in a unit test against this install's own documents, and the
"cannot show movement ⇒ does not ship" rule is satisfiable without spending anything.

**It is coverage-neutral by construction — but "coverage-neutral" is not "quality-neutral", and the
distinction is exactly the one the lever-2 spec got wrong.** That spec called a case "provably
lossless" and had to retract it under review. So, precisely:

- **Coverage-neutral, and this part *is* by construction:** the same characters are ingested. No
  admission control, no dropped content, no population excluded — provided the min-chunk/cap
  arithmetic below holds, which is why that arithmetic is a requirement rather than a tuning knob.
- **NOT quality-neutral, and the arithmetic gate cannot speak to it.** Different split points mean
  different groupings, so an entity split across a boundary today may be whole tomorrow — or the
  reverse. There is no *systematic* loss mechanism (nothing is removed from any prompt; unlike lever
  2, no context is withheld), and content-defined boundaries plausibly land on more natural seams
  than arbitrary byte offsets. But "plausibly better" is not "proven neutral", and this spec does not
  claim it. The free arithmetic gate proves the *churn* reduction; it does not prove extraction
  quality is unchanged, and nothing here pretends otherwise.

## The fix

Replace byte-offset boundaries with a **content-defined** boundary: slide a rolling hash over the
body and cut where the hash matches a mask (the rsync/restic/borg approach, and a
[FastCDC](https://www.usenix.org/conference/atc16/technical-sessions/presentation/xia)-shaped
variant of it). Because the boundary is a function of the *bytes around it* rather than the distance
from the start, an insertion perturbs the chunk it lands in and — usually — little else. **"At worst
its immediate neighbour" would overclaim:** because each boundary is anchored at the previous one,
realignment after an insertion is empirical rather than guaranteed, and pathological low-entropy
content can propagate a shift across several chunks. The acceptance table below (**≤ 3 of 20**) is
the arbiter, not this paragraph.

### Parameters, and the one that is a content-safety issue rather than a tuning knob

| parameter | proposed | why |
|---|---|---|
| target average | 2,500 chars | matches today's `CHUNK_CHARS`, so episode economics and the extraction ceiling are unchanged |
| **minimum** chunk | **1,250 chars** | **load-bearing — see below** |
| maximum chunk | **4,000 chars** | a hard cut when no boundary is found — sized from the measurement below, not from the textbook 2× ratio |

**The maximum is measured, not assumed — and the measurement found something.** The review demanded
a number rather than the assertion that 5,000 "keeps every episode under the extraction ceiling",
because an episode whose *output* overflows graphiti's 16,384-token cap is 202-accepted and **never
becomes facts** (the 2026-06/07 blank-arcs class). Prod `llm_usage`, 30 days, `extract_edges` (the
widest-output call kind at today's 2,500-char chunks):

| p50 | p95 | p99 | max | ≥ half the ceiling |
|---|---|---|---|---|
| 486 | 2,421 | 3,948 | **16,384** | 1 of 898 calls (0.11%) |

p99 sits at 24% of the ceiling, so doubling chunk size would put p99 near 48% — headroom, but **the
max column is the finding: one call has already saturated the ceiling exactly**, at today's chunk
size. That is one episode whose edges were silently truncated. It is rare (1 in ~900 over 30 days,
on 2026-08-05) and pre-existing, but it proves the tail is not theoretical, so the max chunk is set
to **4,000** rather than 5,000 — p99 → ~6,300, ~38% of ceiling — and **the existing saturation is
filed as `EXTRUNC-1`** → [AIO-827](https://linear.app/je4light/issue/AIO-827), not absorbed here: silent output
truncation happens under *any* chunking, and the fix is detection-and-retry in the extraction
pipeline (`finish_reason`, or `output == cap`) rather than a chunk-size change. The 16,384 output
tokens came from ~625 tokens of content — ~26× the input, which points at degenerate generation, not
honest density.

**But "not CDC's bug" is not "unchanged by CDC", and the difference is worth saying:** allowing
4,000-char chunks raises the tail exposure by up to 1.6× content on the largest chunks. Modestly, and
unquantifiably from a single observation — but the honest statement is *increased*, not *unchanged*.
The watch costs nothing because the detector is the measurement itself: **count `llm_usage` rows
where `output_tokens = 16384`**, added to the post-ship observations below.

**What choosing 4,000 costs, stated rather than left implicit:** with the mask targeting a 2,500
average over a (1,250, 4,000] window, a plain gear-hash hard-cuts whenever no boundary appears in
2,750 chars — roughly **11% of chunks, against ~5% at max-5,000**. A hard cut is a *position*-defined
boundary, locally byte-offset-like, so runs of hash-quiet content (code blocks, tables) erode exactly
the insertion-locality this lever buys; the realized average also drops to ~2,360, i.e. ~6% more
episodes per document. **Mitigation, already implied by "FastCDC-shaped": use FastCDC normalized
chunking**, which varies the mask to make max-cuts rare — and the real-fixture ≤3 gate is what
catches any content where this still bites.

**The minimum is not a tuning knob, it is what stops CDC from silently dropping content.**
`MAX_EPISODE_CHUNKS` caps an item at 40 *chunks*, and content past the cap is discarded (the
CHUNKCAP-1 class this repo has already paid for once). Under byte-offset chunking, 40 chunks always
means 100,000 characters. Under CDC, 40 chunks means "however much text 40 content-defined windows
happen to cover" — and a pathological body that produces many small chunks would hit the cap far
sooner and **drop text that is currently ingested**. The minimum chunk size bounds that: with a
1,250-char floor, 40 chunks covers at least 50,000 characters.

**That is still a regression against today's guaranteed 100,000, so the cap must be raised in the
same change** to `MAX_EPISODE_CHUNKS` such that `min_chunk × cap ≥ 100,000` — i.e. **80**
(1,250 × 80 = 100,000, exactly today's floor). This is
the cheap direction of the two knobs (raising the cap does not re-extract the corpus; changing
`CHUNK_CHARS` does — see the ⚠️ comment on those constants), and it is a *requirement*, not an
option: shipping CDC without it would quietly reduce how much of a large document reaches the graph.

### The chunking unit, and what `cdc1` actually pins

**The rolling hash slides over UTF-16 code units** (`charCodeAt`), and boundary indices are code-unit
indices — the same space `slice` already uses, so legacy and CDC boundaries live in one coordinate
system. This is stated because the alternative is the exact class this repo has already been bitten
by (Postgres `length()` counting characters while JS `.length` counts UTF-16 units): a hash rolling
over bytes while min/max live in code units would put boundary indices in two different spaces.
A boundary inside a surrogate pair shifts deterministically by one.

**`cdc1` is the reproducibility contract, not the numbers beside it.** "Re-chunk under the stored
config" needs every detail: the gear table, the window length, the mask derivation, the unit above.
Those are *not* in the config string and must not be — so: **`cdc1` pins all of them; changing any
one is `cdc2`**, and the checked-in boundary fixture is what makes a silent drift a build failure.
The fixture is not a nicety, it is the definition of `cdc1`.

### Determinism is a correctness requirement, not a nicety

The whole delta ledger rests on "same body ⇒ same chunks ⇒ same hashes". The rolling hash must
therefore be a pure function of the body with no randomness, no seeding from wall-clock, and no
platform-dependent behaviour (no `Math.random`, no locale-sensitive string ops, explicit UTF-16
handling). **Pinned by a test that chunks a fixture twice and asserts identical output**, and by one
that chunks the same fixture under a checked-in expected boundary list, so an accidental algorithm
change is a build failure rather than a silent full-corpus re-push.

## The rollout is the hard part, and it is worth ~$76 to get right

Changing boundaries makes every stored `chunk_shas` entry meaningless. `chunkConfigDeltaCompatible`
returns false for a config change, so **all 2,267 items fall through the composite skip to a full
re-push: ~5,166 episodes ≈ $76 at the corrected $0.0147/episode, for zero new information** — the same text, re-extracted under
different boundaries.

**So CDC rolls out LAZILY.** An item whose body has not changed keeps its existing chunking
indefinitely; only items that actually change get re-chunked under the new algorithm. `chunk_config`
already records the algorithm per row (`"2500x40"` → `"cdc1-2500-1250-4000-80"`), so a mixed corpus is
representable and honest.

**The day-one burst, priced.** "Only items that actually change get re-chunked" is false for exactly
one population, deliberately: the 3 items still over the old cap (ARCHITECTURE.md ~338K, and two
~115–120K docs) are body-unchanged but **fail completeness**, so they full-re-push on the first tick
— roughly **170 episodes ≈ $2.50**, part of it re-extracting heads already in the graph. That is the
CHUNKCAP-1 un-stranding arriving as a side effect, which is correct, but it is a cost and it is named
here rather than discovered. Note also that the cap raise rides *inside* the CDC config string, so
the legacy helper's cap-grow path (`b.cap >= a.cap`) is **never exercised by this rollout** — the
"raising the cap is free" claim is true of the knob in general but is not the mechanism that runs
here.

This needs a **third case** the current two-case helper cannot express
(`lib/graph/project.ts:119`, consumed by the composite skip at `:517`):

| case | today | meaning |
|---|---|---|
| boundaries **trustworthy** | `true` — delta-eligible | same chars, cap grew |
| boundaries **stale AND the item owes content** | `false` — re-push | everything else |
| **boundaries stale but the item is provably complete** | *(does not exist)* | **new: leave it alone** |

### "Complete" must be defined precisely, because the loose definition is the hole

It must **NOT** mean `content_sha256` matches — that is the exact bug this codebase has shipped twice
in review, since the body sha is invariant to chunking. It means all four of:

1. parse the **stored** `chunk_config` and re-chunk the body under **that** algorithm and parameters
   (which requires `chunkContent` to become dispatchable on a config string — see *Build shape*);
2. require **element-wise hash equality** with the stored `chunk_shas` — not count equality;
3. require the re-chunk to have **consumed the whole body** — chunk count < the stored cap, or the
   chunk lengths summing to `body.length`. Term 1 already re-chunks under the stored config, so this
   exact answer is **free**, and it is strictly better than the arithmetic proxy
   (`storedMinChunk × storedCap ≥ body.length`) an earlier draft used: that proxy is
   sufficient-but-not-necessary, and would condemn a 150K body fully covered in 60 of 80 chunks to a
   pointless full re-extraction at every future config change. Either way the point stands — an item
   clipped at its old cap is "complete under the stored config" while still owing content, and must
   NOT be left alone, or CDC would permanently re-strand exactly the population CHUNKCAP-1 existed to
   un-strand;
4. an empty or unparseable `chunk_config` (`''` is the column default) is **never** complete.

The other skip terms stay ANDed: this is a **widening of the composite skip, not a new site**, so
`!tierChanged`, `!purgeBeforeRepush` and the `''` reconcile sentinel are inherited — a re-queued or
redacted row can never sha-match and so still pushes. **One mutation test per ANDed term**, per the
one-condition-per-fixture rule.

### The steady state — and the omission that would have shipped this lever as a no-op

The transition above (legacy → CDC) is only half the problem. **What happens when a CDC-stored item's
body changes?** The spec's first draft never said, and the shipped code answers badly:
`chunkConfigDeltaCompatible`'s parser is `/^(\d+)x(\d+)$/` (`project.ts:121`), which returns **false
for any CDC string — including `stored === current`**. So an insertion edit to a CDC item would fail
delta eligibility, `alreadyPushed` would be empty, and **every chunk would full-re-push. The
insertion cascade survives, now wearing content-defined boundaries.**

Worse, the gate this spec declared — "the unit test is the gate" — is a pure-function test counting
hash changes between two chunkings. **It stays green while the projector re-pushes everything**,
because it never touches the push layer. That is the "pin the call site, not just the function"
failure this repo has already paid for, and the same shape as the parent spec's own recorded blocker
(a patch target that would have built green and changed nothing).

So, required:

- **`chunkConfigDeltaCompatible` (or its successor) must return true for identical CDC configs**, and
  CDC↔CDC **cap-grow** is explicitly allowed — but **not for the reason an earlier draft gave.** That
  draft said a CDC boundary "depends only on the content preceding it within the chunk", which is
  **false**: the min-size skip and the hash restart are anchored at the chunk's *start*, i.e. where
  the previous chunk ended, so every boundary depends on the whole chain before it. The conclusion
  survives on a different and simpler basis: **for a fixed body under fixed `cdc1` parameters the
  entire boundary sequence is a deterministic function of the body alone, and the cap is not an input
  to boundary computation — it only truncates the emitted sequence.** Chunks 0..79 are therefore
  identical under cap 80 and cap 120.

  Two things that argument *requires*, so they are requirements rather than assumptions:

  - **Cap semantics must be truncation-only.** A tempting implementation special-cases the final
    permitted chunk (absorbing the remainder, or cutting it differently because it knows it is last);
    any such case breaks prefix stability at exactly chunk `cap−1`. Consequence if violated is bounded
    — on a future cap raise the boundary chunk's stored hash mismatches and re-pushes, costing money
    and leaving a same-name orphan, not losing content — but it must be pinned.
  - **The byte-identical-prefix fixture must actually reach the cap.** A fixture shorter than
    `min × cap` never exercises the boundary chunk and proves nothing. (And it is a *new* CDC fixture,
    not a reuse of the legacy one, which chunks with the legacy algorithm.)
- **A projector-level acceptance test in the data-mechanics tier** (unit tier cannot see this): an
  item stored under the CDC config, body edited by a 33-char insertion near the top, and the
  fake-graphiti spy must receive **≤ 3 episodes**. Without it, "cannot show movement ⇒ does not ship"
  is satisfied by a weaker gate wearing the same words.

### Cap-shrink is decided explicitly, not inherited

Today `chunkConfigDeltaCompatible` documents cap-shrink → `false` because "a full re-push is the
honest answer". A naive third case would instead leave a shrunk-cap item alone, since it verifies
complete under the stored, larger cap. That is content-safe but silently rewrites a documented
decision. **Decision: leave it alone.** The orphan tails a shrink creates are not fixed by re-pushing
the head either (nothing purges them), so paying to re-extract buys nothing. The
`chunkConfigDeltaCompatible` comment must be updated to say so rather than left contradicting this.

## Build shape

- `chunkContent(body)` gains a sibling that **dispatches on a config string**, so "re-chunk under the
  stored config" is expressible. The legacy `"<chars>x<cap>"` form keeps its exact current behaviour —
  a mixed corpus means the old algorithm must remain byte-exact forever, not "close enough".
- The rolling hash and the boundary rule live in one pure module with no I/O, unit-tested.
- **The CDC parameters keep env knobs** (as `CHUNK_CHARS`/`MAX_EPISODE_CHUNKS` have today), and
  `CHUNK_CONFIG` is **derived from the effective values by construction** — so an env flip is just a
  config change with the lazy semantics, rather than a silent boundary change under a stale label.
- `ProjectSummary.episodes`' docstring still says "(16)" — stale since the cap became 40; fix while
  touching.
- `CHUNK_CONFIG` becomes the CDC string; the ⚠️ "$47 re-extracts the corpus" warnings on
  `CHUNK_CHARS`/`MAX_EPISODE_CHUNKS` become misleading once lazy CDC lands and **must be updated in
  this PR** (flagged in the parent spec's Risks and easy to forget).

## How we will know it worked — free, before shipping

A unit test over **this install's own documents** (pulled at test-authoring time, shapes checked in
as fixtures — not content, just lengths and edit positions where content is sensitive):

| scenario | byte-offset (today) | CDC (required) |
|---|---|---|
| edit in place, same length | 1 of 20 | **conditional — see below** |
| append at end | 1 of 20 | conditional, not yet characterised (`CDCAPPEND-1`) |
| **insert 33 chars near the top** | **21 of 20** | **≤ 3** |
| insert a paragraph mid-document | ~half | **≤ 3** |
| delete a paragraph near the top | ~all | **≤ 3** |

### `edit in place, same length` — the row that was wrong, corrected (CDCCHURN-1)

That row promised an unconditional **1** and it cannot be one. For byte offsets 1 IS a theorem: offsets
do not move, so exactly the containing chunk changes. For CDC a boundary **is** content — a cut is
decided by roughly the 32 code units ENDING at it — so an edit can destroy a boundary it never touches,
create one where none was, or span a surviving one. The true rule, verified over 5,743 swept samples
with zero mismatches (`test/graph-cdc.test.ts`, CDCCHURN-1):

> **churn = the number of admitted chunk intervals the changed span intersects.**
>
> (measured at `2b1778d` — the corpus is deliberately live, so these numbers carry a SHA)

Exactly 1 requires two things: the edit changes text, and it lies wholly inside one admitted chunk.
(A third condition — "no boundary strictly inside the edit span" — is implied by the second, and was
deleted after a mutation showed nothing could redden it.) Otherwise there is no useful ceiling —
measured over this repo's own markdown, a 20-character in-place edit reaches **8 of the 80 admitted
chunks**, and that number moves as the corpus does: an earlier measurement, on a longer
`docs/ARCHITECTURE.md`, reached 78 — but that was a POSITIONAL count, and positional churn is not a
cost (see the note above the table).

**So the honest trade, both directions measured on the same corpus:**

| edit (measured at `2b1778d`) | CDC | byte offsets |
|---|---:|---:|
| in-place, same length, boundary-changing (`docs/ARCHITECTURE.md` @181,517) | **8** | **1** |
| in-place, same length, boundary-preserving (@20,000) | 1 | 1 |
| insertion of 33 chars near the top | **1** | **80** |

CDC is **not** "never worse than byte offsets", and this document should never have implied it. It is
dramatically better on the insertion cascade this lever exists for, and dramatically worse on an
in-place edit that disturbs a boundary. Three earlier attempts to characterise this each blamed the
wrong mechanism — the test carries that history so the fourth reader does not re-derive it.

**And in prod, after:** the projector's own `ingest_runs` records episodes per run. A week of
editing-heavy days before and after should show the episode count per changed item fall toward the
number of chunks actually touched. That is observational — the unit test is the gate.

## Risks

- **The corpus stays permanently mixed.** Accepted and made explicit in `chunk_config`; the
  alternative is ~$76 to re-extract text we already have.
- **A CDC boundary can split mid-sentence** — so can a byte offset, and the extractor already receives
  a document's own prior chunks as context (lever 2 preserved exactly that). No worse than today, and
  the parent spec's tie-rank derivation is unaffected.
- **The cap raise is a content-safety requirement, not a nice-to-have.** If plan review disagrees with
  the min-chunk/cap arithmetic above, CDC does not ship until that is settled — silently reducing how
  much of a large document reaches the graph is the one failure this lever must not cause.
- **A future algorithm change re-runs this whole problem.** The determinism test plus the config
  string make it loud rather than silent; the lazy path means it would again cost nothing to adopt.
