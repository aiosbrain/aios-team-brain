import { describe, expect, it } from "vitest";
import {
  parseModelCatalogue,
  verdictFor,
  structuredOutputWarning,
} from "@/lib/llm/structured-output-support";

/**
 * Spec: picking a model that can't do structured outputs must warn AT SAVE TIME.
 *
 * Since the graph proxy made the Admin answering-model picker also drive Graphiti's extraction, a
 * model without structured-output support silently empties the graph — Graphiti keeps returning 202,
 * arcs go blank, and the only other signal is the stall detector six hours later. This turns that
 * into a sentence in the console at the moment of the choice.
 *
 * The shape of the data is taken from OpenRouter's live catalogue, checked 2026-07-29:
 * `qwen3.7-max` and `qwen3.7-plus` list `structured_outputs`; `qwen3.7-flash` lists only
 * `response_format`. That last one is the trap — it is the cheap variant.
 */

const CATALOGUE = {
  data: [
    { id: "qwen/qwen3.7-max", supported_parameters: ["response_format", "structured_outputs", "tools"] },
    { id: "qwen/qwen3.7-plus", supported_parameters: ["response_format", "structured_outputs"] },
    { id: "qwen/qwen3.7-flash", supported_parameters: ["response_format"] },
    { id: "openai/gpt-4o", supported_parameters: ["response_format", "structured_outputs"] },
  ],
};

describe("parseModelCatalogue — only `structured_outputs` counts", () => {
  it("distinguishes schema adherence from mere JSON mode", () => {
    // THE distinction. `response_format` can mean only "emits valid JSON" (`json_object`), which is
    // not enough for `.parse()` — it needs adherence to a supplied schema. Conflating the two is
    // exactly how a model that looks capable empties the graph.
    const m = parseModelCatalogue(CATALOGUE);
    expect(m.get("qwen/qwen3.7-max")?.supportsStructuredOutputs).toBe(true);
    expect(m.get("qwen/qwen3.7-flash")?.supportsStructuredOutputs).toBe(false);
  });

  it("survives a shape it doesn't recognise rather than throwing", () => {
    for (const junk of [null, undefined, {}, { data: "nope" }, { data: [{ id: 1 }] }]) {
      expect(parseModelCatalogue(junk).size).toBeLessThanOrEqual(1);
    }
  });
});

describe("verdictFor — 'couldn't verify' is its own outcome", () => {
  const models = parseModelCatalogue(CATALOGUE);

  it("flags a model that cannot do structured outputs", () => {
    expect(verdictFor("qwen/qwen3.7-flash", models)).toEqual({
      status: "unsupported",
      model: "qwen/qwen3.7-flash",
    });
  });

  it("passes a model that can", () => {
    expect(verdictFor("qwen/qwen3.7-max", models).status).toBe("supported");
  });

  it("says UNKNOWN for an unlisted model — a stale catalogue must never accuse", () => {
    // OpenRouter adds models continually. Treating "not in my list" as "broken" is the cry-wolf
    // failure that made the work-key check worthless, and this file exists downstream of that.
    expect(verdictFor("some/brand-new-model", models).status).toBe("unknown");
  });

  it("says UNKNOWN when the catalogue could not be read at all", () => {
    expect(verdictFor("qwen/qwen3.7-flash", new Map()).status).toBe("unknown");
  });
});

describe("structuredOutputWarning — warns without blocking", () => {
  it("names the model and what specifically breaks", () => {
    const msg = structuredOutputWarning({ status: "unsupported", model: "qwen/qwen3.7-flash" });
    expect(msg).toContain("qwen/qwen3.7-flash");
    expect(msg).toMatch(/Saved/); // the save SUCCEEDS — the model is the admin's choice
    expect(msg).toMatch(/arcs|learning/i);
    // …and it must say what is NOT affected, or an admin reads it as "the brain is broken".
    expect(msg).toMatch(/query box|search|timeline/i);
  });

  it("is silent for supported and unknown — no warning without evidence", () => {
    expect(structuredOutputWarning({ status: "supported" })).toBeNull();
    expect(structuredOutputWarning({ status: "unknown", reason: "x" })).toBeNull();
  });
});
