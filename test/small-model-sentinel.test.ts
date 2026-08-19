import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("executes the exact Docker expression against provider-boundary cases", () => {
    const root = join(import.meta.dirname, "..");
    const docker = readFileSync(join(root, "graphiti", "Dockerfile"), "utf8");
    const sedStart = docker.indexOf("sed -i");
    const anchor = "small_model=";
    const start = docker.indexOf(anchor, sedStart) + anchor.length;
    expect(sedStart).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(anchor.length - 1);

    let depth = 0;
    let end = start;
    for (; end < docker.length; end += 1) {
      const char = docker[end];
      if ("([{".includes(char)) depth += 1;
      else if (")]}".includes(char)) {
        if (depth === 0) break;
        depth -= 1;
      } else if (char === "," && depth === 0) break;
    }
    const expression = docker.slice(start, end).trim();
    const dir = mkdtempSync(join(tmpdir(), "small-sentinel-"));
    const target = join(dir, "zep_graphiti.py");
    try {
      writeFileSync(target, `client = LLMConfig(small_model=${expression})\n`);
      const out = execFileSync("python3", [join(root, "graphiti", "verify-small-model-default.py"), target], {
        encoding: "utf8",
      });
      expect(out).toMatch(/cases pass on the shipped expression/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds legacy teams columns before defining the timestamp trigger", () => {
    const root = join(import.meta.dirname, "..");
    const schema = readFileSync(join(root, "postgres", "schema.sql"), "utf8");
    const legacyColumn = schema.indexOf(
      "alter table teams add column if not exists extraction_small_model text;"
    );
    const boundaryColumn = schema.indexOf(
      "alter table teams add column if not exists extraction_small_model_set_at timestamptz;"
    );
    const trigger = schema.indexOf("create trigger teams_extraction_small_model_stamp_update");
    expect(legacyColumn).toBeGreaterThanOrEqual(0);
    expect(boundaryColumn).toBeGreaterThan(legacyColumn);
    expect(trigger).toBeGreaterThan(boundaryColumn);
  });
});
