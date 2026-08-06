import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { continuityFrom, peopleFrom, memberPresence } from "../scripts/graph-window-battery/measure";

/**
 * The battery's quality measurements for PIPEFF-2 (AIO-821).
 *
 * Spec-derived. The property that matters most is DIRECTION: three of these metrics exist only
 * because plan review found the original five all pointed the wrong way for entity fragmentation —
 * an arm could split one person into several nodes and every gate would have read it as healthy.
 * So each test below states which way the number must move when the graph gets worse, not merely
 * that it computes something.
 */

describe("Q4 — cross-chunk continuity measures within-DOCUMENT convergence", () => {
  const multi = new Set(["item-a"]);

  it("scores 1 when every entity of a multi-chunk item appears in two of its chunks", () => {
    const rows = [
      { episode: "items:item-a#0", entity: "e1" },
      { episode: "items:item-a#1", entity: "e1" },
      { episode: "items:item-a#0", entity: "e2" },
      { episode: "items:item-a#2", entity: "e2" },
    ];
    expect(continuityFrom(rows, multi)).toBe(1);
  });

  it("FALLS when resolution stops converging — the direction that matters", () => {
    // The same document, but each chunk now yields its own node for the same thing. That is exactly
    // what losing the predecessor context looks like, and Q4 is the gate that has to see it.
    const rows = [
      { episode: "items:item-a#0", entity: "e1" },
      { episode: "items:item-a#1", entity: "e1-dup" },
      { episode: "items:item-a#2", entity: "e1-dup2" },
    ];
    expect(continuityFrom(rows, multi)).toBe(0);
  });

  it("ignores single-chunk items, which cannot demonstrate continuity by construction", () => {
    const rows = [
      { episode: "items:item-b", entity: "e1" },
      { episode: "items:item-a#0", entity: "e2" },
      { episode: "items:item-a#1", entity: "e2" },
    ];
    expect(continuityFrom(rows, multi)).toBe(1); // item-b contributes nothing either way
  });

  it("parses the item id exactly — `items:12` must not swallow `items:123`", () => {
    // A `STARTS WITH 'items:12'` prefix match would fold the two documents together and inflate the
    // score. This is the nit review raised, pinned.
    const rows = [
      { episode: "items:12#0", entity: "e1" },
      { episode: "items:123#0", entity: "e1" },
    ];
    // Only `items:12` is in the multi-chunk set, so the shared entity must NOT count as continuous.
    expect(continuityFrom(rows, new Set(["12"]))).toBe(0);
  });

  it("returns 0 rather than NaN when nothing qualifies", () => {
    expect(continuityFrom([], multi)).toBe(0);
  });
});

describe("Q2/Q6 — recall and cross-ITEM convergence", () => {
  const presence = new Map([
    ["john ellison", new Set(["i1", "i2"])], // present in TWO items → counts toward Q6
    ["chetan nandakumar", new Set(["i1"])], // one item only → Q2 but not Q6
  ]);

  it("scores full recall when every present name is an entity", () => {
    const got = peopleFrom(["John Ellison", "Chetan Nandakumar"], presence);
    expect(got.recall).toBe(1);
    expect(got.personsLost).toBe(0);
  });

  it("counts a name absent from the graph as a person LOST — Q2's noise-free clause", () => {
    const got = peopleFrom(["John Ellison"], presence);
    expect(got.personsLost).toBe(1);
    expect(got.recall).toBe(0.5);
  });

  it("is case-insensitive — Cypher equality is not, and would silently split a person in two", () => {
    const got = peopleFrom(["john ELLISON", "chetan nandakumar"], presence);
    expect(got.recall).toBe(1);
  });

  it("Q6 RISES when one person becomes several nodes — the fragmentation direction", () => {
    const clean = peopleFrom(["John Ellison", "Chetan Nandakumar"], presence);
    const fragmented = peopleFrom(["John Ellison", "John Ellison", "John Ellison", "Chetan Nandakumar"], presence);
    expect(clean.convergence).toBe(1);
    expect(fragmented.convergence).toBe(3);
    expect(fragmented.convergence).toBeGreaterThan(clean.convergence);
  });

  it("Q6 counts only names present in ≥2 DISTINCT items", () => {
    // A name confined to one item cannot demonstrate cross-item convergence, so fragmenting it must
    // not move Q6 — that case belongs to Q4 and Q1.
    const got = peopleFrom(["John Ellison", "Chetan Nandakumar", "Chetan Nandakumar"], presence);
    expect(got.convergenceNames).toBe(1);
    expect(got.convergence).toBe(1);
  });

  it("returns 0 rather than NaN on an empty presence map", () => {
    const got = peopleFrom(["Anyone"], new Map());
    expect(got.recall).toBe(0);
    expect(got.convergence).toBe(0);
  });
});

describe("memberPresence — literal presence, which is what needs no answer key", () => {
  const members = [{ display_name: "John Ellison" }, { display_name: "Chetan Nandakumar" }, { display_name: "Bo" }];

  it("maps each name to the items whose text contains it", () => {
    const got = memberPresence(members, [
      { id: "i1", body: "John Ellison reviewed the spec." },
      { id: "i2", body: "Chetan Nandakumar and John Ellison paired." },
      { id: "i3", body: "nobody named here" },
    ]);
    expect([...(got.get("john ellison") ?? [])].sort()).toEqual(["i1", "i2"]);
    expect([...(got.get("chetan nandakumar") ?? [])]).toEqual(["i2"]);
  });

  it("is case-insensitive on the body side too", () => {
    const got = memberPresence(members, [{ id: "i1", body: "JOHN ELLISON shipped it" }]);
    expect(got.has("john ellison")).toBe(true);
  });

  it("skips single-word and very short names, which would match ordinary prose", () => {
    // "Bo" would hit "Bob", "about", "border" — a denominator built from that measures nothing.
    const got = memberPresence(members, [{ id: "i1", body: "we talked about the border" }]);
    expect(got.has("bo")).toBe(false);
  });

  it("omits a name that appears nowhere rather than mapping it to an empty set", () => {
    const got = memberPresence(members, [{ id: "i1", body: "no names at all" }]);
    expect(got.size).toBe(0);
  });
});

describe("Q3's predicate stays tied to the one the health module pins", () => {
  it("uses the relation and property Graphiti actually writes", () => {
    // `test/guards/dedupe-predicate-pinned.test.ts` pins extraction-health.ts against the deployed
    // image. This asserts the battery did not quietly diverge from it — a mismatch here would make
    // Q3 read zero, which looks like a CLEAN graph while meaning the relation is gone.
    const src = readFileSync(join(process.cwd(), "scripts/graph-window-battery/measure.ts"), "utf8");
    expect(src).toContain("[r:RELATES_TO]");
    expect(src).toContain("r.name = 'IS_DUPLICATE_OF'");
  });

  it("scopes every read to a single group_id — the graph's only tier enforcement", () => {
    // CLAUDE.md §5: no RLS, and `episodeGroupId(teamSlug, access)` is the sole tier boundary. A query
    // that forgot the scope would silently mix tiers into a measurement.
    const src = readFileSync(join(process.cwd(), "scripts/graph-window-battery/measure.ts"), "utf8");
    const matches = src.match(/MATCH \([^)]*\{ ?group_id: \$g ?\}/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
    // …and no MATCH on a labelled node without it.
    expect(src).not.toMatch(/MATCH \(n:Entity\)(?!.*group_id)/);
  });
});
