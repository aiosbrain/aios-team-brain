import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Spec (the silent-blank-on-slow-model fix): meetings extraction is a background, best-effort pass,
 * so it must give the model MORE time than the interactive query box's 30s default. A reasoning
 * model (e.g. qwen via OpenRouter) can spend 30–45s on a full transcript; at 30s the call was
 * aborted and the summary/attendees/action-items silently came back empty. We assert the timeout
 * the meetings path hands the shared primitive — 60s by default, and any explicit override.
 */

const { completeTextOrNull } = vi.hoisted(() => ({
  completeTextOrNull: vi.fn(async () => '{"summary":"ok","attendees":[]}'),
}));
vi.mock("@/lib/llm/complete", () => ({ completeTextOrNull, completeText: vi.fn() }));

import {
  callMeetingsLLM,
  extractFromTranscript,
  MEETINGS_LLM_TIMEOUT_MS,
  MEETINGS_LLM_MAX_TOKENS,
} from "@/lib/meetings/llm-extract";
import { extractActionItems } from "@/lib/meetings/action-items";

afterEach(() => completeTextOrNull.mockClear());

const timeoutOf = () => completeTextOrNull.mock.calls.at(-1)?.[1]?.timeoutMs;
const maxTokensOf = () => completeTextOrNull.mock.calls.at(-1)?.[1]?.maxTokens;

describe("meetings extraction timeout", () => {
  it("defaults to the 60s meetings budget, not the query box's 30s", async () => {
    expect(MEETINGS_LLM_TIMEOUT_MS).toBe(60_000);
    await callMeetingsLLM("s", "u", {});
    expect(timeoutOf()).toBe(60_000);
  });

  it("honors an explicit override (backfill over a slow network)", async () => {
    await callMeetingsLLM("s", "u", {}, 120_000);
    expect(timeoutOf()).toBe(120_000);
  });

  it("extractFromTranscript forwards its timeout to the model call", async () => {
    await extractFromTranscript("text", [], {}, 90_000);
    expect(timeoutOf()).toBe(90_000);
  });

  it("extractActionItems forwards its timeout to the model call", async () => {
    await extractActionItems("text", [], {}, 90_000);
    expect(timeoutOf()).toBe(90_000);
  });

  it("asks for a generous token budget so long summaries aren't truncated mid-JSON", async () => {
    expect(MEETINGS_LLM_MAX_TOKENS).toBeGreaterThanOrEqual(2048);
    await callMeetingsLLM("s", "u", {});
    expect(maxTokensOf()).toBe(MEETINGS_LLM_MAX_TOKENS);
  });
});
