# Merge the two extraction calls into one — PIPEFF-5 / AIO-868

**Status: PAUSED at the owner's decision, 2026-08-16 — patch built and reviewed, battery NOT run.**
Spend: **$1.06** of a $16 envelope. The incumbent baseline below is measured; the candidate arm is not.
**Parent:** `docs/design/graph-ingestion-efficiency.md` §4 ("noted, not proposed"), now the largest
remaining lever after PIPEFF-4 (packing) was declined on evidence.
**Siblings shipped:** PIPEFF-2 (predecessor filter, −25.5% verified) · PIPEFF-3 (content-defined chunking).
**Owner approval:** the quality battery's spend was approved 2026-08-11 ($8), and **re-approved at
$16** on the same day once the power arithmetic was corrected.
**Build with:** opus / high — a vendored patch to a third-party extraction path, gated on a paid
quality battery, in the subsystem where this repo has already paid for a silent quality regression.

---

## Relevance re-check, 2026-08-16 — main moved 29 commits, the lever did not

The spec sat for four days while Phase C (per-project graph projection, PCCC-1..6), the alarm work
and the mutation-flow loop landed. Re-checked against `origin/main` before doing anything else,
because a spec that assumes a codebase that has moved is worse than no spec.

**Still relevant, and the lever is bigger than when it was written:**

| check | result |
|---|---|
| Did anyone ship combined extraction? | **No** — zero `extract_nodes_and_edges` rows in `llm_usage`, and zero `unknown`, so the classifier has not drifted either |
| Is the patch target intact? | **Yes** — `graphiti/Dockerfile` and the graphiti pin: **0 commits** |
| Is the instrument intact? | **Yes** — `scripts/graph-window-battery/capture-tap.mjs`, `scripts/graph-window-battery/harvest.ts`, the battery scripts: **0 commits**. The response-capture edit (§4) is still the only instrument change needed |
| Is `graph-call-kind.ts` still missing the row? | **Yes** — 0 commits, so AC8 stands exactly as written |
| Is the saving still there? | **Larger.** Re-measured on a fresh 4-day window: `extract_edges` 25.1% + `extract_nodes` 22.5% = **47.6%** of graph cost, against **44.5%** when the spec was written |

**One thing DID change, and it touches the battery rather than the patch.** Phase C rewrote how the
projector derives `group_id`: it now resolves a stored per-project *home pointer*, with
`episodeGroupId` kept as "the quiet fallback for an unbootstrapped team" (`project.ts:727`, `:791`).
Two consequences for the battery, neither fatal, both to be closed at build time:

1. **The one-group property survives by fallback, not by design.** A freshly seeded battery DB has no
   project pointer rows, so the fallback applies and the corpus lands in one group as the spec
   assumes. But the same comment says a scheduler tick bootstraps those rows "within a tick" — so the
   battery must either keep its scheduler off for projection or assert the corpus is single-group
   **after** the push, not assume it from the seed.
2. **Initiative fan-out is new and would inflate every count.** PCCC-5 added fan-out pushes with a
   per-pass budget of 25 (`FANOUT_PUSH_MAX_PER_PASS`, `project.ts:222`). A fanned-out item is pushed
   to more than one group, which would break the pinned per-rep episode denominator *and* inflate
   cost in both arms. The battery must pin **`GRAPH_FANOUT_PUSH_MAX_PER_PASS=0`** and assert zero
   fan-out rows, rather than relying on a corpus that happens to have no initiatives.

Both are added to the run's preconditions. Neither changes the patch, the projection, or the $16.

---

## PAUSED — what exists, what does not, and what it would take to finish

**Why it stopped.** Measured on prod's ledger the same day: graph spend is **$5.00–7.50/week**
(~$0.011/episode, ~450–600 episodes/week) — down from a $48/day peak before this workstream. At that
volume this lever's 12–14% is worth **$3–4/month**, against **~$15 more** to finish validating it.
Payback ~4–5 months. The owner's call was to hold; recorded as their decision on the measured number.

**Done, merged or pushed:**
- The patch itself — `graphiti/patch-combined-extraction.py` + Dockerfile PATCH 4, validated against
  the deployed file, two adversarial review rounds, 6 mutations. PR #557, **draft**.
- The metering row so the merged call can never read as `unknown` (would have shown a fake ~45% saving).
- The corpus instrument repaired — it was gating on the legacy chunker and under-counting by **40%**.
- Q8′ built and tested, so the orphan-drop metric is buildable rather than discovered at harvest.
- `run-rep.sh`, `build-arms.mjs` — the arms are proven to differ by exactly this patch.

**Measured, and the one durable artifact of the spend — incumbent (PATCH 3) baseline, fresh graph,
98 episodes, cross-check exact:**

```
input tok/episode  28,750        cost/episode  $0.0108        multiple  46.0x
  dedupe_edges   24%   ·  dedupe_nodes  24%   ·  extract_edges 23%   ·  extract_nodes 20%
```

**`extract_nodes` + `extract_edges` = 43% of spend**, corroborating the 47.6% measured on prod from a
different corpus. The lever's target is real and roughly the stated size.

**To finish:** 7 more incumbent reps + 8 candidate reps, ~$15, ~6 hours. Everything else is in place.

### The three conditions for turning it on — two of them mechanical

The patch merges **behind a build flag defaulted off**, so production behaviour is unchanged and the
17 files of instrument repair and tests stop being stranded on a branch (one of them fixes a bug live
on main today: the corpus gate counts with the legacy chunker and under-counts by **40%**).

A flag with only prose behind it becomes furniture. So two of the three conditions are enforced by
tests, not by memory:

| # | condition | enforcement |
|---|---|---|
| 1 | **On only after a passing battery.** Never on an unmeasured guess — this changes the extraction *prompt*, so mechanism cannot carry the quality argument | **Mechanical.** `PIPEFF5_COMBINED_EXTRACTION` defaults `0`; a guard asserts the Dockerfile's default path produces an **unpatched** file, so a merge can never quietly enable it |
| 2 | **Run the battery only when it pays.** Graph spend sustained at **~3× today (~$15/week)**, *or* a real customer heading for that volume | Judgement, but on a checkable number: today is **$5.00–7.50/week** at ~$0.011/episode, measured. At ~$15/week the saving is ~$8/month and the ~$16 battery pays back in ~2 months |
| 3 | **Delete by 2027-02-16 if neither happens.** Six months. Not "revisit" — *delete* | **Mechanical.** An expiry guard reddens on that date and names the decision, so the choice gets made by a person instead of decaying into permanent config |

**Why condition 2 is different for a product than for us.** If this ships to other teams, the trigger
is not *our* volume — it is that the validation should exist **before** a customer runs at that
volume, not after. Our own bill may never grow; that does not make the lever less relevant to someone
running 10×. The trigger is therefore "3× our spend **or** a customer heading there", whichever
arrives first.

**Why an expiry rather than a `TODO`.** A dormant vendored patch is real carrying cost: every reader
of `graphiti/Dockerfile` has to work out whether it is live. The guard converts "we should decide
this someday" into a dated, unavoidable decision — and if the answer is delete, that is a success of
this design, not a failure of the lever.

**What keeps the patch honest while dormant — stated precisely, because the first version of this
paragraph was false.** It said the guard "runs the real patch script against the real anchors on every
CI run". It does not: the guard runs the real script against a **synthetic host** that reproduces the
anchors, and with the flag off the Docker build never applies the patch to the real file at all. So
**upstream drift is NOT detected while dormant** — a graphiti bump could move the anchors and CI would
stay green until someone tried to enable it.

What IS enforced: the off-branch asserts the served file's **sha256** at build time, so a base-image
or PATCH 3 change that moves what "off" ships fails the build. That covers the shipped artefact, not
the dormant patch's applicability. The applicability gap is **accepted** — it is discovered at enable
time, which is exactly when the battery would be run anyway, and closing it would mean applying an
unvalidated patch on every build to see whether it still fits.

### The scaling finding that matters more than this lever

Prod's **mature** graph bills **40,070** tokens/episode; this **fresh** graph bills **28,750** — a
**+39% penalty from graph maturity alone**, at identical volume. The growth is in `dedupe_nodes`
(24% of spend, 8,760 avg input tokens): its candidate list grows as the graph does.

For a team running this for a year, **cost per episode rises over time independent of how much they
ingest.** That is a larger and more structural risk than a one-off 12% saving, and no lever in this
workstream addresses it. Recorded as an observation, not a proposal.

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

### AMENDMENT, 2026-08-16 — the corpus gate was measuring an algorithm we stopped using

Caught by the pre-run preconditions, before any rep: **the seeder's episode-budget gate was
decorative.** It reported "117 episodes · within range" and the projector then pushed **164**.

`corpus.mjs`'s `countFromBody` estimates `ceil(chars / CHUNK_CHARS)` — exact under the legacy
byte-offset chunker, and **not a function of `length(body)` at all** under `cdc1` (PIPEFF-3, shipped
last week). The estimate's own ⚠️ note said it "UNDER-counts by ~5%". Measured: **40%**. So the note
was wrong too, and the `EPISODE_BUDGET` 90–120 gate passed a corpus 44 episodes outside its own
range, while bucket A ("≥8 chunks") was being decided on a guess.

**This is the PIPEFF-2 finding repeating one lever later** — there, the corpus rule yielded 153
episodes against an assumed ~100 and silently changed what a pre-registered band meant. Same class,
caught earlier this time: before the reps rather than at harvest.

**Fixed, and the fix is a bridge not a copy.** `scripts/graph-window-battery/count-chunks.ts` runs
under `tsx --conditions react-server` and imports the projector's own `chunkContent`; the seeder
shells out to it and now **buckets and gates on real counts**. Duplicating the CDC algorithm in
`.mjs` was rejected — that is the parallel-implementation drift this suite already guards against
once. Verified: the bridge reproduces the projector's 164 exactly.

**Then the honest number made the old targets infeasible.** Under `cdc1` the most recent bucket-A
candidate is **80 episodes — two thirds of the entire budget in one document**, and with it in, the
budget and prod's ~17% single-chunk share became mutually unsatisfiable (the only feasible draw with
all four buckets was 120 episodes at a 9.2% share, failing the mix-match that makes C1 transferable).
So `MAX_ITEM_EPISODES = 30` excludes single outlier documents, and targets moved A:3→4, B1:15→10,
B2:5→6, C:8 unchanged.

**What that costs, stated rather than discovered:** the battery does **not** cover documents above
the cap, and prod has them. The claim being bought is only that one document must not be two thirds
of a measurement whose entire purpose is a blended per-episode figure — at 8 reps its variance would
swamp every other item. A run that wants the very-large-document case needs its own draw and its own
budget, not this one silently stretched.

**Corpus as run: 28 items → 98 episodes, single-chunk share 16.3% (prod ~17%), budget within range.**

**Superseded draft note — the earlier "31 items → 117 episodes"** (budget 90–120: in range; single-chunk share
17.1% against prod's ~17%). Earlier text assumed 108. **No band depends on that number** — Q5's gate
is "any rise", not a per-episode fraction, so the PIPEFF-2 trap (a retry ceiling silently changing
meaning when the corpus grew from ~100 to 153) does not reproduce here. Only the money moves, by
117/108 ≈ 1.08.

**Budget guard, because a projection is not a measurement.** Rep 1 of each arm runs first; its
*measured* cost is multiplied out to all 16 reps and checked against the $16 envelope **before reps
2–8 start**. If it projects over, the run stops and the owner decides. The commitment made when the
envelope was approved was to stop and ask rather than quietly overrun, and a corpus 8% larger than
assumed is exactly how "inside the envelope" becomes "over" one rep at a time.

**Bands are derived from the pooled within-arm spread observed in THIS battery**, with the historical
7% as a sanity floor. The 7% was measured on the incumbent only; the candidate's noise is unknown, and
a longer multi-task prompt may well be noisier.

**That is not circular** — the band comes from *within*-arm variance, the verdict from the *between*-arm
mean difference, and a real arm effect does not inflate within-arm spread. It needs two guards to stay
honest:

- **t-quantiles, not z.** The variance estimate at df=14 is itself noisy, and a z-band is too narrow.
- **A candidate-noise validity ceiling.** Pooling *rewards an unstable candidate*: its own noise
  fattens the band that judges it. **If the candidate's within-arm SD exceeds ~2× the incumbent's,
  the session is INVALID**, not judged with a fat band. The 7% floor only guards the too-narrow
  direction; this guards the other. The absence of exactly this kind of validity condition is what
  produced the last INVALID verdict.

### The two arms — stated, because the spec did not say and the wrong answer is catastrophic

Found while preparing the run: this document said "2 arms — incumbent vs combined" and **never said
what file each arm runs.** That is the single most consequential thing it could have left implicit.

| arm | `graphiti_core/graphiti.py` is | why |
|---|---|---|
| **`PATCHED3`** (incumbent) | stock 0.29.3 **+ PATCH 3** | this is **what prod runs today**. It is the thing the candidate must beat |
| **`COMBINED`** (candidate) | stock 0.29.3 **+ PATCH 3 + PATCH 4** | the incumbent plus this lever, and nothing else |

**If the incumbent arm ran STOCK 0.29.3**, the measured delta would fold in PATCH 3's
already-shipped −25.5% and report this lever at roughly triple its real size — a confidently wrong
number, produced by a battery that ran perfectly. PIPEFF-2's own baseline drifted once already
(fresh-graph 25.5% quoted as prod's number until a review caught it); this is the same class, one
layer down.

**Enforced, not documented:** `scripts/graph-window-battery/build-arms.mjs` generates both files from
the same pinned wheel copy and **asserts that `diff PATCHED3 COMBINED` is exactly what
`patch-combined-extraction.py` produces** — the arms differ in that patch and nothing else. It refuses
to write the files otherwise, so a mis-built arm fails before the stack starts rather than after the
money is spent.

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

**Q8′ needed a capture the tap does not take.** `scripts/graph-window-battery/capture-tap.mjs:65-70` appends the **request** body
and nothing else; the response is forwarded (`:82-84`) and discarded. So the raw pre-drop entity list
does not exist anywhere. **Fix, before any run:** the tap also records the response body — `buf` is
already in hand at `:83`, so this is a few lines, and the byte-for-byte forwarding property that
makes the tap trustworthy is untouched (it still forwards exactly what it received, it merely also
writes down what came back).

**The two captures get DIFFERENT failure policies, and my first draft got this wrong by saying
"capture stays fatal, for the same reason it already is".** They do not protect the same thing:

- **Request capture stays FATAL.** It fires *before* forwarding, so a failed write means unrecorded
  traffic would reach a paid model. That guards spend integrity and must keep killing the process.
- **Response capture is NON-FATAL.** It fires *after* the money is spent. Exiting there turns a
  transient write error into an aborted paid run with nothing to show for it — the worst outcome
  available.

Silent loss is prevented instead by **pairing**: each request record carries an id, each response
record carries the same id, and **the Q8′ harvest REFUSES** (the AC7 pattern already used everywhere
in this instrument) if any `extract_nodes_and_edges` request has no paired response. An unmeasurable
Q8′ then reads as a refusal rather than as a low loss rate — which is the difference between "we
could not tell" and a plausible wrong number. A dead disk still halts the run, because the request
write fails first.

**Pre-registered, from the code review:** ids are salted with the tap process's start epoch, because
the capture file survives a tap restart and a bare counter would restart at `0` — two incarnations
writing the same ids into one JSONL, and a harvest pairing by id could pair incarnation 1's request
with incarnation 2's response. Salting (rather than refusing a non-empty capture file) keeps a
mid-run restart recoverable, which the last battery needed several times. **The harvest must also
REFUSE on any duplicate id**, not merely on an unpaired one — that is the remaining gap salting
does not close, and it is registered here before the run rather than discovered at harvest.

**Q9 depended on prior-session artifacts that no longer exist.** I wrote "the prior session's
harvests are on disk". They are not — Docker died three times during that session and nothing
survives on this machine. **Fix:** make the gate self-contained — build the consensus list from
**this session's own 8 incumbent reps** (entities present in *every* one), then require the candidate
to retain them. This is strictly better than what I specified: same corpus, same session, no
staleness, and no dependency on artifacts I cannot verify. It is not circular — the list is built
from the arm the candidate is measured *against*, never from the candidate. The raw material exists:
`scripts/graph-window-battery/harvest.ts:41,62` already stores `entityNameCounts` per rep, so this is a decision-side computation
and the tap edit stays the only instrument change.

**Three things Q9 must pre-register, or it becomes the theatre Q2/Q7 were dropped to avoid:**

1. **The candidate-side quantifier.** "Appears in the candidate's graph" is ambiguous across 8 reps,
   and at ~7% noise "present in every candidate rep" false-fails on flicker — an entity at 95%
   per-rep presence survives all 8 only ~66% of the time. **Hard FAIL only when a consensus entity is
   absent from ALL 8 candidate reps** (unambiguous loss); partial flicker is reported as a
   diagnostic. Names matched normalised, with near-misses reported separately — the combined prompt's
   naming rules differ enough that a systematic *rename* would otherwise read as mass entity loss.
2. **A consensus floor.** An empty or tiny intersection makes Q9 a vacuous pass. **If |consensus| <
   max(25, 20% of the mean per-rep entity count), Q9 reads NOT RUN — unpowerable, never PASS**, and
   |consensus| itself appears in the verdict table. The measured 7.2% was *yield* variance; per-entity
   churn is unmeasured and could be far higher, so this floor is load-bearing rather than ceremony.
3. **`consensus ∩ incumbent-orphans`, computed with the pre-run orphan census and FREE.** Any
   consensus entity that is an orphan in the incumbent graph will be deleted by the candidate **by
   construction** (`combined_extraction.py:295`) — a guaranteed Q9 FAIL that is knowable **before a
   cent is spent**. If that set is non-empty, the named list goes to the owner *before* any candidate
   rep runs: either the loss is accepted on the record (and those entities carry a status row,
   excluded from Q9), or the lever is dead for free. **This is the single highest-value check in the
   spec, because it can end the experiment without spending the $16.**

**Both fixes are free and both are prerequisites to spending anything.** Recorded here rather than
quietly corrected, because "I specified a metric against an instrument I had not opened" is the
failure, not the two fixes.

### The free check, run — the incumbent's orphan share is 7.1%

Measured on prod's live graph (read-only Cypher via `railway ssh`, 2026-08-11), **before spending
anything**:

```
aios_team:     entities 19,051   orphans 1,356   share 7.1%
aios_external: entities     16   orphans     2   share 12.5%
```

**The lever survives this check** — 7.1% is meaningful but not disqualifying. What it fixes:

- **Q8′ gets its pre-registered bound.** The candidate FAILs if its orphan-drop loss rate exceeds the
  **battery incumbent's** share — measured on the battery graph at run time, with prod's 7.1% as the
  prior and a sanity check. If the battery's own figure lands far from 7.1%, that discrepancy is
  itself reportable before any candidate rep runs.
- **It sizes the confound Q1′ exists to dodge.** Raw entities-per-episode should fall ~7% in the
  candidate **mechanically**. Anyone reading raw entity count would have called that a 7% quality
  regression; Q1′ (connected entities) does not move on it.
- **It predicts Q9's exposure.** If ~7% of entities are orphans, a consensus list drawn from all
  entities carries ~7% guaranteed-FAIL members. The `consensus ∩ incumbent-orphans` exclusion is
  therefore **load-bearing, not hypothetical** — without it Q9 would have failed on arithmetic.

**Prediction on the record before the run:** raw entity yield falls ~5–9% in the candidate,
`connected` entity yield does not move outside the band, and Q8′ lands near the battery incumbent's
own orphan share. If raw yield falls much *more* than the orphan share explains, that is real entity
loss and Q9/Q1′ must catch it.

**Also measured before any arm runs:** the battery incumbent's orphan share, on the battery graph. It is the size of the
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
consensus list built from **this session's own 8 incumbent reps** (see the buildability note above;
an earlier draft of this very paragraph said "the prior session's harvests, which exist on disk", and
that sentence survived two paragraphs below its own retraction until the delta review caught it).
The drop is only clean *with* Q9; without it, it is the cut that blocked the last amendment.

### Instrument, reused

The corpus rule, seeder, harvester, refusing parsers and `scripts/graph-window-battery/decision.mjs` are reused from PIPEFF-2
**unchanged**. The capture tap is reused **except for the response capture Q8′ requires** (above) —
stated precisely, because "the instrument does not change" was false the moment Q8′ needed it to.

## 5. Acceptance

Itemized criteria; each bullet leads with its observable anchor (test tier + the file that carries
it), and the table beneath restates the same set with falsifiers.

- **AC1 — `graphiti/Dockerfile` build gate:** the image built from this branch produces a
  `graphiti_core/graphiti.py` whose sha256 equals the file the battery measured, bit-for-bit.
- **AC2 — unit, `test/guards/graphiti-patch-combined.test.ts`:** the patch script is idempotent
  (applying twice is a no-op) and fails loudly on a missing anchor rather than silently skipping.
- **AC3 — unit, `test/guards/graphiti-patch-combined.test.ts`:** the patched file parses under
  `ast`, and the patched call path is exercised against a real episode.
- **AC4 — unit, `test/guards/graphiti-patch-combined.test.ts`, compositional:** the patch hands
  `previous_episodes` to the combined call unchanged. The *zero-predecessors-for-a-single-chunk-item*
  property is pinned by `test/guards/graphiti-patch-same-item.test.ts` on PATCH 3, and the two are
  bound together by the Dockerfile applying PATCH 3 before PATCH 4 against the same file. **No single
  test composes all three**, and this bullet says so rather than implying one does — the review
  caught the earlier wording claiming a structural assertion that does not exist.
- **AC5 — unit, `test/guards/graphiti-patch-combined.test.ts`, plus a battery-harvest assertion:**
  the combined call replaces BOTH reads (its output flows downstream; neither `extract_nodes` nor
  `extract_edges` is called) is provable at unit level by executing the patched Python. The **full
  per-episode call-kind profile** (one batch `edge_timestamps` iff edges exist, 0..k per-edge
  fallbacks) is **not** — it needs a real graphiti against a real model, so it is asserted at battery
  harvest against `llm_usage`, not in a data-mechanics test. An earlier draft of this bullet claimed
  a `test/datamechanics/graph-combined-extraction.datamechanics.test.ts` that cannot exist: the data
  layer has no graphiti in it. Corrected rather than satisfied by writing a test that would have
  stubbed the very thing under test.
- **AC6 — unit, `test/guards/graphiti-patch-combined.test.ts`:** with `pre_extracted_edges=None` the
  function's behaviour is identical to today, so the un-patched path is untouched.
- **AC7 — unit, `test/graph-window-battery-decision.test.ts`:** the decision procedure refuses rather
  than passing when a rep is missing or a window is ambiguous.
- **AC8 — unit, `test/graph-call-kind.test.ts`:** `lib/llm/graph-call-kind.ts` classifies the real
  rendered combined prompt as `extract_nodes_and_edges`, not `unknown`.

| # | Criterion | Tier | Falsifier |
|---|---|---|---|
| AC1 | The image built from this branch produces a `graphiti.py` whose sha256 is **bit-for-bit the file the battery measured** | build gate | any mismatch — "we ship what we tested" must be proved, as in PIPEFF-2 |
| AC2 | The patch script is **idempotent and asserts its anchors**: applying twice is a no-op, and a missing anchor fails loudly rather than silently skipping | unit (runs the real Python) | a silent no-op — the failure `graphiti/Dockerfile`'s gates exist for |
| AC3 | The patched file **parses under `ast`** and the patched call path is exercised end-to-end against a real episode | unit + e2e | any import/runtime error |
| AC4 | **PATCH 3's predecessor filter still applies** under the combined call — a single-chunk item receives **zero** predecessors, a multi-chunk item receives only its own | unit (runs the real Python) | any predecessor from another item reaching the merged prompt |
| AC5 | The **full per-episode call-kind profile**: exactly one `extract_nodes_and_edges`; one **batch** `edge_timestamps` iff any edge was extracted; **0..k per-edge `edge_timestamps` fallbacks**, only for edges the batch left fully null; **zero** `extract_nodes` / `extract_edges` | unit + data-mechanics | any extra, missing or duplicated kind. "`extract_edges` not called" alone would miss a duplicated or lost timestamp call — the guard must cover the level that changed |
| **AC8** | **`lib/llm/graph-call-kind.ts` gains an `extract_nodes_and_edges` row in THIS PR**, with a fixture built from the **real rendered prompt** (unit, shipped). That `llm_usage` records the kind with non-zero tokens is asserted at **battery harvest**, not in data-mechanics — the data layer has no graphiti in it, so a dm test would stub the classifier's input and prove nothing | unit (shipped) + harvest | the call landing in `unknown` |
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

**Pre-registered, so a rising call kind is not read as a bug at harvest:** `edge_timestamps` **volume
will go UP in the candidate arm**, and that is correct behaviour. The incumbent's `extract_edges`
prompt emits `valid_at`/`invalid_at` **inline** (`prompts/extract_edges.py:40-66`), so its per-edge
fallback fires only for undated edges. `CombinedFact` carries **no** timestamp fields, so the
candidate gets dates from an internal **batch** call — additive — and edges that batch leaves fully
null still legitimately fall through to the per-edge path (`edge_operations.py:680,813`). Both share
the same system line, so both classify as `edge_timestamps`. Expected impact ~0.5% of graph cost,
well inside the projection's slop. **An AC that demanded "exactly one `edge_timestamps`" would have
red-barred correct code** — which is what the first draft of AC5 did.

**The lever does not ship if any of these trip** — restated verbatim against §4's table, because the
first draft of this sentence still gated on **Q8 and Q1, which no longer exist**, and this is the
sentence a merge decision gets read from:

| gate | FAIL |
|---|---|
| **C1** | cost fall **< 10%** |
| **Q1′** | connected entities/episode outside the band, either direction |
| **Q4** | edges/episode falls outside the band |
| **Q8′** | orphan-drop loss rate **above the incumbent's measured orphan share** |
| **Q9** | a consensus entity absent from **all 8** candidate reps |
| **Q5** | any rise in retry rate |

If Q1′ and Q4 trip together the verdict says so as **one** finding — across-the-board
under-extraction fails both, and reporting it as two confirmations would double-count a single cause.

And — stated now, before the numbers exist — **a result at the boundary is a FAIL,
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
