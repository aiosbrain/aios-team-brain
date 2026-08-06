import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no types; imported for its pure helpers.
import { assessWindow, summarise, resolveLastWindow } from "../scripts/graph-ingest-cost.mjs";

/**
 * The measurement instrument for PIPEFF-1 (AIO-820).
 *
 * Spec-derived, and the spec here is unusual: this tool's job is to REFUSE more often than it
 * reports. Graph extraction is asynchronous, so a window that opens or closes mid-burst mixes one
 * population's tokens with another's episodes — which is exactly how the first baseline came out at
 * "10.1 tokens per source char" when the honest figure was ~61x the content. A cost instrument that
 * emits a plausible wrong number is worse than one that emits nothing, because the wrong number is
 * what gets quoted in a decision.
 *
 * So the assertions below are mostly about the refusals: each one pins a window shape that MUST NOT
 * produce a ratio.
 */

const clean = {
  leadingCalls: 0,
  trailingCalls: 0,
  forwardCalls: 0,
  forwardUnknown: false,
  extractNodes: 100,
  episodesPushed: 100,
};

describe("assessWindow — refuses more than it reports", () => {
  it("trusts a window that opens and closes in quiet with agreeing counts", () => {
    const v = assessWindow(clean);
    expect(v.trustworthy).toBe(true);
    expect(v.problems).toEqual([]);
  });

  it("refuses when an earlier burst was still extracting as the window opened", () => {
    // Its tokens land in our numerator; its episodes do not. The ratio reads too high.
    const v = assessWindow({ ...clean, leadingCalls: 12 });
    expect(v.trustworthy).toBe(false);
    expect(v.problems.join(" ")).toMatch(/LEADING/);
  });

  it("refuses when our own burst had not drained as the window closed", () => {
    // Episodes counted here are still being billed. The ratio reads too low.
    const v = assessWindow({ ...clean, trailingCalls: 3 });
    expect(v.trustworthy).toBe(false);
    expect(v.problems.join(" ")).toMatch(/TRAILING/);
  });

  it("refuses when extraction spilled PAST the window — the flattering direction", () => {
    // Both other edge checks look backward. A graphiti worker that stalls mid-queue, goes quiet past
    // the drain, then resumes after `until` leaves its episodes counted here and its tokens outside —
    // making the pipeline look cheaper than it is. Silent worker death is a recorded failure of this
    // deployment, so this is a real window shape, not a hypothetical one.
    const v = assessWindow({ ...clean, forwardCalls: 40 });
    expect(v.trustworthy).toBe(false);
    expect(v.problems.join(" ")).toMatch(/AFTER the window/);
  });

  it("refuses when the window is too recent for the forward check to have run", () => {
    // `--last=1h` can never be forward-checked: the drain window after `until` is still in the future.
    // Unknown must not read as clean.
    const v = assessWindow({ ...clean, forwardUnknown: true });
    expect(v.trustworthy).toBe(false);
    expect(v.problems.join(" ")).toMatch(/cannot run yet/);
  });

  it("keeps the cross-check gap SIGNED, because the two directions are different diagnoses", () => {
    // Positive = more extraction attempts than pushes (retries, which 0.29.3 meters). Negative = the
    // window saw a push it did not bill. A lever that changes prompt shape can move the retry rate,
    // so a before/after must read the sign, not just the magnitude.
    expect(assessWindow({ ...clean, extractNodes: 118, episodesPushed: 100 }).crossCheck?.signed).toBe(18);
    expect(assessWindow({ ...clean, extractNodes: 100, episodesPushed: 118 }).crossCheck?.signed).toBe(-18);
  });

  it("refuses a window with no extraction at all rather than dividing by zero", () => {
    const v = assessWindow({ ...clean, extractNodes: 0 });
    expect(v.trustworthy).toBe(false);
    expect(v.problems.join(" ")).toMatch(/no `extract_nodes`/);
  });

  it("refuses when the two episode counts describe different populations", () => {
    // THE failure that produced the wrong baseline: 109 extract_nodes billed against ~169 episodes
    // pushed. Either number alone looks fine; only the comparison exposes the straddle.
    const v = assessWindow({ ...clean, extractNodes: 109, episodesPushed: 169 });
    expect(v.trustworthy).toBe(false);
    expect(v.problems.join(" ")).toMatch(/episode counts disagree/);
    expect(v.crossCheck?.gap).toBeCloseTo(0.355, 2);
  });

  it("tolerates a small disagreement — async lag is normal, not a straddle", () => {
    expect(assessWindow({ ...clean, extractNodes: 100, episodesPushed: 108 }).trustworthy).toBe(true);
  });

  it("does not fail a window that simply has no projector runs to compare against", () => {
    // Runs are recorded at run END, so a window can legitimately contain extraction and no run row.
    // "Cannot cross-check" must not read as "cross-check failed".
    const v = assessWindow({ ...clean, episodesPushed: null });
    expect(v.trustworthy).toBe(true);
    expect(v.crossCheck).toBeNull();
  });
});

describe("summarise — the number the levers move", () => {
  const rows = [
    { call_kind: "extract_nodes", calls: 100, input_tokens: 836_000, output_tokens: 27_800, cost_usd: 0.31 },
    { call_kind: "extract_edges", calls: 100, input_tokens: 811_000, output_tokens: 62_400, cost_usd: 0.34 },
    { call_kind: "dedupe_nodes", calls: 100, input_tokens: 1_041_200, output_tokens: 10_500, cost_usd: 0.35 },
  ];

  it("reports per-episode figures against extract_nodes, not the row count", () => {
    const s = summarise({ rows, extractNodes: 100 });
    expect(s.episodes).toBe(100);
    expect(s.callsPerEpisode).toBe(3);
    expect(s.inputTokensPerEpisode).toBe(26_882);
    expect(s.usdPerEpisode).toBeCloseTo(0.01, 3);
  });

  it("expresses the multiple against a FULL episode's content, the honest ceiling", () => {
    // 2,500 chars ≈ 625 tokens. A half-full episode reads worse than this, which is correct: the
    // fixed overhead is the same either way, and pretending otherwise would flatter the pipeline.
    const s = summarise({ rows, extractNodes: 100 });
    expect(s.multipleOfContent).toBeCloseTo(26_882 / 625, 2);
  });

  it("returns nulls rather than Infinity when there are no episodes", () => {
    const s = summarise({ rows: [], extractNodes: 0 });
    expect(s.inputTokensPerEpisode).toBeNull();
    expect(s.multipleOfContent).toBeNull();
  });
});

describe("resolveLastWindow", () => {
  it("parses the convenience forms", () => {
    const now = Date.parse("2026-08-06T12:00:00.000Z");
    expect(resolveLastWindow("24h", now)?.since).toBe("2026-08-05T12:00:00.000Z");
    expect(resolveLastWindow("90m", now)?.since).toBe("2026-08-06T10:30:00.000Z");
    expect(resolveLastWindow("7d", now)?.since).toBe("2026-07-30T12:00:00.000Z");
  });

  it("returns null for anything it does not understand, rather than guessing a window", () => {
    for (const junk of ["", "24", "h", "24w", "abc", undefined]) {
      expect(resolveLastWindow(junk as string, Date.now())).toBeNull();
    }
  });
});
