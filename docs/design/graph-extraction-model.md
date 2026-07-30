# A separate model for graph extraction

**Status:** accepted (design-reviewed 2026-07-30) · **Owner:** Chetan

## The problem, measured

Graph extraction is **99% of the brain's LLM bill** — $51.01 of $51.70 lifetime. Everything a person
touches (query box, arcs, meeting extraction, timeline summaries, embeddings) is rounding error.

It is expensive for a reason that is fixable: the graph proxy forces extraction to use the team's
**answering** model, and this team's answering model is `qwen/qwen3.7-max` — a *reasoning* model at
**$1.475/M in, $4.425/M out**.

Measured run rate, after the timeout fix landed (`b616b41`):

| | 2026-07-29 (timeout storm) | 2026-07-30 (healthy) |
|---|---|---|
| calls / episode | 45.5 | **4.0** |
| cost / episode | $0.4529 | **$0.0449** |

4.0 calls/episode is normal for Graphiti (extract nodes → dedupe → extract edges → dedupe), so **there
is no remaining amplification bug** — the storm was the 120s proxy timeout plus the OpenAI SDK's three
retries, and it is gone. That makes ~$0.045/episode the honest steady-state unit cost. At the observed
**~70–106 new episodes/day** that is **$3.20–4.80/day ≈ $95–145/month**, indefinitely.

## Phase 0 — reasoning off on the graph leg

`lib/llm/complete.ts:133-137` has always sent `reasoning: { enabled: false }` to OpenRouter for
query/extraction-role calls, with a comment saying exactly why. The graph proxy's `forwardBody`
mirrored that function's `usage: { include: true }` line and **missed the one beside it** — leaving the
graph leg, 99% of the spend, as the only OpenRouter transport still paying for hidden thinking.

One line, gated on OpenRouter, with `complete.ts`'s existing `LLM_DISABLE_REASONING=0` escape hatch.

### Measured against the live proxy, on Graphiti's real prompt shapes

Not asserted — probed through the deployed proxy (`n=3` per arm) with the actual `ExtractedEntities`
and `NodeResolutions` JSON schemas Graphiti sends:

| Prompt shape | completion tokens | of which reasoning | cost/call | vs baseline |
|---|---|---|---|---|
| extract-nodes, baseline | 2398–2881 | 2119–2471 (**~87%**) | $0.0116–0.0133 | — |
| extract-nodes, reasoning off | 409–522 | 0 | $0.0028–0.0033 | **~4.2× cheaper** |
| dedupe, baseline | 582–728 | 487–614 (**~84%**) | $0.0030–0.0037 | — |
| dedupe, reasoning off | 94–109 | 0 | $0.00089–0.00095 | **~3.5× cheaper** |

**Quality, not just cost** (MEDIUM-1 from review — the doc previously claimed "no quality trade" by
fiat, which was an overclaim):

- **Dedupe: identical resolutions 3/3.** Every new node mapped to the same existing node as baseline.
- **Extract-nodes: within baseline's own variance.** Baseline is itself unstable — 14 entities on one
  run, 20 on the next, including junk like `"Graph extraction failing with openai.InternalServerError
  502"` typed as an Event. Reasoning-off returned 16 and 22. There is no signal that reasoning-off is
  worse; there is also no evidence it is better, and this is a 3-run probe, not an eval.
- **One real caveat found:** with a schema that fights the model's natural output shape (an array of
  bare strings where it wants objects), reasoning-off emitted structurally-valid but semantically
  garbage content — `{"entities": [">    { "]}`. Both of Graphiti's real schemas are object-shaped and
  showed none of it. Worth knowing before this flag is extended to a new schema.
- **Rollback is `LLM_DISABLE_REASONING=0`** — but note it is **global**: it re-enables reasoning in
  `complete.ts` too. A blunt instrument, deliberately, because a graph-only flag would be a second
  place that decides.

Phase 0 and Phase 1 ship together, and that does **not** confound the measurement — because Phase 1
ships only the *mechanism*. With both columns null every install keeps resolving the answering model, so
Phase 1 moves no cost on its own; the only thing that changes spend on merge is reasoning-off. The
comparison that would confound things is **changing the default model**, and that is deliberately out of
scope below: it re-baselines against the post-Phase-0 figure, with quality evidence in hand.

## What is actually wrong

With reasoning off, what remains is a *rate* problem rather than a *waste* problem:
`resolveGraphChatTarget` resolves the **answering** backend:

```ts
const keys = await resolveAnsweringKeys(db, teamId);
return graphChatTarget(selectLlmBackend({ … }, keys));
```

There is no way to express "answer with a strong model, extract with a cheap one". A reasoning model
is the *right* pick for answering and the *wrong* one for extraction, and today you cannot have both.

This is a consequence of the proxy: making the console the single source of truth for the key was
correct, but it collapsed two decisions — *which key* and *which model* — into one.

## Proposal

Add a third model role beside answering and reasoning, following the `reasoning_provider` /
`reasoning_model` pattern — but **not copying its fallback bug** (see Resolution).

**Named `extraction`, not `graph`.** The role is a capability, not a consumer: `complete.ts` already
describes the query role as "the direct/extraction model", and meeting extraction, chat titles and
timeline summaries are the same shape of work. A consumer-shaped name cannot absorb them later without
a column rename, and columns are close to permanent.

### Data

```sql
alter table teams add column if not exists extraction_provider text;
alter table teams add column if not exists extraction_model text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'teams_extraction_provider_check') then
    alter table teams add constraint teams_extraction_provider_check
      check (extraction_provider in ('openai', 'openrouter', 'local'));
  end if;
end $$;
```

Migration file: `postgres/migrations/20260730120000_teams_extraction_role.sql`, mirrored byte-identically
into `postgres/schema.sql` (the `create table` body, the `add column if not exists` block, and the same
DO block) — `schema.sql` is `create … if not exists`, so editing the table body alone is a no-op on prod.

**`anthropic` is absent from the CHECK, deliberately** (HIGH-1). See *The Anthropic decision* below.
Widening a CHECK later is a trivial additive migration; narrowing one is the release-breaking direction
(incident #251), so the narrow list is the safe starting point. Precedent: `embedding_provider` is
constrained to `('openai','openrouter')` for the same reason (`schema.sql:136`).

**Named constraint in a conname-guarded DO block**, textually identical in both files. Not because
Postgres would generate different names — it names a single-column check deterministically — but
because `add constraint` has no `if not exists`, and #251 was caused by two copies of a CHECK drifting
apart in their value lists. One form, three places, guarded by name.

### Resolution — the activation truth table (HIGH-3)

Mirrors `setReasoningModel` exactly, so there is one rule for all three roles:

| `extraction_model` | `extraction_provider` | Effect |
|---|---|---|
| set | set | Extraction runs on that provider's backend + that model |
| set | null | **Same backend as answering, different model** — intentional, and the cheapest useful case (`qwen3.7-max` → `qwen3.6-flash` on the same OpenRouter key) |
| null | anything | Role **off**. The provider is cleared on save, so no orphaned "extract on X" with no model. Extraction resolves the answering backend exactly as today — existing installs are byte-unchanged until an admin opts in |

Note the second row is a *deliberate* backend+model split, not to be confused with the *fallback*
half-swap banned below: the admin asked for it, and it is visible on the card.

**The configured-but-unavailable case must NOT copy reasoning's behaviour.** `llm-backend.ts:164-165`
borrows the answering *backend* while keeping the reasoning *model* — so if the admin deletes the key
for that provider, it runs a model name against a backend that may not serve it. For reasoning that
costs a failed arc synthesis. For extraction it means every call errors, Graphiti keeps returning
`202`, the graph silently stops growing, and the first signal is the stall detector six hours later —
precisely the failure this stack has been chasing all week.

So: a configured-but-unconfigurable extraction provider falls back to the **whole** answering backend
*and* model, never a half-swap. And it must be visible — `describeExtraction()` mirroring
`describeReasoning` (`llm-backend.ts:195-212`), surfaced on the admin card the way the existing roles
show `usedFallback`. A cost setting that silently reverts is how you get a surprise bill.

**The reasoning half-swap is deliberately NOT fixed here** (MEDIUM-2 — review said fix it in the same
change; that turned out to be wrong, and the reason is worth recording). Two things block it:

1. **It is pinned as intended behaviour** by `lib/query/llm-backend.test.ts:192-203` — *"fell back to
   the answering provider … still the reasoning model"*. Flipping it is a behaviour change to arc
   synthesis, not a bug fix to dead code.
2. **The honest fix is not two lines.** `reasoningActive()` (`llm-backend.ts:77-79`) keys on
   `nonEmpty(keys.reasoningModel)`, and it is the single switch that turns chain-of-thought *on*. If
   the reasoning role fell back to the answering **model**, `reasoningActive` would still be true, so
   reasoning would stay ON over a model that may be a reasoning model — the exact token-starvation that
   blanked the Learning arcs and that `reasoningActive`'s comment exists to prevent. A correct fix has
   to make "did a distinct reasoning model actually take effect" the switch, which is a change to the
   reasoning contract and deserves its own PR and its own verification.

So: **extraction gets whole-fallback from the start** — it is a new role with no installed base, and its
`reasoningActive` is false by construction (that helper keys on `role === "reasoning"`, and the graph
transport now sends reasoning off unconditionally anyway), so the starvation coupling does not exist for
it. The reasoning role keeps its documented behaviour, and this paragraph is why.

Touch list: `LlmBackendKeys` + `LlmRole` (`llm-backend.ts:40-65`), `resolveAnsweringKeys`'s select list
(`answering.ts:28`), `resolveGraphChatTarget` (`graph-proxy.ts:247`), the admin page's team select
(`page.tsx:41`), `setExtractionModel` in `integrations/actions.ts`, the `RolePicker` in
`components/admin/integrations-manager.tsx`.

### The Anthropic decision (HIGH-1)

The previous draft argued that an erroring extraction backend is unacceptable (six-hour silent stall)
and then, three sections later, listed *"Anthropic selected for the graph role → already refused by
`graphChatTarget`"* as a **mitigation**. It is not a mitigation; it is that same stall, with the
message in another service's logs. Worse, `candidate("anthropic")` is *always* configured
(`llm-backend.ts:129-136`), so whole-fallback would never rescue it.

Resolved by making it unrepresentable, at all three layers:

1. **DB:** absent from `teams_extraction_provider_check`.
2. **Server action:** `setExtractionModel` rejects `anthropic` with a reason, not a generic "invalid
   provider" — validation at the boundary, since the action is callable independently of the UI.
3. **UI:** the extraction `RolePicker` omits Anthropic and says why.

`graphChatTarget`'s existing Anthropic 501 stays as the backstop for the *answering*-is-Anthropic case,
where there is genuinely nothing else to fall back to.

### Structured outputs are non-negotiable here

Graphiti extracts via `beta.chat.completions.parse` — a JSON **schema**, not merely JSON mode. #442's
`checkStructuredOutputSupport` is provider+model-parameterised, so applying it to this role is direct.

Two consequences the implementer must handle (MEDIUM-3): the extraction save gets the check, **and**
`setAnsweringModel`'s existing warning has to become conditional. Its comment says *"the graph proxy
made this picker also drive Graphiti's extraction"* (`actions.ts:500-508`) — the moment
`extraction_model` is set that is false, and an unconditional warning would misdirect an admin about a
model that no longer touches the graph while staying silent about the one that does.

## Guards (CLAUDE.md §7)

Two invariants here trace to real failures, so both get a build-failing test:

1. **The graph leg never pays for reasoning on OpenRouter** — the `forwardBody` block in
   `test/graph-llm-proxy.test.ts` (unit tier). Cited here so it reads as the Phase 0 guard rather than
   incidental coverage.
2. **A configured-but-unconfigurable EXTRACTION provider falls back WHOLE, never half** — a spec-first
   unit test on `selectLlmBackend` asserting both `provider` and `model` equal the answering backend's.
   Asserted against the half-swap outcome specifically (`model` is the assertion that matters — a test
   checking only `provider` passes against the bug), not merely "doesn't throw".

No new raw transport: resolution stays inside the already-allowlisted `graph-proxy.ts`, so
`test/guards/llm-single-caller.test.ts`'s allowlist is untouched.

## What this does not change

- **Embeddings.** Already pinned to 1536 for Graphiti's Neo4j index; separate decision, untouched.
- **The key.** Still resolved from the console, still never leaves the process.
- **The default.** With both columns null, every install behaves exactly as it does today.

## Risks

| Risk | Mitigation |
|---|---|
| A cheap model extracts worse — fewer or sloppier entities | The real risk, and a **quality** question. Fact-yield-per-episode is the wrong test: it is a volume metric, so a model that dedupes worse or invents edges *scores higher*. Instead replay a fixed sample of N recent episodes through both models into a scratch `group_id` and compare (i) edge count, (ii) entity duplicate rate, (iii) sampled edge groundedness judged against the source episode by the strong answering model. A time-window before/after is additionally confounded by content mix. The same method brackets Phase 0. |
| A model without structured outputs is selected | Save-time warning (#442) on the extraction save; the answering warning becomes conditional so exactly one of them speaks |
| Anthropic selected for the graph role | Unrepresentable — CHECK + server action + UI (above) |
| A future model 400s on `reasoning:{enabled:false}` (some reasoning-mandatory models do) | The proxy passes the 400 through transparently, so the signal is the stall detector hours later — the failure this doc dislikes, introduced by its own flag. Current model demonstrably accepts it; `enabled:false` is OpenRouter's documented disable (`exclude:true` still bills the tokens, `max_tokens:0` is not a disable). Detection path is the extraction-health probe; escape hatch is `LLM_DISABLE_REASONING=0` |
| Silent divergence between roles | The costs page splits by source; `source='graph'` shows the effect directly |

## Explicitly out of scope

- **Changing the default.** This ships the *mechanism*. Picking the cheaper model is a separate,
  reversible decision to be made with quality evidence in hand.
- Reworking `lib/llm/complete.ts`'s unmetered non-2xx path (known, lower volume, tracked separately).
- Applying the extraction role to the in-app callers (`complete.ts`'s query role). The role is *named*
  for that future, but moving them is a separate change with its own quality question.
- Per-day provider reconciliation (needs an OpenRouter management key).

## How we will know it worked

`llm_usage` where `source='graph'`, cost per episode. Baseline **before** Phase 0: **$0.0449**
(2026-07-30, post-timeout-fix, 345 calls / 86 episodes). Phase 0 is measured against that; the model
comparison is measured against the **post-Phase-0** figure, not this one.

**The criterion only holds for an OpenRouter extraction pick** (HIGH-2). `resolveOpenAiCost`
(`lib/llm/cost.ts:73-83`) gets a real dollar figure from OpenRouter's `usage.cost`; an OpenAI-cloud
chat call records **$0 with `estimated:true`** (no chat price table) and `local` records an
authoritative $0. So picking `gpt-4o-mini` on **OpenAI-cloud** would make the graph slice drop to zero
for the wrong reason and the A/B unmeasurable — pick `openai/gpt-4o-mini` **via OpenRouter** instead.

Quality is judged by the replay A/B above, not by yield over a time window.

Two scope facts worth stating plainly: `checkStructuredOutputSupport` only returns a verdict for
OpenRouter (`structured-output-support.ts:106-108`), so an OpenAI or local extraction pick gets no
save-time warning; and because `resolveGraphProxyTeamId` is instance-level, on a multi-team instance one
team's extraction model governs everyone's — the same semantics answering already has.
