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

| assumption for the merged prompt's input | projected saving |
|---|---|
| input = one call's worth (optimistic) | **15.9%** of graph cost |
| input = one call's worth **+15%** for merged instructions (conservative) | **13.4%** |

**So the parent's ~15% survives measurement** — which is worth saying plainly, because this document
exists partly because *the last two inherited estimates did not*. The honest range is **13–16%**, and
the residual uncertainty is the merged prompt's own length, which the battery will measure directly
rather than assume.

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

---

## 3. Why this one cannot ship on mechanism, unlike PIPEFF-2

PIPEFF-2 removed *padding* — the same question with less junk attached — so its quality argument
could lean on mechanism. **This changes the question itself.** A different prompt can produce a
different set of entities and edges from identical content. There is no mechanism argument available,
and one is not attempted here.

**The quality prior is, for the first time in this workstream, positive.** Upstream's own docstring
(`combined_extraction.py:53-55`) claims combined extraction *"produces better results than separate
node+edge extraction because the model can see both tasks simultaneously, ensuring every entity has
at least one connecting fact and reducing orphaned nodes."*

That is a **falsifiable, directional claim**, and it hands the battery a metric the previous one did
not have: **orphan rate** — entities with no incident edge. If upstream is right it falls. If it
rises, the merged prompt is producing entities it cannot connect, which is a quality regression this
lever must not ship with. It is measured with one Cypher query and no LLM call.

---

## 4. The battery — designed around why the last one came back INVALID

Session 2 of PIPEFF-2 returned **INVALID** because the incumbent's own two runs, at temperature 0 on
byte-identical input, differed by **7.2%** on entity yield — larger than the 5% validity ceiling the
bands assumed. Two reps cannot separate an arm's effect from the provider's noise. That is now a
**measured property of this stack**, not a surprise, and this battery is built on it:

| | last time | this time |
|---|---|---|
| arms | 3 (W10 / SAME / W1) | **2** — incumbent vs combined |
| reps per arm | 2 | **4** |
| bands | assumed 5% ceiling | **derived from the measured ~7% run-to-run noise**, before any run |
| corpus | 31 items / 108 episodes, pinned | same pinned corpus — comparability with the prior session |

**4 reps is the minimum that makes the question answerable**, not a round number: with a ~7%
per-rep spread, the standard error of a 4-rep mean is ~3.5%, so an effect of ~7% is separable from
noise and an effect of ~3% is honestly *not* — and the spec must say which effects it can and cannot
detect **before** the run, not after.

**Reused as-is from PIPEFF-2**, because it exists and is already mutation-proven: the corpus rule
(`scripts/graph-window-battery/corpus.mjs`), the seeder, the capture tap, the harvester, the judge's
refusing parsers, and `decision.mjs`. The arms change; the instrument does not.

**Pre-registered, before any run:**

| Q | metric | direction that FAILS |
|---|---|---|
| C1 | input tokens per episode | a fall smaller than **10%** — under the conservative projection, the lever is not paying for a vendored patch |
| Q1 | entities per episode | a move **outside** the noise band in **either** direction — a rise is fragmentation, a fall is missed content (two-sided, per the AIO-693 lesson) |
| **Q8** | **orphan rate** (entities with no incident edge) | a **rise** — upstream's own claim inverted, and the specific failure a merged prompt would produce |
| Q4 | edges per episode | a fall outside the band — fewer relationships is the thing edges exist for |
| Q5 | retry rate (harness signed cross-check) | any rise — a longer merged prompt could push validation retries |

**Q2 (people recall) and Q7 (name convergence) are NOT carried forward.** The last session proved
them unpowerable on this install: the roster has exactly one multi-word human name appearing in
content, and 0.29.3's deterministic exact-name matching makes Q7 read ~1.0 for every arm. Running
them again would manufacture two guaranteed passes and dress the result up as five-for-five.

**Projected spend: ~$6.50.** 2 arms × 4 reps × 108 episodes, at the post-PIPEFF-2 measured rate of
~$0.80/rep, plus headroom. **Envelope: $8.00** — I will stop and ask rather than exceed it, as last
time. The candidate arm is cheaper than the incumbent by construction, so this is an upper bound.

---

## 5. Acceptance

| # | Criterion | Tier | Falsifier |
|---|---|---|---|
| AC1 | The image built from this branch produces a `graphiti.py` whose sha256 is **bit-for-bit the file the battery measured** | build gate | any mismatch — "we ship what we tested" must be proved, as in PIPEFF-2 |
| AC2 | The patch script is **idempotent and asserts its anchors**: applying twice is a no-op, and a missing anchor fails loudly rather than silently skipping | unit (runs the real Python) | a silent no-op — the failure `graphiti/Dockerfile`'s gates exist for |
| AC3 | The patched file **parses under `ast`** and the patched call path is exercised end-to-end against a real episode | unit + e2e | any import/runtime error |
| AC4 | **PATCH 3's predecessor filter still applies** under the combined call — a single-chunk item receives **zero** predecessors, a multi-chunk item receives only its own | unit (runs the real Python) | any predecessor from another item reaching the merged prompt |
| AC5 | `extract_edges` is **not called** when the combined path runs — the saving is real and not additive | unit | both call kinds present in one episode's `llm_usage` rows |
| AC6 | With `pre_extracted_edges=None` the function is **byte-identical in behaviour** to today, so the un-patched path is untouched | unit | any divergence on the fallback path |
| AC7 | The battery's decision procedure **refuses** rather than passing when a rep is missing or a window is ambiguous | unit (existing, re-pinned) | a verdict on incomplete data |

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
