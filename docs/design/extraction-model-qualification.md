# Qualify an extraction model before it governs the graph

**Status:** revised after plan review — 2 blockers, both mine, plus a measurement I had to retract
· **Date:** 2026-08-03 · **Owner:** Chetan
· **Task:** `EXMODEL-1` → [AIO-705](https://linear.app/je4light/issue/AIO-705)

## The problem

The only save-time check on the extraction model reads a **catalogue flag**
(`checkStructuredOutputSupport`, #442: does OpenRouter list `structured_outputs`?). On 2026-07-30 a
model that passes that flag was chosen, and it degraded the graph for four days: duplicate entities,
`IS_DUPLICATE_OF` share roughly doubled, work per episode climbed 7.5 → 49 while total spend *fell*.

The flag is not weak — it is **blind to the failure that occurs**. Every model below advertises
`structured_outputs: true`, and five of them break the graph.

## What plan review corrected, and what the deployed image then corrected in me

### 1. My first measurement was against a payload we do not send (retracted)

I measured with graphiti-core **0.29.3**'s prompts, its raw `model_json_schema()` without `strict`,
and an episode body of `user(): …`. Prod runs `zepai/graphiti@sha256:76d14f30…`
(`graphiti/Dockerfile:21`), which contains graphiti-core **0.13.2**, calls
`client.beta.chat.completions.parse` (`llm_client/openai_client.py:72`) — so the SDK sends
`strict: true` with `additionalProperties: false` throughout — and builds the body as `(user): …`
(`graph_service/routers/ingest.py:61`). 0.13.2's dedupe schema is also a different question:
`duplicate_idx` over `idx` candidates, not 0.29.3's `duplicate_candidate_id` over `candidate_id`.

On that wrong payload I reported **`openai/gpt-4.1-mini`: all 12 calls HTTP 400 — unusable**. That
was my schema's fault (`additionalProperties is required to be supplied and to be false` — which
`.parse()` supplies). **Retracted: `gpt-4.1-mini` passes everything.** This is the third time on this
workstream that a fixture of my own making produced a confident wrong verdict, and it is the reason
the probe below is generated *from the deployed image* rather than written by hand.

### 2. "Advisory, never blocking" contradicted the feature's own success criterion

I wrote that success is "rejected at the picker" and, four paragraphs earlier, that the save always
proceeds. As specced the feature could not achieve its stated goal — it re-created the incident's
shape with a better warning. Resolved below: a **completed** probe that failed is evidence, and
refusing on evidence is not the work-key failure (which was accusing on *none*).

### 3. `graphModelWarning` does not cover every path that changes the graph's model

I claimed the probe "inherits that correctness". It inherits the holes too:
`setAnsweringProvider` (`actions.ts:439-461`, the "Auto" choice) and `saveProviderModel`
(`actions.ts:415-431`) both change which model governs the graph and call no check at all. Auto
precedence can land on Anthropic, which `graphChatTarget` 501s — the silent-stall case, reachable
with zero warning. v1 closes both.

## The measurement

Request bodies generated **inside the deployed image** by `gen.py` — graphiti 0.13.2's real
`extract_nodes.extract_message` and `dedupe_nodes.nodes`, and the OpenAI SDK's own
`type_to_response_format_param`, the function `.parse()` calls. Nothing reconstructed. Four real prod
episodes × 3 runs + one dedupe scenario × 3 runs, built from duplicate pairs observed in the live
graph. `max_tokens: 16384` (our Dockerfile's patched cap), `temperature: 0`, plus the two flags the
proxy adds on the OpenRouter leg.

```
model                        in $/M  extract  people  dedupe   entities/episode (median)   $/ep est
                                                               sync sum slack linear-spec
qwen/qwen3.7-max  ← today     1.475    12/12   21/21     3/3     13  15   14      16       0.0238
qwen/qwen3.7-plus             0.320    12/12   21/21     3/3     37  24   15      22       0.0087
openai/gpt-4.1-mini           0.400    12/12   20/21     3/3     22  19   12      21       0.0077
qwen/qwen3.6-27b              0.300    12/12   21/21     2/3     25  25   14      10       0.0082
qwen/qwen3.6-35b-a3b          0.140    12/12   21/21   * 0/3 *   20  17   14      22       0.0036
openai/gpt-4o-mini            0.150    12/12   18/21     0/3      6  20   13       7       0.0019
z-ai/glm-4.7-flash            0.060    12/12   21/21     0/3     24  17   14      35       0.0018
google/gemini-2.5-flash-lite  0.100     8/12    6/12     1/3     41  12   12       2       —
qwen/qwen3.6-flash            0.188     0/12       —     3/3      HTTP 400 on every extract call
```

`qwen/qwen3.6-35b-a3b` is the **negative control**: it degraded the live graph, so a battery that
does not flag it proves nothing. It fails **0/3 on dedupe** — and the specific failure is the one that
polluted the graph: it refuses to resolve `Chetan Nandakumar` onto the existing `Chetan`, creating a
second person node.

**The dedupe probe separates the field cleanly.** Every model that is known or observed to damage the
graph fails it; every model that does not, passes 3/3. Entity count, people recall and error rate all
add information, but none of them alone splits the list — `35b-a3b` and `glm-4.7-flash` score 21/21 on
people while failing dedupe 0/3.

Two failures are real and survive the correction:

- **`qwen/qwen3.6-flash` 400s on every extraction call** while passing dedupe 3/3 — the provider
  downgrades `json_schema` to `json_object` and then rejects the request for not containing the word
  "json". Extraction stops entirely; the symptom is an empty graph. Schema-specific, so a probe that
  tests only one of the two calls would miss it.
- **`qwen/qwen3.6-27b` returned a bare JSON array where the schema says object**, despite
  `strict: true`. graphiti does `llm_response.get('entity_resolutions', [])`
  (`node_operations.py:296`), so that response raises `AttributeError` inside the dedupe path.

### The cost model, validated against production

`(2 × extract input + entities × 700) × $in + outputs × $out`, where the 700-token term is the
per-node summary call — the ~600-input-token band that ran 1,675 calls/day on the healthy model and
4,240–5,672/day on the cheap one. It predicts **$0.0238/episode** for `qwen3.7-max` against
**$0.0267/episode measured in production today**: 11% agreement.

**Known bias: it flatters the models that fail**, because it does not model the extra calls duplicate
pollution creates (it under-predicts `35b-a3b` by ~2.3× versus its measured production cost). A floor
is the safe direction for a gate, and the wrong direction for a purchase decision — so this table
ranks safety, not price.

## Proposal

### `lib/graph/extraction-qualify.ts` — a live probe of the backend that will govern the graph

Four calls, issued **concurrently**, against a checked-in fixture:

1. **One extraction call** — graphiti's `ExtractedEntities` schema. Fails on: non-2xx, unparseable
   body, entity count below the fixture's floor, or a named person missing.
2. **Three dedupe calls** — graphiti's `NodeResolutions` schema over a candidate set with an
   unambiguous answer key including a **false-merge trap** (an unrelated pair that must resolve to
   `-1`). **All three must be exactly correct.** Fails on: non-2xx, unparseable, a non-object
   response, or any wrong resolution.

`n=3` on dedupe is not decoration: the two marginal models in the battery scored 2/3 and 1/3, so a
single run would pass them roughly half the time. It is still a **filter, not a proof** — it catches
the 0/3 models with certainty and the marginal ones with probability. Say so in the help text.

Verdict: `ok` · `degraded` (calls succeed, answers wrong) · `unusable` (calls fail) · `unknown`.

**Budget: 45s wall clock, all four calls in flight at once.** Observed latencies in the battery:
1.0–30.4s per call. A save that takes up to 45 seconds is a deliberate UX choice for an action that
changes what every graph write costs; the picker shows a "qualifying…" state.

### Refuse on evidence, proceed on doubt

| Verdict | Behaviour |
|---|---|
| `ok` | save stands, silent |
| `degraded` / `unusable` | **the write is reverted** and the evidence is returned — "resolved 2 of 5 identities correctly; `Chetan Nandakumar` was not matched to the existing `Chetan`". An explicit **Save anyway** re-submits with `force: true` and is audited as a forced save. |
| `unknown` (timeout, network, no key) | save stands, **silently** — the work-key lesson: never accuse on no evidence |

The probe runs **after** the write, because `graphModelWarning` already resolves the backend that
governs the graph *after* it — the ordering hole #452 closed. Reverting is a second write; two admins
racing the same picker inside 45s could interleave. Named, not solved: this panel has one writer in
practice, and the alternative (re-deriving the post-write backend before writing) reintroduces the
exact bug #452 fixed.

### Cover the paths that were never checked

`graphModelWarning` is added to `setAnsweringProvider` and `saveProviderModel`. Both change the
graph's model today with no check of any kind.

### Metering

Probe calls record to `llm_usage` under a **distinct source** (`graph-probe`), never `graph`. Sharing
the source would put probe calls in the numerator of calls-per-episode (#471) with nothing in the
denominator — the same defect Fable caught in that PR's manual "Project to graph" button.
`llm_usage.source` has no DB CHECK, so this is the TS union in `lib/costs/llm-usage.ts` plus a
`SOURCE_LABEL` entry (`lib/metrics/llm-costs.ts` falls back to the raw key, so a missing label
degrades visibly rather than silently).

Cost: ~$0.02–0.09 per save, four calls. With extraction unset, **every answering-model save now
spends this too** — stated because it is a real change to a previously free action.

### A CLI that tests a model WITHOUT changing production

`npm run qualify:extraction -- <provider> <model>`. Today the only way to evaluate a candidate is to
point the live setting at it, because the proxy overrides the model — so "try three models" means
three production config writes on a running graph. It resolves the key exactly as the app does
(`resolveAnsweringKeys` against `DATABASE_URL`), meters under `graph-probe` like the save path, and
shares the scoring module, so CLI and picker cannot disagree.

## The fixture, and why it is not a fixture of my own making

`test/fixtures/extraction-probe/` holds the request bodies **emitted by `gen.py` inside the pinned
image**, with the digest and `graphiti_core` version in the header. Not hand-written, because
hand-written is what produced the retraction above.

**Acceptance criterion, run once at build time (~$0.20) and recorded in the fixture header:** the
checked-in fixture must reproduce the discrimination the real episodes produced —

- pass: `qwen3.7-max`, `qwen3.7-plus`, `gpt-4.1-mini`
- fail: `qwen3.6-35b-a3b` (the negative control), `gpt-4o-mini`, `glm-4.7-flash`,
  `gemini-2.5-flash-lite`
- `unusable`: `qwen3.6-flash`

If it cannot separate those eight, it is not a qualification probe and this does not ship on it.

Episodes in the fixture are **synthetic but structurally matched** to the four real ones (the repo is
public). The Linear-spec shape is mandatory: it is the only episode type on which several models
collapse.

## Schema drift — guarded, not hoped

The fixture is graphiti 0.13.2's shape. If the service image moves, the probe validates a payload the
service no longer sends and goes quietly vacuous — the "guard must cover the level that changed"
failure. **Guard:** a unit test asserts the digest recorded in the fixture header equals the digest in
`graphiti/Dockerfile`. Changing the image without regenerating the fixture fails the build. It does
not verify the *contents* match — only that nobody moved the image and left the fixture behind.

## Guards (CLAUDE.md §7)

- **Scoring** against **recorded real responses** from the battery — the `35b-a3b` mis-resolution, the
  bare-array schema violation, the `qwen3.6-flash` 400 body. Not hand-written JSON.
- **Call site:** deleting the qualification call from `graphModelWarning` turns a test red
  (`pin-the-call-site-not-just-the-function`).
- **Request shape:** the probe posts the fixture body verbatim through the proxy's own
  `forwardBody`, and a guard asserts the posted body still carries `strict: true` and
  `additionalProperties: false`. Rebuilding the schema by hand — the exact mistake this doc retracts —
  turns it red.
- **Digest drift:** fixture header digest == `graphiti/Dockerfile` digest.
- **`unknown` never blocks and never warns** — pinned, mutation: make `unknown` return an error → red.
- **Source:** the probe's `llm_usage.source` is not `graph`; mutation → red.

## What this does not do

- It does not re-qualify a model after adoption. Post-adoption degradation is AIO-693's alarm.
- It does not judge Q&A answer quality — extraction and dedupe have right answers, "was that a good
  answer" does not.

## Out of scope, deliberately

Entity-resolution efficiency (type gating, cosine short-circuits, top-K candidate retrieval). That is
the structural cost fix, it lives in Graphiti's resolution path, and it is a separate task.

## How we will know it worked

The next extraction model that would have degraded the graph is refused **at the picker**, naming the
identity it failed to resolve — instead of four days later, from the bill.

## The separate decision this measurement unblocks

Not part of this build; the operator's call. On the corrected battery, **`qwen/qwen3.7-plus`**
(21/21 people, 3/3 dedupe, 12/12 calls, already trusted in this stack for narrative arcs) is
**~2.7× cheaper per episode** than today's `qwen3.7-max` — roughly $115/month against $310/month at
current volume. `openai/gpt-4.1-mini` is marginally cheaper again but scored 20/21 on people.
