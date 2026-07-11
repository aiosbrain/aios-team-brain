import { describe, expect, it } from "vitest";
import { readVoice, buildPostPrompt, cleanPostBody } from "@/lib/social/generate";

/**
 * Spec for the pure bits of post generation: reading the brand voice, building the platform prompt,
 * and normalizing the model's output (the X 280-char cap is a hard product constraint).
 */

describe("readVoice", () => {
  it("pulls known string + array fields and ignores the rest", () => {
    expect(
      readVoice({
        formality: "casual",
        emojiUsage: "sparing",
        prohibitedPhrases: ["synergy", "circle back"],
        ctas: ["Learn more"],
        junk: 42,
        preferredPhrases: "not-an-array",
      })
    ).toEqual({
      formality: "casual",
      humor: undefined,
      emojiUsage: "sparing",
      ctas: ["Learn more"],
      preferredPhrases: undefined,
      prohibitedPhrases: ["synergy", "circle back"],
    });
  });

  it("returns all-undefined for an empty/absent voice", () => {
    expect(readVoice(undefined)).toEqual({
      formality: undefined,
      humor: undefined,
      emojiUsage: undefined,
      ctas: undefined,
      preferredPhrases: undefined,
      prohibitedPhrases: undefined,
    });
  });
});

describe("buildPostPrompt", () => {
  const opp = { title: "Shipped arc-sourced discovery", summary: "The Social Brain now reads narrative arcs." };

  it("includes platform guidance and the opportunity in the user turn", () => {
    const { system, user } = buildPostPrompt(opp, { formality: "casual" }, "x", "conversational");
    expect(system).toContain("X (Twitter)");
    expect(system).toContain("280 characters");
    expect(system).toContain("Tone: conversational.");
    expect(system).toContain("Formality: casual.");
    expect(system).toContain("Output ONLY the post text");
    expect(user).toContain("Shipped arc-sourced discovery");
    expect(user).toContain("The Social Brain now reads narrative arcs.");
  });

  it("folds prohibited phrases into a hard constraint", () => {
    const { system } = buildPostPrompt(opp, { prohibitedPhrases: ["synergy"] }, "linkedin", "neutral");
    expect(system).toContain("NEVER use these phrases: synergy");
    expect(system).toContain("LinkedIn");
  });

  it("falls back to a generic line for an unknown platform", () => {
    const { system } = buildPostPrompt(opp, {}, "mastodon", "");
    expect(system).toContain("Platform: mastodon");
  });
});

describe("cleanPostBody", () => {
  it("strips surrounding quotes, code fences, and <think> spans", () => {
    expect(cleanPostBody('<think>hmm</think>```\n"Hello world"\n```', "linkedin")).toBe("Hello world");
  });

  it("hard-caps an X post at 280 characters", () => {
    const long = "a".repeat(400);
    expect(cleanPostBody(long, "x").length).toBe(280);
  });

  it("does not cap LinkedIn posts", () => {
    const long = "a".repeat(400);
    expect(cleanPostBody(long, "linkedin").length).toBe(400);
  });

  it("returns empty string for nullish input", () => {
    expect(cleanPostBody("", "x")).toBe("");
  });
});
