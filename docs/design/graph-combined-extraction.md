# Merge the two extraction calls into one — PIPEFF-5 / AIO-868

**Status:** spec, pre-review. No code written.
**Parent:** `docs/design/graph-ingestion-efficiency.md` §4 ("noted, not proposed"), now the largest
remaining lever after PIPEFF-4 (packing) was declined on evidence.
**Siblings shipped:** PIPEFF-2 (predecessor filter, −25.5% verified) · PIPEFF-3 (content-defined chunking).
**Owner approval:** the quality battery's spend was approved 2026-08-11, before this spec was written.

---

## 0. What it is

`add_episode` — the only path the REST server uses — reads every episode **twice**: once to extract
entities (`extract_nodes`, `graphiti.py:1139`) and again to extract the relationships between them
(`extract_edges`, inside `_extract_and_resolve_edges`, `graphiti.py:656`). Both calls carry the same
episode body, the same predecessor context, and the same entity-type definitions.

graphiti 0.29.3 ships a path that does both in one call —
`utils/maintenance/combined_extraction.py:41 extract_nodes_and_edges` — with a registered prompt
(`prompts/extract_nodes_and_edges.py`, `prompt_library.extract_nodes_and_edges`). **Verified in the
deployed image**, not in a wheel on my laptop: both the module and the prompt-library entry are
present in `aios-graphiti`'s running venv.

It is unreachable from the outside. The flag `use_combined_extraction` exists only on the *bulk*
path (`utils/bulk_utils.py:271`, default `False`), and even there the sole internal caller
(`graphiti.py:798`) omits it. So this is a Dockerfile patch, like PATCH 3.

---

## 1. What it saves — measured, not inherited

The parent spec estimated "~15%" and never measured it. **I measured it before designing**, over the
window since the PIPEFF-2 deploy (`llm_usage`, `source='graph'`, since 2026-08-07 07:08:24Z):

| call kind | calls | input tok | output tok | cost | share |
|---|---|---|---|---|---|
| `dedupe_nodes` | 408 | 3,787,386 | 57,906 | $1.2803 | 24.3% |
| **`extract_edges`** | 407 | 2,633,902 | 334,696 | **$1.2560** | **23.8%** |
| **`extract_nodes`** | 407 | 2,700,553 | 197,429 | **$1.0893** | **20.7%** |
| `dedupe_edges` | 2,883 | 3,159,643 | 51,239 | $1.0767 | 20.4% |
| `node_summaries_batch` | 251 | 1,333,276 | 78,901 | $0.5089 | 9.7% |
| `edge_timestamps` | 285 | 156,137 | 7,621 | $0.0599 | 1.1% |

**The two calls this lever merges are 44.5% of graph cost.**

Per-token rates solved by least squares across all six call kinds (six equations, two unknowns —
so the fit is *over-determined and checkable*, not assumed): **$0.319/Mtok input, $1.215/Mtok
output**. Predicted vs actual cost agrees within ~1% on every call kind, which is what makes the
projection below worth stating.

**The saving is an input-side saving only.** Merging sends the episode + context once instead of
twice; it does **not** reduce output, because the merged call still emits both the nodes and the
edges.

**The merged prompt's instruction block was measured, not assumed** (rendered from the deployed
image): `extract_nodes.extract_message` ≈ 1,782 tok, `extract_edges.edge` ≈ 1,274 tok, and the
combined prompt ≈ **3,085 tok** — essentially both instruction blocks concatenated, plus a ~65-line
negative-examples section. So merged input ≈ 6,635 − 1,782 + 3,085 ≈ **7,938 tok ≈ 1.20× one call**,
*worse* than the 1.15× I first guessed.

| | projected saving |
|---|---|
| my first estimate (input = 1.00–1.15× one call) | 13.4–15.9% |
| **measured merged instructions (1.20×)** | **~12–14% of graph cost** |

**So the parent's ~15% is close but optimistic**, and the honest figure is **~12–14%**. Worth stating
plainly: two inherited estimates in this workstream did not survive measurement, and this one
survives only approximately.

**ONE UNIT, stated once.** Everything above is **% of graph cost**. Input is ~83% of graph cost, so a
10% fall in *input tokens per episode* ≈ 8.3% cost, and the ~12–14% cost projection ≈ **15–17% fall in
input tokens per episode**. §5's C1 bar is stated in **cost**, and only in cost. Mixing the two is the
borrowed-band-from-the-wrong-metric error this workstream has already made once.

---

## 2. The patch

Two edits in `graphiti.py`, both in the `add_episode` path. This is **deeper than PATCH 3**, which
was a 17-line purely-additive filter — and the spec says so rather than inheriting "a patch of the
shape we have shipped twice", which is how I first described it.

**Edit 1 — `_extract_and_resolve_edges` (`graphiti.py:631-677`) gains an optional pre-extracted
edge list**, so the merged call's edges can flow through the *unchanged* resolution pipeline:

```python
async def _extract_and_resolve_edges(self, ..., pre_extracted_edges=None):
    ...
    extracted_edges = (
        pre_extracted_edges
        if pre_extracted_edges is not None
        else await extract_edges(self.clients, episode, extracted_nodes, previous_episodes, ...)
    )
    # everything below this line is untouched
```

**Edit 2 — `add_episode` (`graphiti.py:1138-1170`) calls the combined extractor** and threads its
edges into edit 1, leaving `resolve_extracted_nodes` and every downstream step alone.

**Everything after extraction is unchanged**, deliberately: `resolve_extracted_nodes`,
`resolve_edge_pointers`, `resolve_extracted_edges`, attribute extraction and the episodic-edge write
all keep their current inputs. `extract_nodes_and_edges` returns
`(nodes, edges, node_episode_index_map)` — exactly the two values the current code produces plus the
same index map — so the seam is narrow by construction.

**The `previous_episodes` interaction with PATCH 3 must be verified, not assumed.** PIPEFF-2's
shipped patch filters `previous_episodes` at the retrieval site (`graphiti.py:1090`), *upstream* of
both extractors, so a merged call should inherit the filter unchanged. That is a prediction, and
`AC4` below turns it into a check — because "it's upstream so it must be fine" is precisely the
reasoning that has been wrong twice in this workstream.

### Two seam questions the plan review left open — both now read in the deployed source

**No double-timestamping.** The review flagged a risk that combined's internal batch timestamps
(`combined_extraction.py:233-278`) would be duplicated by the per-edge call downstream. They are not:
`_extract_edge_timestamps` (`edge_operations.py:576-591`) **short-circuits** —

```python
if edge.valid_at is not None or edge.invalid_at is not None:
    return
```

— and its own docstring names the case: *"Skips if the edge already has timestamps set (e.g., from
the extraction prompt in the separate-extraction path)"*. Also settles where timestamps live: **not**
inside `extract_edges` but inside `resolve_extracted_edges` (`edge_operations.py:680,813`), which
Edit 1 does not touch. So skipping `extract_edges` neither loses nor duplicates them.

**The edge name-match skip is NOT a new failure mode — and combined is the more forgiving of the
two.** The review flagged that combined silently drops an edge whose endpoint name it cannot match
(`combined_extraction.py:188-200`) and stated the separate path avoids this by handing the extractor
an ID-indexed entity list. **It does not.** `extract_edges` builds `{node.name: node}` from **raw**
names (`edge_operations.py:168`) and `continue`s on a miss (`:218-231`), whereas combined keys on
`_normalize_string_exact` on **both** sides (`:181-189`). Same failure mode, pre-existing, and the
candidate's matching is *strictly more lenient* than the incumbent's.

The skip rate is still worth reporting — it is a real silent-loss channel in both arms — but as a
**diagnostic**, not as a risk this lever introduces. Recorded because acting on the review's framing
would have priced a pre-existing behaviour as a regression.

---

## 3. Why this one cannot ship on mechanism, unlike PIPEFF-2

PIPEFF-2 removed *padding* — the same question with less junk attached — so its quality argument
could lean on mechanism. **This changes the question itself.** A different prompt can produce a
different set of entities and edges from identical content. There is no mechanism argument available,
and one is not attempted here.

### The upstream "fewer orphans" claim is post-processing, not model quality — and I nearly built the battery on it

My first draft treated upstream's docstring (*"ensuring every entity has at least one connecting fact
and reducing orphaned nodes"*) as a falsifiable directional claim and made **orphan rate** the
headline quality sensor. **The plan review caught that it cannot fail, and I verified it in the
deployed source.**

`combined_extraction.py:280-295` — after edge validation, every node with no incident edge is
**deleted**:

```python
orphan_count = sum(1 for n in extracted_nodes if n.uuid not in connected_node_uuids)
if orphan_count:
    logger.debug('Dropping %d orphan node(s) with no connecting edges', orphan_count)
extracted_nodes = [n for n in extracted_nodes if n.uuid in connected_node_uuids]
```

Three consequences, and together they would have wasted the run:

1. **Orphan rate is ~0 in the candidate arm by construction.** Its FAIL direction is near-impossible.
   That is the manufactured pass this spec congratulated itself for avoiding when it dropped Q2/Q7.
2. **Entities-per-episode is confounded.** The candidate's entity count falls by the incumbent's
   orphan share *mechanically* — neither fragmentation nor missed content — so a two-sided band on it
   either fails spuriously or, worse, lets the mechanical fall **mask real missed content**.
3. **The coupling is perverse.** Dropped entities also shrink `dedupe_nodes` (24.3%) and
   `node_summaries_batch` (9.7%) inputs. **The more entities the arm silently discards, the better its
   cost numbers look.** C1 and Q1 would have pulled in opposite directions on the same artifact.

§4 replaces both sensors accordingly. Upstream's claim is **not** carried as a prior worth anything
on this corpus — it describes lines 280-295, not model behaviour.

---

## 4. The battery — redesigned after the plan review

Session 2 of PIPEFF-2 returned **INVALID** because the incumbent's own two runs, at temperature 0 on
byte-identical input, differed by **7.2%** on entity yield. That is a measured property of this stack.

### The power arithmetic, corrected

My first draft computed the standard error of **one arm's mean** (7%/√4 = 3.5%) and called a 7% effect
separable. **The decision compares two arm means**, so the relevant quantity is the SE of the
*difference*: √(3.5² + 3.5²) ≈ **4.95%**. A true 7% effect is z ≈ 1.4 — not separable at any
conventional threshold. **My own sentence "an effect of ~7% is separable" was false at n=4**, and it is
the same shape of error that produced the INVALID verdict last time, dressed in better-looking
arithmetic.

| n per arm | SE(difference) | smallest reliably detectable effect | cost |
|---|---|---|---|
| 4 | 4.95% | ~12% (t, df=6) | ~$6.40 |
| **8** | **3.5%** | **~7%** | **~$12.80** |

**Decision: 8 reps per arm. Envelope $16.00**, re-approved by the owner on 2026-08-11 after being
told the figure had doubled. C1 needs no extra reps — cost metrics measured solid at n=2 — but the
arms run together, so the reps are shared.

**Bands are derived from the pooled within-arm spread observed in THIS battery**, with the historical
7% as a sanity floor. The 7% was measured on the incumbent only; the candidate's noise is unknown, and
a longer multi-task prompt may well be noisier.

### The metrics, after the orphan finding

| Q | metric | FAIL direction | why this and not the obvious one |
|---|---|---|---|
| **C1** | cost per episode, **% of graph cost** (one unit, §1) | a fall **under 10%** | below that the lever does not pay for a vendored patch |
| **Q1′** | **connected** entities per episode (entities with ≥1 incident edge) | outside the band, **either** direction | raw entity count is confounded: the candidate drops orphans mechanically (§3). Connected entities are well-defined in *both* arms and immune to the drop |
| **Q8′** | **orphan-drop loss rate** in the candidate = (raw entities in the `CombinedExtraction` **response** − nodes kept) / raw | **exceeds the incumbent's measured orphan share** | asks the real question — *is the candidate discarding more than the incumbent was already failing to connect?* **Requires a tap change, see below** |
| **Q4** | edges per episode | a fall outside the band | fewer relationships is the thing edges exist for |
| **Q9** | **consensus-entity retention** — entities present in **every one of this session's 8 incumbent reps**, required to appear in the candidate's graph | any qualifying entity lost | the recall gate replacing Q2 (below). Self-contained by design, see below |
| **Q5** | retry rate (harness signed cross-check) | any rise | a longer merged prompt could push validation retries |
| — | edge name-match skip rate, both arms | *diagnostic only* | pre-existing in both, and the candidate is more lenient (§2) — reported, not gated |
| — | `dedupe_nodes` / `node_summaries_batch` savings | *reported separately from C1* | they shrink because entities were dropped. Folding them into the headline would let entity loss pad the cost win |

### Two of these were unbuildable as first written — found by checking, before the run

I specified Q8′ and Q9 against instruments I had not opened. Both were wrong, and both would have
failed at **harvest**, after the money was spent.

**Q8′ needed a capture the tap does not take.** `capture-tap.mjs:65-70` appends the **request** body
and nothing else; the response is forwarded (`:82-84`) and discarded. So the raw pre-drop entity list
does not exist anywhere. **Fix, before any run:** the tap also records the response body — `buf` is
already in hand at `:83`, so this is a few lines, and the byte-for-byte forwarding property that
makes the tap trustworthy is untouched (it still forwards exactly what it received, it merely also
writes down what came back). Capture stays fatal-on-write-failure, for the same reason it already is.

**Q9 depended on prior-session artifacts that no longer exist.** I wrote "the prior session's
harvests are on disk". They are not — Docker died three times during that session and nothing
survives on this machine. **Fix:** make the gate self-contained — build the consensus list from
**this session's own 8 incumbent reps** (entities present in *every* one), then require the candidate
to retain them. This is strictly better than what I specified: same corpus, same session, no
staleness, and no dependency on artifacts I cannot verify. It is not circular — the list is built
from the arm the candidate is measured *against*, never from the candidate.

**Both fixes are free and both are prerequisites to spending anything.** Recorded here rather than
quietly corrected, because "I specified a metric against an instrument I had not opened" is the
failure, not the two fixes.

**Measured before any arm runs, at zero cost:** the incumbent's orphan share. It is the size of the
confound, the expected mechanical shift in raw entity count, and Q8′'s pre-registered bound. One
Cypher query.

### Q2 and Q7 — dropped, with status rows, and Q2 replaced

| Q | status | reason |
|---|---|---|
| Q2 (people recall) | **NOT RUN — unpowerable** | the roster has exactly one multi-word human name appearing in content (measured, prior session) |
| Q7 (name convergence) | **NOT RUN — unpowerable** | 0.29.3's deterministic exact-name matching makes it read ~1.0 for every arm |

Both get a row in the verdict table rather than vanishing — every pre-registered check gets a status,
including NOT RUN.

**But dropping Q2 while adding a mechanism that deletes entities is the self-serving shape**, even
with an honest reason, and the plan review said so. Q2 was the only recall-of-specific-content gate,
and this candidate's known mechanical risk is entity loss. **Q9 is its powerable replacement** — a
consensus list from the prior session's incumbent reps, which exists on disk and costs nothing to
check. The drop is only clean *with* Q9; without it, it is the cut that blocked the last amendment.

### Instrument, reused

The corpus rule, seeder, capture tap, harvester, refusing parsers and `decision.mjs` are reused from
PIPEFF-2 unchanged. The arms change; the instrument does not.

## 5. Acceptance

| # | Criterion | Tier | Falsifier |
|---|---|---|---|
| AC1 | The image built from this branch produces a `graphiti.py` whose sha256 is **bit-for-bit the file the battery measured** | build gate | any mismatch — "we ship what we tested" must be proved, as in PIPEFF-2 |
| AC2 | The patch script is **idempotent and asserts its anchors**: applying twice is a no-op, and a missing anchor fails loudly rather than silently skipping | unit (runs the real Python) | a silent no-op — the failure `graphiti/Dockerfile`'s gates exist for |
| AC3 | The patched file **parses under `ast`** and the patched call path is exercised end-to-end against a real episode | unit + e2e | any import/runtime error |
| AC4 | **PATCH 3's predecessor filter still applies** under the combined call — a single-chunk item receives **zero** predecessors, a multi-chunk item receives only its own | unit (runs the real Python) | any predecessor from another item reaching the merged prompt |
| AC5 | The **full per-episode call-kind profile** is pinned: exactly one `extract_nodes_and_edges`, one `edge_timestamps` **only when the extractor left dates unset**, and **zero** `extract_nodes` / `extract_edges` | unit + data-mechanics | any extra, missing or duplicated kind. "`extract_edges` not called" alone would miss a duplicated or lost timestamp call — the guard must cover the level that changed |
| **AC8** | **`lib/llm/graph-call-kind.ts` gains an `extract_nodes_and_edges` row in THIS PR**, with a fixture built from the **real rendered prompt**, and `llm_usage` records that kind with non-zero tokens | unit + data-mechanics | the call landing in `unknown` |
| AC6 | With `pre_extracted_edges=None` the function is **byte-identical in behaviour** to today, so the un-patched path is untouched | unit | any divergence on the fallback path |
| AC7 | The battery's decision procedure **refuses** rather than passing when a rep is missing or a window is ambiguous | unit (existing, re-pinned) | a verdict on incomplete data |

### AC8 is the one that would have faked the result

`lib/llm/graph-call-kind.ts` classifies spend by matching the **start of the first system message**
against a fixed prefix table. The combined prompt's system line is:

> `You are an expert knowledge graph extraction specialist for an AI agent memory system.`

**It matches no row.** So without AC8: `extract_nodes` and `extract_edges` vanish from the by-kind
report, their replacement lands in `unknown`, and a by-kind read shows a **fake ~44.5% saving** — the
exact blind spot this repo already found and fixed once (#437), reopened by the very change whose
verification depends on it. The new kind gets its **own label**, not a reused one: the file's own
doctrine is that labelling a replacement with the name of what it replaced hides whether the change
worked.

`edge_timestamps` is safe and stays classified — combined reuses
`extract_edges.extract_timestamps_batch` (`combined_extraction.py:246-249`) — but it gets a pinning
fixture anyway, because "safe by inspection" is the claim this workstream keeps having to retract.

**The lever does not ship if:** C1's fall is under 10%, Q8's orphan rate rises, or Q1/Q4 move outside
the noise band. And — stated now, before the numbers exist — **a result at the boundary is a FAIL,
not a judgement call.** PIPEFF-2 landed at −25.5% against a −25% bar and shipped only as an explicit
owner override, recorded as an override. That precedent is available again, but it must be the
owner's decision on the record, not something this spec's arithmetic quietly absorbs.

---

## 6. Rollout

Same shape as PIPEFF-2, which worked: patch in `graphiti/Dockerfile` behind its own numbered PATCH
block with pre/post-state assertions, byte-identity proven before merge, rollback anchor recorded as
a Railway deployment id, and a post-deploy verification windowed on the harness rather than assumed
from the battery. Prod's real saving is measured after deploy on a drain-clean window — **and the
battery's number is not the number quoted for production**, which is the mistake this workstream made
once and corrected.

---

## 7. Open questions for plan review

1. Is the two-edit patch genuinely as narrow as §2 claims, or does `extract_nodes_and_edges` differ
   from `extract_nodes` in a way the seam hides — `node_episode_index_map` semantics,
   `excluded_entity_types` handling, or the `_collapse_exact_duplicate_extracted_nodes` step it
   performs internally that the separate path may do elsewhere?
2. Is the 13–16% projection sound? It assumes the merged prompt's input ≈ one existing call's input.
   Read `prompts/extract_nodes_and_edges.py` in the deployed image and check whether its instruction
   block is materially longer than the two it replaces.
3. Are 4 reps and the noise-derived bands actually enough, or does the honest answer require more?
   I would rather be told to spend more than produce a second INVALID.
4. Is dropping Q2/Q7 defensible, or does it look like removing the gates an arm might fail? They were
   dropped for measured unpowerability, but the decision is mine and I have made exactly this kind of
   self-serving cut before — it is the finding that BLOCKED the last battery amendment.
5. Should `dedupe_nodes` (24.3%, the largest single kind) be in scope here rather than a separate
   lever? It is untouched by this change and is now the biggest remaining cost.
