import { describe, expect, it } from "vitest";
import { projectionPrecondition, parseWindowDays, heldByWindow } from "./projection-window";

// Spec: docs/design/staging-bounded-projection.md, criteria C1-C8.
// Written from the spec, not from the implementation: each case states what the product SHOULD do.

const CLOCK = new Date("2026-09-06T12:00:00.000Z");
const ok = (marker: boolean) => ({ ok: true as const, marker });
const failed = { ok: false as const, error: "connection terminated" };

describe("projectionPrecondition — the decision (C1-C8)", () => {
  it("C1: marker + no window REFUSES, naming both the marker and the variable", () => {
    // Run the same assertion for every spelling of "unset". A blank Railway variable arrives as "",
    // and D5 makes that UNSET rather than invalid — the realistic production input.
    for (const window of [undefined, "", "   ", "\t"]) {
      const d = projectionPrecondition({ marker: ok(true), window, now: CLOCK });
      expect(d.proceed, `window=${JSON.stringify(window)}`).toBe(false);
      if (d.proceed) throw new Error("unreachable");
      expect(d.refused).toBe("staging-window-unset");
      expect(d.error).toContain("staging_marker");
      expect(d.error).toContain("GRAPH_PROJECT_WINDOW_DAYS");
    }
  });

  it("C2: marker + valid window PROCEEDS with floor = clock - days, not a defaulted date", () => {
    const d = projectionPrecondition({ marker: ok(true), window: "30", now: CLOCK });
    expect(d.proceed).toBe(true);
    if (!d.proceed) throw new Error("unreachable");
    expect(d.workAtFloor).toBe("2026-08-07T12:00:00.000Z");
  });

  it("C3: the SAME window at two clocks yields two floors, each exactly clock - days", () => {
    // The window is per-RUN. An absolute floor would grow with every refresh while still satisfying
    // C1 the whole time, which is the failure this asserts against.
    const a = projectionPrecondition({ marker: ok(true), window: "7", now: CLOCK });
    const later = new Date("2026-10-06T12:00:00.000Z");
    const b = projectionPrecondition({ marker: ok(true), window: "7", now: later });
    if (!a.proceed || !b.proceed) throw new Error("unreachable");
    expect(a.workAtFloor).toBe("2026-08-30T12:00:00.000Z");
    expect(b.workAtFloor).toBe("2026-09-29T12:00:00.000Z");
    expect(a.workAtFloor).not.toBe(b.workAtFloor);
  });

  it.each(["0", "-1", "-30", "2.5", "0.5", "abc", "7d", "NaN", "Infinity", "1e3"])(
    "C4: an invalid window (%s) REFUSES with its own reason and never proceeds unbounded",
    (window) => {
      const d = projectionPrecondition({ marker: ok(true), window, now: CLOCK });
      expect(d.proceed).toBe(false);
      if (d.proceed) throw new Error("unreachable");
      expect(d.refused).toBe("invalid-window");
      expect(d.error).toContain("GRAPH_PROJECT_WINDOW_DAYS");
    }
  );

  it("C4: an invalid window refuses on a PRODUCTION database too — never a silent unbounded fallback", () => {
    const d = projectionPrecondition({ marker: ok(false), window: "0", now: CLOCK });
    expect(d.proceed).toBe(false);
    if (d.proceed) throw new Error("unreachable");
    expect(d.refused).toBe("invalid-window");
  });

  it("C5: no marker + no window PROCEEDS UNBOUNDED — production, unchanged", () => {
    for (const window of [undefined, "", "  "]) {
      const d = projectionPrecondition({ marker: ok(false), window, now: CLOCK });
      expect(d.proceed, `window=${JSON.stringify(window)}`).toBe(true);
      if (!d.proceed) throw new Error("unreachable");
      expect(d.workAtFloor).toBeUndefined();
    }
  });

  it("C6: no marker + valid window PROCEEDS BOUNDED — the knob is not inert on production", () => {
    const d = projectionPrecondition({ marker: ok(false), window: "7", now: CLOCK });
    expect(d.proceed).toBe(true);
    if (!d.proceed) throw new Error("unreachable");
    expect(d.workAtFloor).toBe("2026-08-30T12:00:00.000Z");
  });

  it("C7: a marker read that THROWS refuses on BOTH window arms, preserving the error", () => {
    // When the read fails there is no marker state, so the two arms are window-set and window-unset —
    // not marker-present and marker-absent.
    for (const window of [undefined, "30"]) {
      const d = projectionPrecondition({ marker: failed, window, now: CLOCK });
      expect(d.proceed, `window=${JSON.stringify(window)}`).toBe(false);
      if (d.proceed) throw new Error("unreachable");
      expect(d.refused).toBe("staging-state-unknown");
      expect(d.error).toContain("connection terminated");
    }
  });

  it("C7: the unknown-state reason does NOT instruct anyone to set the staging knob", () => {
    // A production admin clicking "Project to graph" during a DB blip must not be told to configure
    // a staging-only variable.
    const d = projectionPrecondition({ marker: failed, window: undefined, now: CLOCK });
    if (d.proceed) throw new Error("unreachable");
    expect(d.error).not.toContain("GRAPH_PROJECT_WINDOW_DAYS");
  });

  it("C8: each refusal reason has an input that triggers ONLY it", () => {
    const reasons = [
      projectionPrecondition({ marker: ok(true), window: undefined, now: CLOCK }),
      projectionPrecondition({ marker: ok(true), window: "0", now: CLOCK }),
      projectionPrecondition({ marker: failed, window: "30", now: CLOCK }),
    ].map((d) => (d.proceed ? "proceed" : d.refused));
    expect(reasons).toEqual(["staging-window-unset", "invalid-window", "staging-state-unknown"]);
    expect(new Set(reasons).size).toBe(3);
  });
});

describe("parseWindowDays — D5's unset/invalid boundary", () => {
  it("treats every blank spelling as UNSET, not invalid", () => {
    for (const raw of [undefined, "", " ", "\t\n"]) expect(parseWindowDays(raw)).toEqual({ kind: "unset" });
  });
  it("accepts a positive integer, with surrounding whitespace trimmed", () => {
    expect(parseWindowDays("30")).toEqual({ kind: "days", days: 30 });
    expect(parseWindowDays(" 7 ")).toEqual({ kind: "days", days: 7 });
  });
  it.each(["0", "-1", "2.5", "abc", "7d", "1e3", "Infinity"])("rejects %s as invalid", (raw) => {
    expect(parseWindowDays(raw).kind).toBe("invalid");
  });
});

// Added after the pre-push diff review: the 12 decision mutations were all over
// `projectionPrecondition`/`parseWindowDays`, so the predicate that actually decides whether an item
// costs money had nothing behind it. The dm tier cannot reach the null arm at all — `work_at` is
// NOT NULL in the schema — so it can only be pinned here.
describe("heldByWindow — the predicate that decides whether an item extracts", () => {
  const FLOOR = "2026-08-07T12:00:00.000Z";

  it("holds work older than the floor and admits work newer, as a string", () => {
    expect(heldByWindow({ work_at: "2026-07-01T00:00:00.000Z" }, FLOOR)).toBe(true);
    expect(heldByWindow({ work_at: "2026-09-01T00:00:00.000Z" }, FLOOR)).toBe(false);
  });

  it("handles the shapes `work_at` actually arrives in", () => {
    // The adapter returns text; a caller may hold a Date. Both must compare the same way, and a
    // non-UTC offset must be normalised rather than compared as a string — "2026-09-01T00:00+05:30"
    // sorts before the floor lexically while being AFTER it in time.
    expect(heldByWindow({ work_at: new Date("2026-07-01T00:00:00Z") }, FLOOR)).toBe(true);
    expect(heldByWindow({ work_at: new Date("2026-09-01T00:00:00Z") }, FLOOR)).toBe(false);
    expect(heldByWindow({ work_at: "2026-09-01T00:00:00+05:30" }, FLOOR)).toBe(false);
    expect(heldByWindow({ work_at: "2026-07-01T00:00:00+05:30" }, FLOOR)).toBe(true);
    expect(heldByWindow({ work_at: "2026-08-07 12:00:00.000001+00" }, FLOOR)).toBe(false);
  });

  it("is inert with no floor — production's unbounded behaviour", () => {
    expect(heldByWindow({ work_at: "1999-01-01T00:00:00.000Z" }, undefined)).toBe(false);
    expect(heldByWindow({ work_at: null }, undefined)).toBe(false);
  });

  it("resolves a missing or unparseable work_at toward HOLD", () => {
    // Theoretical (the column is NOT NULL), and it resolves in the direction that cannot spend money
    // by accident: an operator can widen the window, nobody can un-bill an extraction. It must NOT
    // fall back to `synced_at`, which is the axis this whole slice exists to move off.
    expect(heldByWindow({ work_at: null }, FLOOR)).toBe(true);
    expect(heldByWindow({ work_at: undefined }, FLOOR)).toBe(true);
    expect(heldByWindow({}, FLOOR)).toBe(true);
    expect(heldByWindow({ work_at: "not a date" }, FLOOR)).toBe(true);
  });
});
