import { describe, expect, it } from "vitest";
import { classifyGraphCall, GRAPH_CALL_KINDS } from "@/lib/llm/graph-call-kind";

/**
 * GRAPHCOST-5 — label every graph LLM call with the Graphiti prompt that made it.
 * Spec: 2-work/specs/graph-call-kind-attribution.md (AIO-739).
 *
 * The fixtures below are the VERBATIM system messages of the five prompts that the deployed image's
 * `add_episode` path actually invokes — derived from the call graph, not from the prompt files.
 * That distinction is the whole point of this suite: every prompt file in the image holds 2-6
 * variants, only one of which runs, and a table built by reading one line per file gets four of the
 * five wrong while looking perfectly plausible. Each fixture names its call site so the next reader
 * can re-derive it.
 *
 * Image: zepai/graphiti@sha256:76d14f30afc65d2f914637d67d0c0631a7e779e2740be1ae99b9dc0c5876d2da
 * Runtime venv: graphiti_core-0.13.2 at /app/.venv/... (NOT the unused 0.22.0 copy at /usr/local).
 * MAX_REFLEXION_ITERATIONS defaults to 0 (helpers.py:36), so the reflexion variants never fire.
 */

/** The five system messages that actually reach the proxy, verbatim from the deployed image. */
const RUNTIME = {
  // node_operations.py:115 — extract_nodes.extract_message
  extract_nodes:
    "You are an AI assistant that extracts entity nodes from conversational messages. \n    Your primary task is to extract and classify the speaker and other significant entities mentioned in the conversation.",
  // edge_operations.py:156 — extract_edges.edge
  extract_edges:
    "You are an expert fact extractor that extracts fact triples from text. 1. Extracted fact triples should also be extracted with relevant date information.2. Treat the CURRENT TIME as the time the CURRENT MESSAGE was sent. All temporal information should be extracted relative to this time.",
  // node_operations.py:292 — dedupe_nodes.nodes
  dedupe_nodes:
    "You are a helpful assistant that determines whether or not ENTITIES extracted from a conversation are duplicatesof existing entities.",
  // edge_operations.py:455 — dedupe_edges.resolve_edge (ModelSize.small)
  dedupe_edges:
    "You are a helpful assistant that de-duplicates facts from fact lists and determines which existing facts are contradicted by the new fact.",
  // node_operations.py:406 — extract_nodes.extract_attributes (ModelSize.small, per-entity fan-out)
  node_attributes: "You are a helpful assistant that extracts entity properties from the provided text.",
} as const;

/**
 * The same five calls in graphiti_core 0.29.3 (GRAPHCOST-8), plus the two it adds. The table spans
 * both versions on purpose: the image upgrade is a separate deploy from this merge, so a
 * version-specific table would misclassify 100% of calls in whichever order they happen.
 * Verified against the 0.29.3 wheel, again from call sites.
 */
const RUNTIME_0293 = {
  // node_operations.py:262 — reworded in 0.29.3
  extract_nodes: "You are an entity extraction specialist for conversational messages. NEVER extract abstract concepts…",
  // node_operations.py:553 — reworded
  dedupe_nodes: "You are an entity deduplication assistant.",
  // edge_operations.py:727 — reworded
  dedupe_edges: "You are a fact deduplication assistant.",
  // edge_operations.py:203 — byte-identical to 0.13.2, so it is covered by the shared row
  extract_edges:
    "You are an expert fact extractor that extracts fact triples from text. 1. Extracted fact triples should also be extracted with relevant date information.",
} as const;

/** NEW call kinds that exist only in 0.29.3. */
const NEW_IN_0293 = {
  // node_operations.py:970/973 — the BATCHED replacement for the per-entity fan-out (the fix itself)
  node_summaries_batch: "You are a helpful assistant that generates concise entity summaries from provided context.",
  // the episode-based variant of the same batched call
  node_summaries_batch_episodes: "You maintain detailed, information-dense entity memories from episode text. Use ONLY facts…",
  // edge_operations.py:680/813 — fires per NEW edge, only when the extractor left dates unset
  edge_timestamps: "You extract temporal bounds from facts. NEVER hallucinate dates.",
} as const;

describe("classifyGraphCall — graphiti_core 0.29.3's prompts (GRAPHCOST-8)", () => {
  for (const [label, system] of Object.entries(RUNTIME_0293)) {
    it(`labels ${label} on 0.29.3's wording`, () => {
      expect(classifyGraphCall(body(system))).toBe(label);
    });
  }

  it("labels the batched summary call — the fix — DISTINCTLY from the fan-out it replaces", () => {
    // Same label would hide whether the upgrade worked: the whole point is that node_attributes
    // goes to ~0 while this appears. Conflating them would make the before/after read flat.
    expect(classifyGraphCall(body(NEW_IN_0293.node_summaries_batch))).toBe("node_summaries_batch");
    expect(classifyGraphCall(body(NEW_IN_0293.node_summaries_batch_episodes))).toBe("node_summaries_batch");
    expect(classifyGraphCall(body(NEW_IN_0293.node_summaries_batch))).not.toBe("node_attributes");
  });

  it("labels the new per-edge timestamp call, whose share is model-dependent", () => {
    expect(classifyGraphCall(body(NEW_IN_0293.edge_timestamps))).toBe("edge_timestamps");
  });

  it("both versions' prompts classify — the table is a UNION, so deploy order cannot break it", () => {
    for (const sys of [...Object.values(RUNTIME), ...Object.values(RUNTIME_0293)]) {
      expect(classifyGraphCall(body(sys))).not.toBe("unknown");
    }
  });
});

/**
 * Variants that exist in the same prompt FILES but are never called on this deployment's path.
 * Four of these were in the spec's first draft. They must classify `unknown` — this is the
 * assertion that reddens if someone adds a file-derived line back to the table.
 */
const NEVER_RUNS = {
  "extract_nodes.reflexion":
    "You are an AI assistant that determines which entities have not been extracted from the given context",
  "extract_edges.reflexion":
    "You are an AI assistant that determines which facts have not been extracted from the given context",
  "dedupe_nodes.node":
    "You are a helpful assistant that determines whether or not a NEW ENTITY is a duplicate of any EXISTING ENTITIES.",
  "dedupe_edges.edge": "You are a helpful assistant that de-duplicates edges from edge lists.",
  "summarize_nodes.summarize_pair": "You are a helpful assistant that combines summaries.",
  "extract_nodes.classify_nodes":
    "You are an AI assistant that classifies entity nodes given the context from which they were extracted",
  "extract_nodes.extract_json": "You are an AI assistant that extracts entity nodes from JSON. ",
  "extract_nodes.extract_text": "You are an AI assistant that extracts entity nodes from text. ",
} as const;

const body = (system: unknown, extra: Record<string, unknown> = {}) => ({
  model: "x",
  messages: [{ role: "system", content: system }, { role: "user", content: "…" }],
  ...extra,
});

describe("classifyGraphCall — the five prompts the deployed image actually calls (AC1)", () => {
  for (const [label, system] of Object.entries(RUNTIME)) {
    it(`labels ${label}`, () => {
      expect(classifyGraphCall(body(system))).toBe(label);
    });
  }

  it("every 0.13.2 runtime label is one the read knows about", () => {
    for (const label of Object.keys(RUNTIME)) expect(GRAPH_CALL_KINDS).toContain(label);
  });

  it("GRAPH_CALL_KINDS is deduped — several labels are carried by two versions' prefixes", () => {
    expect(GRAPH_CALL_KINDS.length).toBe(new Set(GRAPH_CALL_KINDS).size);
  });

  it("survives the suffixes Graphiti appends to the system message", () => {
    // MULTILINGUAL_EXTRACTION_RESPONSES is appended to messages[0].content; the generic client also
    // appends a JSON schema to messages[-1] (the user message). Neither can displace the first
    // system message, so a prefix match must still hold.
    const withSuffix = RUNTIME.extract_nodes + "\n\nAny extracted information should be in the same language as…";
    expect(classifyGraphCall(body(withSuffix))).toBe("extract_nodes");
  });
});

describe("classifyGraphCall — unknown is a value, never a guess (AC2/AC1b)", () => {
  for (const [name, system] of Object.entries(NEVER_RUNS)) {
    it(`does not label ${name} (it never runs on this path)`, () => {
      expect(classifyGraphCall(body(system))).toBe("unknown");
    });
  }

  it("never returns the empty string — '' means pre-instrumentation history, not 'unclassified'", () => {
    for (const b of [body("something else entirely"), body(""), {}]) {
      expect(classifyGraphCall(b)).not.toBe("");
    }
  });
});

describe("classifyGraphCall — hostile body shapes (AC6)", () => {
  const cases: [name: string, body: unknown][] = [
    ["no messages key", { model: "x" }],
    ["messages not an array", { messages: "nope" }],
    ["empty messages", { messages: [] }],
    ["no system role", { messages: [{ role: "user", content: "hi" }] }],
    ["system content is an array of parts", body([{ type: "text", text: RUNTIME.extract_nodes }])],
    ["system content is null", body(null)],
    ["system content is a number", body(42)],
    ["null body", null],
    ["undefined body", undefined],
    ["a string body", "not an object"],
  ];
  for (const [name, b] of cases) {
    it(`returns unknown and does not throw: ${name}`, () => {
      expect(() => classifyGraphCall(b as Record<string, unknown>)).not.toThrow();
      expect(classifyGraphCall(b as Record<string, unknown>)).toBe("unknown");
    });
  }

  it("inspects only a bounded prefix of a huge system message", () => {
    // A pathological system message must not be copied or scanned in full.
    const huge = RUNTIME.dedupe_nodes + "x".repeat(5_000_000);
    expect(classifyGraphCall(body(huge))).toBe("dedupe_nodes");
  });

  it("matches the first system message, not a later one", () => {
    const b = {
      messages: [
        { role: "system", content: RUNTIME.extract_edges },
        { role: "system", content: RUNTIME.dedupe_nodes },
      ],
    };
    expect(classifyGraphCall(b)).toBe("extract_edges");
  });
});
