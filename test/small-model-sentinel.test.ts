import { describe, expect, it } from "vitest";
import { wantsSmallModel, AIOS_SMALL_SENTINEL, GRAPHITI_SMALL_MODEL_MARKER } from "@/lib/llm/graph-call-kind";

/**
 * AIO-983 — a cheap graph call is identified by a PROTOCOL CONSTANT, not by a model name two
 * separately-deployed systems must both remember.
 *
 * The safety property under all of this is the one with an incident behind it: the marker alone is
 * forgeable (an operator setting `MODEL_NAME` to the cheap model makes EVERY call wear it), so our
 * own classification of the request must agree before anything is downgraded. Every disagreement
 * routes to the STRONG model — drift costs money, never graph quality. The sentinel must not weaken
 * that, and the tests below pin both halves.
 */

const body = (systemPrompt: string, model: string) => ({
  model,
  messages: [{ role: "system", content: systemPrompt }],
});

// A prompt graphiti itself marks ModelSize.small (edge_operations.py:455 — dedupe_edges.resolve_edge).
const ELIGIBLE = "You are a helpful assistant that de-duplicates facts from fact lists and determines which existing";
// The one that must NEVER be downgraded — the zero-entities incident (2026-08-04).
const EXTRACTION = "You are an AI assistant that extracts entity nodes from conversational messages.";

describe("the small-call sentinel", () => {
  it("is not a model name, and never will be", () => {
    // The whole point: it names the request's INTENT, so it is invariant under pricing decisions.
    // If someone ever "helpfully" sets this to a real model, the coupling is silently back.
    expect(AIOS_SMALL_SENTINEL).toBe("aios-small");
    expect(AIOS_SMALL_SENTINEL).not.toMatch(/^(gpt|claude|qwen|mistral|llama|gemini)/i);
    expect(AIOS_SMALL_SENTINEL).not.toContain("/"); // no provider/model slug shape
  });

  it("marks an eligible call as small — with NO shared configuration between brain and image", () => {
    // Red before this slice: `wantsSmallModel` compared against the marker only, so a sentinel was
    // an unrecognised model name and this returned false.
    expect(wantsSmallModel(body(ELIGIBLE, AIOS_SMALL_SENTINEL))).toBe(true);
  });

  it("still refuses to downgrade entity extraction, even wearing the sentinel", () => {
    // The forgeability guard, carried over intact. A sentinel on a non-eligible kind is a
    // disagreement, and every disagreement routes STRONG.
    expect(wantsSmallModel(body(EXTRACTION, AIOS_SMALL_SENTINEL))).toBe(false);
  });

  it("keeps honouring the legacy marker, so an unmigrated image is not broken by this", () => {
    expect(wantsSmallModel(body(ELIGIBLE, GRAPHITI_SMALL_MODEL_MARKER))).toBe(true);
    expect(wantsSmallModel(body(EXTRACTION, GRAPHITI_SMALL_MODEL_MARKER))).toBe(false);
  });

  it("ignores an unrelated model name — recognition is not 'anything cheap-looking'", () => {
    expect(wantsSmallModel(body(ELIGIBLE, "gpt-4o"))).toBe(false);
    expect(wantsSmallModel(body(ELIGIBLE, "aios-smallish"))).toBe(false);
  });
});
