import { describe, expect, it } from "vitest";
import { toOrQuery } from "@/lib/query/retrieve";

// Spec for the FTS recall fix: the AI query box failed "what has john ellison been posting to slack?"
// because websearch AND-semantics required EVERY term in the body. toOrQuery drops question/stopwords
// and OR-joins the rest so a doc matching ANY significant term is retrieved (the LLM then filters).

describe("toOrQuery (FTS recall)", () => {
  it("drops question + stop words and OR-joins the significant terms", () => {
    expect(toOrQuery("what has john ellison been posting to slack?")).toBe(
      "john or ellison or posting or slack"
    );
  });

  it("dedupes and lowercases", () => {
    expect(toOrQuery("Slack slack DECISIONS decisions")).toBe("slack or decisions");
  });

  it("falls back to the raw question when nothing significant remains", () => {
    expect(toOrQuery("what is it?")).toBe("what is it?");
  });
});
