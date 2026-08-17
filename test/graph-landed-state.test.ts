import { describe, it, expect } from "vitest";
import {
  expectedEpisodeNames,
  landedState,
  boundPartialDetail,
  PARTIAL_DETAIL_LIMIT,
} from "@/lib/graph/landed-state";

// Spec: docs/design/reconcile-partial-chunks.md — acceptance criteria 1, 2, 3, 6.
// This measures the partial-loss population; it deliberately does NOT enforce (three ways enforcing
// today makes the graph worse are recorded in the spec and in landed-state.ts).

describe("expectedEpisodeNames", () => {
  it("returns the LITERAL names the projector writes", () => {
    // Asserted against literal strings, NOT against `episodeName` — comparing the helper to the
    // function it calls would be green by construction and would pin nothing.
    expect(expectedEpisodeNames("x", 1)).toEqual(["items:x"]);
    expect(expectedEpisodeNames("x", 3)).toEqual(["items:x#0", "items:x#1", "items:x#2"]);
  });

  it("treats 0 / negative / garbage chunk counts as a single un-suffixed episode", () => {
    // `episodeName(id, 0, 1)` is the single-chunk form; a count that cannot be honoured must not
    // produce `items:x#0`, which the projector would never have written.
    expect(expectedEpisodeNames("x", 0)).toEqual(["items:x"]);
    expect(expectedEpisodeNames("x", -4)).toEqual(["items:x"]);
    expect(expectedEpisodeNames("x", NaN)).toEqual(["items:x"]);
  });
});

describe("landedState", () => {
  const present = (...names: string[]) => new Set(names);

  it("is FULL when every expected chunk is present", () => {
    expect(landedState("x", 3, present("items:x#0", "items:x#1", "items:x#2")).state).toBe("full");
    expect(landedState("x", 1, present("items:x")).state).toBe("full");
  });

  it("is PARTIAL for the OBSERVED shape — chunks 0..32 present, #33 missing", () => {
    // The live case: a 502 killed the worker at chunk #33 of docs/ARCHITECTURE.md and reconcile
    // requeued 0 for it, because one present chunk confirmed the whole item.
    const names = Array.from({ length: 33 }, (_, i) => `items:arch#${i}`);
    const r = landedState("arch", 34, present(...names));
    expect(r.state).toBe("partial");
    expect(r.missing).toEqual(["items:arch#33"]);
  });

  it("is NONE when nothing landed — that is the fully-missing class reconcile ALREADY catches", () => {
    expect(landedState("x", 3, present()).state).toBe("none");
  });

  it("is NONE for an EMPTY chunk ledger — never-pushed is not a hole", () => {
    // reconcile depends on this: a row that ever pushed keeps its chunk_shas, so an empty ledger is
    // the honest never-pushed discriminator. Calling it "partial" would accuse a reservation row.
    expect(landedState("x", 0, present()).state).toBe("none");
    expect(landedState("x", 0, present("items:x")).state).toBe("none");
  });

  it("reports every missing name, so an operator can see WHICH chunks are gone", () => {
    const r = landedState("x", 4, present("items:x#0", "items:x#2"));
    expect(r.state).toBe("partial");
    expect(r.missing).toEqual(["items:x#1", "items:x#3"]);
  });
});

describe("boundPartialDetail — the meta blob must stay loadable", () => {
  it("caps the number of items sampled and reports how many were elided", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ itemId: `i${i}`, missing: ["items:a#1"] }));
    const b = boundPartialDetail(items);
    expect(b.sample).toHaveLength(PARTIAL_DETAIL_LIMIT);
    expect(b.elided).toBe(12 - PARTIAL_DETAIL_LIMIT);
  });

  it("caps the names WITHIN an item too — a 40-chunk hole is itself a blob", () => {
    const missing = Array.from({ length: 40 }, (_, i) => `items:big#${i}`);
    const b = boundPartialDetail([{ itemId: "big", missing }]);
    expect(b.sample[0].missing).toHaveLength(PARTIAL_DETAIL_LIMIT);
    expect(b.elided).toBe(0); // one item, so nothing elided at the ITEM level
  });

  it("elides nothing when the input already fits", () => {
    expect(boundPartialDetail([{ itemId: "a", missing: [] }])).toEqual({
      sample: [{ itemId: "a", missing: [] }],
      elided: 0,
    });
  });
});
