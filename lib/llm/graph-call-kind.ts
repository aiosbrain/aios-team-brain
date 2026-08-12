/**
 * Which Graphiti prompt made this call — the missing dimension on `llm_usage`.
 *
 * Graph extraction is ~99% of the brain's LLM bill and every call lands under one `source='graph'`,
 * so the bill is a single undifferentiated number and no lever can be sized before pulling it. The
 * request body already says which prompt it is; this classifies it. No extra round-trip, no Graphiti
 * change, no cost.
 *
 * ── THE TABLE BELOW IS DERIVED FROM THE RUNTIME CALL GRAPH, NOT FROM THE PROMPT FILES ──
 *
 * Every prompt file in the image holds 2-6 variants and only one of each is on the `add_episode`
 * path. A table built by reading one line per file gets four of the five wrong — and omits the
 * per-entity fan-out entirely — while every line in it still appears verbatim in the image, so
 * fixtures built that way go green while labelling ~80% of production spend `unknown`. That is
 * exactly what the first draft of this did.
 *
 * Verified against the deployed image
 * `zepai/graphiti@sha256:76d14f30afc65d2f914637d67d0c0631a7e779e2740be1ae99b9dc0c5876d2da`.
 * Two traps when re-deriving:
 *   • the RUNTIME package is `graphiti_core-0.13.2` at `/app/.venv/lib/python3.12/site-packages`;
 *     an unused **0.22.0** copy sits at `/usr/local/lib/python3.12/site-packages` and answers
 *     differently.
 *   • `MAX_REFLEXION_ITERATIONS` defaults to 0 (`helpers.py:36`), so no reflexion variant fires.
 *
 * An upgrade of the graph service is expected to reword these prompts — that is the designed
 * failure mode: matches fall to `unknown` rather than being silently mislabelled, and a rising
 * `unknown` share is the signal that this table has drifted from what is deployed.
 */

/** Prefixes are matched case-sensitively against the START of the first system message. */
const PROMPT_PREFIXES: readonly (readonly [kind: string, prefix: string])[] = [
  // node_operations.py:115 — extract_nodes.extract_message
  ["extract_nodes", "You are an AI assistant that extracts entity nodes from conversational messages."],
  // edge_operations.py:156 — extract_edges.edge
  ["extract_edges", "You are an expert fact extractor that extracts fact triples from text."],
  // node_operations.py:292 — dedupe_nodes.nodes (resolve_extracted_nodes)
  [
    "dedupe_nodes",
    "You are a helpful assistant that determines whether or not ENTITIES extracted from a conversation are duplicates",
  ],
  // edge_operations.py:455 — dedupe_edges.resolve_edge (asks for ModelSize.small)
  [
    "dedupe_edges",
    "You are a helpful assistant that de-duplicates facts from fact lists and determines which existing",
  ],
  // node_operations.py:406 — extract_nodes.extract_attributes (ModelSize.small; ONE CALL PER RESOLVED
  // ENTITY PER EPISODE — the fan-out that dominates call count). Named `node_attributes` rather than
  // `extract_attributes` because `summarize_nodes.py:72` carries a byte-identical system line: only
  // this path runs today (the other is community operations), but the prefix cannot tell them apart,
  // and a label must not claim precision the evidence doesn't have.
  ["node_attributes", "You are a helpful assistant that extracts entity properties from the provided text."],

  // ── graphiti_core 0.29.3 (GRAPHCOST-8) ─────────────────────────────────────────────────────────
  //
  // A UNION with the 0.13.2 rows above, deliberately. The upgrade is a separate deploy from this
  // merge, and the table must be right in BOTH orders: ship these late and every post-upgrade call
  // reads `unknown`; ship them without the old rows and every pre-upgrade call does. The prefixes
  // are mutually exclusive, so carrying both costs nothing and removes the sequencing hazard.
  // Drop the 0.13.2 rows only once no ledger row of interest predates the upgrade.
  //
  // Labels are kept STABLE across versions where the semantics match, so a before/after comparison
  // of `getGraphSpendByCallKind` is a like-for-like read rather than a rename.
  ["extract_nodes", "You are an entity extraction specialist for conversational messages."],
  ["dedupe_nodes", "You are an entity deduplication assistant."],
  ["dedupe_edges", "You are a fact deduplication assistant."],
  // `extract_edges.edge` is byte-identical in 0.29.3 — already covered by the row above.

  // NEW in 0.29.3: the batched replacement for the per-entity fan-out. Same label as the call it
  // replaces would be WRONG — this one is the fix, and conflating them would hide whether it worked.
  ["node_summaries_batch", "You are a helpful assistant that generates concise entity summaries from provided context."],
  ["node_summaries_batch", "You maintain detailed, information-dense entity memories from episode text."],

  // NEW in 0.29.3: fires once per genuinely NEW edge, and only when the extractor left the dates
  // unset — so its share is model-dependent and worth watching rather than assuming.
  ["edge_timestamps", "You extract temporal bounds from facts. NEVER hallucinate dates."],
] as const;

/** Every label this classifier can emit, excluding `unknown`. Deduped: several labels are carried by
 *  more than one prefix, because the table spans two graphiti versions (see above). */
export const GRAPH_CALL_KINDS: readonly string[] = [...new Set(PROMPT_PREFIXES.map(([kind]) => kind))];

/**
 * `unknown` — classified, no match. Distinct from `''`, which means "recorded before this shipped".
 * Folding the two would turn a drift alarm into indistinguishable history, so nothing in the read
 * path may `coalesce` them together.
 */
export const UNKNOWN_GRAPH_CALL = "unknown";

/**
 * How much of the system message is ever inspected. The longest prefix above is ~110 chars; the
 * bound exists so a pathological system message can't make labelling cost real memory or time on a
 * path that must never slow the graph down.
 */
const INSPECT_CHARS = 160;

/** The first system message's text, or null for any shape that doesn't have one. */
function firstSystemText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  for (const m of messages) {
    if (typeof m !== "object" || m === null) continue;
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role !== "system") continue;
    // Only a plain string is classifiable. The OpenAI wire format also permits an array of content
    // parts; graphiti_core 0.13.2's clients send a string, so an array means something changed and
    // `unknown` is the honest answer rather than a guess at which part carries the prompt.
    return typeof msg.content === "string" ? msg.content.slice(0, INSPECT_CHARS) : null;
  }
  return null;
}

/**
 * Label one forwarded chat body with the Graphiti prompt that produced it.
 *
 * TOTAL: never throws, for any input. This runs on the request path of the graph's own LLM proxy —
 * the one thing this module exists to keep alive — so a classification problem must degrade to
 * `unknown`, never to a failed extraction call.
 */
export function classifyGraphCall(body: unknown): string {
  try {
    const text = firstSystemText(body);
    if (!text) return UNKNOWN_GRAPH_CALL;
    for (const [kind, prefix] of PROMPT_PREFIXES) if (text.startsWith(prefix)) return kind;
    return UNKNOWN_GRAPH_CALL;
  } catch {
    return UNKNOWN_GRAPH_CALL;
  }
}

/**
 * The model name Graphiti sends when it wants a CHEAPER model for a simpler prompt.
 *
 * A WIRE SENTINEL, not a model we serve: it names no backend, is never forwarded to a provider, and
 * must not migrate into `selectLlmBackend`/the settings path. `graphiti_core` 0.13.2's
 * `_get_model_for_size` (`llm_client/openai_base_client.py:103`) returns
 * `self.small_model or DEFAULT_SMALL_MODEL` for `ModelSize.small` and `self.model or DEFAULT_MODEL`
 * otherwise; the deployed service configures neither, so `gpt-4.1-nano` vs `gpt-4.1-mini` is how the
 * request tells us which it is. Verified against
 * zepai/graphiti@sha256:76d14f30afc65d2f914637d67d0c0631a7e779e2740be1ae99b9dc0c5876d2da.
 */
export const GRAPHITI_SMALL_MODEL_MARKER = "gpt-4.1-nano";

/**
 * The only call kinds we will ever downgrade — the ones Graphiti itself marks `ModelSize.small`.
 * Two on graphiti_core 0.13.2, four on 0.29.3 (the table above spans both).
 *
 * Every one operates on work a STRONG model already did: `node_attributes` fills in attributes for
 * entities `extract_nodes` has already found, and `dedupe_edges.resolve_edge` chooses among edges
 * `extract_edges` already produced. Neither can reduce what the graph knows about, which is what
 * makes downgrading them a different risk class from swapping the extraction model itself.
 */
export const SMALL_ELIGIBLE_KINDS: ReadonlySet<string> = new Set([
  "node_attributes", // 0.13.2's per-entity fan-out
  "dedupe_edges",
  // 0.29.3 marks these `ModelSize.small` too. Both, like the two above, only refine work a strong
  // model already did — batched summaries rewrite summaries of entities `extract_nodes` found, and
  // timestamp extraction dates a fact `extract_edges` already produced.
  "node_summaries_batch",
  "edge_timestamps",
]);

/**
 * Should this call be served by the team's cheap model? TWO INDEPENDENT SIGNALS MUST AGREE.
 *
 * The marker alone is NOT safe, and this is the single most important line in the change. Normal
 * calls resolve to `self.model or DEFAULT_MODEL`, so an operator who sets `MODEL_NAME=gpt-4.1-nano`
 * on the Graphiti service — which the proxy's own header comment invites them to try — makes EVERY
 * call arrive wearing the marker, including `extract_nodes`. Routing on the marker alone would then
 * put entity extraction on the weak model: the zero-entities failure a qualification probe caught on
 * a real payload on 2026-08-04, where a candidate returned valid JSON containing nothing.
 *
 * So the upstream's intent must be corroborated by our own reading of the request's content. Any
 * disagreement — marker without an eligible kind, eligible kind without the marker, a reworded
 * prompt that classifies `unknown` — routes to the STRONG model, i.e. today's behaviour. Every
 * drift state costs money rather than silently degrading the graph.
 */
export function wantsSmallModel(body: unknown): boolean {
  try {
    if (typeof body !== "object" || body === null) return false;
    const model = (body as { model?: unknown }).model;
    if (model !== GRAPHITI_SMALL_MODEL_MARKER) return false;
    return SMALL_ELIGIBLE_KINDS.has(classifyGraphCall(body));
  } catch {
    return false;
  }
}

