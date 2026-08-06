import { describe, expect, it } from "vitest";
import { splitPrompt, PREV_TAGS } from "../scripts/graph-window-battery/phase-a-predecessors";

/**
 * The predecessor-block parser for Phase A (PIPEFF-2 / AIO-821).
 *
 * THIS TEST EXISTS BECAUSE THE FIRST PARSER WAS CONFIDENTLY WRONG AND SILENT ABOUT IT. It looked for
 * a JSON key `"previous_episodes"`, which graphiti_core 0.29.3's prompts do not contain — they use
 * XML-ish section tags. So it reported **0% predecessors** on prompts that were ~75% predecessors.
 * Had that run against a paid session it would have "measured" the ten-episode window as free and
 * killed the lever on its own bug, with a plausible number and no error.
 *
 * A dry run against prompts generated inside the deployed image caught it — which is the procedure
 * worth keeping, because this test can only pin what the parser does with a KNOWN format, never that
 * the format is still what the image emits. Re-run the generator before trusting a Phase A number:
 *
 *   docker exec <graphiti> /app/.venv/bin/python -c "from graphiti_core.prompts import prompt_library; ..."
 *
 * The two spellings below are not a style choice — graphiti 0.29.3 genuinely emits both, `extract_nodes`
 * and `dedupe_nodes` with a space and `extract_edges` with an underscore.
 */

const predecessorBlock = (tag: string, filler: string) => `<${tag}>\n[{"content": "${filler}"}]\n</${tag}>`;

describe("splitPrompt finds the predecessor block in both spellings graphiti emits", () => {
  it.each([...PREV_TAGS])("parses <%s>", (tag) => {
    const filler = "predecessor text. ".repeat(200);
    const content = `preamble\n${predecessorBlock(tag, filler)}\n<CURRENT MESSAGE>\nthe episode\n</CURRENT MESSAGE>`;
    const got = splitPrompt(content);
    expect(got.parsed).toBe(true);
    expect(got.predecessors).toBeGreaterThan(0);
    // The block is the bulk of this prompt, so the share must be large — a parser that matched the
    // tag but measured the wrong span would still pass a bare `> 0`.
    expect(got.predecessors / got.total).toBeGreaterThan(0.8);
  });

  it("covers both tag spellings — dropping one is how extract_edges would silently read as zero", () => {
    expect([...PREV_TAGS]).toEqual(["PREVIOUS MESSAGES", "PREVIOUS_MESSAGES"]);
  });

  // The `it.each` above iterates PREV_TAGS, so it follows the constant and cannot catch a WRONG one —
  // it would simply test whatever tag is configured. These two fixtures are literals taken from the
  // shapes the deployed image actually emits, so a changed constant reddens a behaviour test rather
  // than only an equality assertion.
  it("parses a literal extract_nodes-shaped prompt (space spelling)", () => {
    const got = splitPrompt(`<ENTITY TYPES>\n[]\n</ENTITY TYPES>\n<PREVIOUS MESSAGES>\n[{"content": "${"p".repeat(4000)}"}]\n</PREVIOUS MESSAGES>\n<CURRENT MESSAGE>\nepisode\n</CURRENT MESSAGE>`);
    expect(got.parsed).toBe(true);
    expect(got.predecessors / got.total).toBeGreaterThan(0.8);
  });

  it("parses a literal extract_edges-shaped prompt (underscore spelling)", () => {
    const got = splitPrompt(`<PREVIOUS_MESSAGES>\n[{"content": "${"p".repeat(4000)}"}]\n</PREVIOUS_MESSAGES>\n<CURRENT_MESSAGE>\nepisode\n</CURRENT_MESSAGE>\n<ENTITIES>\n[]\n</ENTITIES>`);
    expect(got.parsed).toBe(true);
    expect(got.predecessors / got.total).toBeGreaterThan(0.8);
  });
});

describe("an unrecognised prompt is REPORTED, never assumed to carry nothing", () => {
  it("marks a prompt with no predecessor tag unparsed rather than 0% and moving on", () => {
    const got = splitPrompt("a prompt in some future format with no predecessor section at all");
    expect(got.parsed).toBe(false);
    // The distinction that matters: `parsed: false` is what the report surfaces per call kind. A
    // parser that returned {predecessors: 0, parsed: true} would be indistinguishable from a genuine
    // measurement of a window that carries nothing — which is exactly the claim the lever rests on.
    expect(got.predecessors).toBe(0);
  });

  it("marks an unclosed tag unparsed rather than swallowing the rest of the prompt", () => {
    const got = splitPrompt(`<PREVIOUS MESSAGES>\n[{"content": "truncated`);
    expect(got.parsed).toBe(false);
  });

  it("does not match a tag that only appears in the closing form", () => {
    expect(splitPrompt("</PREVIOUS MESSAGES>\nstray").parsed).toBe(false);
  });
});

describe("the split is exhaustive — episode plus predecessors accounts for the whole prompt", () => {
  it("assigns every token to exactly one side", () => {
    const content = `head\n${predecessorBlock("PREVIOUS MESSAGES", "x".repeat(4000))}\ntail`;
    const got = splitPrompt(content);
    expect(got.predecessors + got.episode).toBe(got.total);
  });

  it("reports the whole prompt as episode when there is no predecessor block", () => {
    const got = splitPrompt("just the episode, nothing else");
    expect(got.episode).toBe(got.total);
  });
});
