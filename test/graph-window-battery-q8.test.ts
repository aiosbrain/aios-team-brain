import { describe, expect, it } from "vitest";
import {
  assessQ8,
  orphansIn,
  normalizeExact,
  isCombinedRequest,
  parseCombinedPayload,
  COMBINED_PREFIX,
} from "../scripts/graph-window-battery/q8-orphan-drop.mjs";

/**
 * Q8′ (PIPEFF-5 / AIO-868) — the metric that replaced a sensor which could not fail.
 *
 * The first draft of the spec made "orphan rate in the graph" the headline quality gate, on
 * upstream's claim that combined extraction reduces orphans. It does, by DELETING them
 * (`combined_extraction.py:295`), so that sensor is ~0 by construction. Q8′ asks the answerable
 * question instead: is the candidate discarding MORE than the incumbent already failed to connect?
 *
 * Every refusal below exists because a plausible wrong number here is worse than no number — it
 * would read as "the candidate discards little", which is the exact claim being tested.
 */

const sysMsg = (content: string) => ({ messages: [{ role: "system", content }] });
const combinedReq = (id: string) => ({ id, kind: "request", body: sysMsg(`${COMBINED_PREFIX} …rest…`) });
const otherReq = (id: string) => ({ id, kind: "request", body: sysMsg("You are a fact deduplication assistant.") });
const resp = (id: string, payload: unknown) => ({
  id,
  kind: "response",
  body: { choices: [{ message: { content: JSON.stringify(payload) } }] },
});

const payload = (entities: string[], edges: Array<[string, string]>) => ({
  extracted_entities: entities.map((name) => ({ name })),
  edges: edges.map(([source_entity_name, target_entity_name]) => ({ source_entity_name, target_entity_name })),
});

describe("Q8' — name matching mirrors graphiti's own normalisation", () => {
  it("normalizeExact lowercases, collapses whitespace and trims, like _normalize_string_exact", () => {
    expect(normalizeExact("  John   SMITH \n")).toBe("john smith");
  });

  it("an entity referenced under different casing/spacing is NOT an orphan", () => {
    // graphiti normalises both sides (combined_extraction.py:181-189), so this file must too —
    // counting it as an orphan would overstate the loss rate and fail a healthy arm.
    const out = orphansIn(payload(["John  Smith"], [["JOHN SMITH", "Acme"]]));
    expect(out).toEqual({ raw: 1, orphans: 0 });
  });

  it("an entity no edge references IS an orphan — that is what line 295 deletes", () => {
    expect(orphansIn(payload(["Alice", "Bob", "Lonely"], [["Alice", "Bob"]]))).toEqual({ raw: 3, orphans: 1 });
  });
});

describe("Q8' — it counts only combined-extraction calls", () => {
  it("ignores other call kinds entirely", () => {
    const out = assessQ8([
      otherReq("x"),
      resp("x", { irrelevant: true }),
      combinedReq("a"),
      resp("a", payload(["A", "B"], [["A", "B"]])),
    ] as never);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.calls).toBe(1);
    expect(out.raw).toBe(2);
    expect(out.orphans).toBe(0);
  });

  it("aggregates across calls and reports the share", () => {
    const out = assessQ8([
      combinedReq("a"),
      resp("a", payload(["A", "B", "C"], [["A", "B"]])), // C orphaned
      combinedReq("b"),
      resp("b", payload(["D"], [["D", "E"]])),
    ] as never);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.raw).toBe(4);
    expect(out.orphans).toBe(1);
    expect(out.share).toBeCloseTo(0.25, 6);
  });
});

describe("Q8' REFUSES rather than reporting a low loss rate", () => {
  it("a DUPLICATE id refuses — a tap restart could cross incarnations", () => {
    const out = assessQ8([combinedReq("a"), combinedReq("a")] as never);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal).toMatch(/duplicate/i);
  });

  it("an UNPAIRED combined request refuses — response capture is non-fatal, so loss must surface", () => {
    const out = assessQ8([combinedReq("a")] as never);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal).toMatch(/no paired response/i);
  });

  it("an unrecognised response shape refuses — never folded into a zero", () => {
    // The parser-that-matches-nothing lesson: a zero here is indistinguishable from a measurement.
    const out = assessQ8([combinedReq("a"), resp("a", { something_else: [] })] as never);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal).toMatch(/does not parse/i);
  });

  it("ZERO combined calls refuses — the arm did not run the patch", () => {
    const out = assessQ8([otherReq("x"), resp("x", {})] as never);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal).toMatch(/did not run PATCH 4/);
  });

  it("an empty denominator refuses — a share over zero entities is not a measurement", () => {
    const out = assessQ8([combinedReq("a"), resp("a", payload([], []))] as never);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal).toMatch(/empty denominator|zero entities/i);
  });

  it("a record with no id refuses — a pre-pairing capture cannot support Q8'", () => {
    const out = assessQ8([{ kind: "request", body: sysMsg(COMBINED_PREFIX) }] as never);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal).toMatch(/no id/i);
  });

  it("an unrecognised record kind refuses", () => {
    const out = assessQ8([{ id: "a", kind: "trace", body: {} }] as never);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal).toMatch(/unrecognised record kind/i);
  });
});

describe("Q8' — helper contracts", () => {
  it("isCombinedRequest keys on the same prefix the cost classifier uses", () => {
    expect(isCombinedRequest(sysMsg(`${COMBINED_PREFIX} more`))).toBe(true);
    expect(isCombinedRequest(sysMsg("You are an entity extraction specialist for conversational messages."))).toBe(false);
    expect(isCombinedRequest({})).toBe(false);
  });

  it("parseCombinedPayload returns null on anything it does not recognise", () => {
    expect(parseCombinedPayload({ choices: [{ message: { content: "not json" } }] })).toBeNull();
    expect(parseCombinedPayload({ choices: [{ message: { content: '{"a":1}' } }] })).toBeNull();
    expect(parseCombinedPayload({})).toBeNull();
  });
});
