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

  it("labels every runtime call, and every label is one the read knows about", () => {
    const produced = Object.keys(RUNTIME);
    expect(produced.sort()).toEqual([...GRAPH_CALL_KINDS].sort());
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
