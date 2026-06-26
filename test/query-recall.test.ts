import { describe, expect, it } from "vitest";
import { toOrQuery, graphExpansionQuery } from "@/lib/query/retrieve";
import type { GraphFact } from "@/lib/graph/graphiti-client";

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

// Spec: Graphiti facts → FTS expansion terms. A paraphrased question ("how do users sign in?") has
// no overlap with the auth doc, but the graph's facts name the real entities ("magic links",
// "passwordless authentication"); harvesting those lets a second FTS pass reach the source item.
describe("graphExpansionQuery (semantic expansion)", () => {
  const facts: GraphFact[] = [
    { fact: "Authentication uses passwordless magic links", source_node_name: "Authentication", target_node_name: "Magic Links" },
    { fact: "The legacy password flow was removed" },
  ];

  it("harvests entity names + fact terms into an OR query (lowercased, stopwords/short dropped)", () => {
    const q = graphExpansionQuery(facts);
    for (const t of ["authentication", "passwordless", "magic", "links", "legacy", "password", "flow"]) {
      expect(q.split(" or ")).toContain(t);
    }
    expect(q.split(" or ")).not.toContain("the"); // stopword dropped (as a standalone term)
  });

  it("returns '' for no facts (→ keyword-only, no behavior change)", () => {
    expect(graphExpansionQuery([])).toBe("");
  });

  it("caps the number of expansion terms", () => {
    const many: GraphFact[] = Array.from({ length: 50 }, (_, i) => ({ fact: `alpha${i} beta${i} gamma${i} delta${i}` }));
    expect(graphExpansionQuery(many).split(" or ").length).toBeLessThanOrEqual(24);
  });
});
