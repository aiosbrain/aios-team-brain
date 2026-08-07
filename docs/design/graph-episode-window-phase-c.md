# Phase C — ship the same-item predecessor filter

**Status:** spec, pre-plan-review · **Date:** 2026-08-07 · **Owner:** Chetan
· **Task:** `PIPEFF-2` → [AIO-821](https://linear.app/je4light/issue/AIO-821)
· **Parent:** [`graph-episode-window.md`](./graph-episode-window.md) — the battery, its two INVALID
  sessions, and Amendments 1–4.

## The decision, and whose it is

**Chetan's product call, 2026-08-07: ship the same-item filter (`SAME`) on the evidence as it
stands.** This spec exists because the battery did *not* clear its own pre-registered bar, and the
record must say so plainly rather than let a ship look like a pass.

What the evidence actually is:

| | measured |
|---|---|
| Input tokens per episode | **−25.5%** (20,792/21,378 vs 28,000/28,574) |
| Entity yield per episode | −3% (6.37 vs 6.57) |
| Cross-chunk continuity | +4% (0.127 vs 0.122) |
| People found / lost | identical, zero lost |
| Same-name splits, retry rate | zero in every arm and rep |
| **Incumbent's own run-to-run noise** | **~7%** on quality metrics (2.0% on cost) |

**No quality loss was detected on any measure. Every observed difference is smaller than the
incumbent's own noise, which cuts both ways: it is equally consistent with "no damage" and with
"damage up to ~7%".** The pre-registered rule required beating a −25% cost bar *by more than the
noise*; at −25.5% the lever lands on the bar, which the procedure reads as INCONCLUSIVE → FAIL.

Two things follow, and both are stated rather than buried:

1. **This ship overrides the battery's procedural outcome.** It is a threshold judgement — "nothing
   detected, detection limit ~7%, mechanism structurally low-risk, saving worth it" — made by the
   product owner, not a measurement result. The battery's verdict stands unchanged in its own doc.
2. **The `W1` arm (−35.8%, the blunt `last_n=1` cut) is NOT shipped, and that is also a product
   call**, now stated openly as Amendment 4's review demanded: we decline a deeper cut whose quality
   risk the battery could not resolve, even though it would clear the cost bar comfortably. The
   preference is architectural and risk-based, not evidentiary.

**Why the mechanism bounds the risk.** The filter does not reduce what is read. It stops attaching
ten *unrelated documents'* chunks to every extraction call; a document's own prior chunks are kept in
full (guaranteed by the tie-rank derivation in the parent spec §4). The only loss channel is
cross-item dedupe judgement — the context that helps the extractor decide "John" here is "John Smith"
there — which is why the battery added Q1's upper bound and Q7, and why neither moved.

## What ships

**`graphiti/patch-same-item.py`, byte-for-byte the script the measured arm ran** (`/tmp/gwb/patch_same.py`,
2026-08-06). The parent spec requires "the sed that ships is the sed that was measured"; shipping the
same script against the same pinned wheel produces a byte-identical `graphiti.py`, which is a
checkable claim rather than a promise — see *Verification* below.

The patch is **purely additive: 17 lines inserted, 0 removed.** It leaves the `retrieve_episodes`
call expression untouched and filters afterwards, guarded on the same `previous_episode_uuids is
None` condition as the retrieval, so an explicit caller instruction is never silently discarded.

Placement: a new **PATCH 3** in `graphiti/Dockerfile`, **after the `pip install` RUN and after PATCH
2** — pip would overwrite an earlier edit, which is precisely what PATCH 2's own comment warns about.
Gates, in the file's established style:

- pre-state: `grep -c` the anchor line == 1 (uniqueness, and it fails loud if a base-image bump moves it)
- the patch script's own asserts (anchor count, the line that must follow it)
- post-state: `grep -q` the `PIPEFF-2` marker **and** `ast.parse` (already inside the script)
- **untouched-elsewhere**: `grep -c RELEVANT_SCHEMA_LIMIT search_utils.py` == **15**, so the patch can
  never widen into the retrieval-quality change the parent spec rejected

## The backstop question, re-derived — and the honest answer is "not the alarm we just shipped"

Amendment 3 made Phase C conditional on *"ALARMFIX-1's replacement pollution signal being live in
prod."* Re-deriving that condition against ALARMFIX-1 as built, **it does not do what the condition
wanted, and pretending otherwise would be the attestation failure this repo has a rule against:**

- The census detects **same-name splits** — one normalised name carried by several nodes.
- ALARMFIX-1's own analysis (and Amendment 3's) established that on graphiti 0.29.3 exact-name
  resolution is deterministic and runs before any LLM, so same-name splits are near-impossible while
  candidate retrieval works. Measured: **0 splits / 684 names**.
- This lever's plausible failure mode is **variant-name** fragmentation ("John" beside "John Smith"),
  which the census counts as two different names and **cannot see by construction** — the identical
  blindness that made Amendment 3 declare Q7 near-vacuous.

So the census is a backstop for a failure this lever is unlikely to cause, and blind to the one it
might. Two consequences:

**1. The metric that IS sensitive is entity yield per episode** — variant-name fragmentation *raises*
node count, which is exactly why Q1 became two-sided. And it is **already computable from data
`groupCensuses` fetches today**: the census query returns per-name node counts (their sum is the
group's entity count) and the ledger leg already returns episode flow for the window. Phase C
therefore adds **`entitiesPerEpisode` to the census output and the admin card** — a derived field, no
new query, no new cost — and that number is the quality leg of the post-deploy verification below.

**2. The merge condition is amended, in the open:** the lever merges when **`entitiesPerEpisode` is
visible on the card** (so a regression is observable), **not** when the pollution alarm is armed. The
arming of the pollution alarm remains ALARMFIX-1's own rollout step and is not this lever's gate,
because it does not protect against this lever. Arming also cannot be scheduled from here: the census
constants must be set from a prod reading, prod Neo4j has no public endpoint, and the card is the
only surface that shows it — a human read, not an automatable step.

## Verification — in the ledger, not the logs

**Before deploy**, record from the harness over a drain-clean prod window (the current steady state,
~40,070 input tokens/episode per the parent spec's baseline) and note `entitiesPerEpisode` from the
card.

**After deploy**, over a drain-clean window of comparable episode volume:

| check | expectation | falsifier → roll back |
|---|---|---|
| input tokens/episode (harness) | falls ~20–30% | **no fall** ⇒ the patch did not take effect in the running image — the silent-no-op class this Dockerfile exists to prevent |
| signed cross-check gap (harness) | unchanged (~0) | a rise ⇒ the prompt change moved the validation-retry rate; part of the "saving" is a retry artefact |
| `entitiesPerEpisode` (card) | within ~±10% of the pre-deploy reading | a **rise beyond that** ⇒ variant-name fragmentation, the lever's named risk ⇒ roll back |
| same-name split share (card) | unchanged (~0) | a rise ⇒ candidate-retrieval damage (unexpected; the census's own job) |

**Byte-identity check, before merge:** build the image from the branch and diff the resulting
`graphiti_core/graphiti.py` against the file the measured arm ran (`/tmp/gwb/graphiti.same.py`). Equal
⇒ the shipped patch is the measured patch. This is the one claim in this spec that can be *proved*
rather than argued, so it is a merge precondition rather than a hope.

## Rollout and rollback

1. **Rollback anchor recorded: graphiti deployment `fde9d3b4-9e7`** (SUCCESS, 2026-08-07T00:57:11).
   Rollback is a **dashboard rollback to that deployment** — never `railway up`/`redeploy`, which is
   denied by policy and has previously rebuilt a broken image on this exact service.
2. **Precondition, re-confirmed at deploy time:** the graphiti service must still have **no custom
   start command**. A start command re-syncs the venv at boot and silently reverts every patch in the
   image — every gate in the Dockerfile passes and the server runs unpatched anyway.
3. Note: the graphiti service builds from this repo, so **it rebuilds on every merge to main**,
   including merges that do not touch `graphiti/`. That is pre-existing, and it means this patch
   ships on the next merge whether or not that merge is this one — so the byte-identity check and the
   post-deploy verification are tied to *this* PR's merge, not to a separate deploy action.
4. `docs/ARCHITECTURE.md` is updated in the same PR (CLAUDE.md §1).
5. Rollback is data-safe in the same sense the 0.29.3 upgrade was — same labels, same embedder, same
   indices — but Graphiti's worker queue is **in-memory**, so episodes accepted (202) and unprocessed
   at rollback are lost; confirm the brain's reconcile re-pushed them.

## Risks

- **The ~7% detection limit is real and unresolved.** A quality loss of up to ~7% would not have been
  visible to the battery. Accepted knowingly (see *The decision*); `entitiesPerEpisode` on the card is
  the ongoing observation that would surface a larger drift than the battery could rule out.
- **Prod's graph is mature; the battery's was fresh.** Dedupe candidate lists are longer on a mature
  graph, so both the saving and the risk may differ in magnitude from the measured numbers. The
  post-deploy token check is what confirms the saving actually transferred.
- **The patch is a vendored-library edit.** It must be re-verified on every base-image or
  `graphiti-core` bump; the pre-state grep gate makes a moved anchor a build failure rather than a
  silent no-op, which is the durable protection. The `previous_episode_uuids` alternative in the
  parent spec remains the version that would live in our own code — recorded, not scheduled.
