import { describe, expect, it } from "vitest";
import { callerBlock, type CallerIdentity } from "@/lib/query/claude";

// Spec: the query pipeline must tell the model WHO is asking, so first-person questions
// ("how about me?", "what did I ship?") resolve to a concrete person and match that person's
// row in the by-name activity digests. Before this, both query routes resolved the caller for
// auth/rate-limiting but never surfaced the identity to the LLM — so "me" had no referent and
// the brain replied "the context does not include contributions tied to specific users".

describe("callerBlock", () => {
  it("returns empty string when there is no usable identity (→ no behavior change)", () => {
    expect(callerBlock(undefined)).toBe("");
    expect(callerBlock({})).toBe("");
    expect(callerBlock({ displayName: "  ", email: "", handle: null })).toBe("");
  });

  it("anchors first-person resolution to the caller's name/email/handle", () => {
    const caller: CallerIdentity = {
      displayName: "Chetan Nandakumar",
      email: "chetan@example.com",
      handle: "chetan",
    };
    const block = callerBlock(caller);
    expect(block.startsWith("<caller>")).toBe(true);
    expect(block.trimEnd().endsWith("</caller>")).toBe(true);
    expect(block).toContain("Chetan Nandakumar");
    expect(block).toContain("<chetan@example.com>");
    expect(block).toContain("@chetan");
    // The instruction the model needs to bind "me"/"my"/"I" to this person.
    expect(block).toMatch(/resolve first-person references/i);
    expect(block).toMatch(/"me"/);
  });

  it("renders whatever partial identity is available", () => {
    const nameOnly = callerBlock({ displayName: "Priya" });
    expect(nameOnly).toContain("answering for Priya.");
    expect(nameOnly).not.toContain("<>"); // no empty email markup
    expect(nameOnly).not.toContain("@\n"); // no dangling handle marker

    const emailOnly = callerBlock({ email: "priya@example.com" });
    expect(emailOnly).toContain("answering for <priya@example.com>.");
    expect(emailOnly).not.toContain("undefined");
    expect(emailOnly).not.toContain("null");
  });
});
