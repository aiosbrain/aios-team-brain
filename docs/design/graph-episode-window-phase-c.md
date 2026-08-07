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

- pre-state: `grep -cF` the anchor line == 1 (fixed-string: the anchor contains `(` and `.`; uniqueness, and it fails loud if a base-image bump moves it)
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
node count, which is exactly why Q1 became two-sided.

**It needs a new query, and the first draft of this spec was wrong to say otherwise.** The census
returns per-name **all-time** node counts plus each name's `max(created_at)`; you cannot recover
"entities created in the window" from that (a name with 5 nodes and a recent newest says nothing
about how many of the 5 are new). The only ratios constructible from today's data are all-time
entities ÷ windowed episodes — dimensionally incoherent, drifting upward forever on a growing graph,
and **numerically dead as a sensor**: a week of +30% fragmentation on ~300 new episodes moves a
~5,400-episode cumulative total by under 2%, invisible inside any sane band.

So Phase C adds **one small windowed count** —

```cypher
MATCH (n:Entity {group_id: $g})
WHERE n.created_at >= datetime($since)
RETURN count(n) AS entities
```

— and defines **`entitiesPerEpisode` = entities created in the window ÷ episodes projected in the
same window** (the ledger leg already supplies the denominator, windowed by `projected_at`). Both
legs windowed, same span, dimensionally coherent.

**Windowing by `created_at` also dissolves the baseline problem the first draft created:** the card,
the patch and the graphiti rebuild all ship in the same merge, so a "pre-deploy reading from the
card" was uncapturable by construction. A `created_at`-windowed count is **computable retroactively**
— after deploy, the same query over a pre-deploy span reads the historical baseline out of graph
history. The before/after comparison is therefore taken entirely after the merge, from one surface.

**2. The merge condition is amended, in the open:** the pollution alarm's arming is **not** this
lever's gate, because it does not protect against this lever — and arming cannot be scheduled from
here regardless (the census constants must be set from a prod reading, prod Neo4j has no public
endpoint, and the card is the only surface that shows it: a human read, not an automatable step).
What replaces it is **a build-content requirement, not an external gate** — and it is named as such
rather than dressed up as one: this PR must *contain* the windowed `entitiesPerEpisode` on the card,
so that the post-deploy check below has a sensor to read. The honest gate on the *outcome* is the
verification table itself, which runs after the merge.

## Verification — in the ledger, not the logs

### The prod saving is ~18%, not the battery's 25.5% — corrected before shipping, not after

The battery ran on a **fresh** graph whose baseline was 28,287 tokens/episode; prod's steady state is
**40,070**, the difference being mostly longer dedupe-candidate lists on a mature graph. The
predecessor block this lever removes is roughly **fixed in absolute size** (ten episodes' content,
independent of graph maturity), so the same cut lands differently:

| | baseline | absolute cut | percentage |
|---|---|---|---|
| battery (fresh graph) | 28,287 | −7,202 | **−25.5%** ✅ measured |
| **prod (mature graph)** | 40,070 | ~−7,200 | **~−18%** ← the number to expect |

**This corrects the figure the ship decision was taken on.** It does not change the mechanism, the
quality evidence, or the build — but the expected recurring saving is ~18%, and any verification band
written around 25% would have flagged a fully-working patch as broken.

**After deploy**, over a drain-clean window of comparable episode volume (all readings retroactive
per the windowing above — no pre-deploy capture is required):

| check | expectation | falsifier |
|---|---|---|
| input tokens/episode (harness) | falls **~15–25%** (prod-derived, see table above) | **no fall at all** ⇒ the patch did not take effect in the running image — the silent-no-op class this Dockerfile exists to prevent ⇒ investigate before rollback (a no-op is not a regression) |
| signed cross-check gap (harness) | unchanged (~0) | a rise ⇒ the prompt change moved the validation-retry rate; part of the "saving" is a retry artefact |
| `entitiesPerEpisode` (windowed) | **observational for the first two weeks** — record it, do not gate on it | once two weeks of prod week-over-week variation exist, set the band from that measured variation; **until then a movement is a prompt to look, not a rollback trigger** |
| same-name split share (card) | unchanged (~0) | a rise ⇒ candidate-retrieval damage (unexpected; the census's own job) |

The `entitiesPerEpisode` band is deliberately left underived rather than guessed: the battery's ~7%
was single-rep noise on a 108-episode corpus, while prod's week-over-week **content mix** (a
GitHub-heavy week vs a Slack-heavy one) can move entity yield legitimately by more than that. A band
invented now would both false-fire and swallow real fragmentation — the measured-not-chosen rule this
workstream applies to every other constant.

**Byte-identity check, before merge — anchored on checksums, not on `/tmp`:** the committed script
applied to the pinned wheel deterministically reproduces the measured file, so the check survives a
reboot or a different machine:

| artifact | sha256 |
|---|---|
| `patch-same-item.py` (as committed) | `94ba6b1918b8df3f34fd44737e79a5c42f9e26a00d0fe498975e255dcdfcf2d6` |
| patched `graphiti_core/graphiti.py` (the measured arm ran this exact file) | `49ee534a1043760f9e3b58617f7853edd65e7e643a75f34f75267528cb0ec72d` |

Build the image from the branch, extract `graphiti_core/graphiti.py`, and check its sha256 equals the
second value. Equal ⇒ the shipped patch is the measured patch. This is the one claim in this spec
that can be *proved* rather than argued, so it is a merge precondition rather than a hope.

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
- **Non-`items:` episodes now get zero predecessors** — `correction:<arc_id>` arc-writeback episodes
  have no `items:` prefix, so the same-item filter matches nothing for them. That is the intended
  semantics (a correction episode is not a chunk of a document), but the parent spec required it be
  *stated and pinned* rather than discovered: **this PR carries a test that pins the behaviour for a
  non-`items:` episode name**, carried here from the parent's Risks section so it does not fall
  between the two documents.
- **The patch is a vendored-library edit.** It must be re-verified on every base-image or
  `graphiti-core` bump; the pre-state grep gate makes a moved anchor a build failure rather than a
  silent no-op, which is the durable protection. The `previous_episode_uuids` alternative in the
  parent spec remains the version that would live in our own code — recorded, not scheduled.
