import { describe, expect, it } from "vitest";
import { GRAPHITI_SMALL_MODEL_MARKER, SMALL_ELIGIBLE_KINDS, wantsSmallModel } from "@/lib/llm/graph-call-kind";
import { selectSmallExtractionBackend, describeSmallExtraction } from "@/lib/query/llm-backend";

/**
 * GRAPHCOST-7 (AIO-753) — honour Graphiti's small-model request instead of discarding it.
 * Spec: 2-work/specs/graph-small-model-routing.md.
 *
 * The whole risk of this change is routing the WRONG call to the weak model. Graphiti signals
 * "this one is simple" by sending `gpt-4.1-nano` as the model (`_get_model_for_size` →
 * `DEFAULT_SMALL_MODEL`), but that signal alone is not safe: `_get_model_for_size` returns
 * `self.model or DEFAULT_MODEL` for normal calls, so an operator setting `MODEL_NAME=gpt-4.1-nano`
 * on the Graphiti service makes EVERY call — entity extraction included — wear the marker. So the
 * decision requires two signals from different places to agree, and every drift state must route to
 * the STRONG model.
 */

const smallBody = (system: string) => ({
  model: GRAPHITI_SMALL_MODEL_MARKER,
  messages: [{ role: "system", content: system }],
});
// node_operations.py:406 — extract_nodes.extract_attributes (ModelSize.small)
const ATTRS = "You are a helpful assistant that extracts entity properties from the provided text.";
// edge_operations.py:455 — dedupe_edges.resolve_edge (ModelSize.small)
const RESOLVE_EDGE =
  "You are a helpful assistant that de-duplicates facts from fact lists and determines which existing facts are contradicted by the new fact.";
// node_operations.py:115 — extract_nodes.extract_message (NOT small: this is entity extraction)
const EXTRACT = "You are an AI assistant that extracts entity nodes from conversational messages. ";

describe("wantsSmallModel — two signals must agree (AC2)", () => {
  it("routes small when the marker AND the call kind agree", () => {
    expect(wantsSmallModel(smallBody(ATTRS))).toBe(true);
    expect(wantsSmallModel(smallBody(RESOLVE_EDGE))).toBe(true);
  });

  it("the two eligible kinds are exactly the two Graphiti marks ModelSize.small", () => {
    expect([...SMALL_ELIGIBLE_KINDS].sort()).toEqual(["dedupe_edges", "node_attributes"]);
  });

  it("REFUSES to route entity extraction small even when it carries the marker", () => {
    // The blocker this design exists for: `MODEL_NAME=gpt-4.1-nano` on the Graphiti service makes
    // every call wear the marker. Routing on the marker alone would send extract_nodes to the weak
    // model — the zero-entities failure the 2026-08-04 probe caught on a real payload.
    expect(wantsSmallModel(smallBody(EXTRACT))).toBe(false);
  });

  it("REFUSES an eligible kind that did NOT carry the marker", () => {
    expect(wantsSmallModel({ model: "gpt-4.1-mini", messages: [{ role: "system", content: ATTRS }] })).toBe(false);
  });

  it("REFUSES when the prompt is unrecognised (a Graphiti upgrade reworded it)", () => {
    expect(wantsSmallModel(smallBody("You are some entirely new prompt."))).toBe(false);
  });

  it("never throws, and refuses, on hostile bodies", () => {
    for (const b of [null, undefined, "str", {}, { messages: "x" }, { model: 1, messages: [] }]) {
      expect(() => wantsSmallModel(b as Record<string, unknown>)).not.toThrow();
      expect(wantsSmallModel(b as Record<string, unknown>)).toBe(false);
    }
  });
});

const ENV = { LLM_BASE_URL: undefined, LLM_MODEL: undefined };
const OR = { openrouterKey: "k", openrouterModel: "answer/model", activeProvider: "openrouter" as const };

describe("selectSmallExtractionBackend — fails toward the STRONG model (AC3/AC5/AC7)", () => {
  it("returns the small model on the extraction backend when everything is configured", () => {
    const b = selectSmallExtractionBackend(ENV, {
      ...OR,
      extractionModel: "big/extract",
      extractionSmallModel: "small/cheap",
    });
    expect(b?.model).toBe("small/cheap");
    expect(b?.provider).toBe("openrouter");
  });

  it("is OFF when no small model is configured — today's behaviour, byte for byte (AC3)", () => {
    expect(selectSmallExtractionBackend(ENV, { ...OR, extractionModel: "big/extract" })).toBeNull();
  });

  it("is OFF when the extraction role itself is not configured (AC7)", () => {
    // extraction_model unset means extraction reuses the ANSWERING model. Layering a small model
    // under that would silently downgrade a role the operator never turned on.
    expect(selectSmallExtractionBackend(ENV, { ...OR, extractionSmallModel: "small/cheap" })).toBeNull();
  });

  it("is OFF when the extraction target itself FELL BACK (AC7)", () => {
    // selectLlmBackend falls back WHOLE for extraction because the extraction model on a backend
    // that may not serve it is a guaranteed 404 per call and a silently emptied graph. The small
    // model inherits that trap exactly, so it must switch off rather than ride the fallback.
    const b = selectSmallExtractionBackend(ENV, {
      ...OR,
      extractionModel: "big/extract",
      extractionSmallModel: "small/cheap",
      extractionProvider: "openai", // requested, but no openai key configured → falls back
    });
    expect(b).toBeNull();
  });

  it("blank/whitespace small model is not a configuration", () => {
    for (const m of ["", "   ", null, undefined]) {
      expect(
        selectSmallExtractionBackend(ENV, { ...OR, extractionModel: "big/extract", extractionSmallModel: m })
      ).toBeNull();
    }
  });
});

describe("describeSmallExtraction — a set-but-inert setting is visible (AC8)", () => {
  it("reports enabled + the model when in effect", () => {
    const d = describeSmallExtraction(ENV, { ...OR, extractionModel: "big/extract", extractionSmallModel: "small/cheap" });
    expect(d).toMatchObject({ enabled: true, model: "small/cheap", inert: false });
  });

  it("reports INERT when configured but the extraction role is off", () => {
    const d = describeSmallExtraction(ENV, { ...OR, extractionSmallModel: "small/cheap" });
    // A cost setting that reverts unnoticed is a surprise bill — the reason describeExtraction exists.
    expect(d).toMatchObject({ enabled: false, inert: true });
    expect(d.model).toBe("small/cheap"); // what they asked for, so the card can say why it isn't running
  });

  it("reports INERT when the extraction target fell back", () => {
    const d = describeSmallExtraction(ENV, {
      ...OR,
      extractionModel: "big/extract",
      extractionSmallModel: "small/cheap",
      extractionProvider: "openai",
    });
    expect(d).toMatchObject({ enabled: false, inert: true });
  });

  it("is not inert when nothing was configured — there is nothing to warn about", () => {
    expect(describeSmallExtraction(ENV, { ...OR, extractionModel: "big/extract" })).toMatchObject({
      enabled: false,
      inert: false,
    });
  });
});
