import { describe, expect, it } from "vitest";
import {
  attributeParticipants,
  attributedFactTexts,
  attributeFactText,
  attributeEventParticipants,
  isAiAgentName,
} from "@/lib/graph/arc-attribution";

/**
 * Spec: an AI agent/tool name in an arc's `participants` must never stand in for a human — it gets
 * tagged with the human(s) actually behind the work, or explicitly marked unattributed. Derived from
 * the product requirement: "any AI agent should be traceable to a human."
 */

describe("isAiAgentName", () => {
  it("recognizes known AI agent/tool/product names, case-insensitively and trimmed", () => {
    expect(isAiAgentName("Claude Code")).toBe(true);
    expect(isAiAgentName("  claude code  ")).toBe(true);
    expect(isAiAgentName("AIOS Team Brain")).toBe(true);
    expect(isAiAgentName("Claude Agent SDK")).toBe(true);
    expect(isAiAgentName("GitHub Copilot")).toBe(true);
    expect(isAiAgentName("ChatGPT")).toBe(true);
  });

  it("does not misfire on a human's real name via substring matching", () => {
    // "Claude" alone IS in the known-agent list (the common self-reference), but a name that merely
    // CONTAINS an agent name must not match — exact-match only, never substring.
    expect(isAiAgentName("Claudia Rivera")).toBe(false);
    expect(isAiAgentName("Cursor Jones")).toBe(false);
    expect(isAiAgentName("Sarah Chen")).toBe(false);
  });
});

describe("attributeParticipants", () => {
  it("tags a recognized AI agent with the resolved human(s)", () => {
    expect(attributeParticipants(["Claude Code"], ["Chetan Nandakumar"])).toEqual([
      "Claude Code (Chetan Nandakumar)",
    ]);
  });

  it("leaves ordinary human participants untouched", () => {
    expect(attributeParticipants(["Chetan Nandakumar", "John Smith"], [])).toEqual([
      "Chetan Nandakumar",
      "John Smith",
    ]);
  });

  it("marks an AI agent unattributed when no human resolves, rather than dropping or guessing", () => {
    expect(attributeParticipants(["AIOS Team Brain"], [])).toEqual(["AIOS Team Brain (unattributed AI agent)"]);
  });

  it("joins up to 2 distinct humans and caps beyond that", () => {
    expect(attributeParticipants(["Claude Code"], ["Alice", "Bob", "Carol"])).toEqual([
      "Claude Code (Alice, Bob)",
    ]);
  });

  it("dedupes repeated human names", () => {
    expect(attributeParticipants(["Claude Code"], ["Alice", "Alice"])).toEqual(["Claude Code (Alice)"]);
  });

  it("handles a mix of agent and human participants in one arc", () => {
    expect(attributeParticipants(["Claude Code", "Chetan Nandakumar"], ["Chetan Nandakumar"])).toEqual([
      "Claude Code (Chetan Nandakumar)",
      "Chetan Nandakumar",
    ]);
  });
});

describe("attributeFactText", () => {
  it("prefixes a fact whose subject is a recognized AI agent with its human, via the agent", () => {
    expect(attributeFactText("Claude Code refactored the auth module", "Claude Code", ["Chetan Nandakumar"])).toBe(
      "(Chetan Nandakumar, via Claude Code) Claude Code refactored the auth module"
    );
  });

  it("marks the agent unattributed when no human resolves", () => {
    expect(attributeFactText("AIOS Team Brain shipped the importer", "AIOS Team Brain", [])).toBe(
      "(unattributed AI agent: AIOS Team Brain) AIOS Team Brain shipped the importer"
    );
  });

  it("leaves a fact whose subject is an ordinary human untouched", () => {
    expect(attributeFactText("Chetan shipped the Linear importer", "Chetan", ["Chetan Nandakumar"])).toBe(
      "Chetan shipped the Linear importer"
    );
  });
});

describe("attributedFactTexts", () => {
  const epToItem = new Map([
    ["ep-1", { itemId: "item-aaa" }],
    ["ep-2", { itemId: "item-bbb" }],
  ]);
  const humanByItem = new Map([["item-aaa", "Chetan Nandakumar"]]);

  it("resolves each fact's human via its episodes and only tags AI-agent subjects", () => {
    const facts = [
      { fact: "Claude Code refactored the auth module", subject: "Claude Code", episodeUuids: ["ep-1"] },
      { fact: "John reviewed the RLS change", subject: "John", episodeUuids: ["ep-1"] },
    ];
    expect(attributedFactTexts(facts, epToItem, humanByItem)).toEqual([
      "(Chetan Nandakumar, via Claude Code) Claude Code refactored the auth module",
      "John reviewed the RLS change",
    ]);
  });

  it("tags an AI-agent subject unattributed when its item has no resolvable human", () => {
    const facts = [{ fact: "Codex opened a PR", subject: "Codex", episodeUuids: ["ep-2"] }];
    expect(attributedFactTexts(facts, epToItem, humanByItem)).toEqual([
      "(unattributed AI agent: Codex) Codex opened a PR",
    ]);
  });

  it("handles a fact with no resolvable episode/item at all", () => {
    const facts = [{ fact: "Claude Code did something", subject: "Claude Code", episodeUuids: [] }];
    expect(attributedFactTexts(facts, epToItem, humanByItem)).toEqual([
      "(unattributed AI agent: Claude Code) Claude Code did something",
    ]);
  });
});

describe("attributeEventParticipants (Layer 2)", () => {
  const humanByItem = new Map([["item-aaa", "Chetan Nandakumar"]]);

  it("tags a recognized AI-agent participant with the human behind the event's item", () => {
    const events = [{ itemId: "item-aaa", participants: ["Claude Code"] }];
    expect(attributeEventParticipants(events, humanByItem)).toEqual([
      { itemId: "item-aaa", participants: ["Claude Code (Chetan Nandakumar)"] },
    ]);
  });

  it("leaves ordinary human participants untouched", () => {
    const events = [{ itemId: "item-aaa", participants: ["Chetan Nandakumar"] }];
    expect(attributeEventParticipants(events, humanByItem)).toEqual(events);
  });

  it("marks an AI-agent participant unattributed when the item has no resolvable human", () => {
    const events = [{ itemId: "item-bbb", participants: ["Codex"] }];
    expect(attributeEventParticipants(events, humanByItem)).toEqual([
      { itemId: "item-bbb", participants: ["Codex (unattributed AI agent)"] },
    ]);
  });

  it("marks an AI-agent participant unattributed when the event has no item at all", () => {
    const events = [{ itemId: null, participants: ["AIOS Team Brain"] }];
    expect(attributeEventParticipants(events, humanByItem)).toEqual([
      { itemId: null, participants: ["AIOS Team Brain (unattributed AI agent)"] },
    ]);
  });

  it("preserves any extra fields on the event object (structural passthrough)", () => {
    const events = [{ itemId: "item-aaa", participants: ["Claude Code"], source: "github", factCount: 3 }];
    expect(attributeEventParticipants(events, humanByItem)).toEqual([
      { itemId: "item-aaa", participants: ["Claude Code (Chetan Nandakumar)"], source: "github", factCount: 3 },
    ]);
  });
});
