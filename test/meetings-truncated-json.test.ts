import { describe, expect, it } from "vitest";
import { parseTranscriptExtraction, salvageSummaryBullets } from "@/lib/meetings/llm-extract";
import { summaryBullets } from "@/lib/meetings/summary-format";

/**
 * Spec (the max-tokens truncation / malformed-JSON recovery). On a long transcript, qwen sometimes
 * (a) emits bullets as bare comma-separated strings — `{"summary":"- a","- b"}` — which is invalid
 * JSON, and/or (b) overruns the token budget and the JSON is cut off mid-string. Before the fix,
 * `JSON.parse` threw and the note silently saved BLANK. The product intent: recover whatever
 * complete bullets the model did produce so the note shows a summary. These assertions are derived
 * from that intent (real shapes captured from prod), not the implementation.
 */

describe("salvageSummaryBullets", () => {
  it("recovers complete bullets from a truncated response, dropping the cut-off tail", () => {
    // The exact prod shape: summary starts as a string, more bullets follow as bare strings, and the
    // final bullet is truncated (no closing quote) by the token limit.
    const raw =
      '{"summary":"- Chetan discusses his upcoming visa appointment and John offers advice.",' +
      '"- Chetan details recent updates to Aios including OpenRouter as a context engine.",' +
      '"- They review the meeting note interface and the social dashboard.",' +
      '"- The team plans to extend tool integrations to distribution ski';
    expect(salvageSummaryBullets(raw)).toEqual([
      "- Chetan discusses his upcoming visa appointment and John offers advice.",
      "- Chetan details recent updates to Aios including OpenRouter as a context engine.",
      "- They review the meeting note interface and the social dashboard.",
    ]);
  });

  it("recovers from a truncated JSON ARRAY summary", () => {
    const raw = '{"summary":["- alpha point","- beta point","- gam';
    expect(salvageSummaryBullets(raw)).toEqual(["- alpha point", "- beta point"]);
  });

  it("ignores non-bullet strings (keys, prose)", () => {
    expect(salvageSummaryBullets('{"summary":"just prose, no bullets","attendees":["Alex"]}')).toEqual([]);
  });
});

describe("parseTranscriptExtraction recovers a summary from malformed/truncated JSON", () => {
  it("malformed comma-separated bullets (invalid JSON) -> bulleted summary", () => {
    const raw = '{"summary":"- Shipped the job queue","- Aligned on the rollout plan","- Next: analytics"}';
    const out = parseTranscriptExtraction(raw, []);
    expect(summaryBullets(out.summary)).toEqual([
      "Shipped the job queue",
      "Aligned on the rollout plan",
      "Next: analytics",
    ]);
  });

  it("token-truncated response -> the complete bullets survive", () => {
    const raw =
      '{"summary":"- Point one is complete.","- Point two is complete.","- Point three is complete.",' +
      '"- Point four was cut off mid-sen';
    const out = parseTranscriptExtraction(raw, []);
    expect(summaryBullets(out.summary)).toEqual([
      "Point one is complete.",
      "Point two is complete.",
      "Point three is complete.",
    ]);
  });

  it("returns empty when fewer than two bullets can be recovered (not a real summary)", () => {
    const raw = '{"summary":"- one lonely complete bullet","- the rest got trunca';
    expect(parseTranscriptExtraction(raw, []).summary).toBe("");
  });

  it("well-formed JSON is unaffected (no regression through the salvage path)", () => {
    const raw = '{"summary":"- a\\n- b","attendees":[]}';
    expect(summaryBullets(parseTranscriptExtraction(raw, []).summary)).toEqual(["a", "b"]);
  });
});
