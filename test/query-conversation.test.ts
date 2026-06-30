import { describe, expect, it } from "vitest";
import { conversationBlock, type ChatTurn } from "@/lib/query/claude";

// Spec: windowed in-session memory so the model can resolve follow-ups/pronouns ("he", "that")
// without re-litigating old sources — last N turns, each prior answer truncated. This is the fix
// for "what did he finish last week? what did john finish?" dropping the unresolvable "he" part.

const turn = (q: string, a = ""): ChatTurn => ({ question: q, answer: a });

describe("conversationBlock", () => {
  it("returns empty string when there is no usable history", () => {
    expect(conversationBlock(undefined)).toBe("");
    expect(conversationBlock([])).toBe("");
    expect(conversationBlock([turn("   ", "x")])).toBe(""); // blank question dropped
  });

  it("wraps recent turns so an earlier antecedent ('he' = Chetan) is resolvable", () => {
    const block = conversationBlock([
      turn("what did chetan ship last week?", "Chetan shipped the Linear importer."),
      turn("nice", "Glad it helped."),
    ]);
    expect(block.startsWith("<conversation_so_far>")).toBe(true);
    expect(block.trimEnd().endsWith("</conversation_so_far>")).toBe(true);
    expect(block).toContain("User: what did chetan ship last week?");
    expect(block).toContain("Brain: Chetan shipped the Linear importer.");
  });

  it("keeps only the last N turns", () => {
    const history = Array.from({ length: 10 }, (_, i) => turn(`q${i}`, `a${i}`));
    const block = conversationBlock(history, { maxTurns: 3 });
    expect(block).toContain("User: q9");
    expect(block).toContain("User: q7");
    expect(block).not.toContain("User: q6"); // older than the window
  });

  it("truncates each prior answer and collapses whitespace", () => {
    const block = conversationBlock([turn("q", "x".repeat(50))], { maxAnswerChars: 10 });
    expect(block).toContain("Brain: xxxxxxxxxx…");
    expect(block).not.toMatch(/x{11}/);
  });

  it("omits the Brain line for a turn that has no answer yet", () => {
    const block = conversationBlock([turn("pending question", "")]);
    expect(block).toContain("User: pending question");
    expect(block).not.toContain("Brain:");
  });
});
