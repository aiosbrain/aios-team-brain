import { describe, expect, it } from "vitest";
import { messagesToExchanges } from "@/components/query-chat";

/**
 * Spec for rehydrating a persisted thread into the chat's Exchange shape — the mapping behind the
 * Home embed remembering its history across navigation. Derived from the pairing contract:
 * consecutive user→assistant messages become one exchange; a trailing user turn stays unanswered.
 */

describe("messagesToExchanges", () => {
  it("pairs user→assistant messages into exchanges", () => {
    const ex = messagesToExchanges([
      { role: "user", content: "what shipped?" },
      { role: "assistant", content: "the auth rewrite" },
      { role: "user", content: "who did it?" },
      { role: "assistant", content: "Alice" },
    ]);
    expect(ex).toEqual([
      { question: "what shipped?", answer: "the auth rewrite", sources: [], status: "done" },
      { question: "who did it?", answer: "Alice", sources: [], status: "done" },
    ]);
  });

  it("keeps a trailing unanswered user turn (answer empty)", () => {
    const ex = messagesToExchanges([{ role: "user", content: "pending?" }]);
    expect(ex).toEqual([{ question: "pending?", answer: "", sources: [], status: "done" }]);
  });

  it("ignores a leading assistant message with no question", () => {
    expect(messagesToExchanges([{ role: "assistant", content: "orphan" }])).toEqual([]);
  });

  it("returns [] for empty input", () => {
    expect(messagesToExchanges([])).toEqual([]);
  });
});
