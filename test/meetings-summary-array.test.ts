import { afterEach, describe, expect, it, vi } from "vitest";
import { extractFromTranscript } from "@/lib/meetings/llm-extract";
import { normalizeSummaryField, summaryBullets } from "@/lib/meetings/summary-format";

/**
 * Spec (the array-shaped-summary regression). The meetings prompt asks for
 * `{"summary":"- ...\n- ...","attendees":[...]}` — a newline-joined bullet STRING. But some models
 * that a team can select as their answering provider (observed live: `qwen/qwen3.7-plus` via
 * OpenRouter) return `summary` as a JSON ARRAY of bullet strings instead. The old parser accepted a
 * string only (`typeof obj.summary === "string" ? … : ""`), so a perfectly good array answer was
 * silently discarded → blank summary → the Regenerate button reported "LLM unavailable" even though
 * the model answered in ~2s.
 *
 * The product intent: whichever shape the model returns, a bulleted summary must survive extraction
 * and render as a list. These assertions are derived from that intent, not from the implementation.
 */

const OPENROUTER_KEYS = {
  openrouterKey: "or-test-key",
  openrouterModel: "qwen/qwen3.7-plus",
  activeProvider: "openrouter" as const,
};

/** Stub the OpenAI-compatible transport to return one completion body. */
function mockLLM(content: string) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("meeting summary survives an array-shaped model response", () => {
  it("array of already-bulleted lines → non-empty bulleted summary", async () => {
    // Exactly the shape qwen/qwen3.7-plus returned in prod for the 'John/Chetan' note.
    mockLLM(
      JSON.stringify({
        summary: [
          "- Chetan is invited to join as a consultant on an existing client project.",
          "- The workstation has undergone testing and is ready for the next phase.",
        ],
        attendees: [],
      })
    );
    const out = await extractFromTranscript("transcript text", [], OPENROUTER_KEYS);
    expect(out.summary).not.toBe("");
    // Renders as a real bulleted list, not a mangled paragraph.
    expect(summaryBullets(out.summary)).toEqual([
      "Chetan is invited to join as a consultant on an existing client project.",
      "The workstation has undergone testing and is ready for the next phase.",
    ]);
  });

  it("array of un-prefixed lines → each gets a bullet marker", async () => {
    // The 'Abdulsettar' note came back as array elements with NO leading dash.
    mockLLM(
      JSON.stringify({
        summary: [
          "John and Abdulsettar discuss structuring a B2B negotiation platform.",
          "Abdulsettar retains ownership of the methodology framework.",
        ],
        attendees: [],
      })
    );
    const out = await extractFromTranscript("transcript text", [], OPENROUTER_KEYS);
    expect(summaryBullets(out.summary)).toEqual([
      "John and Abdulsettar discuss structuring a B2B negotiation platform.",
      "Abdulsettar retains ownership of the methodology framework.",
    ]);
  });

  it("string summary still passes through unchanged (no regression)", async () => {
    mockLLM(JSON.stringify({ summary: "- one point\n- two point", attendees: [] }));
    const out = await extractFromTranscript("transcript text", [], OPENROUTER_KEYS);
    expect(out.summary).toBe("- one point\n- two point");
    expect(summaryBullets(out.summary)).toEqual(["one point", "two point"]);
  });
});

describe("normalizeSummaryField", () => {
  it("joins an array into a newline-separated bullet string", () => {
    expect(normalizeSummaryField(["a", "b"])).toBe("- a\n- b");
  });

  it("strips a pre-existing bullet marker so it isn't doubled", () => {
    expect(normalizeSummaryField(["- a", "• b", "* c"])).toBe("- a\n- b\n- c");
  });

  it("passes a string through, trimmed", () => {
    expect(normalizeSummaryField("  - a\n- b  ")).toBe("- a\n- b");
  });

  it("drops non-string array elements and blanks", () => {
    expect(normalizeSummaryField(["a", 42, "", null, "b"])).toBe("- a\n- b");
  });

  it("returns '' for null/undefined/object", () => {
    expect(normalizeSummaryField(null)).toBe("");
    expect(normalizeSummaryField(undefined)).toBe("");
    expect(normalizeSummaryField({ x: 1 })).toBe("");
  });
});
