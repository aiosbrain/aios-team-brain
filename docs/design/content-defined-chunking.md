# Kill the insertion cascade — content-defined chunking

**Status:** spec, pre-plan-review · **Date:** 2026-08-07 · **Owner:** Chetan
· **Task:** `PIPEFF-3` (Linear key to be cited once the projection lands)
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

**And it is coverage-neutral by construction.** The same characters end up in the graph either way;
only the split points move. There is no admission control, no dropped content, and — unlike lever 2 —
no mechanism by which the extractor sees *less* context about anything.

## The fix

Replace byte-offset boundaries with a **content-defined** boundary: slide a rolling hash over the
body and cut where the hash matches a mask (the rsync/restic/borg approach, and a
[FastCDC](https://www.usenix.org/conference/atc16/technical-sessions/presentation/xia)-shaped
variant of it). Because the boundary is a function of the *bytes around it* rather than the distance
from the start, an insertion perturbs only the chunk it lands in and, at worst, its immediate
neighbour. Expected: the 21-of-20 case becomes 1–2 of 20.

### Parameters, and the one that is a content-safety issue rather than a tuning knob

| parameter | proposed | why |
|---|---|---|
| target average | 2,500 chars | matches today's `CHUNK_CHARS`, so episode economics and the extraction ceiling are unchanged |
| **minimum** chunk | **1,250 chars** | **load-bearing — see below** |
| maximum chunk | 5,000 chars | a hard cut when no boundary is found; keeps every episode under the extraction ceiling |

**The minimum is not a tuning knob, it is what stops CDC from silently dropping content.**
`MAX_EPISODE_CHUNKS` caps an item at 40 *chunks*, and content past the cap is discarded (the
CHUNKCAP-1 class this repo has already paid for once). Under byte-offset chunking, 40 chunks always
means 100,000 characters. Under CDC, 40 chunks means "however much text 40 content-defined windows
happen to cover" — and a pathological body that produces many small chunks would hit the cap far
sooner and **drop text that is currently ingested**. The minimum chunk size bounds that: with a
1,250-char floor, 40 chunks covers at least 50,000 characters.

**That is still a regression against today's guaranteed 100,000, so the cap must be raised in the
same change** to `MAX_EPISODE_CHUNKS` such that `min_chunk × cap ≥ 100,000` — i.e. **80**. This is
the cheap direction of the two knobs (raising the cap does not re-extract the corpus; changing
`CHUNK_CHARS` does — see the ⚠️ comment on those constants), and it is a *requirement*, not an
option: shipping CDC without it would quietly reduce how much of a large document reaches the graph.

### Determinism is a correctness requirement, not a nicety

The whole delta ledger rests on "same body ⇒ same chunks ⇒ same hashes". The rolling hash must
therefore be a pure function of the body with no randomness, no seeding from wall-clock, and no
platform-dependent behaviour (no `Math.random`, no locale-sensitive string ops, explicit UTF-16
handling). **Pinned by a test that chunks a fixture twice and asserts identical output**, and by one
that chunks the same fixture under a checked-in expected boundary list, so an accidental algorithm
change is a build failure rather than a silent full-corpus re-push.

## The rollout is the hard part, and it is worth $51 to get right

Changing boundaries makes every stored `chunk_shas` entry meaningless. `chunkConfigDeltaCompatible`
returns false for a config change, so **all 2,267 items fall through the composite skip to a full
re-push: ~5,166 episodes ≈ $51, for zero new information** — the same text, re-extracted under
different boundaries.

**So CDC rolls out LAZILY.** An item whose body has not changed keeps its existing chunking
indefinitely; only items that actually change get re-chunked under the new algorithm. `chunk_config`
already records the algorithm per row (`"2500x40"` → `"cdc1-2500-1250-5000-80"`), so a mixed corpus is
representable and honest.

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
3. require the stored config to have **covered the whole body**
   (`storedMinChunk × storedCap ≥ body.length` for CDC, `storedChars × storedCap ≥ body.length` for
   the legacy fixed algorithm) — otherwise an item clipped at its old cap is "complete under the
   stored config" while still owing content, and CDC would permanently re-strand exactly the
   population CHUNKCAP-1 existed to un-strand;
4. an empty or unparseable `chunk_config` (`''` is the column default) is **never** complete.

The other skip terms stay ANDed: this is a **widening of the composite skip, not a new site**, so
`!tierChanged`, `!purgeBeforeRepush` and the `''` reconcile sentinel are inherited — a re-queued or
redacted row can never sha-match and so still pushes. **One mutation test per ANDed term**, per the
one-condition-per-fixture rule.

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
- `CHUNK_CONFIG` becomes the CDC string; the ⚠️ "$47 re-extracts the corpus" warnings on
  `CHUNK_CHARS`/`MAX_EPISODE_CHUNKS` become misleading once lazy CDC lands and **must be updated in
  this PR** (flagged in the parent spec's Risks and easy to forget).

## How we will know it worked — free, before shipping

A unit test over **this install's own documents** (pulled at test-authoring time, shapes checked in
as fixtures — not content, just lengths and edit positions where content is sensitive):

| scenario | byte-offset (today) | CDC (required) |
|---|---|---|
| edit in place, same length | 1 of 20 | 1 |
| append at end | 1 of 20 | 1 |
| **insert 33 chars near the top** | **21 of 20** | **≤ 3** |
| insert a paragraph mid-document | ~half | **≤ 3** |
| delete a paragraph near the top | ~all | **≤ 3** |

**And in prod, after:** the projector's own `ingest_runs` records episodes per run. A week of
editing-heavy days before and after should show the episode count per changed item fall toward the
number of chunks actually touched. That is observational — the unit test is the gate.

## Risks

- **The corpus stays permanently mixed.** Accepted and made explicit in `chunk_config`; the
  alternative is $51 to re-extract text we already have.
- **A CDC boundary can split mid-sentence** — so can a byte offset, and the extractor already receives
  a document's own prior chunks as context (lever 2 preserved exactly that). No worse than today, and
  the parent spec's tie-rank derivation is unaffected.
- **The cap raise is a content-safety requirement, not a nice-to-have.** If plan review disagrees with
  the min-chunk/cap arithmetic above, CDC does not ship until that is settled — silently reducing how
  much of a large document reaches the graph is the one failure this lever must not cause.
- **A future algorithm change re-runs this whole problem.** The determinism test plus the config
  string make it loud rather than silent; the lazy path means it would again cost nothing to adopt.
