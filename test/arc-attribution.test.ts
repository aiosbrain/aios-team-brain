import { describe, expect, it } from "vitest";
import {
  attributeParticipants,
  attributedFactTexts,
  attributeFactText,
  attributeEventParticipants,
  isAiAgentName,
  groundParticipants,
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

  it("prefixes a fact with a technical/component subject with the resolved human", () => {
    // The fix: an arc whose facts have non-person subjects still reaches synthesis with a human.
    expect(
      attributeFactText("the checklist evaluator was added to adversarial testing", "the checklist evaluator", [
        "Chetan Nandakumar",
      ])
    ).toBe("(Chetan Nandakumar) the checklist evaluator was added to adversarial testing");
  });

  it("does not double-attribute when the subject already names the human (first-name → full-name)", () => {
    expect(attributeFactText("Chetan shipped the Linear importer", "Chetan", ["Chetan Nandakumar"])).toBe(
      "Chetan shipped the Linear importer"
    );
  });

  it("leaves a fact untouched when no human resolves and the subject isn't an agent", () => {
    expect(attributeFactText("the checklist evaluator was added", "the checklist evaluator", [])).toBe(
      "the checklist evaluator was added"
    );
  });

  it("joins up to 2 resolved humans on a component-subject fact", () => {
    expect(attributeFactText("context management was enhanced", "context management", ["Alice", "Bob", "Carol"])).toBe(
      "(Alice, Bob) context management was enhanced"
    );
  });
});

describe("attributedFactTexts", () => {
  const epToItem = new Map([
    ["ep-1", { itemId: "item-aaa" }],
    ["ep-2", { itemId: "item-bbb" }],
  ]);
  const humanByItem = new Map([["item-aaa", "Chetan Nandakumar"]]);

  it("resolves each fact's human via its episodes and attributes agent + component subjects", () => {
    const facts = [
      { fact: "Claude Code refactored the auth module", subject: "Claude Code", episodeUuids: ["ep-1"] },
      // Component subject: the human (Chetan, via item-aaa) is surfaced even though the subject
      // isn't a person or an agent — this is the fix.
      { fact: "the retriever gained date-awareness", subject: "the retriever", episodeUuids: ["ep-1"] },
    ];
    expect(attributedFactTexts(facts, epToItem, humanByItem)).toEqual([
      "(Chetan Nandakumar, via Claude Code) Claude Code refactored the auth module",
      "(Chetan Nandakumar) the retriever gained date-awareness",
    ]);
  });

  it("leaves a component-subject fact untouched when its item has no resolvable human", () => {
    // item-bbb has no human in humanByItem → nothing to attribute, not an agent → unchanged.
    const facts = [{ fact: "the parser was refactored", subject: "the parser", episodeUuids: ["ep-2"] }];
    expect(attributedFactTexts(facts, epToItem, humanByItem)).toEqual(["the parser was refactored"]);
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

describe("groundParticipants — participants are the EVIDENCE authors, not merely-mentioned names", () => {
  it("drops a name the model echoed from fact prose that authored NONE of the cited evidence (the fix)", () => {
    // The real bug: evidence authored by John + Fatma; the model also named Chetan (a fact mentioned him).
    expect(groundParticipants(["John Ellison", "Fatma", "Chetan"], ["John Ellison", "Fatma"])).toEqual([
      "John Ellison",
      "Fatma",
    ]);
  });

  it("uses the evidence humans even when the model named nobody (commit-shaped work)", () => {
    expect(groundParticipants([], ["Chetan", "John Ellison"])).toEqual(["Chetan", "John Ellison"]);
  });

  it("when a human resolves, an AI-agent chip is replaced by the plain human (not 'Claude Code (Chetan)')", () => {
    expect(groundParticipants(["Claude Code"], ["Chetan"])).toEqual(["Chetan"]);
    expect(groundParticipants(["Claude Code", "Chetan"], ["John Ellison"])).toEqual(["John Ellison"]);
  });

  it("dedupes evidence humans + drops blanks", () => {
    expect(groundParticipants(["Fatma"], ["Chetan", "Chetan", "", "  "])).toEqual(["Chetan"]);
  });

  it("no resolvable evidence human → falls back to the model's names (with AI-agent tags) so it isn't nameless", () => {
    expect(groundParticipants(["John Ellison"], [])).toEqual(["John Ellison"]);
    expect(groundParticipants(["Claude Code"], [])).toEqual(["Claude Code (unattributed AI agent)"]);
  });
});
