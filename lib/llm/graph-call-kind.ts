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
] as const;

/** Every label this classifier can emit, excluding `unknown`. The by-kind read renders these. */
export const GRAPH_CALL_KINDS: readonly string[] = PROMPT_PREFIXES.map(([kind]) => kind);

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
